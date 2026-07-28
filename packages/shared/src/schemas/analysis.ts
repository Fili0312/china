import { z } from "zod";
import type { Localized } from "../i18n/locale";

/**
 * Contratto dell'analisi di una riga d'Excel fatta da Claude.
 *
 * È il documento più importante di questo modulo: definisce **cosa** il
 * modello può dire e, per differenza, cosa non può inventare. Tre scelte
 * ricorrono ovunque:
 *
 * 1. **Nessun campo obbligatorio con valore di ripiego.** Ciò che non è
 *    scritto nella riga arriva `null` o come lista vuota, mai riempito con un
 *    valore plausibile. Un modello inventato è peggio di un modello mancante:
 *    il primo fa comprare il prodotto sbagliato, il secondo fa alzare la mano.
 * 2. **Misure e specifiche restano numero + unità separati**, come sono
 *    scritte. La conversione in unità base è un passo deterministico del
 *    nostro codice (`product-identity`), non una richiesta al modello: è ciò
 *    che rende `5.00mm` e `5mm` la stessa variante a distanza di mesi.
 * 3. **I dubbi sono dati strutturati, non prosa.** Un'ambiguità diventa un
 *    `warning` con un codice, non una frase dentro un altro campo: solo così
 *    l'interfaccia può fermare la riga prima della ricerca.
 */

/* -------------------------------------------------------------------------- */
/* Pezzi elementari                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Asse di una misura. `other` esiste perché i fogli reali contengono quote che
 * non sono lunghezza/larghezza/altezza (passo, filetto, corsa): forzarle in un
 * asse noto le renderebbe confrontabili con misure che non lo sono.
 */
export const DIMENSION_AXES = [
  "length",
  "width",
  "height",
  "depth",
  "diameter",
  "outerDiameter",
  "innerDiameter",
  "thickness",
  "other",
] as const;
export const DimensionAxisSchema = z.enum(DIMENSION_AXES);
export type DimensionAxis = z.infer<typeof DimensionAxisSchema>;

export const AnalyzedDimensionSchema = z.object({
  axis: DimensionAxisSchema,
  /** Etichetta originale quando `axis` è `other` (`passo`, `螺距`, …). */
  label: z.string().nullable(),
  value: z.number(),
  /**
   * Unità come scritta nella riga (`mm`, `cm`, `寸`).
   *
   * `null` quando il foglio non la indica (`60*60`). Non va indovinata: resta
   * nulla e la riga riceve un warning `AMBIGUOUS_UNIT`. Due misure senza unità
   * restano comunque confrontabili fra loro, quindi `60*60` e `30*30` sono
   * varianti diverse anche senza sapere se sono centimetri o millimetri.
   */
  unit: z.string().nullable(),
});
export type AnalyzedDimension = z.infer<typeof AnalyzedDimensionSchema>;

/**
 * Specifica tecnica obbligatoria: tensione, potenza, capacità, peso, portata,
 * classe di precisione… Tutto ciò che, cambiando, cambia il prodotto.
 *
 * È una lista di coppie e non un dizionario perché lo schema deve restare
 * chiuso (`additionalProperties: false`) per gli output strutturati.
 */
export const AnalyzedSpecSchema = z.object({
  /** Chiave in inglese, minuscola (`voltage`, `power`, `weight`, `capacity`). */
  key: z.string(),
  value: z.string(),
  /** Unità dichiarata nella riga; `null` se assente. */
  unit: z.string().nullable(),
});
export type AnalyzedSpec = z.infer<typeof AnalyzedSpecSchema>;

/**
 * Codici di avvertimento.
 *
 * Sono un elenco chiuso perché servono a **decidere**, non a informare: quelli
 * critici bloccano l'avvio automatico della ricerca. Una stringa libera non
 * potrebbe farlo senza un'analisi del testo, che è esattamente il tipo di
 * fragilità che questo modulo esiste per evitare.
 */
export const ANALYSIS_WARNING_CODES = [
  "AMBIGUOUS_MEASURE",
  "AMBIGUOUS_MODEL",
  "AMBIGUOUS_UNIT",
  "AMBIGUOUS_QUANTITY",
  "MULTIPLE_PRODUCTS",
  "MISSING_INFO",
  "UNCLEAR_TEXT",
  "OTHER",
] as const;
export const AnalysisWarningCodeSchema = z.enum(ANALYSIS_WARNING_CODES);
export type AnalysisWarningCode = z.infer<typeof AnalysisWarningCodeSchema>;

/**
 * Avvertimenti che impediscono l'avvio automatico dello scouting.
 *
 * Il criterio è uno solo: se il dubbio riguarda **quale prodotto** cercare, la
 * ricerca non deve partire da sola. `MISSING_INFO` e `UNCLEAR_TEXT` restano
 * fuori perché segnalano una riga povera, non una riga sbagliata.
 */
export const CRITICAL_WARNING_CODES: readonly AnalysisWarningCode[] = [
  "AMBIGUOUS_MEASURE",
  "AMBIGUOUS_MODEL",
  "AMBIGUOUS_UNIT",
  "MULTIPLE_PRODUCTS",
];

export const AnalysisWarningSchema = z.object({
  code: AnalysisWarningCodeSchema,
  /** Campo interessato (`dimensions`, `model`, `unit`…); `null` se generale. */
  field: z.string().nullable(),
  /** Spiegazione in italiano, mostrata in interfaccia. */
  message: z.string(),
});
export type AnalysisWarning = z.infer<typeof AnalysisWarningSchema>;

/* -------------------------------------------------------------------------- */
/* Acquistabilità                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Che cos'è la riga, in termini d'acquisto.
 *
 * Un foglio di richiesta industriale non contiene solo articoli di catalogo:
 * su una corsa da 498 righe, delle 41 rimaste scoperte una quindicina non era
 * mai stata comprabile su un marketplace — moduli di collaudo che il cliente
 * stampa, codici interni che solo il costruttore risolve. Cercarle è denaro
 * speso per forza, e presentarle come «non trovate» racconta un fallimento
 * della ricerca dove c'è invece una richiesta di natura diversa.
 *
 * Questo giudizio appartiene all'**analisi**, non alla ricerca: è una lettura
 * del testo, la stessa cosa che l'analisi già fa per famiglia e variante, e
 * costa zero perché viaggia nella chiamata che c'è comunque.
 */
export const PROCUREMENT_KINDS = [
  /** Articolo di catalogo, comprabile a listino. È il valore predefinito. */
  "MARKETPLACE_ITEM",
  /** Solo un codice interno o di costruttore: lo risolve il ricambista. */
  "PROPRIETARY_PART",
  /** Pezzo su disegno o su misura del cliente. */
  "CUSTOM_MADE",
  /** Modulistica, registri, schede da stampare: carta, non merce. */
  "PRINTED_DOCUMENT",
  /** Lavorazione, taratura, trasporto, manodopera. */
  "SERVICE",
  /** Intestazione, nota o totale del foglio: non è una richiesta. */
  "NOT_A_PRODUCT",
] as const;
export const ProcurementKindSchema = z.enum(PROCUREMENT_KINDS);
export type ProcurementKind = z.infer<typeof ProcurementKindSchema>;

export const ProcurementSchema = z.object({
  kind: ProcurementKindSchema,
  /** Perché non è un articolo di marketplace; `null` quando lo è. */
  reason: z.string().nullable(),
});
export type Procurement = z.infer<typeof ProcurementSchema>;

/**
 * Il valore predefinito, usato in due punti diversi con lo stesso scopo:
 * quando il modello non si esprime, e quando si rilegge un'analisi salvata
 * prima che questo campo esistesse. In entrambi i casi la riga resta un
 * prodotto normale — l'unica ipotesi che non toglie niente a nessuno.
 */
export const DEFAULT_PROCUREMENT: Procurement = {
  kind: "MARKETPLACE_ITEM",
  reason: null,
};

/* -------------------------------------------------------------------------- */
/* Analisi di una riga                                                         */
/* -------------------------------------------------------------------------- */

const ProductAnalysisFieldsSchema = z.object({
  /** Famiglia leggibile, in italiano (`calibri a spillo in ceramica`). */
  productFamily: z.string(),
  /**
   * Identità semantica della famiglia, in inglese e in `kebab-case`
   * (`ceramic-pin-gauge`). È l'unico giudizio che non si può ricavare dal
   * testo con una regola: due righe scritte in modo diverso appartengono alla
   * stessa famiglia solo se qualcuno lo riconosce. Le chiavi finali salvate a
   * database vengono comunque ricalcolate da questo valore normalizzato.
   */
  familyKey: z.string(),
  /** Etichetta leggibile della variante (`5 mm`, `60x60 cm bianco`). */
  variantKey: z.string(),

  productNameChinese: z.string().nullable(),
  productNameEnglish: z.string().nullable(),

  model: z.string().nullable(),
  material: z.string().nullable(),
  color: z.string().nullable(),

  dimensions: z.array(AnalyzedDimensionSchema),
  technicalSpecifications: z.array(AnalyzedSpecSchema),
  includedAccessories: z.array(z.string()),

  /** Vincoli che un prodotto **deve** rispettare per essere accettabile. */
  hardRequirements: z.array(z.string()),
  /** Preferenze: spostano il punteggio, non escludono. */
  softRequirements: z.array(z.string()),

  requestedQuantity: z.number().nullable(),
  unit: z.string().nullable(),

  /** Query da usare sulle fonti cinesi; `null` se non ricavabile. */
  searchQueryChinese: z.string().nullable(),
  /** Query da usare sulle fonti export. */
  searchQueryEnglish: z.string().nullable(),

  /** Da 0 a 1. Va abbassata quando i warning riguardano il prodotto. */
  confidence: z.number(),
  warnings: z.array(AnalysisWarningSchema),
});

/**
 * L'analisi **come si legge**: `procurement` ha un valore di ripiego.
 *
 * Serve perché questo schema rilegge anche ciò che è già a database, scritto
 * prima che il campo esistesse. Senza il default, aggiungere un campo
 * obbligatorio avrebbe reso illeggibili tutte le analisi salvate — e una riga
 * illeggibile diventa una riga fallita, che è il modo peggiore di introdurre
 * un miglioramento.
 */
export const ProductAnalysisSchema = ProductAnalysisFieldsSchema.extend({
  procurement: ProcurementSchema.prefault(DEFAULT_PROCUREMENT),
});
export type ProductAnalysis = z.infer<typeof ProductAnalysisSchema>;

/**
 * L'analisi **come la si chiede al modello**: `procurement` è obbligatorio.
 *
 * Il modello deve pronunciarsi sempre, anche per dire «prodotto normale»: un
 * campo facoltativo verrebbe omesso proprio nelle righe difficili, che sono
 * quelle per cui esiste. Gli output strutturati vogliono inoltre che ogni
 * proprietà sia dichiarata obbligatoria, e un default qui li romperebbe.
 */
export const ProductAnalysisModelSchema = ProductAnalysisFieldsSchema.extend({
  procurement: ProcurementSchema,
});

/**
 * Risposta di un batch: le righe tornano etichettate con il proprio indice.
 *
 * L'indice è ciò che tiene insieme richiesta e risposta quando più righe
 * viaggiano nella stessa chiamata. Non ci si affida all'ordine dell'array:
 * un modello che ne salta una sposterebbe silenziosamente tutte le analisi
 * successive sulla riga sbagliata, ed è l'errore peggiore possibile qui.
 */
export const ProductAnalysisBatchSchema = z.object({
  results: z.array(
    z.object({
      /** Indice della riga **come inviato** nella richiesta. */
      rowIndex: z.number(),
      analysis: ProductAnalysisModelSchema,
    })
  ),
});
export type ProductAnalysisBatch = z.infer<typeof ProductAnalysisBatchSchema>;

/* -------------------------------------------------------------------------- */
/* Identità: famiglia, variante, duplicato                                     */
/* -------------------------------------------------------------------------- */

export const ProductIdentitySchema = z.object({
  /** Stessa famiglia di prodotto. */
  familyKey: z.string(),
  /** Configurazione tecnica precisa: è l'identità usata per il riuso. */
  variantKey: z.string(),
  /** Richiesta realmente identica, vincoli obbligatori compresi. */
  duplicateKey: z.string(),
});
export type ProductIdentity = z.infer<typeof ProductIdentitySchema>;

/* -------------------------------------------------------------------------- */
/* Stato di una riga nella fase di revisione                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stato di una riga analizzata.
 *
 * `NEW_PRODUCT`/`NEW_VARIANT`/`KNOWN_PRODUCT` dicono cosa sa il database;
 * `NEEDS_REVIEW` e `ANALYSIS_FAILED` dicono che la riga non è pronta;
 * `READY` è l'unico stato dal quale la ricerca parte da sola.
 */
export const ANALYSIS_ROW_STATES = [
  "NEW_PRODUCT",
  "NEW_VARIANT",
  "KNOWN_PRODUCT",
  "NEEDS_REVIEW",
  "ANALYSIS_FAILED",
  "READY",
] as const;
export const AnalysisRowStateSchema = z.enum(ANALYSIS_ROW_STATES);
export type AnalysisRowState = z.infer<typeof AnalysisRowStateSchema>;

/** Etichette degli stati, tradotte, condivise fra API e interfaccia. */
export const ANALYSIS_ROW_STATE_LABELS: Localized<AnalysisRowState> = {
  en: {
    NEW_PRODUCT: "New product",
    NEW_VARIANT: "New variant",
    KNOWN_PRODUCT: "Already known product",
    NEEDS_REVIEW: "Needs checking",
    ANALYSIS_FAILED: "AI analysis failed",
    READY: "Ready to search",
  },
  zh: {
    NEW_PRODUCT: "新产品",
    NEW_VARIANT: "新款式",
    KNOWN_PRODUCT: "已知产品",
    NEEDS_REVIEW: "待核对",
    ANALYSIS_FAILED: "AI 分析失败",
    READY: "可以搜索",
  },
  it: {
    NEW_PRODUCT: "Nuovo prodotto",
    NEW_VARIANT: "Variante nuova",
    KNOWN_PRODUCT: "Prodotto già conosciuto",
    NEEDS_REVIEW: "Da verificare",
    ANALYSIS_FAILED: "Analisi IA fallita",
    READY: "Pronto per la ricerca",
  },
};

/** Cosa il database sa già della variante analizzata. */
export const AnalysisDbMatchSchema = z.object({
  /** Richiesta con la stessa `variantKey`, se esiste. */
  requestId: z.string().nullable(),
  /** Prodotti già salvati per quella variante. */
  candidateCount: z.number().int().min(0),
  /** Prodotti ancora considerati validi (raggiungibili e con prezzo). */
  validCandidateCount: z.number().int().min(0),
  lastSearchedAt: z.string().nullable(),
  /** Ultima volta che i prodotti sono stati riletti alla fonte. */
  lastVerifiedAt: z.string().nullable(),
  /** Richieste della stessa famiglia, utili come punto di partenza. */
  familyRequestCount: z.number().int().min(0),
  /** Query già usate con successo sulla stessa famiglia. */
  familyQueries: z.array(z.string()),
});
export type AnalysisDbMatch = z.infer<typeof AnalysisDbMatchSchema>;

export const AnalysisRowSchema = z.object({
  analysisRowId: z.string(),
  rowNumber: z.number().int().min(1),
  /** Riga originale, intatta: è sempre la fonte di verità. */
  originalCells: z.array(z.string()),
  /** Testo effettivamente inviato a Claude, senza dati amministrativi. */
  submittedText: z.string(),
  /** Link presente nell'Excel, se c'era. */
  referenceUrl: z.string().nullable(),

  state: AnalysisRowStateSchema,
  /** Analisi validata; `null` se l'analisi è fallita. */
  analysis: ProductAnalysisSchema.nullable(),
  identity: ProductIdentitySchema.nullable(),
  dbMatch: AnalysisDbMatchSchema.nullable(),

  /** `true` se un umano ha corretto l'analisi. */
  edited: z.boolean(),
  /** `true` se l'analisi arriva dalla cache e non ha speso una chiamata. */
  fromCache: z.boolean(),
  /** Motivo del fallimento, se `state` è `ANALYSIS_FAILED`. */
  error: z.string().nullable(),
});
export type AnalysisRow = z.infer<typeof AnalysisRowSchema>;

/** Consumo di una sessione di analisi: chiamate, token, costo stimato. */
export const AnalysisUsageSchema = z.object({
  model: z.string(),
  /** Motore che ha prodotto l'analisi (`claude` o `deepseek`). Facoltativo
   * perché le sessioni salvate prima dei provider multipli non lo hanno. */
  provider: z.string().optional(),
  promptVersion: z.string(),
  apiCalls: z.number().int().min(0),
  cachedRows: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Costo stimato in dollari con i prezzi di listino del modello. */
  estimatedCostUsd: z.number().min(0),
});
export type AnalysisUsage = z.infer<typeof AnalysisUsageSchema>;

export const AnalysisRunSchema = z.object({
  runId: z.string(),
  datasetId: z.string(),
  fileName: z.string(),
  totalRows: z.number().int().min(0),
  analyzedRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  readyRows: z.number().int().min(0),
  usage: AnalysisUsageSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  rows: z.array(AnalysisRowSchema),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

/* -------------------------------------------------------------------------- */
/* Richieste API                                                               */
/* -------------------------------------------------------------------------- */

/** POST /api/scouting/datasets/:id/analysis */
export const StartAnalysisRequestSchema = z.object({
  mapping: z.array(
    z.object({
      columnIndex: z.number().int().min(0),
      field: z.string(),
    })
  ),
  /** Limita l'analisi alle prime N righe (prova su file grandi). */
  maxRows: z.coerce.number().int().min(1).max(5000).optional(),
  /** Rianalizza anche le righe già in cache (dopo un cambio di prompt). */
  ignoreCache: z.boolean().default(false),
});
export type StartAnalysisRequest = z.infer<typeof StartAnalysisRequestSchema>;

/**
 * PATCH /api/scouting/analysis/rows/:id — correzione manuale.
 *
 * Ogni campo assente resta com'era: la correzione è una modifica, non una
 * riscrittura. Le chiavi di identità vengono ricalcolate dai campi corretti.
 */
export const UpdateAnalysisRowRequestSchema = z.object({
  productFamily: z.string().optional(),
  familyKey: z.string().optional(),
  variantKey: z.string().optional(),
  productNameChinese: z.string().nullable().optional(),
  productNameEnglish: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  material: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  dimensions: z.array(AnalyzedDimensionSchema).optional(),
  technicalSpecifications: z.array(AnalyzedSpecSchema).optional(),
  includedAccessories: z.array(z.string()).optional(),
  hardRequirements: z.array(z.string()).optional(),
  softRequirements: z.array(z.string()).optional(),
  requestedQuantity: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  searchQueryChinese: z.string().nullable().optional(),
  searchQueryEnglish: z.string().nullable().optional(),
  /**
   * Correzione dell'acquistabilità dedotta dal modello. È l'unica via per
   * rimettere in ricerca una riga classificata per sbaglio come non
   * acquistabile — e per toglierne una che il modello ha creduto un prodotto.
   */
  procurement: ProcurementSchema.optional(),
  /**
   * Conferma esplicita dell'operatore: la riga passa a «pronta» anche con
   * confidenza bassa o warning critici. È l'unico modo per superarli, e resta
   * registrato che è stata una decisione umana.
   */
  approve: z.boolean().optional(),
});
export type UpdateAnalysisRowRequest = z.infer<
  typeof UpdateAnalysisRowRequestSchema
>;
