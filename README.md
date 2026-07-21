# China Sourcing

Piattaforma di sourcing automatico multi-marketplace: incolli un messaggio
libero o una lista con centinaia di prodotti (quantità, colori, misure,
caratteristiche) e ottieni un preventivo con ricarico configurabile, generato
cercando i prodotti sui marketplace cinesi e selezionando i candidati migliori
con Claude.

## Modalità ricerca diretta (attiva, 2026-07-19)

La home (`/`) cerca sulle fonti attualmente disponibili, insieme oppure una
alla volta:

- **Taobao** e il **catalogo storico Tmall**, tramite [OTAPI](https://otapi.net)
  `BatchSearchItemsFrame`, separati dal flag `Tmall=true/false` e con verifica
  del metodo realmente applicato (`Storage`);
- **Alibaba**, tramite adapter browser Playwright best-effort;
- **AliExpress**, tramite adapter browser Playwright best-effort;
- **Made-in-China**, tramite lo scraper Playwright isolato, prima pagina e
  senza ordinamento;
- **Chinagoods** e **Yiwugo**, cataloghi B2B di Yiwu tramite adapter browser
  difensivi, prima pagina e senza ordinamento.

La UI offre tre profili: `strict` (predefinito), `balanced` e `broad`. La
pipeline è deterministica e verificabile:

`query → normalizzazione/traduzione controllata → recupero ampliato → filtri
di validità → matching categoria e specifiche numeriche → ranking → deduplica`.

Una ricerca su “Tutti” usa `POST /api/v1/searches`: le sette fonti lavorano in
parallelo, un errore resta isolato, e il server restituisce una classifica unica
con `searchId`, stato per fonte, punteggio, motivi, warning e più offerte dentro
la stessa scheda. `GET /api/search` rimane disponibile per interrogare una
singola fonte. I prezzi restano nella valuta originale: non si confrontano o
convertono importi appartenenti a valute diverse.

La modalità lista accetta fino a 500 task sorgente complessivi, usa pool
separati per provider, avanzamento, interruzione, retry ed export CSV con
diagnostica di qualità.

- Chiave: `OTAPI_INSTANCE_KEY` nel `.env` di root (solo backend, mai nel
  frontend né nel repo). Timeout opzionale `OTAPI_TIMEOUT_MS` (default 45s: a
  cache fredda OTAPI impiega ~20s).
- Le fonti browser usano cache/circuit breaker configurabili con
  `SCRAPER_CACHE_TTL_MS`, `SCRAPER_CACHE_FILL_SIZE` e
  `SCRAPER_CAPTCHA_COOLDOWN_MS`. Code e API pubblica sono protette da
  `SCRAPER_MAX_PENDING`, `SEARCH_MAX_IN_FLIGHT` e
  `SEARCH_RATE_LIMIT_PER_MINUTE`. Il rate limit è condiviso via Redis con
  fallback locale.
- Le soglie sono configurabili con `SEARCH_RELEVANCE_STRICT_THRESHOLD`,
  `SEARCH_RELEVANCE_BALANCED_THRESHOLD` e
  `SEARCH_RELEVANCE_BROAD_THRESHOLD`; `SEARCH_STRICT_FETCH_SIZE` controlla il
  sovracampionamento delle fonti browser.
- Codice: `apps/api/src/search/` (provider separati dietro
  `ProductSearchProvider`), schemi in `packages/shared/src/schemas/search.ts`,
  UI in `apps/web/app/search-experience.tsx` e `bulk-search.tsx`.
- “Tutti” oggi significa **Taobao + Tmall + Alibaba + AliExpress +
  Made-in-China + Chinagoods + Yiwugo**.
  Le fonti browser possono attivare verifiche anti-bot: il
  singolo errore resta isolato. L'istanza OTAPI attuale abilita soltanto
  `Taobao/Storage`; il catalogo Tmall viene separato tramite feature ma non va
  considerato una ricerca ufficiale live. 1688, JD e
  Pinduoduo richiedono l'abilitazione lato OpenTrade Commerce o credenziali
  ufficiali. DHgate e Global Sources bloccano l'IP del server. Queste fonti non
  vengono simulate.
- La pipeline preventivi Playwright/scraping qui sotto è **accantonata ma
  intatta**: UI su `/legacy`, adapter su `MARKETPLACES=mock`. Per riattivarla:
  `MARKETPLACES=made-in-china` nel `.env` e riavvia `china-worker` (i tool di
  debug in `apps/worker/src/tools/` sono esclusi dalla build, si lanciano con
  `tsx`).

## Richieste da foglio Excel (`/scraping`, 2026-07-20)

La terza modalità di `/scraping` importa un foglio di richiesta d'acquisto
cinese e cerca ogni riga **sui soli marketplace via browser** (Alibaba,
AliExpress, Made-in-China, Chinagoods, Yiwugo). La modalità OTAPI non è
coinvolta: Taobao e Tmall restano fuori.

La query si costruisce con il **testo cinese originale**, `品名` + `规格型号`,
senza passare da una traduzione italiana e da una riconversione, che
perderebbero codici, modelli, misure e materiali:

```
品名: 防静电椅   规格型号: 黑色，升降，无靠背
        →  防静电椅 黑色 升降 无靠背
```

- Restano intatti codici e misure: `2HHS57-A-5/24`, `300KG/层`, `M8*35`,
  `NN100-200（不带电机）` → `NN100-200 不带电机`.
- Escono dalla query solo le parole amministrative (reparto, richiedente,
  centro di costo) e le quantità di confezionamento (`-20个`, `/一千个`).
  Quantità richiesta, fornitore e data non vengono nemmeno lette.
- La query cinese arriva al marketplace **così com'è**: `planSearchQuery`
  riconosce la scrittura Han e salta la traduzione IT→EN.
- Ogni scheda mostra la query usata, la lascia correggere a mano e permette di
  rilanciare la ricerca; le correzioni restano salvate nel browser. La query
  realmente inviata è anche in `diagnostics.queryUsed` e nell'export CSV.
- Se il file contiene già un link prodotto (colonna senza intestazione, con
  collegamento ipertestuale) la scheda lo mostra come primo passo — “apri il
  prodotto originale” — e poi cerca le alternative con nome e specifiche.
- Nessuna IA sceglie o filtra: l'ordinamento `best-match` combina
  compatibilità delle parole, prezzo, vendite e recensioni quando la fonte le
  espone. I prezzi si confrontano solo fra prodotti nella stessa valuta.

### Quale fonte risponde davvero al cinese

| Fonte | Query cinese | Note |
|---|---|---|
| **Yiwugo** | ✅ vetrina cinese `www.yiwugo.com/search?q=` | titoli in cinese → pertinenza misurata davvero (80/100 su `平板灯 60*60`), prezzi CNY e MOQ. La più precisa. |
| **Chinagoods** | ✅ indicizza il cinese | titoli in inglese → corrispondenza non verificabile (~53/100), da controllare a mano |
| **AliExpress** | ⚠️ con lo slug codificato | **non ha una vetrina cinese**: da questo IP reindirizza sempre a `de.aliexpress.com` (`gatewayAdapt=glo2deu`) e col cookie `b_locale=zh_CN` la ricerca smette di funzionare. Catalogo export al dettaglio: 496 € una sedia antistatica contro 110 ¥ su Yiwugo. Scatta il captcha dopo poche ricerche |
| **Alibaba** | ❌ captcha | bloccato per IP anche in inglese: servono API ufficiali o proxy |
| **Made-in-China** | ❌ captcha | redirect a `captcha.made-in-china.com` anche in inglese |

Piattaforme domestiche verificate il 2026-07-20 e **non raggiungibili** da
questo server: `s.1688.com` risponde `亲，访问被拒绝` (pagina punish di Alibaba)
e la ricerca web di `s.taobao.com` richiede il login. Il catalogo Taobao resta
disponibile solo tramite OTAPI, cioè fuori da questa modalità.

Due trappole trovate sul campo, entrambe corrette:

- gli adapter puntavano tutti alla **vetrina inglese** (`IndexArea=product_en`,
  `en.yiwugo.com`, path `hot-china-products`), che non indicizza il cinese;
  Yiwugo ora sceglie la vetrina in base alla scrittura della query;
- `buildSearchUrl` di AliExpress riduceva la query a uno slug latino: da una
  query cinese usciva `wholesale-products.html`, cioè il listino generico.
  Ecco perché tornavano prodotti scorrelati.

Se una fonte non trova nulla con la query completa, `MarketplaceScraperProvider`
riprova in modo deterministico con una query più corta (metà termini, poi il
solo nome prodotto): la ricerca dei marketplace cinesi combina i termini in AND
e una richiesta completa spesso non ha corrispondenze. La query davvero inviata
compare in `diagnostics.queryUsed` e nella scheda.

Le vetrine internazionali rispondono a una query cinese con titoli in inglese:
in quel caso la corrispondenza parola per parola non è verificabile, quindi il
risultato **non viene scartato** ma resta a metà classifica con un avviso
esplicito (`relevance.ts`), e la modalità parte dal profilo *Esplorativa*.
Restano confrontabili i codici prodotto latini (`DJM-050-485`), che infatti
fanno salire il punteggio.

Il foglio in dotazione sta in `data/inquiries/` (override con
`INQUIRY_DATA_DIR`); dall'interfaccia si può anche caricare un altro file.
Limite di caricamento `INQUIRY_MAX_UPLOAD_BYTES` (default 25 MB).

## Scouting da Excel con analisi IA (`/scouting`, 2026-07-21)

Il flusso completo di `/scouting`:

```
caricamento Excel
  → normalizzazione iniziale (colonne, righe intatte)
  → analisi delle richieste con Claude
  → revisione umana delle richieste interpretate
  → controllo nel database (variante conosciuta? famiglia conosciuta?)
  → aggiornamento dei prodotti noti  oppure  ricerca multi-marketplace
  → salvataggio candidati e storico prezzi
```

Il percorso precedente (job avviato senza analisi) **continua a funzionare**: senza
`analysisRunId` il job usa l'impronta come identità, esattamente come prima.

### 1. Analisi con Claude

Prima di qualunque ricerca ogni riga normalizzata viene mandata a Claude, che
restituisce JSON validato con Zod (`ProductAnalysisSchema`):

| campo | contenuto |
| --- | --- |
| `productFamily`, `familyKey` | famiglia leggibile e sua identità in kebab-case |
| `variantKey` | etichetta leggibile della variante (`5 mm`, `60x60 bianco`) |
| `productNameChinese`, `productNameEnglish` | nomi nelle due lingue |
| `model`, `material`, `color` | **termini letterali** del foglio, mai tradotti |
| `dimensions[]` | `{axis, label, value, unit}` — unità come scritta, `null` se assente |
| `technicalSpecifications[]` | `{key, value, unit}` — tensione, potenza, peso, capacità… |
| `includedAccessories[]`, `hardRequirements[]`, `softRequirements[]` | vincoli e preferenze |
| `requestedQuantity`, `unit` | quantità richiesta (non entra nell'identità) |
| `searchQueryChinese`, `searchQueryEnglish` | query per fonti cinesi e per fonti export |
| `confidence`, `warnings[]` | da 0 a 1, e i dubbi con codice tipizzato |

Claude **non inventa**: ciò che la riga non dice torna `null`. Una misura senza
unità (`60*60`) resta senza unità, con un warning `AMBIGUOUS_UNIT` e confidenza
più bassa. La riga originale resta sempre integra a database.

Il servizio è isolato in `apps/api/src/analysis/claude-product-analysis.service.ts`
e nessun controller o componente React parla con Claude. La chiave sta solo nel
backend (`CLAUDE_API_KEY`, in alternativa `ANTHROPIC_API_KEY`) e non compare mai
in una risposta API, in un log o a database.

**Cosa viene inviato**: nome, specifiche, utilizzo, quantità, unità, titolo già
indicato, link. Richiedente (`申请人`), reparto, centro di costo, firme e prezzi
interni non hanno un campo in cui entrare, quindi non escono dal server.

### 2. Identità a tre livelli

L'impronta unica non bastava: non sapeva distinguere «variante nuova di un
prodotto che conosciamo» da «prodotto mai visto». I livelli sono tre
(`packages/shared/src/scouting/product-identity.ts`):

- **`familyKey`** — stessa famiglia. È l'unico giudizio semantico (di Claude):
  che `陶瓷针规` e `ceramic pin gauge` siano la stessa cosa non si deduce da una
  regola sui caratteri. Normalizzato a slug leggibile.
- **`variantKey`** — `famiglia:hash` della configurazione tecnica: modello,
  materiale, colore, misure, specifiche obbligatorie (tensione, potenza,
  capacità, peso…), accessori inclusi. **Decide il riuso.**
- **`duplicateKey`** — `variantKey:hash` con in più i vincoli obbligatori. Due
  righe con la stessa `duplicateKey` sono la stessa domanda scritta due volte.

Le ultime due sono **deterministiche**: numeri convertiti in unità base, liste
ordinate, testi normalizzati. Quantità richiesta, unità d'acquisto, reparto e
richiedente non entrano in nessuna delle tre.

```
陶瓷针规 5.00mm  ==  陶瓷针规 5mm      stessa variante (5.00 → 5)
陶瓷针规 5mm     !=  陶瓷针规 6mm      stessa famiglia, varianti diverse
平板灯 60*60     !=  平板灯 30*30      varianti diverse anche senza unità
砝码 M1镀铬400g  !=  砝码 M1镀铬600g   400 g → 0.4 kg, 600 g → 0.6 kg
1.5 m            ==  1500 mm           unità base
```

### 3. Controllo nel database

Cercata la `variantKey`, i casi sono tre:

- **A — variante esatta conosciuta.** Non si ricerca subito. Si **riaprono i
  link già noti** e si aggiornano prezzo, valuta, disponibilità, MOQ, variante,
  venditore e data di controllo; poi si decide (sotto).
- **B — famiglia conosciuta, variante nuova.** Le query già usate sulla
  famiglia tornano come punto di partenza, ma la nuova variante viene verificata
  per conto suo: il risultato della variante precedente non si riusa mai.
- **C — prodotto nuovo.** Ricerca multi-marketplace completa, query cinese sulle
  fonti cinesi (Taobao, Tmall, Chinagoods, Yiwugo) e query inglese sulle fonti
  export (Alibaba, AliExpress, Made-in-China).

### 4. Quando un prodotto noto non vale più

Un vecchio link non è valido per sempre. Si rifà la ricerca completa quando:
il link non risponde, il prodotto è stato rimosso, la variante richiesta non è
più disponibile, il prodotto non rispetta più un vincolo obbligatorio
(`HARD_CONSTRAINT`), il prezzo non è recuperabile, la verifica è troppo vecchia,
il prezzo supera la soglia di variazione, il venditore non c'è più, o i prodotti
ancora validi sono meno del minimo richiesto.

Soglie configurabili: `SCOUTING_PRODUCT_CACHE_HOURS` (336),
`SCOUTING_MAX_PRICE_CHANGE_PCT` (25), `SCOUTING_MIN_VALID_CANDIDATES` (2),
`SCOUTING_FULL_SEARCH_ON_ERROR` (1). Ogni riga registra **perché** è stata
riusata o rifatta (`ImportJobRow.reuseReason`).

### 5. Revisione: «Analisi richieste con IA»

Dopo il caricamento l'interfaccia mostra, per ogni riga: testo originale,
famiglia, variante, nome cinese e inglese, modello, misure, specifiche
obbligatorie, query nelle due lingue, confidenza, warning e stato nel database.

Stati: *Nuovo prodotto*, *Variante nuova*, *Prodotto già conosciuto*,
*Da verificare*, *Analisi IA fallita*, *Pronto per la ricerca*.

Tutti i campi sono correggibili a mano; correggere ricalcola le chiavi e rilegge
lo stato nel database. **Le righe con confidenza sotto la soglia o con warning
critici non partono automaticamente**: vanno confermate. Il job ammette
esattamente ciò che la revisione mostra come pronto.

### 6. Quanto costa, e perche costa poco

Sul file reale da 498 righe l'analisi completa costa **circa $2,70** — era
$7,90 prima delle ottimizzazioni. Le tre leve, in ordine di peso:

- **Righe gemelle analizzate una volta sola.** Nei fogli reali meta delle
  righe sono ripetute (un foglio di riepilogo che ricopia i reparti): 496
  righe, 248 richieste uniche. La cache a database non bastava, perche dentro
  una singola esecuzione le righe partono insieme e nessuna ha ancora scritto
  il proprio risultato.
- **Lotti da 10 invece che da 5.** Il prompt di sistema pesa ~2000 token e si
  paga a ogni chiamata: erano 400 token di sola intestazione per riga.
- **`effort: low`.** Su dieci righe reali ha prodotto le stesse famiglie, le
  stesse varianti e gli stessi avvertimenti di `high`, con le confidenze entro
  0,05 e un terzo dei token di ragionamento. L'estrazione strutturata non e un
  compito di ragionamento.

Il prompt di sistema (2035 token) resta **sotto la soglia di 4096** oltre la
quale Opus 4.8 accetta la cache dei prompt: attivarla non avrebbe alcun
effetto, e va saputo prima di provarci.

Rianalizzare un file gia analizzato costa **zero**: le analisi sono in cache
per (riga, versione prompt, modello).

### 7. Memoria del sistema

Sta a database, non nella conversazione. `RequestAnalysis` conserva il risultato
strutturato, la versione del prompt, il modello, le chiavi, le query generate e
il consumo; `AnalysisRunRow` conserva le correzioni manuali e lo stato.

Prima di chiamare l'API si cerca la stessa riga normalizzata analizzata con la
stessa versione del prompt e lo stesso modello: se c'è, **la chiamata non si
fa**. Cambiare `ANALYSIS_PROMPT_VERSION` invalida la cache invece di sporcarla.

### 8. Affidabilità

Output solo JSON validato Zod; al massimo **un** nuovo tentativo per riga (il
secondo giro è riga per riga, così un lotto troppo grande non blocca nessuno);
errore salvato e stato *Analisi IA fallita*, senza fermare le altre righe.
Concorrenza limitata, timeout, cache, conteggio di chiamate, token e costo
stimato. Le righe viaggiano a lotti ma ogni risultato torna etichettato con il
proprio indice: l'ordine dell'array non viene mai usato per l'associazione.

## Pipeline

```
POST /api/quotes (messaggio libero)
  │
  ▼
[quote-parse]      Claude: messaggio → lista strutturata + query EN/ZH
  │                (BullMQ, retry 3x)
  ▼
[item-search]      fan-out: 1 job per articolo × marketplace (Playwright)
  │                (retry 3x, ignoreDependencyOnFailure)
  ▼
[item-select]      fan-in per articolo: Claude sceglie i 2-3 candidati
  │                migliori, poi getDetails() → prezzo/MOQ/variante/immagine
  ▼
[quote-assemble]   fan-in finale: ricarico % → preventivo in DB → READY
```

Il fan-out/fan-in è un **BullMQ Flow** costruito dal job di parse (il numero
di figli è noto solo dopo il parsing). L'avanzamento viene pubblicato su Redis
pub/sub e arriva alla dashboard via **SSE** (`GET /api/quotes/:id/events`).
Se un marketplace o un articolo fallisce dopo tutti i retry, il preventivo
esce comunque con ciò che è stato trovato (`ignoreDependencyOnFailure`).

## Struttura del monorepo (pnpm + Turborepo)

| Percorso | Cosa contiene |
|---|---|
| `packages/shared` | Schemi Zod condivisi (parsing, marketplace, preventivo), nomi code e tipi eventi |
| `packages/db` | Prisma 7 + PostgreSQL (schema, client singleton con adapter pg) |
| `packages/ai` | Chiamate Claude con output JSON strutturato: parsing, query EN/ZH, matching |
| `packages/adapters` | `MarketplaceAdapter` + registry: `mock`, `alibaba`, `aliexpress`, `made-in-china`, `chinagoods`, `yiwugo` |
| `apps/api` | NestJS: REST + SSE (porta 3021, prefix `/api`) |
| `apps/worker` | Worker BullMQ separato con Playwright (parse/search/select/assemble) |
| `apps/web` | Dashboard Next.js (porta 3020) |

### Aggiungere un marketplace

1. `packages/adapters/src/adapters/<nome>.ts` implementando `MarketplaceAdapter`:
   ```ts
   interface MarketplaceAdapter {
     search(query: SearchQuery): Promise<ProductCandidate[]>;
     getDetails(productId: string): Promise<ProductDetails>;
   }
   ```
2. Registralo in `packages/adapters/src/registry.ts` (nome + lingue `en`/`zh`).
3. Aggiungi il nome a `MARKETPLACES` nel `.env`. Nient'altro cambia.

`productId` è opaco e scoped all'adapter (per gli scraper è l'URL prodotto).

## Setup

Prerequisiti già installati su questo server: Node 22, pnpm 9 (corepack),
Redis (`redis-server`), PostgreSQL (db `china_sourcing`, utente `china`).

```bash
cd /var/www/china
cp .env.example .env          # poi compila ANTHROPIC_API_KEY
pnpm install
pnpm db:push                  # sincronizza lo schema Prisma con Postgres
pnpm build                    # compila tutto (turbo)
```

Per lo scraping reale serve il browser Playwright (non necessario in mock):

```bash
pnpm --filter @china/adapters exec playwright install --with-deps chromium
```

## Avvio

```bash
# Sviluppo (watch su tutto)
pnpm dev

# Produzione (dopo pnpm build)
pnpm start:api      # http://localhost:3021/api
pnpm start:worker
pnpm start:web      # http://localhost:3020
```

## Modalità mock (testare senza costi)

Nel `.env`:

- `AI_MOCK=1` → salta le chiamate Claude (parser/matcher finti);
- `MARKETPLACES=mock` → adapter deterministico senza rete né browser.

Con entrambi attivi l'intera pipeline (code, flow, retry, SSE, preventivo)
gira offline. Verificato: POST → READY con 3 articoli in ~4 secondi.

In produzione: `AI_MOCK=0`, `ANTHROPIC_API_KEY` valorizzata; configura
`MARKETPLACES` solo per le fonti richieste dalla pipeline legacy.

## API

| Metodo | Rotta | Descrizione |
|---|---|---|
| `GET` | `/api/search` | ricerca filtrata su una fonte; supporta `quality=strict\|balanced\|broad` |
| `GET` | `/api/search/health` | stato trasporti, code, cache e circuit breaker delle fonti |
| `POST` | `/api/v1/searches` | ricerca multi-motore coordinata, ordinata e deduplicata |
| `GET` | `/api/inquiry/sources` | fogli di richiesta disponibili in `data/inquiries/` |
| `GET` | `/api/inquiry/rows` | righe e query cinesi di un foglio (`source`, `sheet`) |
| `POST` | `/api/inquiry/import` | importa un foglio caricato (corpo = file binario) |
| `POST` | `/api/quotes` | `{ text, markupPct? }` → `{ id }` (validazione Zod) |
| `GET` | `/api/quotes` | ultime 50 richieste |
| `GET` | `/api/quotes/:id` | dettaglio: articoli, candidati selezionati, preventivo |
| `GET` | `/api/quotes/:id/events` | SSE: `request_status`, `item_status`, `log`, `quote_ready` |
| `GET` | `/api/scouting/analysis/status` | chiave configurata (mai il valore), modello, versione prompt |
| `POST` | `/api/scouting/datasets/:id/analysis` | analizza il file con Claude e apre la revisione |
| `GET` | `/api/scouting/datasets/:id/analysis` | sessioni di analisi gia fatte sul file |
| `GET` | `/api/scouting/analysis/:runId` | righe, identita, stato nel database, consumo |
| `PATCH` | `/api/scouting/analysis/rows/:rowId` | correzione manuale di una riga (`approve` per confermarla) |
| `POST` | `/api/scouting/datasets/:id/jobs` | avvia lo scouting (`analysisRunId` per partire dalla revisione) |

## Note e limiti noti

- **Scraping**: i selettori dei marketplace cambiano e alcuni siti applicano
  anti-bot (captcha). Ogni adapter distingue un vero zero risultati da blocchi
  e layout non riconosciuti; l'errore resta isolato. Per volumi seri usare API
  ufficiali o un provider autorizzato.
- **1688 e altri provider OTAPI**: le query in cinese vengono già generate e
  salvate (`queryZh`), ma sull'istanza corrente `Alibaba1688`, `Jd`,
  `Pinduoduo`, `Alibaba`, `Aliexpress`, `MadeInChina` e `Temu` non sono
  abilitati. Dopo l'attivazione si possono collegare allo stesso provider API
  senza esporre nuove chiavi al frontend.
- **Valuta**: i prezzi sono presi così come esposti (di norma USD); la
  conversione EUR e i costi di spedizione/dazi non sono ancora calcolati.
- **Modello Claude**: `claude-opus-4-8` (override con `CLAUDE_MODEL` nel .env).
- **Prisma 7**: la connection URL sta in `packages/db/prisma.config.ts`
  (legge il `.env` di root via symlink `packages/db/.env`).

## Deploy (bozza systemd, stesso pattern di menu-digitale)

```ini
# /etc/systemd/system/china-api.service
[Unit]
Description=China Sourcing API
After=network.target postgresql.service redis-server.service

[Service]
WorkingDirectory=/var/www/china/apps/api
ExecStart=/usr/bin/node dist/main.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Analoghi `china-worker.service` (`apps/worker`) e `china-web.service`
(`pnpm start` in `apps/web`). Nginx: proxy verso 3020 (web) e 3021 (api),
ricordando `proxy_buffering off;` sulla location SSE.
