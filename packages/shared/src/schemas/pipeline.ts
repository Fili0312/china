import { z } from "zod";
import { DatasetMappingSchema } from "./scouting";
import { TaobaoClarificationSchema } from "./taobao";

/**
 * Lo scouting che si guida da solo (v2).
 *
 * La v1 è una sequenza di pulsanti: carica, analizza, conferma, cerca,
 * verifica, migliora, scarica. Ogni passo è visibile e ogni passo va premuto.
 * Va bene per capire cosa fa il sistema, meno per usarlo tutti i giorni: chi
 * quota un foglio non vuole *decidere* sette volte, vuole il risultato.
 *
 * Qui il foglio entra e la quotazione esce. In mezzo il sistema decide da sé
 * cosa serve — quali colonne sono quali, quali righe rifare, quando insistere
 * e quando fermarsi — e si interrompe **solo** quando ha una domanda a cui non
 * può rispondere da solo.
 *
 * Tre conseguenze sulla forma dei dati, tutte volute:
 *
 * 1. **Lo stato sta nel database, non nella pagina.** Un'elaborazione dura
 *    minuti: chiudere la scheda, riaprirla dal telefono o perdere la rete non
 *    deve buttare via il lavoro (e i crediti) già spesi.
 * 2. **L'avanzamento è un codice, non una frase.** Il job gira fuori da una
 *    richiesta HTTP e non sa in che lingua legge chi guarda; salvare
 *    «Analizzo la riga 40 di 95» lo fisserebbe a una lingua sola. Si salva
 *    `phase.analysis.rows` più i suoi valori, e la frase la compone la pagina.
 * 3. **Le domande sono una pausa, non un errore.** `WAITING_ANSWERS` è uno
 *    stato normale: si risponde e si riparte da dove ci si era fermati.
 */

/* -------------------------------------------------------------------------- */
/* Stato                                                                       */
/* -------------------------------------------------------------------------- */

export const TAOBAO_PIPELINE_STATUSES = [
  "RUNNING",
  /** In pausa: l'IA ha domande e senza risposta proseguirebbe alla cieca. */
  "WAITING_ANSWERS",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const TaobaoPipelineStatusSchema = z.enum(TAOBAO_PIPELINE_STATUSES);
export type TaobaoPipelineStatus = z.infer<typeof TaobaoPipelineStatusSchema>;

/**
 * Le fasi, nell'ordine in cui accadono.
 *
 * `QUESTIONS` e `REFINE` possono ripetersi; le altre passano una volta sola.
 * L'ordine dell'elenco è anche quello che la pagina disegna nello stepper, per
 * questo non va riordinato per comodità.
 */
export const TAOBAO_PIPELINE_PHASES = [
  "QUEUED",
  "ANALYSIS",
  "QUESTIONS",
  "REVIEW",
  "SEARCH",
  "VERIFY",
  "REFINE",
  "REPORT",
] as const;
export const TaobaoPipelinePhaseSchema = z.enum(TAOBAO_PIPELINE_PHASES);
export type TaobaoPipelinePhase = z.infer<typeof TaobaoPipelinePhaseSchema>;

/**
 * Cosa sta facendo il sistema, adesso.
 *
 * Sono chiavi del dizionario dell'interfaccia: `stepParams` porta i numeri e
 * i nomi che ci vanno dentro. Aggiungerne una qui obbliga a tradurla nei tre
 * dizionari, ed è esattamente il controllo che si vuole.
 */
export const TAOBAO_PIPELINE_STEPS = [
  "step.queued",
  "step.reading",
  "step.analysing",
  "step.analysingRows",
  "step.questions",
  "step.reanalysing",
  "step.approving",
  "step.searchStarting",
  "step.searchRows",
  "step.verifying",
  "step.refining",
  "step.refineRound",
  "step.report",
  "step.done",
  "step.failed",
  "step.cancelled",
] as const;
export const TaobaoPipelineStepSchema = z.enum(TAOBAO_PIPELINE_STEPS);
export type TaobaoPipelineStep = z.infer<typeof TaobaoPipelineStepSchema>;

/* -------------------------------------------------------------------------- */
/* Preventivo di spesa                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cosa costerà al massimo, prima di spendere.
 *
 * Si mostra dopo la lettura del foglio e prima di qualunque chiamata a
 * pagamento: è l'unico momento in cui fermarsi costa zero.
 *
 * Sono **tetti**, non previsioni, e la differenza non è prudenza formale. Ciò
 * che abbatte davvero il costo — righe già analizzate, varianti già in
 * memoria — dipende da chiavi che esistono solo *dopo* l'analisi: prima si
 * possono solo indovinare. Una prima versione ci provava con due
 * approssimazioni sul testo grezzo e su un foglio di prova ha annunciato «0
 * chiamate» per una corsa che poi ne ha fatte 64. Un numero al ribasso su una
 * schermata di conferma non è una stima imprecisa: è una promessa rotta, e
 * toglie senso alla conferma stessa. Meglio un tetto onesto e un risultato
 * finale che quasi sempre gli sta sotto.
 */
export const TaobaoPipelineEstimateSchema = z.object({
  datasetId: z.string(),
  fileName: z.string(),
  sheet: z.string(),
  totalRows: z.number().int().min(0),
  /** Righe con un nome prodotto leggibile: le uniche che verranno analizzate. */
  usableRows: z.number().int().min(0),
  /**
   * Prodotti distinti stimati dal testo grezzo.
   *
   * La ricerca costa per variante, non per riga: due righe con lo stesso testo
   * pagano una volta sola. Il conteggio vero delle varianti arriva
   * dall'analisi, quindi questo è il limite superiore.
   */
  estimatedVariants: z.number().int().min(0),
  /** Spesa IA massima: analisi di ogni riga più verifica di ogni candidato. */
  maxCostUsd: z.number().min(0),
  /** Chiamate di ricerca massime: una per variante più i dettagli. */
  maxSearchCalls: z.number().int().min(0),
  estimatedSeconds: z.number().int().min(0),
  /** Mappatura dedotta dalle intestazioni: si mostra per poterla smentire. */
  mapping: z.array(DatasetMappingSchema),
  /** Problemi che impedirebbero di partire (nessuna colonna nome, foglio vuoto). */
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type TaobaoPipelineEstimate = z.infer<typeof TaobaoPipelineEstimateSchema>;

/* -------------------------------------------------------------------------- */
/* Avvio                                                                       */
/* -------------------------------------------------------------------------- */

export const StartTaobaoPipelineRequestSchema = z.object({
  /** Mappatura confermata; se manca si usa quella dedotta dal preventivo. */
  mapping: z.array(DatasetMappingSchema).optional(),
  /** Ricarico del report finale: modificabile anche dopo, al download. */
  markupPct: z.coerce.number().min(0).max(500).default(15),
  /**
   * Quante volte insistere sulle righe senza un prodotto coerente.
   *
   * Ogni giro è: ri-ricerca guidata dai difetti + riverifica dei nuovi
   * candidati. Zero disattiva la ri-ricerca; il valore predefinito è la scelta
   * di equilibrio fra copertura e spesa.
   */
  maxRefineRounds: z.coerce.number().int().min(0).max(5).default(2),
  /** Ricerca completa anche per le varianti già conosciute. */
  forceFullSearch: z.boolean().default(false),
  /** Lingua dell'interfaccia, salvata perché la pipeline prosegue in background. */
  locale: z.enum(["it", "en", "zh"]).default("it"),
});
export type StartTaobaoPipelineRequest = z.infer<typeof StartTaobaoPipelineRequestSchema>;

export const AnswerTaobaoPipelineRequestSchema = z.object({
  answers: z
    .array(
      z.object({
        clarificationId: z.string().min(1),
        /** Testo della risposta; vuoto insieme a `skip` significa «non chiedere più». */
        answer: z.string().default(""),
        /** Archivia la domanda invece di rispondere: si decide riga per riga. */
        skip: z.boolean().default(false),
      })
    )
    .min(1),
});
export type AnswerTaobaoPipelineRequest = z.infer<typeof AnswerTaobaoPipelineRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Lo stato che la pagina legge                                                */
/* -------------------------------------------------------------------------- */

/** Una riga che è arrivata in fondo senza un prodotto di cui fidarsi. */
export const TaobaoPipelineGapSchema = z.object({
  rowNumber: z.number().int(),
  displayName: z.string(),
  searchQuery: z.string().nullable(),
  /**
   * Perché è scoperta: nessun candidato, nessuno giudicato coerente, oppure
   * — `not_procurable` — perché quella riga non è un articolo di marketplace
   * e nessuna ricerca l'avrebbe mai trovata.
   */
  reason: z.enum([
    "no_results",
    "no_coherent",
    "failed",
    "low_confidence",
    "not_procurable",
  ]),
  /** Dettaglio già leggibile: errore della fonte o motivi dell'incoerenza. */
  detail: z.string().nullable(),
});
export type TaobaoPipelineGap = z.infer<typeof TaobaoPipelineGapSchema>;

/**
 * Un dubbio tecnico che la v2 ha gestito senza trasformarlo in domanda.
 *
 * Il codice e la categoria restano strutturati: il testo visibile viene
 * localizzato dalla pagina, mentre `detail` conserva l'evidenza prodotta
 * dall'analisi o dalla verifica. In questo modo una bassa confidenza o un dato
 * da controllare su Taobao non possono finire accidentalmente nel canale delle
 * domande rivolte all'utente.
 */
export const TAOBAO_PIPELINE_REVIEW_CATEGORIES = [
  "INTERNAL",
  "TAOBAO_CHECK",
  "ROW_REVIEW",
] as const;
export const TaobaoPipelineReviewCategorySchema = z.enum(
  TAOBAO_PIPELINE_REVIEW_CATEGORIES
);
export type TaobaoPipelineReviewCategory = z.infer<
  typeof TaobaoPipelineReviewCategorySchema
>;

export const TaobaoPipelineReviewIssueSchema = z.object({
  rowNumber: z.number().int(),
  displayName: z.string(),
  category: TaobaoPipelineReviewCategorySchema,
  code: z.string(),
  attributeKey: z.string().nullable(),
  detail: z.string().nullable(),
  /** `true` quando il dato è stato normalizzato o verificato automaticamente. */
  resolvedAutomatically: z.boolean(),
});
export type TaobaoPipelineReviewIssue = z.infer<
  typeof TaobaoPipelineReviewIssueSchema
>;

/** Il risultato in una riga sola, quando l'elaborazione è finita. */
export const TaobaoPipelineOutcomeSchema = z.object({
  totalRows: z.number().int().min(0),
  /** Righe con almeno un prodotto giudicato coerente dall'IA. */
  confirmedRows: z.number().int().min(0),
  /** Righe con prodotti ma senza verdetto di coerenza positivo. */
  uncertainRows: z.number().int().min(0),
  /**
   * Righe senza nulla di utilizzabile che una ricerca migliore potrebbe
   * ancora salvare. Le righe non acquistabili non sono qui: contarle insieme
   * significherebbe promettere un recupero impossibile.
   */
  uncoveredRows: z.number().int().min(0),
  /**
   * Righe che non sono articoli da marketplace (moduli da stampare, codici di
   * costruttore, servizi). Il default tiene leggibili gli esiti salvati prima
   * che l'analisi sapesse riconoscerle.
   */
  notProcurableRows: z.number().int().min(0).default(0),
  reusedRows: z.number().int().min(0),
  totalCostUsd: z.number().min(0),
  searchCalls: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  refineRounds: z.number().int().min(0),
  recoveredRows: z.number().int().min(0),
  gaps: z.array(TaobaoPipelineGapSchema),
  /**
   * Avvisi non bloccanti da rivedere. Il default mantiene leggibili gli esiti
   * v2 creati prima che la revisione strutturata fosse introdotta.
   */
  reviewIssues: z.array(TaobaoPipelineReviewIssueSchema).default([]),
});
export type TaobaoPipelineOutcome = z.infer<typeof TaobaoPipelineOutcomeSchema>;

export const TaobaoPipelineStateSchema = z.object({
  pipelineId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  datasetId: z.string(),
  fileName: z.string(),
  totalRows: z.number().int().min(0),
  status: TaobaoPipelineStatusSchema,
  phase: TaobaoPipelinePhaseSchema,
  /** 0-100. Monotono: non torna mai indietro, nemmeno fra un giro e l'altro. */
  progress: z.number().int().min(0).max(100),
  step: TaobaoPipelineStepSchema,
  /** Valori da inserire nella frase di `step`, già pronti. */
  stepParams: z.record(z.string(), z.union([z.string(), z.number()])),
  /** Fasi già concluse: la pagina le spunta senza doverlo dedurre. */
  completedPhases: z.array(TaobaoPipelinePhaseSchema),
  /** Domande a cui rispondere adesso; vuoto se non è in pausa. */
  questions: z.array(TaobaoClarificationSchema),
  /** Quante volte l'IA ha già chiesto: serve a non far sembrare infinito il flusso. */
  questionRound: z.number().int().min(0),
  analysisRunId: z.string().nullable(),
  jobId: z.string().nullable(),
  markupPct: z.number().min(0),
  outcome: TaobaoPipelineOutcomeSchema.nullable(),
  error: z.string().nullable(),
  /** Data del caricamento del file, distinta dall'avvio dell'elaborazione. */
  uploadedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type TaobaoPipelineState = z.infer<typeof TaobaoPipelineStateSchema>;

/* -------------------------------------------------------------------------- */
/* Pesi dell'avanzamento                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Quanto pesa ogni fase sulla barra.
 *
 * Non sono frazioni uguali: la ricerca dura minuti e l'analisi decine di
 * secondi, mentre approvazione e report sono istantanei. Una barra a fasi
 * uguali starebbe ferma al 40% per il 90% del tempo — che è il modo più
 * semplice di far credere che si sia bloccata.
 */
export const TAOBAO_PIPELINE_PHASE_WEIGHTS: Record<TaobaoPipelinePhase, number> = {
  QUEUED: 0,
  ANALYSIS: 25,
  QUESTIONS: 5,
  REVIEW: 5,
  SEARCH: 45,
  VERIFY: 12,
  REFINE: 6,
  REPORT: 2,
};

/** Percentuale già maturata quando una fase inizia. */
export function pipelineProgressFloor(phase: TaobaoPipelinePhase): number {
  let total = 0;
  for (const entry of TAOBAO_PIPELINE_PHASES) {
    if (entry === phase) break;
    total += TAOBAO_PIPELINE_PHASE_WEIGHTS[entry];
  }
  return total;
}

/**
 * Avanzamento complessivo: base della fase più la sua quota parte.
 *
 * `ratio` fuori da 0-1 viene riportato dentro invece che sollevare: un
 * contatore che supera il totale — succede, quando una fase rifà righe già
 * contate — deve dare una barra piena, non un'eccezione a metà elaborazione.
 */
export function pipelineProgress(phase: TaobaoPipelinePhase, ratio: number): number {
  // `NaN` è l'unico caso che non si può riportare dentro: nasce da una
  // divisione per zero (`done / total` con zero righe) e vuol dire «non lo so
  // ancora», che a inizio fase è zero. Un infinito invece è un «oltre il
  // totale», e va letto come fase conclusa.
  const clamped = Number.isNaN(ratio) ? 0 : Math.min(1, Math.max(0, ratio));
  const floor = pipelineProgressFloor(phase);
  return Math.round(floor + TAOBAO_PIPELINE_PHASE_WEIGHTS[phase] * clamped);
}
