import { z } from "zod";
import type { Localized } from "../i18n/locale";
import { AnalysisRowStateSchema, AnalysisUsageSchema, ProductAnalysisSchema } from "./analysis";
import { DatasetColumnSchema, DatasetMappingSchema, DatasetRowSchema } from "./scouting";

/**
 * Contratti dello scouting v1: un cliente, un file, solo Taobao.
 *
 * Sono separati da quelli dello scouting multi-marketplace invece di
 * estenderli, per una ragione precisa: lì un risultato appartiene a un file,
 * qui appartiene a un **cliente**. Mettere `clientId` come campo facoltativo
 * nei contratti esistenti avrebbe reso possibile — anzi, facile — dimenticarlo
 * in una query e mostrare a un cliente il lavoro fatto per un altro.
 */

/* -------------------------------------------------------------------------- */
/* Clienti                                                                     */
/* -------------------------------------------------------------------------- */

export const ClientSummarySchema = z.object({
  clientId: z.string(),
  name: z.string(),
  slug: z.string(),
  contact: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
  /** Quanto lavoro esiste per questo cliente: file, analisi, ricerche. */
  datasetCount: z.number().int().min(0),
  jobCount: z.number().int().min(0),
});
export type ClientSummary = z.infer<typeof ClientSummarySchema>;

export const CreateClientRequestSchema = z.object({
  name: z.string().trim().min(1, "Il nome del cliente è obbligatorio.").max(120),
  contact: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type CreateClientRequest = z.infer<typeof CreateClientRequestSchema>;

export const UpdateClientRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  contact: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});
export type UpdateClientRequest = z.infer<typeof UpdateClientRequestSchema>;

/* -------------------------------------------------------------------------- */
/* File                                                                        */
/* -------------------------------------------------------------------------- */

/** POST /api/taobao/clients/:clientId/datasets?fileName=…&sheet=… */
export const TaobaoUploadQuerySchema = z.object({
  fileName: z.string().min(1).max(255),
  sheet: z.string().min(1).max(120).optional(),
  previewLimit: z.coerce.number().int().min(1).max(200).default(25),
});
export type TaobaoUploadQuery = z.infer<typeof TaobaoUploadQuerySchema>;

export const TaobaoDatasetSummarySchema = z.object({
  datasetId: z.string(),
  clientId: z.string(),
  fileName: z.string(),
  format: z.string(),
  sheet: z.string(),
  totalRows: z.number().int().min(0),
  createdAt: z.string(),
  analysisRunCount: z.number().int().min(0),
  jobCount: z.number().int().min(0),
});
export type TaobaoDatasetSummary = z.infer<typeof TaobaoDatasetSummarySchema>;

export const TaobaoDatasetPreviewSchema = TaobaoDatasetSummarySchema.extend({
  headerRowNumber: z.number().int().nullable(),
  columns: z.array(DatasetColumnSchema),
  rows: z.array(DatasetRowSchema),
  suggestedMapping: z.array(DatasetMappingSchema),
  warnings: z.array(z.string()),
});
export type TaobaoDatasetPreview = z.infer<typeof TaobaoDatasetPreviewSchema>;

/* -------------------------------------------------------------------------- */
/* Analisi                                                                     */
/* -------------------------------------------------------------------------- */

/** POST /api/taobao/datasets/:id/analysis */
export const StartTaobaoAnalysisRequestSchema = z.object({
  mapping: z.array(DatasetMappingSchema),
  maxRows: z.coerce.number().int().min(1).max(5000).optional(),
  ignoreCache: z.boolean().default(false),
});
export type StartTaobaoAnalysisRequest = z.infer<typeof StartTaobaoAnalysisRequestSchema>;

/** Cosa la memoria sa già di una variante, dal punto di vista di un cliente. */
export const TaobaoMemoryMatchSchema = z.object({
  requestId: z.string().nullable(),
  productCount: z.number().int().min(0),
  /** Prodotti ancora considerati validi: disponibili, con prezzo, recenti. */
  validProductCount: z.number().int().min(0),
  lastSearchedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  /** Varianti note della stessa famiglia: punto di partenza, non risultato. */
  familyRequestCount: z.number().int().min(0),
  familyQueries: z.array(z.string()),
});
export type TaobaoMemoryMatch = z.infer<typeof TaobaoMemoryMatchSchema>;

export const TaobaoAnalysisRowSchema = z.object({
  analysisRowId: z.string(),
  rowNumber: z.number().int().min(1),
  originalCells: z.array(z.string()),
  submittedText: z.string(),
  /** Link Taobao già presente nel foglio: entra fra i candidati. */
  referenceUrl: z.string().nullable(),

  state: AnalysisRowStateSchema,
  analysis: ProductAnalysisSchema.nullable(),
  identity: z
    .object({
      familyKey: z.string(),
      variantKey: z.string(),
      duplicateKey: z.string(),
      /** Token del testo entrati nell'identità perché non erano nei campi. */
      residual: z.array(z.string()),
    })
    .nullable(),
  memory: TaobaoMemoryMatchSchema.nullable(),

  edited: z.boolean(),
  fromCache: z.boolean(),
  error: z.string().nullable(),
});
export type TaobaoAnalysisRow = z.infer<typeof TaobaoAnalysisRowSchema>;

export const TaobaoAnalysisRunSchema = z.object({
  runId: z.string(),
  datasetId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  fileName: z.string(),
  totalRows: z.number().int().min(0),
  analyzedRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  readyRows: z.number().int().min(0),
  /**
   * Righe pronte che portano comunque un avviso da guardare (misura senza
   * unità, modello incerto). **Non** sono ferme: sono segnalate. Tenerle
   * separate dalle righe bloccate è ciò che rende quel numero leggibile.
   */
  warningRows: z.number().int().min(0),
  usage: AnalysisUsageSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  rows: z.array(TaobaoAnalysisRowSchema),
});
export type TaobaoAnalysisRun = z.infer<typeof TaobaoAnalysisRunSchema>;

/* -------------------------------------------------------------------------- */
/* Sessione Taobao                                                             */
/* -------------------------------------------------------------------------- */

/** Marketplace della sessione browser: uno solo, e non è configurabile. */
export const TAOBAO_SESSION_MARKETPLACE = "taobao-web";

export const TaobaoSessionStatusSchema = z.object({
  connected: z.boolean(),
  label: z.string().nullable(),
  /** Nomi dei cookie presenti, mai i valori. */
  cookieNames: z.array(z.string()),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  expiringSoon: z.boolean(),
  lastUsedAt: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** `false` se manca `SCOUTING_SESSION_SECRET`: senza non si può cifrare. */
  encryptionReady: z.boolean(),
});
export type TaobaoSessionStatus = z.infer<typeof TaobaoSessionStatusSchema>;

export const ConnectTaobaoSessionRequestSchema = z.object({
  /**
   * Cookie esportati dal browser dopo il login manuale, in JSON.
   *
   * Solo cookie: username, password, codici SMS e captcha non hanno un campo
   * in cui entrare, e non devono averlo.
   */
  cookiesJson: z.string().min(2, "Incolla l'esportazione JSON dei cookie."),
  label: z.string().trim().max(120).nullable().optional(),
});
export type ConnectTaobaoSessionRequest = z.infer<typeof ConnectTaobaoSessionRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Ricerca                                                                     */
/* -------------------------------------------------------------------------- */

export const TAOBAO_ROW_STATUSES = [
  "PENDING",
  "REFRESHING",
  "SEARCHING_API",
  "SEARCHING_BROWSER",
  "DONE",
  "SKIPPED",
  "FAILED",
] as const;
export const TaobaoRowStatusSchema = z.enum(TAOBAO_ROW_STATUSES);
export type TaobaoRowStatus = z.infer<typeof TaobaoRowStatusSchema>;

/**
 * Etichette degli stati, tradotte, condivise fra API e interfaccia.
 *
 * Le tiene lo schema e non il dizionario dell'interfaccia perché finiscono
 * anche nei fogli Excel generati dall'API: se vivessero solo nel frontend, il
 * file scaricato mostrerebbe `SEARCHING_API` mentre la pagina accanto scrive
 * «API search».
 */
export const TAOBAO_ROW_STATUS_LABELS: Localized<TaobaoRowStatus> = {
  en: {
    PENDING: "Waiting",
    REFRESHING: "Refreshing prices",
    SEARCHING_API: "API search",
    SEARCHING_BROWSER: "Playwright search",
    DONE: "Done",
    SKIPPED: "Skipped",
    FAILED: "Error",
  },
  zh: {
    PENDING: "等待中",
    REFRESHING: "更新价格中",
    SEARCHING_API: "API 搜索中",
    SEARCHING_BROWSER: "Playwright 搜索中",
    DONE: "已完成",
    SKIPPED: "已跳过",
    FAILED: "出错",
  },
  it: {
    PENDING: "In attesa",
    REFRESHING: "Aggiornamento prezzi",
    SEARCHING_API: "Ricerca API",
    SEARCHING_BROWSER: "Ricerca Playwright",
    DONE: "Completato",
    SKIPPED: "Saltata",
    FAILED: "Errore",
  },
};

export const TAOBAO_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
] as const;
export const TaobaoJobStatusSchema = z.enum(TAOBAO_JOB_STATUSES);
export type TaobaoJobStatus = z.infer<typeof TaobaoJobStatusSchema>;

/**
 * Da dove arriva un candidato. Un prodotto può averne più di una.
 *
 * `hwh` è «Taobao API by H-W-H» (ricerca primaria), `api` è Taobao DataHub
 * (fallback e dettagli), `elim` è ElimAPI: restano distinte perché sono
 * fornitori con piani, limiti e qualità dei dati diversi, e sapere quale ha
 * trovato un prodotto è ciò che permette di decidere quale tenere.
 */
export const TAOBAO_SOURCES = ["hwh", "api", "elim", "playwright", "excel", "memory"] as const;
export const TaobaoSourceSchema = z.enum(TAOBAO_SOURCES);
export type TaobaoSource = z.infer<typeof TaobaoSourceSchema>;

/** Solo «memoria» si traduce: gli altri sono nomi di prodotti software. */
export const TAOBAO_SOURCE_LABELS: Localized<TaobaoSource> = {
  en: {
    hwh: "Taobao API",
    api: "DataHub",
    elim: "ElimAPI",
    playwright: "Playwright",
    excel: "Excel",
    memory: "Memory",
  },
  zh: {
    hwh: "Taobao API",
    api: "DataHub",
    elim: "ElimAPI",
    playwright: "Playwright",
    excel: "Excel",
    memory: "记忆库",
  },
  it: {
    hwh: "Taobao API",
    api: "DataHub",
    elim: "ElimAPI",
    playwright: "Playwright",
    excel: "Excel",
    memory: "Memoria",
  },
};

/**
 * Marketplace di provenienza di un prodotto.
 *
 * Su ElimAPI il valore del parametro per 1688 è `alibaba` (verificato: i link
 * restituiti sono `detail.1688.com`); qui si usa `1688`, che è il nome con cui
 * il marketplace è conosciuto da chi compra.
 */
export const TAOBAO_PLATFORMS = ["taobao", "1688"] as const;
export const TaobaoPlatformSchema = z.enum(TAOBAO_PLATFORMS);
export type TaobaoPlatform = z.infer<typeof TaobaoPlatformSchema>;

export const TAOBAO_PLATFORM_LABELS: Localized<TaobaoPlatform> = {
  en: { taobao: "Taobao", "1688": "1688" },
  zh: { taobao: "淘宝", "1688": "1688" },
  it: { taobao: "Taobao", "1688": "1688" },
};

/** POST /api/taobao/datasets/:id/jobs */
export const StartTaobaoJobRequestSchema = z.object({
  mapping: z.array(DatasetMappingSchema),
  /** Sessione di revisione da cui partire: senza, il job non parte. */
  analysisRunId: z.string().min(1),
  /** Rifà la ricerca completa anche per le varianti già conosciute. */
  forceFullSearch: z.boolean().default(false),
  /** Aggiunge la ricerca Playwright quando l'account è collegato. */
  useBrowser: z.boolean().default(true),
  maxCandidates: z.coerce.number().int().min(1).max(40).default(10),
  /** Dettaglio prodotto sui primi N candidati: 1 chiamata ciascuno. */
  detailTopN: z.coerce.number().int().min(0).max(10).default(3),
  /** Recensioni sui primi N finalisti: 1 chiamata ciascuno, 0 = mai. */
  reviewTopN: z.coerce.number().int().min(0).max(10).default(0),
  /** Usa ElimAPI come riserva quando DataHub non basta. */
  useElim: z.boolean().default(true),
  /** Cerca anche su 1688 tramite ElimAPI. */
  use1688: z.boolean().default(false),
  maxRows: z.coerce.number().int().min(1).max(5000).optional(),
});
export type StartTaobaoJobRequest = z.infer<typeof StartTaobaoJobRequestSchema>;

/**
 * Quali righe rifare quando si rilancia una ricerca.
 *
 * Rilanciare tutto è raramente ciò che serve: dopo aver collegato una chiave
 * mancante interessano le righe fallite, dopo aver corretto una query quelle
 * rimaste vuote. Restringere l'ambito è il modo più diretto di non ripagare
 * ciò che era già andato bene.
 */
export const TAOBAO_RERUN_SCOPES = ["all", "failed", "empty"] as const;
export const TaobaoRerunScopeSchema = z.enum(TAOBAO_RERUN_SCOPES);
export type TaobaoRerunScope = z.infer<typeof TaobaoRerunScopeSchema>;

export const TAOBAO_RERUN_SCOPE_LABELS: Localized<TaobaoRerunScope> = {
  en: {
    all: "every row",
    failed: "only rows with errors",
    empty: "only rows with no results",
  },
  zh: {
    all: "全部行",
    failed: "仅出错的行",
    empty: "仅无结果的行",
  },
  it: {
    all: "tutte le righe",
    failed: "solo le righe in errore",
    empty: "solo le righe senza risultati",
  },
};

/** POST /api/taobao/clients/:id/jobs/:jobId/rerun */
export const RerunTaobaoJobRequestSchema = z.object({
  scope: TaobaoRerunScopeSchema.default("failed"),
  /**
   * Ignora i prodotti già in memoria e ricerca comunque.
   *
   * Predefinito `true`: chi chiede di rifare la ricerca vuole interrogare la
   * fonte, non rileggere quello che avevamo già.
   */
  forceFullSearch: z.boolean().default(true),
  /** Aggiunge la ricerca browser se l'account è collegato. */
  useBrowser: z.boolean().optional(),
  useElim: z.boolean().optional(),
  use1688: z.boolean().optional(),
  maxCandidates: z.coerce.number().int().min(1).max(40).optional(),
  detailTopN: z.coerce.number().int().min(0).max(10).optional(),
  reviewTopN: z.coerce.number().int().min(0).max(10).optional(),
});
export type RerunTaobaoJobRequest = z.infer<typeof RerunTaobaoJobRequestSchema>;

/** Consumo di un job: è ciò che si risponde a «quanto è costato?». */
export const TaobaoJobUsageSchema = z.object({
  /** Chiamate «Taobao API by H-W-H» partite (piano RapidAPI separato). */
  hwhCalls: z.number().int().min(0),
  /** Chiamate DataHub davvero partite (i crediti si contano qui). */
  apiCalls: z.number().int().min(0),
  /** Chiamate risparmiate dalla cache (tutte le fonti RapidAPI). */
  apiCacheHits: z.number().int().min(0),
  /** Ricerche Playwright eseguite. */
  browserCalls: z.number().int().min(0),
  /** Richieste ElimAPI consumate: il piano le conta a parte da DataHub. */
  elimCalls: z.number().int().min(0),
  /** Prodotti riusati dalla memoria e prodotti trovati da zero. */
  reusedProducts: z.number().int().min(0),
  newProducts: z.number().int().min(0),
});
export type TaobaoJobUsage = z.infer<typeof TaobaoJobUsageSchema>;

export const TaobaoJobSummarySchema = z.object({
  jobId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  datasetId: z.string(),
  fileName: z.string(),
  status: TaobaoJobStatusSchema,
  totalRows: z.number().int().min(0),
  processedRows: z.number().int().min(0),
  reusedRows: z.number().int().min(0),
  searchedRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  usage: TaobaoJobUsageSchema,
  /** `true` se la ricerca browser era attiva e l'account era collegato. */
  browserUsed: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type TaobaoJobSummary = z.infer<typeof TaobaoJobSummarySchema>;

export const TaobaoProductRecordSchema = z.object({
  productId: z.string(),
  /** Marketplace di provenienza. */
  platform: TaobaoPlatformSchema,
  /** Identità del prodotto sul suo marketplace. */
  itemId: z.string(),
  title: z.string(),
  /** Titolo tradotto, quando la fonte lo espone. */
  titleEn: z.string().nullable(),
  url: z.string().nullable(),
  imageUrl: z.string().nullable(),

  price: z.number().nullable(),
  currency: z.string().nullable(),
  variantPrice: z.number().nullable(),
  /** Prezzo promozionale: quello che si paga oggi, se c'è una promozione. */
  promotionPrice: z.number().nullable(),
  /** Quantità minima d'ordine: su 1688 è quasi sempre presente. */
  moq: z.number().int().nullable(),
  /** SKU/variante indicata dalla fonte. */
  sku: z.string().nullable(),

  shopName: z.string().nullable(),
  shopUrl: z.string().nullable(),

  totalSales: z.number().int().nullable(),
  reviewCount: z.number().int().nullable(),
  rating: z.number().nullable(),

  specs: z.record(z.string(), z.string()).nullable(),
  variants: z
    .array(z.object({ name: z.string(), options: z.array(z.string()) }))
    .nullable(),
  availability: z.string().nullable(),
  shipping: z.string().nullable(),

  foundQuery: z.string(),
  sources: z.array(TaobaoSourceSchema),
  lastCheckedAt: z.string(),
  changedFields: z.array(z.string()),
  unavailable: z.boolean(),
});
export type TaobaoProductRecord = z.infer<typeof TaobaoProductRecordSchema>;

/** Un prodotto proposto per una riga, con il perché del suo posto. */
export const TaobaoCandidateSchema = z.object({
  rank: z.number().int().min(1),
  score: z.number(),
  scoreBreakdown: z
    .object({
      compatibility: z.number(),
      price: z.number(),
      sales: z.number(),
      reviews: z.number(),
    })
    .nullable(),
  matchedRequirements: z.array(z.string()),
  missingRequirements: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Differenze fra fonti sullo stesso prodotto (prezzo, disponibilità). */
  sourceConflicts: z.array(z.string()),
  /** Verdetto della seconda passata IA; `null` finché non è stata chiesta. */
  coherence: z
    .object({
      verdict: z.enum(["coherent", "incoherent", "unsure"]),
      issues: z.array(z.string()),
      confidence: z.number(),
    })
    .nullable(),
  product: TaobaoProductRecordSchema,
});
export type TaobaoCandidate = z.infer<typeof TaobaoCandidateSchema>;

export const TaobaoRowResultsSchema = z.object({
  jobRowId: z.string(),
  rowNumber: z.number().int(),
  displayName: z.string(),
  searchQuery: z.string(),
  status: TaobaoRowStatusSchema,
  reused: z.boolean(),
  reuseReason: z.string().nullable(),
  variantKey: z.string().nullable(),
  originalCells: z.array(z.string()),
  /** Quantità e unità chieste dal foglio, come le ha lette l'analisi. */
  requestedQuantity: z.number().nullable(),
  requestedUnit: z.string().nullable(),
  /** Esito separato per trasporto: uno può fallire senza l'altro. */
  hwhStatus: z.string().nullable(),
  hwhError: z.string().nullable(),
  hwhCount: z.number().int().min(0),
  apiStatus: z.string().nullable(),
  apiError: z.string().nullable(),
  apiCount: z.number().int().min(0),
  /** Esito della seconda fonte: interviene solo quando la prima non basta. */
  elimStatus: z.string().nullable(),
  elimError: z.string().nullable(),
  elimCount: z.number().int().min(0),
  browserStatus: z.string().nullable(),
  browserError: z.string().nullable(),
  browserCount: z.number().int().min(0),
  error: z.string().nullable(),
  candidates: z.array(TaobaoCandidateSchema),
});
export type TaobaoRowResults = z.infer<typeof TaobaoRowResultsSchema>;

export const TaobaoJobResultsSchema = z.object({
  job: TaobaoJobSummarySchema,
  rows: z.array(TaobaoRowResultsSchema),
});
export type TaobaoJobResults = z.infer<typeof TaobaoJobResultsSchema>;

/* -------------------------------------------------------------------------- */
/* Storico di un prodotto                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Un cambiamento reale nei dati di un prodotto.
 *
 * Lo storico non registra i controlli, registra i **cambiamenti**: un
 * prodotto riletto dieci volte senza variazioni non produce nessuna riga. È
 * ciò che rende leggibile l'unica domanda che conta davvero — «quando è
 * cambiato il prezzo, e di quanto?».
 */
export const TaobaoPriceHistoryEntrySchema = z.object({
  capturedAt: z.string(),
  /** Valore **precedente** al cambiamento: è la fotografia del «prima». */
  price: z.number().nullable(),
  currency: z.string().nullable(),
  totalSales: z.number().int().nullable(),
  reviewCount: z.number().int().nullable(),
  available: z.boolean(),
  changedFields: z.array(z.string()),
});
export type TaobaoPriceHistoryEntry = z.infer<typeof TaobaoPriceHistoryEntrySchema>;

export const TaobaoProductHistorySchema = z.object({
  productId: z.string(),
  itemId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  /** Valori attuali, per confrontarli con l'ultima istantanea. */
  currentPrice: z.number().nullable(),
  currency: z.string().nullable(),
  firstSeenAt: z.string(),
  lastCheckedAt: z.string(),
  lastChangedAt: z.string().nullable(),
  unavailable: z.boolean(),
  /** Dal più recente al più vecchio. */
  entries: z.array(TaobaoPriceHistoryEntrySchema),
});
export type TaobaoProductHistory = z.infer<typeof TaobaoProductHistorySchema>;

/**
 * Esito della verifica immediata di un prodotto.
 *
 * `priceBefore` è il prezzo che la carta mostrava prima della verifica: è ciò
 * che permette di scrivere «prima 12,50 → ora 13,80» invece di un prezzo nuovo
 * senza contesto.
 */
export const TaobaoProductRefreshResultSchema = z.object({
  product: TaobaoProductRecordSchema,
  priceBefore: z.number().nullable(),
});
export type TaobaoProductRefreshResult = z.infer<typeof TaobaoProductRefreshResultSchema>;

/* -------------------------------------------------------------------------- */
/* Storico della memoria interna                                               */
/* -------------------------------------------------------------------------- */

/**
 * Una variante nella memoria condivisa: cosa il sistema conosce già.
 *
 * Espone solo dati di prodotto — mai per quale cliente è stata cercata: la
 * memoria è condivisa fra clienti, il lavoro no.
 */
export const TaobaoMemoryRequestSchema = z.object({
  requestId: z.string(),
  variantKey: z.string(),
  familyKey: z.string(),
  displayName: z.string(),
  productNameChinese: z.string().nullable(),
  searchQueryChinese: z.string().nullable(),
  productCount: z.number().int().min(0),
  searchCount: z.number().int().min(0),
  firstSeenAt: z.string(),
  lastSearchedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  topProduct: z
    .object({
      title: z.string(),
      price: z.number().nullable(),
      currency: z.string().nullable(),
      url: z.string().nullable(),
    })
    .nullable(),
});
export type TaobaoMemoryRequest = z.infer<typeof TaobaoMemoryRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Domande di chiarimento e conoscenza accumulata                              */
/* -------------------------------------------------------------------------- */

export const TAOBAO_CLARIFICATION_STATUSES = ["OPEN", "ANSWERED", "DISMISSED"] as const;
export const TaobaoClarificationStatusSchema = z.enum(TAOBAO_CLARIFICATION_STATUSES);
export type TaobaoClarificationStatus = z.infer<typeof TaobaoClarificationStatusSchema>;

export const TAOBAO_CLARIFICATION_SOURCES = ["analysis", "verify"] as const;
export const TaobaoClarificationSourceSchema = z.enum(TAOBAO_CLARIFICATION_SOURCES);
export type TaobaoClarificationSource = z.infer<typeof TaobaoClarificationSourceSchema>;

/**
 * Una domanda che l'IA non ha saputo sciogliere da sola.
 *
 * La risposta non serve solo alla riga che l'ha generata: entra nella
 * conoscenza iniettata nelle analisi successive, così la stessa domanda non
 * viene mai rifatta. `hitCount` dice quante righe hanno incontrato il dubbio:
 * è l'ordine giusto in cui rispondere.
 */
export const TaobaoClarificationSchema = z.object({
  clarificationId: z.string(),
  source: TaobaoClarificationSourceSchema,
  /** Codice del warning che l'ha originata, se c'è. */
  code: z.string().nullable(),
  familyKey: z.string().nullable(),
  question: z.string(),
  answer: z.string().nullable(),
  status: TaobaoClarificationStatusSchema,
  /** Esempi di testo che hanno sollevato il dubbio. */
  examples: z.array(z.string()),
  /** Quante righe hanno incontrato questo dubbio. */
  hitCount: z.number().int().min(0),
  /** Quante analisi hanno già riusato la risposta. */
  timesApplied: z.number().int().min(0),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
});
export type TaobaoClarification = z.infer<typeof TaobaoClarificationSchema>;

/** PATCH /api/taobao/clarifications/:id — risposta o archiviazione. */
export const AnswerClarificationRequestSchema = z.object({
  /** Risposta dell'operatore: da qui in poi è conoscenza del sistema. */
  answer: z.string().trim().min(1).max(2000).optional(),
  /** Archivia senza rispondere: la domanda non verrà più posta. */
  dismiss: z.boolean().optional(),
});
export type AnswerClarificationRequest = z.infer<typeof AnswerClarificationRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Verifica di coerenza (seconda passata IA)                                   */
/* -------------------------------------------------------------------------- */

export const TAOBAO_COHERENCE_VERDICTS = ["coherent", "incoherent", "unsure"] as const;
export const TaobaoCoherenceVerdictSchema = z.enum(TAOBAO_COHERENCE_VERDICTS);
export type TaobaoCoherenceVerdict = z.infer<typeof TaobaoCoherenceVerdictSchema>;

export const TAOBAO_COHERENCE_VERDICT_LABELS: Localized<TaobaoCoherenceVerdict> = {
  en: {
    coherent: "coherent with the request",
    incoherent: "NOT coherent",
    unsure: "unsure",
  },
  zh: {
    coherent: "与询价内容吻合",
    incoherent: "不吻合",
    unsure: "存疑",
  },
  it: {
    coherent: "coerente con la richiesta",
    incoherent: "NON coerente",
    unsure: "dubbio",
  },
};

/** Verdetto della seconda passata IA su un candidato. */
export const TaobaoCoherenceSchema = z.object({
  verdict: TaobaoCoherenceVerdictSchema,
  /** Cosa non torna, in italiano, pronto da mostrare. */
  issues: z.array(z.string()),
  confidence: z.number(),
});
export type TaobaoCoherence = z.infer<typeof TaobaoCoherenceSchema>;

/** POST /api/taobao/clients/:clientId/jobs/:jobId/verify */
export const VerifyTaobaoJobRequestSchema = z.object({
  /** Candidati verificati per riga, dal primo in classifica. */
  topN: z.coerce.number().int().min(1).max(10).default(3),
  /** Riverifica anche i candidati già controllati. */
  force: z.boolean().default(false),
});
export type VerifyTaobaoJobRequest = z.infer<typeof VerifyTaobaoJobRequestSchema>;

/** POST /api/taobao/clients/:clientId/jobs/:jobId/refine */
export const RefineTaobaoJobRequestSchema = z.object({
  /** Candidati per riga considerati (top-N) sia in ingresso sia in verifica. */
  topN: z.coerce.number().int().min(1).max(10).default(3),
});
export type RefineTaobaoJobRequest = z.infer<typeof RefineTaobaoJobRequestSchema>;

/**
 * Esito della ri-ricerca guidata dai difetti.
 *
 * Riparte dalle righe che, dopo la verifica, non hanno nessun prodotto
 * coerente: per ognuna l'IA riscrive la query dai motivi del fallimento, si
 * cerca di nuovo e si ri-verifica. Il conto separa la spesa di ricerca
 * (DataHub) da quella dell'IA (riscrittura + verifica).
 */
export const TaobaoRefineResultSchema = z.object({
  jobId: z.string(),
  /** Righe senza un prodotto coerente, candidate alla ri-ricerca. */
  rowsProblematic: z.number().int().min(0),
  /** Righe per cui l'IA ha prodotto una query nuova e si è ricercato. */
  rowsRefined: z.number().int().min(0),
  /** Righe che, dopo la ri-ricerca, hanno ora almeno un prodotto coerente. */
  rowsRecovered: z.number().int().min(0),
  /** Prodotti nuovi trovati dalla ri-ricerca. */
  newProducts: z.number().int().min(0),
  /** Chiamate di ricerca DataHub consumate dalla ri-ricerca. */
  apiCalls: z.number().int().min(0),
  /** Candidati ri-verificati dopo la ri-ricerca. */
  reverifiedCandidates: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
  /** Messaggio quando non c'era nulla da rifare o è mancata la verifica. */
  note: z.string().nullable(),
});
export type TaobaoRefineResult = z.infer<typeof TaobaoRefineResultSchema>;

export const TaobaoVerifyResultSchema = z.object({
  jobId: z.string(),
  /** Candidati esaminati in questa passata (esclusi quelli già verificati). */
  checkedCandidates: z.number().int().min(0),
  /** Candidati saltati perché già verificati in una passata precedente. */
  skippedCandidates: z.number().int().min(0),
  coherent: z.number().int().min(0),
  incoherent: z.number().int().min(0),
  unsure: z.number().int().min(0),
  /** Domande nuove aperte da questa verifica. */
  questionsOpened: z.number().int().min(0),
  apiCalls: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
});
export type TaobaoVerifyResult = z.infer<typeof TaobaoVerifyResultSchema>;

/** Stato del trasporto API: configurazione e consumo complessivo. */
export const TaobaoApiStatusSchema = z.object({
  /** `true` se `RAPIDAPI_KEY` è configurata (mai il valore). */
  configured: z.boolean(),
  /** Fonte di ricerca primaria scelta nel `.env` (`TAOBAO_PRIMARY_SEARCH`). */
  primarySearch: z.enum(["hwh", "datahub"]).optional(),
  host: z.string(),
  endpoints: z.object({
    search: z.string(),
    detail: z.string(),
    review: z.string(),
    shipping: z.string(),
  }),
  /** Chiamate e crediti spesi da quando il processo è partito. */
  calls: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  cacheTtlHours: z.number(),
  lastError: z.string().nullable(),
});
export type TaobaoApiStatus = z.infer<typeof TaobaoApiStatusSchema>;

/** Stato del trasporto ElimAPI: configurazione, piano e consumo. */
export const ElimApiStatusSchema = z.object({
  /** `true` se `ELI_API` è configurata (mai il valore). */
  configured: z.boolean(),
  baseUrl: z.string(),
  endpoint: z.string(),
  platforms: z.array(TaobaoPlatformSchema),
  calls: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  cacheTtlHours: z.number(),
  lastError: z.string().nullable(),
});
export type ElimApiStatus = z.infer<typeof ElimApiStatusSchema>;
