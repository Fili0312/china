# China Sourcing

Scouting di prodotti su Taobao per cliente: carichi il foglio di richiesta,
l'IA interpreta ogni riga, si cerca su Taobao e si esporta il risultato — con
i tre migliori link e i prezzi già ricaricati — in un Excel pronto da inoltrare.

## Stato: una pagina sola (2026-07-26)

**Le pagine in linea sono due**, e servono due modi di lavorare:
`/china/scouting-v2` (carichi il foglio, il resto va da solo) e
`/china/scouting-v1` (ogni passo a mano, per capire *perché* il sistema ha
deciso una certa cosa). La radice `/china` reindirizza alla v1; `/scraping`,
`/scouting`, `/legacy` e `/quotes/:id` rispondono 404 e i loro moduli non sono
più registrati nell'API.

Cosa è stato ritirato, e perché il codice è ancora qui:

| Cosa | Stato | Dove |
| --- | --- | --- |
| Quotazione automatica da foglio | **in linea** | `/china/scouting-v2` |
| Scouting Taobao passo per passo | **in linea** | `/china/scouting-v1` |
| Ricerca diretta OTAPI, ricerca multi-motore, richieste da Excel | ritirate | `apps/api/src/{search,inquiry}` — non registrate in `app.module.ts` |
| Scouting multi-marketplace | ritirato | `apps/api/src/scouting` — `TaobaoModule` ne usa ancora tre file (fogli Excel, normalizzazione, crittografia sessioni) |
| Preventivi Playwright | ritirato | `apps/api/src/quotes` + `apps/worker` — servizio `china-worker` fermo e disabilitato |

Le sezioni marcate **[ritirata]** più sotto descrivono flussi non più
raggiungibili: restano perché rimetterne uno in linea è una riga di `imports`
in `app.module.ts` più il ripristino della pagina, non un recupero da git.

## Lingue: inglese predefinito, cinese e italiano

L'interfaccia parla tre lingue e parte in **inglese**. Il selettore è in alto a
destra; la scelta finisce in `localStorage` e sopravvive al reload.

- **Interfaccia** — `apps/web/app/i18n/`. `messages-en.ts` è la sorgente di
  verità delle chiavi: `messages-zh.ts` e `messages-it.ts` sono tipizzati su di
  essa, quindi una chiave aggiunta e non tradotta non compila. `t()` restituisce
  testo, `tr()` interpreta `<strong>` senza passare da `innerHTML`.
- **Etichette condivise** — `packages/shared/src/schemas/{taobao,analysis}.ts`.
  Sono `Localized<T>` (`{ en, zh, it }`) perché servono sia alla pagina sia ai
  fogli Excel generati dall'API.
- **API** — `apps/api/src/i18n/`. Un middleware apre un `AsyncLocalStorage` per
  richiesta, così `t()` funziona a qualsiasi profondità senza passare `locale`
  di servizio in servizio. La lingua si ricava da `?lang=` (vince, perché lo
  mettono i link di download) o da `Accept-Language`.
- **Fuori da una richiesta** — i job di ricerca girano dopo che la risposta è
  partita: `currentLocale()` ricade sul predefinito, e i testi che il runner
  salva nel database (`reuseReason`, `shipping`) restano in inglese.

**Resta in italiano** ciò che scrive Claude: i verdetti di coerenza
(`issues`), le domande di chiarimento e `productFamily`. I prompt in
`packages/ai/src/{verify-coherence,analyze-products}.ts` lo impongono
esplicitamente; cambiarli richiede di ri-testare con chiamate a pagamento.

## [ritirata] Modalità ricerca diretta (2026-07-19)

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

## [ritirata] Richieste da foglio Excel (`/scraping`, 2026-07-20)

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

## [ritirato] Scouting da Excel con analisi IA (`/scouting`, 2026-07-21)

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

## Scouting v1: solo Taobao, per cliente (`/scouting-v1`) — **la pagina in linea**

Il cliente cerca i prodotti **principalmente su Taobao**, quindi questa versione
usa Taobao e basta: Alibaba, AliExpress, Yiwugo, Chinagoods e Made-in-China sono
in pausa e non compaiono. Lo scouting multi-marketplace resta intatto su
`/scouting`: le due pagine non condividono né tabelle né identità, e una
modifica qui non può romperlo.

Il flusso:

```
cliente → caricamento Excel → normalizzazione righe → analisi IA (cache)
  → revisione umana → controllo in memoria (variante conosciuta?)
      → sì : riapri i prodotti noti, aggiorna prezzo e disponibilità
      → no : ricerca Taobao API (+ Playwright se l'account è collegato)
  → unione e deduplica → salvataggio per cliente/variante → export Excel
```

### Clienti: cosa vede chi

Ogni file, analisi e ricerca appartiene a un cliente, e **tutte** le rotte
client-scoped vivono sotto `/api/taobao/clients/:clientId/`: non esiste un
endpoint che restituisca un file o una ricerca conoscendone solo l'id. Restano
salvati cliente, nome file, data, righe originali, richieste analizzate,
prodotti cercati, candidati, prodotti scelti, prezzi e storico.

La **memoria dei prodotti è condivisa** fra clienti — `TaobaoRequest` e
`TaobaoProduct` — perché è ciò che evita di ricercare (e ripagare) due volte lo
stesso pezzo. Non è mai esposta direttamente: un cliente la vede solo
attraverso le righe di job che ha chiesto lui.

### La correzione dei falsi duplicati

L'identità a tre livelli (famiglia, variante, duplicato) resta, ma la chiave di
variante non dipende più **soltanto** dai campi che il modello estrae. Se
l'analisi perde una misura — perché era attaccata al nome, perché la riga era
scritta male — due prodotti diversi finivano con la stessa chiave: si cercava
solo il primo e si consegnavano i suoi prodotti anche per il secondo, senza che
comparisse alcun errore.

Ora dal testo originale si estraggono in modo deterministico misure con unità,
gruppi di quote (`60*60`) e codici (`M8*35`, `DJM-050-485`), e ciò che i campi
strutturati non coprono entra nella chiave come **residuo**
(`packages/shared/src/scouting/variant-signature.ts`). Le proprietà:

| Caso | Esito |
| --- | --- |
| `陶瓷针规 5mm` / `陶瓷针规 5.00mm` | stessa variante (duplicato reale) |
| `陶瓷针规 5mm` / `陶瓷针规 6mm` | varianti diverse **anche senza misure estratte** |
| `平板灯 60*60` / `平板灯 30*30` | varianti diverse anche senza unità |
| `砝码 M1镀铬400g` / `600g` | varianti diverse (400 g → 0.4 kg, 600 g → 0.6 kg) |
| `电缆扎带` / `电缆扎带 -20个` | stessa variante: la quantità non è una caratteristica |

Quando l'estrazione è completa il residuo è vuoto e l'identità è esattamente
quella di prima: la rete interviene solo dove prima si perdeva qualcosa. La
revisione mostra il residuo, così «perché queste due righe non sono la stessa
richiesta?» ha una risposta visibile.

### Cosa ferma una riga (e cosa no)

Il cancello della revisione ha un criterio solo: **si sa quale prodotto
cercare?** Una riga si ferma quando non ha query cinese, quando contiene più
prodotti (`MULTIPLE_PRODUCTS`), o quando la confidenza è sotto
`TAOBAO_MIN_CONFIDENCE` (0,45 — la soglia sotto cui il prompt stesso dice «non
sei sicuro di quale prodotto si tratti»).

Una **misura senza unità non ferma niente**: la query parte come testo cinese
originale (`平板灯 60*60` è ciò che digiterebbe un compratore), quindi
l'ambiguità non cambia *cosa* si cerca. Sposta il punteggio, e resta scritta
come avviso accanto al prodotto trovato — dove l'operatore la vede insieme al
risultato invece che al posto suo.

Misurato sul file reale da 498 righe:

| | Prima | Dopo |
|---|---:|---:|
| Righe ferme in revisione | 135 | **4** |
| Analisi fallite | 2 | **0** |
| Righe pronte | 361 | **494** |
| Righe con avvisi (segnalate, non bloccanti) | — | 107 |

Le 4 righe che restano sono 2 richieste distinte ripetute: in entrambe il nome
e il titolo del link indicano prodotti diversi (`铁垫片` di ferro contro un
titolo in acciaio inox 304; `批头 S2H2.5` singolo contro un set completo).
Sono esattamente i casi in cui cercarne uno solo sarebbe una risposta sbagliata
data con sicurezza. La regola vive in `review-gate.ts` ed è coperta da test.

**Il blocco di condivisione di Taobao viene recuperato.** Quando qualcuno
incolla in una colonna qualsiasi il testo che Taobao mette negli appunti —
`淘宝】https://e.tb.cn/… 「欧普护眼灯LED…」 点击链接直接打开` — la riga
risultava «senza nome prodotto» e veniva saltata, pur essendo la più
informativa del foglio. Ora titolo e link vengono estratti
(`share-text.ts`), il contorno («点击链接直接打开», il codice `tk=`) viene
tolto, e la riga entra nella ricerca come tutte le altre.

### Costo dell'analisi

Stesso servizio Claude di `/scouting`, quindi stessa cache: prima di chiamare si
cerca la riga normalizzata già analizzata con la stessa versione di prompt e lo
stesso modello, le righe gemelle di un file vengono analizzate una volta sola, i
lotti sono da 10 e l'effort è `low`. Un file già analizzato nell'altra pagina
qui costa **zero**. Claude struttura la richiesta e nient'altro: **non sceglie
il prodotto vincitore**.

⚠️ **La chiave della cache è il testo inviato, che dipende dalla mappatura
delle colonne.** Rianalizzare lo stesso file con una mappatura diversa (una
colonna in più o in meno) cambia il testo di quelle righe e le fa ripagare.
Sul file da 498 righe: stessa mappatura ≈ $0,01, mappatura cambiata $0,88.
Conviene confermare la mappatura una volta e non toccarla più.

### Account Taobao

Sezione «Account Taobao» nella pagina. Il collegamento è manuale: l'utente fa il
login su Taobao nel proprio browser ed esporta i cookie in JSON. Il sistema non
riceve né conserva username, password, SMS o captcha — non c'è un campo in cui
possano entrare. I cookie sono cifrati AES-256-GCM
(`SCOUTING_SESSION_SECRET`), non tornano mai da un'API e non finiscono nei log;
l'interfaccia mostra solo collegato/non collegato, scadenza, ultimo utilizzo e i
pulsanti riconnetti/scollega. Sono usati esclusivamente dal contesto Playwright.

Le verifiche anti-bot **non si aggirano**: quando Taobao ne mostra una la riga
riporta «Verifica richiesta su Taobao: completa il controllo manualmente e
riprendi» e la ricerca browser si ferma per qualche minuto invece di insistere.

### I due trasporti

**API — Taobao DataHub su RapidAPI.** Ordine di chiamata pensato sui crediti:
ricerca per parola chiave una volta per `variantKey`; dettaglio solo sui primi
candidati; recensioni solo sui finalisti e solo se richieste. Ogni risposta
finisce in `TaobaoApiCache` (chiave = endpoint + parametri), quindi la stessa
domanda non si ripaga entro la TTL. La chiave sta solo nel backend.

Endpoint **verificati sulla sottoscrizione reale** il 2026-07-22: il percorso
è l'endpoint stesso e non esiste nessun parametro `api=`.

| Uso | Percorso | Note |
|---|---|---|
| Ricerca | `/item_search` | parametro `q`; `keyword` viene rifiutato (codice 4008) |
| Dettaglio | `/item_detail` | parametro `itemId` numerico |
| Recensioni | `/item_review` | usato solo sui finalisti, se richiesto |
| Spedizione | — | **nessun endpoint**, e non serve: provenienza e costo arrivano già dentro la ricerca (`delivery.shippingFrom`, `deliveryFee`) |

Due trappole trovate collegando la chiave, entrambe corrette:

- **`/item_search_x` non va usato.** Restituisce `itemIdStr`, un token cifrato
  che **cambia a ogni richiesta** (misurato: 20 risultati su 20 diversi fra due
  chiamate identiche). Come identità farebbe apparire nuovo ogni prodotto a
  ogni ricerca, azzerando deduplica, memoria e storico prezzi. `/item_search`
  restituisce l'`itemId` numerico e l'`itemUrl` canonico, che è esattamente ciò
  su cui poggia tutto il resto.
- **Il fornitore risponde `200` anche quando fallisce**: l'esito vero sta in
  `result.status.code`. Senza controllarlo, una chiave scaduta o un parametro
  sbagliato sembrerebbero «nessun prodotto trovato» — il modo più efficace di
  cercare a vuoto per ore senza accorgersene. Il codice `205` («nessun
  risultato») resta invece una risposta legittima.

**Query troppo specifiche.** Taobao combina i termini in AND: `珍珠白4层货架
加厚中型 200*40*140 300KG/层` descrive benissimo lo scaffale e non trova
niente. La ricerca prova in ordine la query intera, poi metà termini, poi il
solo nome prodotto, e si ferma al primo tentativo che trova qualcosa
(`query-ladder.ts`). Una riga precisa costa una chiamata; solo le righe
difficili ne costano due o tre, e la scala è deterministica, quindi la cache la
riconosce. La query che ha davvero funzionato viene salvata sul prodotto e
mostrata nei risultati.

**ElimAPI — la seconda fonte (`openapi.elim.asia`).** Interviene quando
DataHub non basta: errore, limite raggiunto, o meno di `ELIM_MIN_RESULTS` (3)
risultati. Non è ridondanza — sono due fornitori con cataloghi diversi, e la
riga che l'uno non trova spesso l'altro la trova.

Endpoint e parametri **verificati** contro lo Swagger ufficiale (`/api-json`) e
con chiamate reali il 2026-07-22:

| | |
|---|---|
| Endpoint | **`POST /v1/products/search`** — è una POST, non una GET, e risponde **201** |
| Autenticazione | header `x-api-key` (la chiave sta solo nel backend) |
| Parametri obbligatori | `q`, `platform`, `page`, `size` |
| `platform` | `taobao` \| **`alibaba`** — e `alibaba` **è 1688**: i link tornano `detail.1688.com` |
| `lang` | `vi` (predefinito) \| `en` — si usa `en`, così al titolo cinese si aggiunge `titleEn` |
| `sort` | `PRICE_ASC`, `PRICE_DESC`, `SALE_QTY_ASC`, `SALE_QTY_DESC`, `RETENTION_ASC`, `RETENTION_DESC` |

Due trappole trovate provando davvero:

- **`/item_search_x`… no: qui è `itemIdStr`.** L'endpoint restituisce sia `id`
  (numerico, stabile) sia `mi_id`/`itemIdStr`. Solo il primo è utilizzabile
  come identità.
- **Lo Swagger e la risposta divergono**: lo schema dichiara
  `whosesale_price`, la risposta manda `wholesale_price`, e `seller_name`,
  `promotion_displays`, `promotion_url` non sono documentati ma arrivano. Dove
  divergono, vince ciò che arriva.

**1688 non è una riserva**: è un catalogo all'ingrosso, con prezzi e minimi
d'ordine diversi. Chi lo attiva vuole quei prezzi, quindi parte quando è
richiesto, indipendentemente da come è andata la prima fonte. Su Taobao invece
ElimAPI parte **solo** se DataHub non è bastato: chiamarla comunque sarebbe
pagare due volte lo stesso catalogo.

**MOQ e SKU non sono nella ricerca**: stanno solo in `POST /v1/products/detail`.
Restano nulli invece di essere dedotti da `quantity`, che è la disponibilità —
un minimo d'ordine inventato farebbe comprare sulla base di un numero falso.

Il piano gratuito include 200 richieste al mese: per questo ogni risposta va in
cache per `variantKey` (chiave = piattaforma + parametri) e
`GET /api/taobao/elim/plan` dice quante ne restano, invece di scoprirlo con un
402 a metà di un file.

**Playwright autenticato.** Si aggiunge quando l'account è collegato e porta
quello che vede un compratore reale: prezzo, prezzo variante, vendite,
recensioni, negozio, id, link, spedizione. Senza account la ricerca usa solo
l'API e l'interfaccia dice «Collega Taobao per aggiungere i risultati della
ricerca browser». **Un errore Playwright non annulla i risultati API**: l'esito
è registrato separatamente per trasporto.

### Unione e classifica

Si fondono DataHub, ElimAPI (Taobao e 1688), Playwright, link già presenti
nell'Excel e memoria. La deduplica usa **piattaforma + `itemId`** — gli
identificativi sono numerici su entrambi i marketplace e niente garantisce che
non collidano — e quindi anche l'URL canonico, che dà lo stesso id;
poi SKU e venditore+titolo+prezzo insieme: **il titolo da solo non basta mai**,
perché su Taobao decine di venditori copiano la stessa riga. Ogni candidato
conserva le provenienze; quando due fonti non concordano su prezzo o
disponibilità la differenza diventa un avviso invece di una scelta silenziosa.

L'ordinamento è **prima la compatibilità tecnica**, poi prezzo, vendite e
recensioni — e solo fra prodotti nella stessa fascia di compatibilità. Nessun
prodotto viene eletto vincitore: ogni scheda mostra requisiti soddisfatti,
requisiti mancanti e avvisi, e la scelta resta all'operatore.

### Storico: cosa si può riaprire

Niente va rifatto due volte, e riaprire non costa mai crediti.

- **Ricerche già fatte** — il pannello «Storico» elenca tutte le ricerche del
  cliente con data, file, righe elaborate e consumo; «riapri» ricarica i
  risultati salvati (`GET .../jobs`, `.../jobs/:id/results`), «Excel» li
  riscarica. Niente viene richiamato: né Claude né RapidAPI.
- **Revisioni già fatte** — per il file aperto si elencano le sessioni di
  analisi con data, righe e costo; riaprirne una rimette in piedi la revisione
  senza rianalizzare.
- **Rilancio di una ricerca** — dalla ricerca aperta si rifà la ricerca
  interrogando di nuovo la fonte (`POST .../jobs/:id/rerun`), scegliendo
  l'ambito: **tutte** le righe, **solo quelle in errore**, **solo quelle senza
  risultati**. Il contatore accanto a ogni voce dice quante righe rientrano,
  così non si lancia su un ambito vuoto. Nasce da un caso concreto: 118 righe
  fallite perché `RAPIDAPI_KEY` non era configurata — ricaricare il file e
  rianalizzarlo per rifarle sarebbe costato una seconda analisi completa,
  mentre l'unica cosa mancata era la ricerca.

  Il rilancio crea un job **nuovo** invece di riscrivere quello vecchio: lo
  storico resta leggibile («questa ha fallito, questa l'ha rifatta») e i due
  risultati si confrontano. Eredita la configurazione — mappatura, candidati,
  dettagli, recensioni — e ignora la memoria (`forceFullSearch`), perché chi
  rilancia vuole interrogare la fonte, non rileggere quello che c'era già. La
  revisione viene riletta: le righe confermate a mano nel frattempo entrano nel
  nuovo job anche se in quello precedente erano saltate.

- **Storico prezzi di un prodotto** — ogni scheda ha «storico prezzi»
  (`GET .../products/:id/history`): quando è cambiato e cosa, con il valore
  **precedente** accanto a ogni riga. Si carica solo quando lo si apre, perché
  chiederlo per ogni scheda sarebbe decine di richieste per prodotti che
  nessuno guarderà.

Lo storico prezzi registra i **cambiamenti**, non i controlli: un prodotto
riletto dieci volte senza variazioni non produce nessuna riga, e la scheda lo
dice («nessun cambiamento registrato», con le date di primo avvistamento e
ultimo controllo). L'appartenenza si verifica per risultato e non per prodotto:
la memoria è condivisa fra clienti, quindi un cliente vede lo storico solo dei
prodotti che una **sua** ricerca ha proposto.

### Quando un prodotto noto non vale più

Si rifà la ricerca completa quando i link non rispondono, il prodotto non è
disponibile, la variante richiesta non c'è più, il prezzo non è recuperabile,
l'ultimo controllo è troppo vecchio, il prezzo è variato oltre la soglia o i
prodotti validi sono meno del minimo. Soglie:
`TAOBAO_PRODUCT_CACHE_HOURS` (336), `TAOBAO_MAX_PRICE_CHANGE_PCT` (25),
`TAOBAO_MIN_VALID_PRODUCTS` (2). Ogni riga registra **perché** è stata riusata
o rifatta.

### Variabili d'ambiente

| Variabile | Default | A cosa serve |
| --- | --- | --- |
| `RAPIDAPI_KEY` | — | Chiave RapidAPI. Senza, la ricerca API non è disponibile (nessun risultato simulato). |
| `TAOBAO_DATAHUB_HOST` | `taobao-datahub.p.rapidapi.com` | Host del fornitore |
| `TAOBAO_DATAHUB_{SEARCH,DETAIL,REVIEW}_PATH` | `/item_search`, `/item_detail`, `/item_review` | Percorso dell'endpoint (verificato) |
| `TAOBAO_DATAHUB_*_API` | vuoto | Valore di `api=` per i fornitori con path unico. **Vuoto = non inviare il parametro**, che è il caso di questa sottoscrizione |
| `TAOBAO_DATAHUB_QUERY_PARAM` | `q` | Nome del parametro della query |
| `TAOBAO_DATAHUB_ITEM_PARAM` | `itemId` | Nome del parametro dell'id prodotto |
| `TAOBAO_DATAHUB_CACHE_HOURS` | `168` | TTL della cache delle risposte |
| `TAOBAO_DATAHUB_TIMEOUT_MS` | `30000` | Timeout di una chiamata |
| `TAOBAO_BROWSER_TIMEOUT_MS` | `45000` | Timeout della ricerca Playwright |
| `TAOBAO_BROWSER_COOLDOWN_MS` | `900000` | Pausa dopo una verifica anti-bot |
| `TAOBAO_REFRESH_LIMIT` | `12` | Prodotti noti riletti per variante |
| `TAOBAO_MIN_CONFIDENCE` | `0.45` | Sotto questa confidenza la riga non parte da sola |
| `ELI_API` | — | Chiave ElimAPI, header `x-api-key`. Senza, la seconda fonte non è disponibile |
| `ELI_API_BASE_URL` | `https://openapi.elim.asia/v1` | Base dell'API |
| `ELIM_MIN_RESULTS` | `3` | Sotto questo numero di risultati DataHub «non basta» |
| `ELIM_CACHE_HOURS` | `168` | TTL della cache delle risposte ElimAPI |
| `ELIM_TIMEOUT_MS` | `30000` | Timeout di una chiamata |
| `ELIM_MAX_ATTEMPTS` | `2` | Tentativi: si ritenta 429 e rete, mai 401/402 |
| `ELIM_RETRY_MS` | `1500` | Attesa prima del secondo tentativo |
| `SCOUTING_SESSION_SECRET` | — | Cifratura dei cookie: senza, il collegamento è rifiutato |

I percorsi degli endpoint sono configurabili perché i fornitori RapidAPI li
cambiano fra una revisione e l'altra: una stringa sbagliata si corregge nel
`.env`, senza ricompilare. `GET /api/taobao/api/status` mostra quelli in uso.

## Scouting v2: il foglio entra, la quotazione esce (`/scouting-v2`, 2026-07-26)

La v1 è una sequenza di sette pulsanti — carica, analizza, conferma, cerca,
verifica, migliora, scarica — e ogni pulsante è una decisione presa a mano. La
v2 prende quelle decisioni da sola e chiede solo ciò che non può dedurre.

```
foglio  →  preventivo (tetti di spesa)  →  [ Avvia ]
                                              │
        ┌─────────────────────────────────────┘
        ▼
   analisi IA  ──┬─→ domande?  ── sì ──→  PAUSA, si chiede, si riparte
                 │                          (le risposte restano per sempre)
                 └─→ no
                     ▼
              conferma automatica delle righe
                     ▼
              ricerca su Taobao  (seguita riga per riga)
                     ▼
              verifica di coerenza IA
                     ▼
              ri-ricerca guidata  ×N, finché recupera  (N = 2 di serie)
                     ▼
              quotazione + elenco delle righe scoperte
```

### Perché lo stato sta nel database

`TaobaoPipeline` è una macchina a stati persistita: `phase` dice a che punto è
e `PipelineService.resume()` riparte da lì. Una corsa dura minuti e si ferma
nel mezzo per fare domande — scritta come una funzione lineare vivrebbe nello
stack di una richiesta HTTP, e chi chiude la scheda perderebbe l'analisi già
pagata. Riaprendo la pagina si ritrova il punto esatto: la v2 cerca da sé
l'ultima corsa viva del cliente e ci si riaggancia.

`PipelineService` **non contiene logica di dominio**. Chiama i servizi della
v1 e decide solo *cosa fare dopo*: una regola su come si cerca o come si
giudica un prodotto, scritta lì, sarebbe la seconda copia di una regola che
vive altrove.

### Le decisioni automatiche

| Decisione | Cosa fa | Perché |
|---|---|---|
| Mappatura colonne | accetta quella dedotta dalle intestazioni | senza colonna «nome prodotto» non parte affatto: è l'unico campo da cui esce una query |
| Domande | si ferma finché non si risponde, max 3 giri | senza risposta proseguirebbe indovinando, ed è ciò che rende inaffidabile una quotazione |
| Righe poco sicure | diventano domande | scelta di Filippo (2026-07-26): qualche attesa in più, nessuna riga cercata alla cieca |
| Righe ancora incerte dopo le domande | confermate e segnalate | una riga cercata con un avviso resta più utile di una riga assente |
| Ri-ricerca | insiste finché recupera, fino a `maxRefineRounds` | un giro che non recupera nulla dice che il problema non è la query: continuare spenderebbe soltanto |
| Verifica o ri-ricerca non disponibili | salta la fase, non fallisce | la ricerca è già pagata: buttarla per un controllo che è un di più sarebbe il danno peggiore |

### Il preventivo è un tetto, non una previsione

Prima di spendere si mostrano righe, prodotti distinti, **spesa massima** e
**chiamate massime**. Sono limiti superiori di proposito: ciò che abbatte il
costo — righe già analizzate, varianti già in memoria — dipende da chiavi che
esistono solo *dopo* l'analisi. Una prima versione provava a indovinarle con
due approssimazioni sul testo grezzo e su un foglio di prova ha annunciato «0
chiamate» per una corsa che poi ne ha fatte 64. Su una schermata di conferma
un numero al ribasso non è una stima imprecisa: è una promessa rotta.

### Avanzamento

`progress` è monotono e i pesi delle fasi non sono uguali
(`TAOBAO_PIPELINE_PHASE_WEIGHTS`: ricerca 45, analisi 25, verifica 12…): a fasi
uguali la barra starebbe ferma al 40% per il 90% del tempo. Il passo corrente
si salva come **codice** (`step.searchRows`) più i suoi valori, mai come frase:
il job gira fuori da una richiesta HTTP e non sa in che lingua legge chi
guarda. La frase la compone la pagina, in una delle tre lingue.

### API

| Metodo | Rotta | Descrizione |
|---|---|---|
| `GET` | `.../datasets/:datasetId/estimate` | tetti di spesa e mappatura dedotta, prima di spendere |
| `POST` | `.../datasets/:datasetId/pipeline` | avvia; ritorna subito, si segue con lo stato |
| `GET` | `.../pipelines` | ultime corse del cliente (per riagganciarsi) |
| `GET` | `.../pipelines/:id` | stato: fase, percentuale, passo, domande, esito |
| `POST` | `.../pipelines/:id/answers` | risponde alle domande e fa ripartire |
| `POST` | `.../pipelines/:id/cancel` | ferma; ciò che è stato trovato resta |


## [ritirata] Pipeline dei preventivi

Serviva `/legacy` e gira sul worker BullMQ, oggi fermo e disabilitato.

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
di figli è noto solo dopo il parsing). L'avanzamento veniva pubblicato su Redis
pub/sub e arrivava alla dashboard via **SSE** (`GET /api/quotes/:id/events`).
Se un marketplace o un articolo falliva dopo tutti i retry, il preventivo
usciva comunque con ciò che era stato trovato (`ignoreDependencyOnFailure`).

Per rimetterla in linea: `QuotesModule` negli `imports` di `app.module.ts`,
la pagina `/legacy` in `apps/web/app/`, poi
`systemctl enable --now china-worker`.

## Struttura del monorepo (pnpm + Turborepo)

| Percorso | Cosa contiene |
|---|---|
| `packages/shared` | Schemi Zod condivisi, elenco delle lingue (`i18n/locale.ts`), etichette tradotte, nomi code e tipi eventi |
| `packages/db` | Prisma 7 + PostgreSQL (schema, client singleton con adapter pg) |
| `packages/ai` | Chiamate Claude/DeepSeek con output JSON strutturato: analisi righe, coerenza, riscrittura query |
| `packages/adapters` | `MarketplaceAdapter` + registry: `mock`, `alibaba`, `aliexpress`, `made-in-china`, `chinagoods`, `yiwugo` — usati solo dai flussi ritirati |
| `apps/api` | NestJS: REST (porta 3021, prefix `/api`). In linea solo `TaobaoModule`; `i18n/` tiene lingua di richiesta e messaggi |
| `apps/worker` | Worker BullMQ con Playwright — **fermo e disabilitato** |
| `apps/web` | Dashboard Next.js (porta 3020, basePath `/china`). Due rotte: `/` reindirizza, `/scouting-v1` è la pagina |

### Aggiungere un marketplace

Riguarda i flussi ritirati; lo scouting v1 non passa dagli adapter.

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

### Aggiungere una lingua

1. Aggiungila a `LOCALES` in `packages/shared/src/i18n/locale.ts`.
2. Il compilatore segnala ogni mappa `Localized<T>` e ogni dizionario
   incompleto: `packages/shared/src/schemas/{taobao,analysis}.ts`,
   `apps/web/app/i18n/messages-*.ts`, `apps/api/src/i18n/messages.ts`.
3. Aggiungi nome, etichetta corta e locale BCP 47 in
   `apps/web/app/i18n/locale.ts`. Il selettore si aggiorna da solo.

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

Lo scouting v1 non usa Playwright: il browser serve solo ai flussi ritirati.

```bash
pnpm --filter @china/adapters exec playwright install --with-deps chromium
```

## Avvio

```bash
# Sviluppo (watch su tutto)
pnpm dev

# Produzione (dopo pnpm build)
pnpm start:api      # http://localhost:3021/api
pnpm start:web      # http://localhost:3020
pnpm start:worker   # solo se si riattiva la pipeline dei preventivi
```

Test: `pnpm test` (343 test, nessuna chiamata di rete).

## Modalità mock (testare senza costi)

Nel `.env`:

- `AI_MOCK=1` → salta le chiamate Claude (parser/matcher finti);
- `MARKETPLACES=mock` → adapter deterministico senza rete né browser.

Con entrambi attivi la pipeline dei preventivi gira offline. In produzione:
`AI_MOCK=0`, `ANTHROPIC_API_KEY` valorizzata.

## API

Tutte le rotte in linea stanno sotto `/api/taobao` e sono servite dal solo
`TaobaoModule`. Ogni risposta segue la lingua della richiesta: `?lang=en|zh|it`
se presente, altrimenti `Accept-Language`, altrimenti inglese.

| Metodo | Rotta | Descrizione |
|---|---|---|
| `GET` | `/api/taobao/analysis/status` | motore d'analisi: provider, modello, versione prompt, budget (mai la chiave) |
| `GET` | `/api/taobao/api/status` | fonte di ricerca attiva e chiavi configurate |
| `GET` | `/api/taobao/hwh/status`, `/elim/status`, `/elim/plan` | stato dei singoli fornitori e crediti residui |
| `GET` | `/api/taobao/memory` | memoria interna: varianti già cercate (`query`, `limit`) |
| `GET` `PATCH` | `/api/taobao/clarifications[/:id]` | domande dell'IA; `PATCH` per rispondere o archiviare |
| `GET` `POST` `DELETE` | `/api/taobao/session` | sessione Playwright dell'account Taobao (cookie cifrati) |
| `GET` `POST` | `/api/taobao/clients` | elenco e creazione clienti |
| `GET` `PATCH` | `/api/taobao/clients/:clientId` | scheda cliente |
| `GET` `POST` | `/api/taobao/clients/:clientId/datasets` | fogli caricati; `POST` con corpo binario |
| `GET` | `/api/taobao/clients/:clientId/datasets/:datasetId` | anteprima del foglio e mappatura suggerita |
| `POST` `GET` | `/api/taobao/clients/:clientId/datasets/:datasetId/analysis` | analizza il foglio con l'IA / revisioni già fatte |
| `GET` | `/api/taobao/clients/:clientId/analysis/:runId` | righe, identità, stato in memoria, consumo |
| `PATCH` | `/api/taobao/clients/:clientId/analysis/rows/:rowId` | correzione manuale (`approve` per confermare) |
| `POST` | `/api/taobao/clients/:clientId/datasets/:datasetId/jobs` | avvia la ricerca da una revisione |
| `GET` | `/api/taobao/clients/:clientId/jobs[/:jobId][/results]` | storico, stato e risultati completi |
| `POST` | `/api/taobao/clients/:clientId/jobs/:jobId/rerun` | rilancia (`scope`: `all`, `failed`, `empty`) |
| `POST` | `/api/taobao/clients/:clientId/jobs/:jobId/cancel` | ferma una ricerca in corso |
| `POST` | `/api/taobao/clients/:clientId/jobs/:jobId/verify` | seconda passata IA di coerenza sui primi N |
| `POST` | `/api/taobao/clients/:clientId/jobs/:jobId/refine` | ri-ricerca guidata delle righe senza prodotto coerente |
| `GET` | `/api/taobao/clients/:clientId/jobs/:jobId/export` | Excel dei risultati (3 fogli), intestazioni tradotte |
| `GET` | `/api/taobao/clients/:clientId/jobs/:jobId/report` | Excel per il cliente (`markupPct`), intestazioni tradotte |
| `GET` `POST` | `/api/taobao/clients/:clientId/products/:productId/{history,refresh}` | storico prezzi e verifica alla fonte |

**Non più registrate** (404): `/api/search`, `/api/v1/searches`,
`/api/inquiry/*`, `/api/quotes/*`, `/api/scouting/*`. Il codice è in
`apps/api/src/{search,inquiry,quotes,scouting}`; per riattivarne una, rimetti
il modulo negli `imports` di `app.module.ts`.

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
- **Testi dell'IA in italiano**: i verdetti di coerenza, le domande di
  chiarimento e `productFamily` escono in italiano anche con l'interfaccia in
  inglese o cinese, perché i prompt in `packages/ai/src/` lo impongono. Sono
  anche salvati nel database, quindi cambiando i prompt le righe già analizzate
  resterebbero comunque italiane finché non si rianalizzano.
- **Testi salvati dal runner**: `reuseReason` e `shipping` si scrivono mentre
  il job gira, fuori da una richiesta HTTP, quindi nella lingua predefinita.
  Le righe prodotte prima del 2026-07-26 sono ancora in italiano; si aggiornano
  rifacendo la ricerca o con «verifica prezzo adesso».
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

Analogo `china-web.service` (`next start -p 3020` in `apps/web`).
`china-worker.service` esiste ma è **disabilitato**: serviva alla pipeline dei
preventivi.

Nginx (in `/etc/nginx/sites-available/filippo`): proxy verso 3020 (web) e 3021
(api), con `proxy_buffering off;` sulla location `/china-api/` — resta perché
la pipeline ritirata usava SSE.

Deploy di una modifica:

```bash
cd /var/www/china
pnpm build                       # shared → api → web, in quest'ordine
systemctl restart china-api china-web
```

`packages/shared` si risolve da `dist/`: se cambi un'etichetta tradotta lì e
ricompili solo `apps/web`, la pagina continua a mostrare la vecchia.
