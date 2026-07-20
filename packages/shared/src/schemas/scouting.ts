import { z } from "zod";
import { SearchEngineSchema, SearchQualitySchema } from "./search";

/**
 * Contratti dello scouting prodotti multi-marketplace a partire da un file.
 *
 * Differenza rispetto a `inquiry`: quel modulo legge **un** formato noto (il
 * foglio 博工 `询价`, intestazioni cinesi fisse). Qui il file è arbitrario —
 * Excel, XLS o CSV, in qualsiasi lingua — quindi le colonne vengono proposte
 * dall'euristica ma decise dall'utente, e la riga originale viene conservata
 * per intero.
 */

/* -------------------------------------------------------------------------- */
/* Dataset: file caricato, colonne, anteprima                                  */
/* -------------------------------------------------------------------------- */

export const DATASET_FORMATS = ["xls", "xlsx", "xlsm", "csv"] as const;
export const DatasetFormatSchema = z.enum(DATASET_FORMATS);
export type DatasetFormat = z.infer<typeof DatasetFormatSchema>;

/**
 * Campi ai quali una colonna del file può essere associata.
 *
 * `name` è l'unico obbligatorio: senza un nome prodotto non esiste richiesta.
 * Gli altri campi migliorano l'impronta e i vincoli, ma restano facoltativi
 * perché i fogli reali sono molto diversi fra loro.
 */
export const DATASET_FIELDS = [
  "name",
  "spec",
  "category",
  "brand",
  "model",
  "quantity",
  "unit",
  "material",
  "certifications",
  "targetPrice",
  "notes",
  "referenceUrl",
  "ignore",
] as const;
export const DatasetFieldSchema = z.enum(DATASET_FIELDS);
export type DatasetField = z.infer<typeof DatasetFieldSchema>;

/** Campi che, se mappati più volte, vengono uniti in ordine di colonna. */
export const MERGEABLE_DATASET_FIELDS: readonly DatasetField[] = [
  "spec",
  "notes",
  "certifications",
];

export const DatasetColumnSchema = z.object({
  /** Indice 0-based della colonna nel foglio. */
  index: z.number().int().min(0),
  /** Riferimento Excel della colonna (A, B, AA…), per ritrovarla nel file. */
  letter: z.string(),
  /** Intestazione letta dal file; vuota se la colonna non ne ha una. */
  header: z.string(),
  /** Campo proposto dall'euristica; `null` se nessuno è plausibile. */
  suggestedField: DatasetFieldSchema.nullable(),
  /** Perché è stato proposto quel campo (mostrato in interfaccia). */
  suggestionReason: z.string().nullable(),
  /** Quante celle non vuote sono state trovate sotto l'intestazione. */
  filledCount: z.number().int().min(0),
  /** Primi valori reali della colonna, per l'anteprima. */
  sampleValues: z.array(z.string()),
});
export type DatasetColumn = z.infer<typeof DatasetColumnSchema>;

export const DatasetRowSchema = z.object({
  /** Riga del file (1-based), conservata per ritrovare la richiesta. */
  rowNumber: z.number().int().min(1),
  /** Tutti i valori originali della riga, indicizzati per colonna. */
  cells: z.array(z.string()),
  /** Collegamento ipertestuale trovato nella riga, se presente. */
  hyperlink: z.string().nullable(),
});
export type DatasetRow = z.infer<typeof DatasetRowSchema>;

/** Associazione colonna → campo scelta (o confermata) dall'utente. */
export const DatasetMappingSchema = z.object({
  columnIndex: z.number().int().min(0),
  field: DatasetFieldSchema,
});
export type DatasetMapping = z.infer<typeof DatasetMappingSchema>;

export const DatasetPreviewSchema = z.object({
  datasetId: z.string(),
  fileName: z.string(),
  format: DatasetFormatSchema,
  sheet: z.string(),
  availableSheets: z.array(z.string()),
  /** Riga del file usata come intestazione (1-based); `null` se assente. */
  headerRowNumber: z.number().int().min(1).nullable(),
  columns: z.array(DatasetColumnSchema),
  totalRows: z.number().int().min(0),
  /** Righe restituite nell'anteprima (le prime `previewLimit`). */
  rows: z.array(DatasetRowSchema),
  /** Mapping proposto: da confermare o correggere prima di avviare il run. */
  suggestedMapping: z.array(DatasetMappingSchema),
  warnings: z.array(z.string()),
});
export type DatasetPreview = z.infer<typeof DatasetPreviewSchema>;

/** Query string di POST /api/scouting/datasets (corpo = file binario). */
export const DatasetUploadQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sheet: z.string().trim().min(1).max(120).optional(),
  previewLimit: z.coerce.number().int().min(1).max(200).default(25),
});
export type DatasetUploadQuery = z.infer<typeof DatasetUploadQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Richiesta normalizzata e impronta                                           */
/* -------------------------------------------------------------------------- */

/**
 * Input dell'impronta stabile di una richiesta prodotto.
 *
 * Il contratto è quello indicato dalla specifica e non va cambiato: è ciò che
 * rende confrontabili due richieste scritte in file, righe e forme diverse.
 */
export type ProductRequirementFingerprintInput = {
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

export const ProductRequirementFingerprintInputSchema = z.object({
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  normalizedName: z.string(),
  requiredVariant: z.record(z.string(), z.union([z.string(), z.number()])),
  dimensions: z.record(z.string(), z.number()),
  material: z.string().nullable(),
  power: z.number().nullable(),
  voltage: z.number().nullable(),
  capacity: z.number().nullable(),
  certifications: z.array(z.string()),
  requestedQuantity: z.number().nullable(),
}) satisfies z.ZodType<ProductRequirementFingerprintInput>;

/**
 * Vincolo estratto dalla richiesta.
 *
 * `hard` = requisito obbligatorio: un prodotto che lo viola viene scartato con
 * motivazione. `soft` = preferenza: sposta il punteggio, non esclude.
 */
export const RequirementKindSchema = z.enum(["hard", "soft"]);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const ProductRequirementSchema = z.object({
  /** Chiave stabile: `dimension.length`, `power`, `material`, `cert.CE`… */
  key: z.string(),
  kind: RequirementKindSchema,
  /** Etichetta leggibile, in italiano, per l'interfaccia. */
  label: z.string(),
  /** Valore numerico normalizzato in unità base, quando applicabile. */
  value: z.union([z.string(), z.number()]).nullable(),
  /** Unità base del valore (`mm`, `W`, `V`, `l`, `kg`). */
  unit: z.string().nullable(),
  /** Tolleranza relativa ammessa sul valore numerico (0.05 = ±5%). */
  tolerance: z.number().min(0).max(1).nullable(),
  /** Testo originale dal quale il vincolo è stato estratto. */
  source: z.string(),
});
export type ProductRequirement = z.infer<typeof ProductRequirementSchema>;

export const NormalizedRequestSchema = z.object({
  /** Riga originale nel file. */
  rowNumber: z.number().int().min(1),
  /** Impronta stabile: identità della richiesta fra file diversi. */
  fingerprint: z.string(),
  /** Identità debole, per proporre richieste simili già elaborate. */
  normalizedNameKey: z.string(),
  /** Testo prodotto ripulito, nella lingua originale. */
  displayName: z.string(),
  normalizedName: z.string(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  material: z.string().nullable(),
  power: z.number().nullable(),
  voltage: z.number().nullable(),
  capacity: z.number().nullable(),
  dimensions: z.record(z.string(), z.number()),
  requiredVariant: z.record(z.string(), z.union([z.string(), z.number()])),
  certifications: z.array(z.string()),
  requestedQuantity: z.number().nullable(),
  unit: z.string().nullable(),
  targetPrice: z.number().nullable(),
  notes: z.string().nullable(),
  referenceUrl: z.string().nullable(),
  /** Query inviata ai marketplace, costruita dal testo originale. */
  searchQuery: z.string(),
  /** Lingua prevalente della query: decide la vetrina del marketplace. */
  language: z.enum(["zh", "en"]),
  requirements: z.array(ProductRequirementSchema),
  /** Termini scartati (amministrativi, quantità di confezionamento). */
  droppedTerms: z.array(z.string()),
  /** Motivi per cui la riga non è elaborabile; se non vuoto va saltata. */
  issues: z.array(z.string()),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

/** PUT /api/scouting/datasets/:id/mapping — conferma della mappatura. */
export const SaveMappingRequestSchema = z.object({
  mapping: z.array(DatasetMappingSchema).min(1),
});
export type SaveMappingRequest = z.infer<typeof SaveMappingRequestSchema>;

/** POST /api/scouting/datasets/:id/normalize — anteprima della mappatura. */
export const NormalizePreviewRequestSchema = z.object({
  mapping: z.array(DatasetMappingSchema).min(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type NormalizePreviewRequest = z.infer<
  typeof NormalizePreviewRequestSchema
>;

export const NormalizePreviewResultSchema = z.object({
  datasetId: z.string(),
  totalRows: z.number().int().min(0),
  normalizedRows: z.number().int().min(0),
  skippedRows: z.number().int().min(0),
  /** Righe la cui impronta esiste già a database (verranno riusate). */
  knownRows: z.number().int().min(0),
  requests: z.array(
    NormalizedRequestSchema.extend({
      /** `true` se questa impronta è già stata elaborata in passato. */
      known: z.boolean(),
      /** Quante volte è già stata cercata, se conosciuta. */
      previousSearchCount: z.number().int().min(0),
      /** Ultima ricerca completa, se conosciuta. */
      lastSearchedAt: z.string().nullable(),
      /** Candidati già salvati per questa impronta. */
      knownCandidateCount: z.number().int().min(0),
    })
  ),
});
export type NormalizePreviewResult = z.infer<
  typeof NormalizePreviewResultSchema
>;

/* -------------------------------------------------------------------------- */
/* Job: esecuzione dello scouting su un dataset                                */
/* -------------------------------------------------------------------------- */

export const ImportJobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

export const ScoutingRowStatusSchema = z.enum([
  "PENDING",
  "SEARCHING",
  "REFRESHING",
  "SCORING",
  "DONE",
  "SKIPPED",
  "FAILED",
  "CANCELLED",
]);
export type ScoutingRowStatus = z.infer<typeof ScoutingRowStatusSchema>;

export const ScoutingEngineStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "DONE",
  "ERROR",
  "SKIPPED",
]);
export type ScoutingEngineStatus = z.infer<typeof ScoutingEngineStatusSchema>;

/** POST /api/scouting/datasets/:id/jobs — avvio dell'elaborazione. */
export const StartImportJobRequestSchema = z.object({
  mapping: z.array(DatasetMappingSchema).min(1),
  /** Marketplace scelti dall'utente. */
  engines: z.array(SearchEngineSchema).min(1),
  quality: SearchQualitySchema.default("balanced"),
  /** Candidati richiesti a ciascun motore, per riga. */
  candidatesPerEngine: z.coerce.number().int().min(1).max(50).default(10),
  /** Finalisti da conservare per riga (usati dalla selezione, M7). */
  finalists: z.coerce.number().int().min(1).max(20).default(3),
  /** Ignora i candidati salvati e ricerca tutto da capo. */
  forceFullSearch: z.boolean().default(false),
  /** Motivazioni AI sui finalisti (a consumo). Deterministico se `false`. */
  aiRationale: z.boolean().default(false),
  /** Limita l'esecuzione alle prime N righe (prova su file grandi). */
  maxRows: z.coerce.number().int().min(1).max(5000).optional(),
});
export type StartImportJobRequest = z.infer<typeof StartImportJobRequestSchema>;

/** POST /api/scouting/jobs/:id/retry */
export const RetryJobRequestSchema = z.object({
  /** `failed` ritenta solo ciò che è fallito, `all` rifà tutte le righe. */
  scope: z.enum(["failed", "all"]).default("failed"),
  /** Limita il nuovo tentativo a un solo marketplace. */
  engine: SearchEngineSchema.optional(),
});
export type RetryJobRequest = z.infer<typeof RetryJobRequestSchema>;

/** Avanzamento di una riga su un singolo marketplace. */
export const ScoutingEngineProgressSchema = z.object({
  engine: z.string(),
  status: ScoutingEngineStatusSchema,
  queryUsed: z.string().nullable(),
  fetchedCount: z.number().int().min(0),
  acceptedCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  retryable: z.boolean(),
  attempts: z.number().int().min(0),
  servedFromCache: z.boolean(),
});
export type ScoutingEngineProgress = z.infer<
  typeof ScoutingEngineProgressSchema
>;

export const ScoutingRowProgressSchema = z.object({
  jobRowId: z.string(),
  rowNumber: z.number().int().min(1),
  displayName: z.string(),
  searchQuery: z.string(),
  status: ScoutingRowStatusSchema,
  /** `true` quando i risultati arrivano da una richiesta già elaborata. */
  reused: z.boolean(),
  /** Impronta della richiesta: righe uguali mostrano la stessa impronta. */
  fingerprint: z.string().nullable(),
  candidateCount: z.number().int().min(0),
  engines: z.array(ScoutingEngineProgressSchema),
  error: z.string().nullable(),
});
export type ScoutingRowProgress = z.infer<typeof ScoutingRowProgressSchema>;

/** Avanzamento aggregato per marketplace su tutto il file. */
export const ScoutingEngineSummarySchema = z.object({
  engine: z.string(),
  pending: z.number().int().min(0),
  running: z.number().int().min(0),
  done: z.number().int().min(0),
  error: z.number().int().min(0),
  skipped: z.number().int().min(0),
  acceptedCount: z.number().int().min(0),
  /** Ultimo errore osservato su questa fonte, per capire subito il perché. */
  lastError: z.string().nullable(),
});
export type ScoutingEngineSummary = z.infer<
  typeof ScoutingEngineSummarySchema
>;

export const ImportJobSummarySchema = z.object({
  jobId: z.string(),
  datasetId: z.string(),
  fileName: z.string(),
  status: ImportJobStatusSchema,
  engines: z.array(z.string()),
  quality: SearchQualitySchema,
  totalRows: z.number().int().min(0),
  processedRows: z.number().int().min(0),
  reusedRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  creditsSpent: z.number().int().min(0),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ImportJobSummary = z.infer<typeof ImportJobSummarySchema>;

export const ImportJobProgressSchema = z.object({
  job: ImportJobSummarySchema,
  engineSummary: z.array(ScoutingEngineSummarySchema),
  rows: z.array(ScoutingRowProgressSchema),
});
export type ImportJobProgress = z.infer<typeof ImportJobProgressSchema>;

/* -------------------------------------------------------------------------- */
/* Risultati                                                                   */
/* -------------------------------------------------------------------------- */

export const ScoutingOutcomeSchema = z.enum([
  "FINALIST",
  "SHORTLISTED",
  "REJECTED",
]);
export type ScoutingOutcome = z.infer<typeof ScoutingOutcomeSchema>;

export const PriceTierRecordSchema = z.object({
  minQty: z.number().int().min(1),
  price: z.number(),
  currency: z.string(),
});
export type PriceTierRecord = z.infer<typeof PriceTierRecordSchema>;

export const ScoutingProductSchema = z.object({
  candidateId: z.string(),
  engine: z.string(),
  externalId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /** Query che ha fatto emergere questo prodotto. */
  foundQuery: z.string(),
  vendorName: z.string().nullable(),
  vendorUrl: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  moq: z.number().int().nullable(),
  stock: z.number().int().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().min(0).nullable(),
  totalSales: z.number().int().min(0).nullable(),
  relevanceScore: z.number().min(0).max(100).nullable(),
  matchReasons: z.array(z.string()),
  matchWarnings: z.array(z.string()),
  variants: z.array(
    z.object({ name: z.string(), options: z.array(z.string()) })
  ),
  specs: z.record(z.string(), z.string()),
  priceTiers: z.array(PriceTierRecordSchema),
  firstSeenAt: z.string(),
  lastCheckedAt: z.string(),
  lastChangedAt: z.string().nullable(),
  /** Campi cambiati all'ultimo aggiornamento (vuoto se nulla è cambiato). */
  changedFields: z.array(z.string()),
  unavailable: z.boolean(),
});
export type ScoutingProduct = z.infer<typeof ScoutingProductSchema>;

export const ScoutingRowResultsSchema = z.object({
  jobRowId: z.string(),
  rowNumber: z.number().int().min(1),
  displayName: z.string(),
  searchQuery: z.string(),
  status: ScoutingRowStatusSchema,
  reused: z.boolean(),
  fingerprint: z.string().nullable(),
  /** Valori originali della riga del file, intatti. */
  cells: z.array(z.string()),
  requirements: z.array(ProductRequirementSchema),
  /** Tutti i prodotti trovati per la richiesta di questa riga. */
  candidates: z.array(ScoutingProductSchema),
  engines: z.array(ScoutingEngineProgressSchema),
  error: z.string().nullable(),
});
export type ScoutingRowResults = z.infer<typeof ScoutingRowResultsSchema>;

export const ImportJobResultsSchema = z.object({
  job: ImportJobSummarySchema,
  rows: z.array(ScoutingRowResultsSchema),
});
export type ImportJobResults = z.infer<typeof ImportJobResultsSchema>;
