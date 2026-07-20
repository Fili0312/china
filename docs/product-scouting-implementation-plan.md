# Scouting prodotti multi-marketplace da file Excel — piano di implementazione

Branch: `feature/multi-marketplace-scouting`
Documento vivo: ogni milestone aggiorna la propria sezione di stato
(`completato` / `parzialmente completato` / `bloccato` / `da implementare`).

---

## 1. Inventario del repository esistente

### 1.1 Stack rilevato

| Livello | Tecnologia | Dove |
| --- | --- | --- |
| Monorepo | pnpm 9.15.9 workspace + Turborepo 2 | `pnpm-workspace.yaml`, `turbo.json` |
| Linguaggio | TypeScript 5.7 strict, `module: NodeNext` | `tsconfig.base.json` |
| Backend | NestJS 11 REST (+ SSE), porta 3021, prefisso globale `/api` | `apps/api` |
| Worker | BullMQ 5 + Playwright, code Redis | `apps/worker` |
| Frontend | Next 16 App Router, React 19, porta 3020, `basePath=/china` | `apps/web` |
| Database | PostgreSQL 16 + Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`) | `packages/db` |
| Contratti | Zod 4 | `packages/shared` |
| Scraping | interfaccia `MarketplaceAdapter` + Chromium condiviso | `packages/adapters` |
| AI | Claude structured output (`@anthropic-ai/sdk`) | `packages/ai` |
| Excel | `xlsx` 0.18.5 (già dipendenza di `@china/api`) | `apps/api/src/inquiry` |
| Test | `node --test` via `tsx --test` (nessun framework esterno) | `*.test.ts` |

**Autenticazione: assente.** Non esiste alcun modulo di login, sessione o
guard Nest. L'applicazione è esposta dietro nginx su
`filippo.eventoyou.com/china` senza controllo accessi.

**Lint: assente.** Non esiste ESLint/Biome né configurazione. Lo script
`typecheck` (`tsc --noEmit`) è oggi l'unico controllo statico.

**Migrazioni: assenti.** Lo schema è applicato con `prisma db push`, non
esiste `prisma/migrations/`. Le 5 tabelle attuali sono già create sul DB
`china_sourcing`.

### 1.2 Funzionalità già operative (da riutilizzare, non riscrivere)

1. **Ricerca multi-motore** — `apps/api/src/search/search.service.ts`
   registra 7 motori dietro l'interfaccia `ProductSearchProvider`:
   `taobao`/`tmall` (OTAPI) e `alibaba`/`aliexpress`/`made-in-china`/
   `chinagoods`/`yiwugo` (`MarketplaceScraperProvider` → adapter Playwright).
   Espone `GET /api/search` (singolo motore) e `POST /api/v1/searches`
   (aggregato, errori tipizzati isolati per fonte).
2. **Motore di pertinenza** — `relevance.ts` (1319 righe): punteggio 0-100,
   copertura termini, gestione query cinese vs titolo inglese, dedup,
   `matchReasons`/`matchWarnings`. Soglie per profilo `strict|balanced|broad`.
3. **Pianificazione query** — `query-planner.ts`: normalizzazione unità e
   forma della query **per motore** (OTAPI vuole `10000 mah` staccato, i
   cataloghi internazionali `10000mAh`).
4. **Aggregazione** — `aggregate.ts`: merge dei duplicati fra fonti in
   `offers[]` con `canonicalKey`, selezione diversificata.
5. **Import fogli 询价** — `apps/api/src/inquiry/`: lettura `.xls/.xlsx/.xlsm`
   con riconoscimento delle intestazioni **cinesi** per nome (non per
   posizione), estrazione del link di riferimento (hyperlink o URL in cella),
   costruzione della query cinese verbatim (`inquiry-query.ts`), upload come
   corpo binario `application/octet-stream` (niente multer: `express` non è
   risolvibile da `apps/api` con pnpm).
6. **Adapter Playwright** — `packages/adapters`: 5 marketplace reali con
   `search()` **e** `getDetails()` già implementati (varianti, `priceTiers`,
   `attributes`, immagini), rilevamento captcha esplicito, browser Chromium
   condiviso per processo (`browser.ts`).
7. **Protezioni di carico** — cache per-provider con TTL, cooldown captcha,
   coda serializzata per marketplace, `SEARCH_MAX_IN_FLIGHT`,
   `search-rate-limit.service.ts`.
8. **Pipeline preventivi legacy** — BullMQ Flow
   (`quote-parse` → `item-search` → `item-select` → `quote-assemble`) con
   avanzamento via Redis pub/sub + SSE `GET /api/quotes/:id/events`.
   Accantonata ma **intatta**: è il modello di riferimento per i job.
9. **UI** — `search-experience.tsx` (motore singolo), `bulk-search.tsx`
   (lista prodotti, pool client-side), `inquiry-search.tsx` (righe da Excel),
   `search-shared.tsx` (card prodotto condivisa).

### 1.3 Cosa manca rispetto all'obiettivo

| Requisito | Stato attuale |
| --- | --- |
| Upload CSV | ❌ solo `.xls/.xlsx/.xlsm` |
| Mapping colonne scelto dall'utente | ❌ intestazioni cinesi fisse |
| Anteprima righe/colonne generiche | ❌ solo schema 询价 |
| Fingerprint della richiesta | ❌ inesistente |
| Riuso di richieste già elaborate | ❌ inesistente |
| Job server-side con avanzamento per riga | ❌ il bulk gira nel browser |
| Persistenza di candidati/scartati/finalisti | ❌ nessuna tabella |
| Storico prezzi e rilevamento modifiche | ❌ inesistente |
| Piloterr | ❌ inesistente |
| Sessioni account 1688/Taobao cifrate | ❌ inesistenti |
| Export Excel | ⚠️ solo CSV lato browser |

---

## 2. Vincoli reali verificati (non negoziabili)

Questi limiti sono stati verificati sul campo in sessioni precedenti e sono
registrati nel README: il piano ci si adatta invece di ignorarli.

- **Alibaba e Made-in-China sono bloccati da captcha dall'IP del VPS**, anche
  con query inglesi. Non sono risolvibili via Playwright da questo server →
  è esattamente il caso d'uso di **Piloterr** (M3).
- **AliExpress non ha vetrina cinese** e reindirizza a `de.aliexpress.com`:
  è un catalogo export al dettaglio, impreciso sui ricambi industriali.
- **`s.1688.com` risponde con punish page**, **`s.taobao.com` richiede login**:
  Taobao resta raggiungibile solo via OTAPI; 1688 richiede sessione (M5).
- **Chinagoods capisce il cinese ma pubblica titoli in inglese** → il ranking
  cross-lingua è già gestito da `relevance.ts` e non va rifatto.
- **Yiwugo cinese è una SPA**: serve `waitFor` ≥ 15 s.
- Fonti affidabili per un blocco di richieste cinesi: **Yiwugo** e
  **Chinagoods**.

---

## 3. Architettura proposta

Nuovo dominio **`scouting`**, additivo: non tocca `search`, `inquiry`,
`quotes`. Riusa i loro servizi come dipendenze.

```
apps/api/src/scouting/
  scouting.module.ts
  datasets/            upload, parsing xls/xlsx/csv, anteprima, mapping
  normalize/           riga grezza → richiesta normalizzata + requisiti
  fingerprint/         impronta stabile della richiesta
  runs/                job di scouting, avanzamento per riga
  selection/           hard constraints, dedup, punteggi, finalisti
  export/              workbook dei risultati
apps/api/src/search/providers/piloterr.provider.ts
packages/shared/src/schemas/scouting.ts
```

Il **worker** esegue le righe (BullMQ, come la pipeline preventivi); l'API
pubblica lo stato via SSE riusando `events.service.ts`.

### 3.1 Impronta della richiesta (identità)

Il tipo richiesto dalla specifica è il contratto di input:

```ts
type ProductRequirementFingerprintInput = {
  category: string | null;
  brand: string | null;
  model: string | null;
  normalizedName: string;
  requiredVariant: Record<string, string | number>;
  dimensions: Record<string, number>;
  material: string | null;
  power: number | null;
  voltage: number | null;
  capacity: number | null;
  certifications: string[];
  requestedQuantity: number | null;
};
```

Regole di stabilità (il fingerprint **non** dipende da file, riga o ordine):

- `normalizedName`: NFKC, minuscole, punteggiatura → spazio, token ordinati
  alfabeticamente (l'ordine delle parole non conta), stopword amministrative
  rimosse;
- unità convertite in **unità base SI** prima dell'hash (mm, W, V, ml/l → l,
  g/kg → kg): `1.5 m` e `1500 mm` producono la stessa impronta;
- `requiredVariant` e `dimensions`: chiavi ordinate, numeri arrotondati a 4
  decimali per evitare derive in virgola mobile;
- `certifications`: deduplicate, maiuscole, ordinate;
- `requestedQuantity` **esclusa** dall'hash (una quantità diversa non è un
  prodotto diverso) ma conservata sul record;
- hash = SHA-256 del JSON canonico, primi 32 caratteri esadecimali.

Due `fingerprint` a confronto:
`ProductRequest.fingerprint` (identità forte, indice unico) e
`normalizedNameKey` (identità debole, per suggerire richieste simili).

### 3.2 Riuso vs nuova ricerca

Per ogni riga:

1. calcolo del fingerprint → `SELECT ProductRequest WHERE fingerprint = ?`;
2. **mai vista** → ricerca completa sui motori scelti;
3. **già vista** → si riaprono le pagine dei candidati salvati
   (`getDetails`/Piloterr), si aggiornano prezzo, variante, stock, MOQ,
   venditore, recensioni, disponibilità;
4. confronto campo per campo con `ProductSnapshot`: se nulla è cambiato il
   punteggio resta **invariato** (nessun ricalcolo, nessun consumo di crediti);
5. ricalcolo dei punteggi **solo** per i candidati con dati modificati;
6. nuova ricerca completa solo se: nessun candidato salvato, finalisti sotto
   la soglia minima, oppure `staleness` > `SCOUTING_REFRESH_AFTER_DAYS`,
   oppure richiesta esplicita dell'utente (`forceFullSearch`).

---

## 4. Schema database proposto (additivo)

Nessuna tabella esistente viene modificata o rimossa.

```prisma
model ScoutingDataset {          // un file caricato
  id, fileName, format(xls|xlsx|csv), sheetName, sizeBytes,
  columns Json,                  // intestazioni riconosciute
  mapping Json,                  // scelta dell'utente colonna→campo
  rowCount, createdAt
  rows ScoutingDatasetRow[]
  runs ScoutingRun[]
}

model ScoutingDatasetRow {       // riga originale, valori intatti
  id, datasetId, rowNumber, cells Json, createdAt
  @@unique([datasetId, rowNumber])
}

model ProductRequest {           // richiesta normalizzata, riusabile fra file
  id, fingerprint @unique, normalizedNameKey,
  normalizedName, category, brand, model,
  requiredVariant Json, dimensions Json,
  material, power, voltage, capacity,
  certifications String[], requestedQuantity,
  searchQuery, language, firstSeenAt, lastSearchedAt, searchCount
  candidates ProductCandidateRecord[]
  rowRuns ScoutingRowRun[]
}

model ScoutingRun {              // esecuzione su un dataset
  id, datasetId, status, engines String[], quality,
  totalRows, processedRows, reusedRows, failedRows,
  startedAt, finishedAt, error
  rows ScoutingRowRun[]
}

model ScoutingRowRun {           // avanzamento della singola riga
  id, runId, datasetRowId, productRequestId,
  status(PENDING|NORMALIZING|SEARCHING|REFRESHING|SCORING|DONE|SKIPPED|FAILED),
  reused Boolean, engineStatuses Json, error,
  startedAt, finishedAt
  results ScoutingResult[]
}

model ProductCandidateRecord {   // prodotto trovato, vive oltre il run
  id, productRequestId, engine, externalId, url, title, imageUrl,
  vendorName, vendorUrl, price, currency, moq, stock,
  rating, reviewCount, variants Json, specs Json, priceTiers Json,
  firstSeenAt, lastCheckedAt, lastChangedAt, contentHash
  snapshots ProductSnapshot[]
  results ScoutingResult[]
  @@unique([productRequestId, engine, externalId])
}

model ProductSnapshot {          // storico: una riga per cambiamento reale
  id, candidateId, capturedAt, price, currency, moq, stock,
  rating, reviewCount, availability, contentHash, changedFields String[]
}

model ScoutingResult {           // esito per riga: finalista o scartato
  id, rowRunId, candidateId,
  outcome(FINALIST|REJECTED|SHORTLISTED),
  rank, score, scoreBreakdown Json,
  rejectionCode, rejectionReason, aiRationale,
  scoreReused Boolean, createdAt
}
```

Applicazione: `pnpm db:push` (coerente con la prassi esistente).

---

## 5. Rischi e dipendenze mancanti

| # | Rischio | Impatto | Mitigazione |
| --- | --- | --- | --- |
| R1 | **Chiave Piloterr non disponibile in questa sessione** | il provider non è verificabile live | client completo + test unitari con `fetch` iniettato; nessun mock nel percorso di produzione: senza chiave il motore risponde con errore tipizzato `SOURCE_CONFIGURATION` |
| R2 | Captcha su Alibaba/Made-in-China da questo IP | scouting incompleto su quelle fonti | instradamento automatico su Piloterr quando la chiave è presente; errore esplicito altrimenti |
| R3 | 1688/Taobao richiedono login | M5 non verificabile senza credenziali reali | infrastruttura sessioni cifrate completa + procedura di test manuale documentata |
| R4 | Nessun ESLint nel repo | «esegui lint» non ha un comando | `typecheck` + `test` + `build` come gate; aggiungere ESLint è fuori perimetro e produrrebbe migliaia di segnalazioni sul codice esistente |
| R5 | Nessuna autenticazione | i dataset caricati sono pubblici | fuori perimetro, ma **segnalato**: l'endpoint di upload eredita l'esposizione attuale |
| R6 | Costo AI sulle motivazioni (M7) | ~3¢/articolo con opus | motivazione AI **opzionale** e solo sui finalisti; punteggi sempre deterministici |
| R7 | `prisma db push` senza migrazioni | derive fra ambienti | schema additivo, nessuna colonna rimossa |
| R8 | Playwright serializzato per marketplace | un file da 400 righe è lento | riuso della cache per fingerprint + concorrenza per motore configurabile |

### Dipendenze nuove

- **nessun nuovo pacchetto npm richiesto**: `xlsx` (Excel + CSV), `zod`,
  `bullmq`, `playwright`, `@prisma/client` sono già presenti; la cifratura
  delle sessioni usa `node:crypto` (AES-256-GCM).

### Variabili d'ambiente nuove (solo `.env.example`, valori mai nel codice)

```
PILOTERR_API_KEY=
```

più le opzionali di comportamento (timeout, TTL cache, soglie, concorrenza,
`SCOUTING_SESSION_SECRET` per M5).

---

## 6. Stato delle milestone

| # | Contenuto | Stato |
| --- | --- | --- |
| M1 | Analisi, inventario, piano, schema DB, rischi | **completato** |
| M2 | Upload xls/xlsx/csv, anteprima, mapping, normalizzazione, fingerprint, DB, riuso | **completato** |
| M3 | PiloterrClient, Alibaba/AliExpress, cache e crediti, salvataggio candidati | **parzialmente completato** (manca la prova con chiave reale) |
| M4 | ImportJob, ScoutingRequest, esecuzione, avanzamento, controlli, UI | **completato** |
| M5 | Sessioni 1688/Taobao cifrate, scadenza, riconnessione | da implementare |
| M6 | Aggiornamento prodotti, storico prezzi, rilevamento modifiche | **completato**; varianti/scaglioni dipendono dall'adapter della fonte |
| M7 | Hard constraints, dedup, punteggi, finalisti | **completato** (motivazioni AI: da implementare) |
| M8 | Export Excel **completato**; UI base c'è (M4). Resta: rifinitura UI, test end-to-end automatici |


---

## 7. M2 — esito (completato)

### Cosa è stato costruito

| Componente | File |
| --- | --- |
| Contratti Zod dello scouting | `packages/shared/src/schemas/scouting.ts` |
| Impronta stabile della richiesta | `packages/shared/src/scouting/fingerprint.ts` |
| Estrazione requisiti + conversione unità | `packages/shared/src/scouting/requirements.ts` |
| Lettura file xls/xlsx/xlsm/csv, colonne, mapping | `apps/api/src/scouting/dataset-workbook.ts` |
| Riga → richiesta normalizzata | `apps/api/src/scouting/normalize-request.ts` |
| Persistenza, riuso, ricerca per impronta | `apps/api/src/scouting/scouting.service.ts` |
| API REST | `apps/api/src/scouting/scouting.controller.ts` |
| Lettura corpo binario condivisa | `apps/api/src/common/binary-body.ts` |
| Schema DB (9 modelli, 3 enum) | `packages/db/prisma/schema.prisma` |

Endpoint disponibili:

```
GET    /api/scouting/datasets                  elenco dei file caricati
POST   /api/scouting/datasets                  upload (corpo binario)
GET    /api/scouting/datasets/:id              anteprima righe e colonne
PUT    /api/scouting/datasets/:id/mapping      conferma mappatura
POST   /api/scouting/datasets/:id/normalize    normalizza + segnala i già noti
```

### Verifica su dati reali

Eseguita sul foglio `副本博工询价.xls` (249 righe, colonne cinesi):

- riga di intestazione trovata alla **riga 5**, non alla prima;
- 12 colonne su 19 associate automaticamente al campo giusto, compresa la
  colonna **S senza intestazione**, riconosciuta come link di riferimento dai
  collegamenti ipertestuali delle celle;
- 248 righe normalizzate, 1 scartata (priva di nome prodotto);
- **240 impronte distinte**: 8 righe erano duplicati interni al file,
  individuati senza intervento manuale;
- al secondo passaggio tutte e 240 le richieste risultano già elaborate;
- `长200*宽40*高140` → `{length: 200, width: 40, height: 140}` mm;
  la stessa riga riscritta come `高14cm*宽4cm*长20cm`, con le parole in ordine
  diverso, produce **la stessa identica impronta**;
- `针规 2.48` e `针规 2.62` restano due richieste **diverse**: i numeri non
  consumati da una misura restano parte dell'identità.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 78/78 ✅ · `pnpm build` ✅
(34 test nuovi in `apps/api/src/scouting/`).

I dati di prova sono stati rimossi dal database al termine della verifica.

### Gotcha scoperto durante la verifica

**`pnpm dev` non funziona per l'API, e non è colpa dello scouting.** `tsx` usa
esbuild, che non emette `design:paramtypes`: l'iniezione delle dipendenze di
Nest fallisce e **ogni** controller risponde 500
(`Cannot read properties of undefined`). Vale anche per `quotes`, `search` e
`inquiry`, che sono precedenti a questo lavoro. Il servizio in produzione non
è toccato perché gira su `node dist/main.js`, compilato da `tsc`. Per provare
l'API in locale: `pnpm --filter @china/api build && node dist/main.js`.
Sistemarlo (`@swc-node/register` o `nest start`) è fuori dal perimetro di
questo intervento, ma va annotato.


---

## 8. M3 — esito (parzialmente completato)

### Cosa è stato costruito

| Componente | File |
| --- | --- |
| Client HTTP Piloterr: chiave, timeout, cache, crediti, errori tipizzati | `apps/api/src/search/providers/piloterr.client.ts` |
| Provider di ricerca Alibaba e AliExpress | `apps/api/src/search/providers/piloterr.provider.ts` |
| Instradamento Piloterr ↔ browser per marketplace | `apps/api/src/search/providers/routed.provider.ts` |

Gli schemi non sono inventati: sono quelli pubblicati da Piloterr
(`GET /v2/alibaba/search`, `GET /v2/aliexpress/search`, header `x-api-key`,
base `https://api.piloterr.com`), letti in modo tollerante sui campi
facoltativi.

### Trattamento della chiave

- vive **solo** in `PILOTERR_API_KEY` (aggiunta vuota a `.env.example`);
- viaggia **solo** nell'header `x-api-key`, mai in query string: gli URL
  finiscono nei log di accesso di qualunque proxy attraversato;
- `redactKey()` la toglie da ogni testo prima che diventi messaggio d'errore
  o riga di log — verificato da un test dedicato;
- non compare in interfaccia: `GET /api/search/health` espone solo
  `configured: true|false` e il consumo di crediti.

### Governo dei crediti

| Meccanismo | Comportamento |
| --- | --- |
| Cache per chiamata identica | TTL 1 h (`PILOTERR_CACHE_TTL_MS`); una ripetizione costa 0 |
| Conteggio | costo reale per endpoint, esposto in `health`: **ricerca Alibaba 1 credito, tutti gli altri 2** (compresa `/v2/alibaba/product`, corretta il 2026-07-20 dopo verifica sul pannello) |
| Tetto di spesa | `PILOTERR_MAX_CALLS_PER_RUN` (0 = illimitato) |
| Errori 4xx | non conteggiati: Piloterr non li fattura |
| Paginazione | una pagina per ricerca (20 risultati): ogni pagina in più è un credito in più |

### Instradamento

`alibaba` e `aliexpress` passano da Piloterr **se e solo se** la chiave è
configurata; altrimenti resta attivo l'adapter Playwright preesistente, con lo
stesso comportamento di prima. La scelta viene rifatta a ogni chiamata, così la
chiave può essere aggiunta al `.env` senza ricompilare — basta riavviare il
servizio. Verificato su istanza reale: senza chiave `route: "browser"`, con
chiave `route: "piloterr"`, e la chiave non compare nel journal.

**Nessun ripiego automatico in caso di errore**: se Piloterr fallisce, l'errore
tipizzato arriva all'utente (`SOURCE_UPSTREAM`, `SOURCE_BUSY`,
`SOURCE_CONFIGURATION`) e viene isolato per fonte dall'aggregatore. Ripiegare
in silenzio su una fonte che sappiamo bloccata dal captcha nasconderebbe il
problema invece di risolverlo.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 93/93 ✅ · `pnpm build` ✅
(15 test nuovi, con `fetch` iniettato: nessuna rete, nessuna chiave).

### ⚠️ Test manuale necessario prima di dichiarare M3 completata

Il percorso non è mai stato eseguito contro l'API reale, perché la chiave è
tua e non è presente su questo server. Servono, con `PILOTERR_API_KEY`
valorizzata in `.env`:

1. `systemctl restart china-api`
2. `curl -s 'http://localhost:3021/api/search/health' | jq '.providers[] | select(.name=="alibaba")'`
   → deve mostrare `"route": "piloterr"`
3. `curl -s 'http://localhost:3021/api/search?q=esd+chair&engine=alibaba&quality=broad&frameSize=5'`
   → devono arrivare prodotti reali con prezzo, MOQ e venditore
4. ricontrollare `health`: `usage.calls` = 1, `usage.creditsSpent` = 1
5. ripetere la stessa ricerca entro un'ora: `usage.calls` deve restare 1 e
   `cacheHits` salire a 1 (conferma che la cache protegge i crediti)

Da verificare in quell'occasione, perché la documentazione non lo chiarisce:
se `rating` e `review_count` compaiano davvero nella ricerca Alibaba (lo
schema ufficiale non li elenca, un esempio della libreria sì) e quale
`subdomain` dia i prezzi migliori (`PILOTERR_ALIBABA_SUBDOMAIN`).

Nota: la documentazione segnala l'endpoint **Alibaba Product** come
temporaneamente sospeso per manutenzione. Riguarda M6 (dettagli prodotto), non
la ricerca.


---

## 9. M4 — esito (completato)

### Vocabolario allineato

I modelli sono stati rinominati per corrispondere ai termini della specifica.
Le tabelle erano vuote, quindi il rename è stato applicato senza perdita:

| Prima | Ora |
| --- | --- |
| `ScoutingRun` | `ImportJob` (uno per elaborazione di un file) |
| `ScoutingRowRun` | `ImportJobRow` |
| `ProductRequest` | `ScoutingRequest` (una per impronta distinta) |
| — | `ImportJobRowEngine` (**nuovo**: stato per riga × marketplace) |

### I quindici punti richiesti

| # | Requisito | Dove |
| --- | --- | --- |
| 1 | ImportJob per file | `ImportJobService.createJob` |
| 2 | ScoutingRequest per impronta | idem, tramite `upsertScoutingRequest` |
| 3 | Righe duplicate sulla stessa richiesta | `requestIdByFingerprint` |
| 4 | Scelta dei marketplace | `StartImportJobRequest.engines`, caselle in UI |
| 5 | Avvio automatico di tutte le righe | `ScoutingRunnerService.start` |
| 6 | Candidati salvati permanentemente | `candidate-store.ts` |
| 7 | Candidato legato a richiesta **e** query | campo `foundQuery` |
| 8 | Stato ed errori separati per marketplace | `ImportJobRowEngine` |
| 9 | Avanzamento per file, riga e fonte | `GET /api/scouting/jobs/:id` |
| 10 | Pausa, annulla, riprendi, ritenta | quattro endpoint POST + pulsanti |
| 11 | Riuso dei candidati per impronta nota | `ScoutingRunnerService.canReuse` |
| 12 | Nessuna ripetizione Piloterr con cache valida | cache del client + `servedFromCache` |
| 13 | Aggiornamento dei candidati preparato | confronto `contentHash` + `ProductSnapshot` |
| 14 | Endpoint backend | `import-job.controller.ts` |
| 15 | Prima UI funzionante | `apps/web/app/scouting/` |

### Perché l'esecuzione sta nell'API e non nel worker

I provider di ricerca vivono nel processo API, Chromium compreso, e ogni
marketplace ha già lì la propria coda, la propria cache e il proprio cooldown
anti-captcha. Spostare l'esecuzione nel worker BullMQ significherebbe un
secondo Chromium e due cache che si ignorano, cioè il doppio delle visite agli
stessi siti — esattamente ciò che fa scattare i captcha. Lo stato vive
interamente su Postgres, quindi pausa, ripresa e riavvio del servizio
funzionano lo stesso.

### Verifica end-to-end su marketplace reali

CSV con tre righe di cui **due uguali a parole invertite**
(`防静电椅 黑色 升降` e `防静电椅 升降 黑色`), fonti Chinagoods + Yiwugo:

- job concluso 3/3, **1 riga riusata**: la riga 4 ha ereditato gli 8 candidati
  della riga 2 senza interrogare nessuna fonte (entrambe le fonti `SKIPPED`
  con motivazione esplicita);
- prodotti veri salvati con prezzo e valuta della fonte (110 CNY da Yiwugo,
  1,33 USD da Chinagoods) e con la query che li ha trovati;
- durata e conteggi registrati per fonte: Chinagoods 13,8 s, Yiwugo 68,2 s;
- crediti Piloterr consumati: 0 (chiave non configurata).

Controlli di comando, su un job abbastanza lento da poterlo fermare davvero:

- **pausa** durante l'esecuzione → `PAUSED` a 2/4 righe, le righe in corso
  hanno completato il loro lavoro invece di buttarlo;
- **ripresa** → riparte dalle righe rimaste;
- **annulla** → `CANCELLED`, righe mai iniziate chiuse come annullate;
- **ripresa di un job annullato** → rifiutata con messaggio che indirizza a
  «ritenta»;
- **ritenta tutto** dopo l'annullamento → 4/4 completate, **3 riusate**: la
  sola riga senza candidati è stata ricercata di nuovo.

UI guidata con un browser vero (Playwright): caricamento del CSV, colonne
riconosciute con i campi giusti, marketplace preselezionati, avvio, barra di
avanzamento, riepilogo per fonte, pulsante di pausa.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 101/101 ✅ · `pnpm build` ✅

### Difetti trovati dai test e corretti

1. **`resume` accettava anche job già conclusi**, riportandoli a `QUEUED` per
   poi richiuderli subito: un giro a vuoto che in interfaccia sembra un errore.
   Ora è permesso solo da `PAUSED`, `QUEUED`, `RUNNING`, `FAILED`.
2. **L'annullamento lasciava in attesa le righe mai iniziate**, che «ritenta»
   non riusciva più a vedere. Ora il ciclo le chiude come `CANCELLED`.

### Nota sui dati di prova

Tutti i dati creati durante la verifica sono stati rimossi dal database, e la
build di `apps/web` è stata rigenerata con l'URL API di produzione dopo essere
stata temporaneamente ricompilata verso la porta di test.


---

## 10. M7 — esito (completato; motivazioni AI ancora da fare)

Anticipata rispetto a M5 e M6 perché è l'unica delle tre **interamente
verificabile qui**: M5 richiede le credenziali 1688/Taobao di Filippo, M6 la
chiave Piloterr e un endpoint che Piloterr dichiara sospeso. Consegnare codice
mai eseguito su quelle due sarebbe stato peggio che rimandarle.

### Come vengono valutati i prodotti

Tre esiti distinti per ogni requisito, ed è la distinzione che conta:

| Esito | Significato | Effetto |
| --- | --- | --- |
| violato | il prodotto dichiara un valore incompatibile | scartato con motivazione |
| verificato | il prodotto dichiara il valore giusto | punteggio pieno |
| non verificabile | il prodotto non dichiara nulla | **neutro**, mai penalizzante |

Un titolo cinese di quaranta caratteri non elenca le certificazioni:
trattarne l'assenza come mancanza scarterebbe i prodotti giusti.

Punteggio deterministico su cento punti: pertinenza 45, requisiti 25, prezzo
12, reputazione 10, minimo d'ordine 8. Nessuna IA — dev'essere spiegabile e
identico a distanza di mesi.

Scarti tipizzati: `HARD_CONSTRAINT`, `MOQ_TOO_HIGH`, `PRICE_OVER_TARGET`,
`UNAVAILABLE`, `DUPLICATE`, `BELOW_THRESHOLD`. Ognuno porta sempre una
motivazione leggibile: un test lo verifica per tutti.

### Il difetto più importante trovato provando sul serio

Il primo giro su dati reali ha prodotto un risultato **sbagliato ma
convincente**: cinque «finalisti» a pari merito 52,1 per una richiesta di
tappetini antistatici — erano tutti **pettini**. Causa: su Chinagoods una
query cinese incontra titoli inglesi, il motore di pertinenza non può
confrontarli e assegna a tutti lo stesso punteggio neutro; nessuna misura era
dichiarata, quindi tutti i requisiti erano «non verificabili» e il punteggio
finiva identico per chiunque.

Correzione: **un prodotto senza un solo segnale positivo verificabile non può
essere proposto come finalista.** Serve almeno un requisito verificato oppure
una pertinenza sopra 55. I prodotti restano in elenco come `SHORTLISTED`, con
la nota del perché non sono proposti. Sullo stesso job la selezione è passata
da 5 finalisti sbagliati a **zero finalisti** — che è la risposta onesta.

### Il secondo difetto, nel riuso dei punteggi

Riusando il punteggio di un prodotto immutato veniva riusato anche il
**giudizio di proponibilità**. Ma quel giudizio dipende dalle regole, non dai
dati del prodotto: dopo la correzione qui sopra, i vecchi esiti sbagliati le
sopravvivevano e i pettini restavano finalisti. Ora del calcolo precedente si
conserva solo il **punteggio** — è quello che deve restare stabile — mentre
controlli e proponibilità si rideducono sempre da capo. Verificato sul job
reale: punteggi `riusato=True` a 52,1 invariati, finalisti proposti 0.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 118/118 ✅ · `pnpm build` ✅
(17 test in `selection.test.ts`).

### Da fare ancora su M7

Le **motivazioni discorsive AI** sui finalisti (`aiRationale`, facoltative e a
consumo). Il campo esiste a database ed è esposto dall'API, ma non viene
ancora popolato. Vanno aggiunte dopo, senza mai lasciar loro cambiare la
classifica: il punteggio resta deterministico.


---

## 11. M8 — export Excel (completato)

`GET /api/scouting/jobs/:id/export` scarica un `.xlsx` con quattro fogli:

| Foglio | Contenuto |
| --- | --- |
| **Finalisti** | i prodotti proposti, con posizione e punteggio |
| **In elenco** | i trovati non proposti, con il perché |
| **Scartati** | codice e motivo dello scarto |
| **Riepilogo** | dati del job ed esito per riga × marketplace |

Ogni riga dei primi tre fogli riporta in testa **le celle originali del file
caricato**, più numero di riga, query e impronta: il foglio esportato si
affianca a quello di richiesta senza doverli riconciliare a mano.

Verificato scaricandolo davvero dall'endpoint: 33 KB, `Content-Disposition`
con nome derivato dal file caricato, quattro fogli, primo finalista con
impronta, celle originali, punteggio 57 e prodotto Yiwugo reale a 43,75 CNY.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 124/124 ✅ · `pnpm build` ✅

## 12. Cosa resta

| Milestone | Stato | Perché |
| --- | --- | --- |
| M3 prova con chiave reale | bloccato | serve `PILOTERR_API_KEY`: procedura al §8 |
| M5 sessioni 1688/Taobao | da implementare | serve un login manuale con credenziali vere |
| M6 dettagli, varianti, stock, storico prezzi | parziale | lo **storico e il rilevamento modifiche funzionano** (§9); mancano i dettagli di prodotto, che richiedono la chiave Piloterr e un endpoint che Piloterr dichiara sospeso |
| M7 motivazioni AI | da implementare | facoltative e a consumo; la classifica resta deterministica |
| M8 rifinitura UI e test E2E automatici | da implementare | la UI funziona ed è stata guidata con un browser vero, ma non c'è un test automatico che la copra |


---

## 13. M6 — esito (completato per la parte verificabile)

### Cosa fa

`CandidateRefreshService` chiude il ciclo del riuso descritto nella specifica:
quando una richiesta è già nota non si ricerca di nuovo, si **riaprono le
pagine** dei prodotti salvati e si rileggono prezzo, minimo d'ordine, stock,
varianti, prezzi per quantità e disponibilità.

```
POST /api/scouting/rows/:jobRowId/refresh       aggiorna i prodotti di una riga
POST /api/scouting/candidates/:id/refresh       aggiorna un singolo prodotto
GET  /api/scouting/candidates/:id/history       storico dei prezzi
```

Dopo l'aggiornamento la riga viene **rivalutata**: se un prezzo cambia, i
finalisti possono cambiare, e mostrarli fermi sarebbe fuorviante.

L'aggiornamento è sequenziale di proposito: ogni scheda è una visita al sito,
e le visite ravvicinate sono ciò che fa scattare i captcha.

### Il difetto trovato provando sul serio, e la regola che ne è nata

Il primo aggiornamento reale su Yiwugo ha **distrutto dati buoni**: ha
sostituito il titolo cinese con uno inglese e ha azzerato un prezzo di
114,75 CNY, perché la scheda di dettaglio risponde sulla vetrina inglese e il
parser non vi trova il prezzo.

Ne è nata la regola che governa ora tutto l'aggiornamento:

> **Una lettura mancata non è un dato cancellato.**

In concreto:

- prezzo, MOQ, stock, valuta: si sovrascrivono **solo** se la scheda ne
  restituisce uno; altrimenti resta il valore precedente;
- varianti, specifiche e scaglioni: si aggiornano solo se non vuoti;
- il **titolo non viene mai sostituito**. È l'identità su cui è stata calcolata
  la pertinenza, e alcune schede lo restituiscono tradotto: cambiarlo in
  silenzio invaliderebbe il punteggio senza dirlo;
- una pagina irraggiungibile marca il prodotto non disponibile **senza
  cancellarlo**, così lo storico resta proprio quando serve.

Riverificato sullo stesso caso: l'aggiornamento ora riporta «invariato», e
titoli, prezzi e finalisti restano intatti.

### Storico prezzi

Ogni cambiamento reale scrive uno `ProductSnapshot` con i valori **precedenti**
e l'elenco dei campi cambiati — è ciò che permette di dire «costava X, ora
costa Y». Verificato: dopo una modifica, `GET /candidates/:id/history` ha
restituito la voce con il prezzo di prima e `changedFields: [title, price]`.

Controlli: `pnpm typecheck` ✅ · `pnpm test` 132/132 ✅ · `pnpm build` ✅

### Limite noto, da sistemare a parte

`YiwugoAdapter.getDetails()` ricade sulla **vetrina inglese** e non estrae
prezzo, varianti né scaglioni: l'aggiornamento su Yiwugo è quindi oggi un
non-evento (segnala «invariato»). È un limite dell'adapter, precedente a
questo lavoro e della stessa famiglia della trappola già documentata nel
README sulla ricerca. Va corretto nell'adapter — passando alla scheda
`www.yiwugo.com` e rileggendone i selettori — non nel servizio di
aggiornamento, che è già corretto e protetto.

Per Alibaba e AliExpress l'aggiornamento passerà da Piloterr
(`/v2/alibaba/product`, 2 crediti): il client c'è, il percorso è quello della
ricerca, ma non è verificabile senza chiave — e Piloterr dichiara quell'
endpoint temporaneamente sospeso.
