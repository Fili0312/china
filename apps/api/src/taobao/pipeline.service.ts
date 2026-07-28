import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  PROCUREMENT_KIND_LABELS,
  ProductAnalysisSchema,
  isMarketplaceProcurement,
  isSearchableProcurement,
  pipelineProgress,
  procurementOf,
  TAOBAO_PIPELINE_PHASE_WEIGHTS,
  type AnalysisWarning,
  type AnswerTaobaoPipelineRequest,
  type DatasetMapping,
  type ProductAnalysis,
  type StartTaobaoPipelineRequest,
  type TaobaoClarification,
  type TaobaoPipelineEstimate,
  type TaobaoPipelineGap,
  type TaobaoPipelineOutcome,
  type TaobaoPipelinePhase,
  type TaobaoPipelineState,
  type TaobaoPipelineStep,
} from "@china/shared";
import { t } from "../i18n/messages";
import {
  ClarificationService,
  classifyV2Doubt,
} from "./clarification.service";
import { ClientService } from "./client.service";
import { CoherenceService } from "./coherence.service";
import { RefineService } from "./refine.service";
import { TaobaoAnalysisService } from "./taobao-analysis.service";
import { TaobaoDatasetService } from "./taobao-dataset.service";
import { TaobaoJobService } from "./taobao-job.service";
import {
  isV2NoCompatibleReason,
  isV2WarningRelevant,
} from "./v2-requirement-policy";
import {
  type V2PipelineHumanAction,
  type V2PipelineReviewIssue,
  v2CandidateCoherence,
} from "./v2-review-contract";

/**
 * Traduce un dubbio USER_INPUT in una delle sole cinque azioni ammesse.
 *
 * Usa codice e campo strutturati, mai il messaggio localizzato: il campanello
 * deve avere lo stesso significato in italiano, inglese e cinese.
 */
export function v2HumanActionForWarning(
  warning: AnalysisWarning
): V2PipelineHumanAction {
  const field = (warning.field ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (/(?:variant|sku|option)/u.test(field)) return "CHOOSE_VARIANT";
  if (/(?:tolerance|tolleranza)/u.test(field)) return "CHANGE_TOLERANCE";
  if (/(?:equivalent|alternative|substitute)/u.test(field)) {
    return "APPROVE_EQUIVALENT";
  }
  if (/(?:availability|unavailable|stock)/u.test(field)) {
    return "MARK_UNAVAILABLE";
  }
  if (warning.code === "AMBIGUOUS_MODEL") return "APPROVE_EQUIVALENT";
  if (warning.code === "AMBIGUOUS_MEASURE") return "CHANGE_TOLERANCE";
  return "CLARIFY_REQUIREMENT";
}

/**
 * L'elaborazione che si guida da sola.
 *
 * Concatena i servizi che la v1 espone come pulsanti separati — analisi,
 * revisione, ricerca, verifica, ri-ricerca — e prende da sé le decisioni che
 * lì prende l'operatore. Non contiene logica di dominio propria: se qui ci
 * finisse una regola su come si cerca o come si giudica un prodotto, sarebbe
 * la seconda copia di una regola che vive altrove, e le due divergerebbero.
 * Questo file decide **cosa fare dopo**, mai *come* farlo.
 *
 * ## Perché una macchina a stati e non una funzione
 *
 * Una corsa dura minuti e si ferma nel mezzo per fare domande. Scritta come
 * una funzione lineare, vivrebbe nello stack di una richiesta HTTP: chi chiude
 * la scheda perderebbe l'analisi già pagata, e una domanda in sospeso terrebbe
 * aperta una connessione per il tempo che l'operatore impiega a rispondere.
 * Ogni transizione qui è invece scritta nel database, e `resume()` riparte da
 * `phase` — la stessa forma che `TaobaoRunnerService` usa già per i job.
 *
 * ## Le decisioni automatiche, e il loro perché
 *
 * - **Mappatura**: si accetta quella dedotta dalle intestazioni. Senza una
 *   colonna «nome prodotto» non si parte affatto: è l'unico campo da cui si
 *   ricava una query, e proseguire darebbe righe vuote invece di un errore.
 * - **Domande**: dopo l'analisi si guarda cosa è rimasto aperto. Se c'è, ci si
 *   ferma. Rispondere cambia il prompt delle analisi successive, quindi dopo
 *   le risposte l'analisi si **rifà** — le righe già capite arrivano dalla
 *   cache e non si ripagano, quelle bloccate ci riprovano con la conoscenza in
 *   più.
 * - **Righe poco sicure**: vanno in revisione tecnica e non diventano domande.
 *   La bassa confidenza da sola non è un'informazione che l'utente possa
 *   necessariamente integrare e non deve fermare le altre righe.
 * - **Ri-ricerca**: si insiste finché ogni giro recupera qualcosa, fino al
 *   tetto (`maxRefineRounds`, 2 di serie). Un giro che non recupera nulla è il
 *   segnale che il problema non è la query: continuare spenderebbe soltanto.
 */

/**
 * Quanti candidati giudicare alla prima passata di verifica.
 *
 * Tenerlo basso è giusto: il ranking mette davanti i più promettenti e ogni
 * giudizio costa. Le righe che restano scoperte le recupera la seconda passata.
 */
const V2_VERIFY_TOP_N = (() => {
  const parsed = Number(process.env.V2_VERIFY_TOP_N);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
})();

/**
 * Fin dove spingersi sulle righe rimaste senza un prodotto promosso.
 *
 * Copre tutti i candidati che la ricerca ha già portato a casa: sono pagati,
 * non giudicarli è l'unico spreco che resta.
 */
const V2_VERIFY_DEEP_TOP_N = (() => {
  const parsed = Number(process.env.V2_VERIFY_DEEP_TOP_N);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
})();

/** Ogni quanto si rilegge lo stato di un job in corso. */
const JOB_POLL_MS = 3000;

/**
 * Su quanti candidati per riga si chiede la scheda completa.
 *
 * Lo stesso valore serve al preventivo e al job: se i due divergessero, il
 * tetto annunciato prima di partire non sarebbe più un tetto.
 */
const DETAIL_TOP_N = 3;

/**
 * Chiamate di ricerca che una singola variante può arrivare a costare.
 *
 * Non è «una ricerca e via», e la differenza si è vista: una prima versione
 * contava `1 + dettagli` e annunciava 20 chiamate per una corsa che poi ne ha
 * fatte 45. I tre addendi sono tre strade che il runner può percorrere **tutte
 * per la stessa variante**:
 *
 * - `TAOBAO_REFRESH_LIMIT` — se la variante è già in memoria, i prodotti
 *   salvati vengono riletti alla fonte uno per uno prima di decidere se
 *   bastano. È l'addendo più grosso, ed è invisibile a chi pensa «già
 *   conosciuta = gratis».
 * - la scala delle query — una ricerca che non trova nulla viene ritentata
 *   con forme via via più corte, fino a `MAX_ATTEMPTS` volte.
 * - i dettagli — una scheda completa per ognuno dei primi candidati.
 *
 * Il valore si legge dalle stesse variabili d'ambiente che legge il runner:
 * un tetto calcolato su costanti proprie smetterebbe di essere un tetto al
 * primo `.env` modificato.
 */
function maxCallsPerVariant(): number {
  return numericEnv("TAOBAO_REFRESH_LIMIT", 12) + QUERY_LADDER_ATTEMPTS + DETAIL_TOP_N;
}

/**
 * Il tetto completo, varianti e giri di ri-ricerca compresi.
 *
 * Esportata perché è l'unico pezzo del preventivo che vale la pena fissare a
 * test, e perché a un test serve la formula, non mezzo modulo Nest attorno.
 */
export function maxSearchCallsCeiling(variants: number, refineRounds: number): number {
  return (
    variants * maxCallsPerVariant() +
    refineRounds * variants * (QUERY_LADDER_ATTEMPTS + DETAIL_TOP_N)
  );
}

/** Tentativi della scala delle query, come in `providers/query-ladder.ts`. */
const QUERY_LADDER_ATTEMPTS = 3;

/**
 * Quante domande al massimo prima di procedere comunque.
 *
 * Le domande sono utili finché sono poche: oltre, si smette di leggerle e si
 * risponde a caso, che è peggio del non chiedere. Dopo questi giri il sistema
 * va avanti e segnala nel riepilogo le righe rimaste incerte.
 */
export const V2_MAX_QUESTION_ROUNDS = 1;

export function canOpenPipelineQuestions(questionRound: number): boolean {
  return questionRound < V2_MAX_QUESTION_ROUNDS;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export interface PipelineReviewSourceRow {
  rowNumber: number;
  submittedText: string;
  analysis: ProductAnalysis | null;
  error: string | null;
}

/**
 * Il buco di una riga che non è un articolo da marketplace.
 *
 * Restituisce `null` quando la riga è merce normale — così chi chiama scrive
 * `?? altro` e la regola resta in un punto solo. Il nome del prodotto e la
 * query si prendono dall'analisi perché queste righe spesso non hanno mai
 * avuto una riga di job: la ricerca non è stata nemmeno tentata.
 */
function procurementGap(
  source: PipelineReviewSourceRow | undefined,
  fallback: { displayName?: string | null; searchQuery?: string | null } = {}
): TaobaoPipelineGap | null {
  const analysis = source?.analysis;
  if (!analysis) return null;
  const kind = procurementOf(analysis);
  if (isMarketplaceProcurement(kind)) return null;
  const label = PROCUREMENT_KIND_LABELS.en[kind];
  const why = analysis.procurement.reason?.trim();
  return {
    rowNumber: source!.rowNumber,
    displayName:
      fallback.displayName ||
      analysis.productNameEnglish ||
      analysis.productNameChinese ||
      analysis.productFamily ||
      `#${source!.rowNumber}`,
    searchQuery: fallback.searchQuery ?? analysis.searchQueryChinese ?? null,
    reason: "not_procurable",
    detail: why ? `${label} · ${why}` : label,
  };
}

/** Solo una decisione USER_INPUT resta un'azione umana irrisolta. */
export function hasPendingPipelineDecision(
  row: PipelineReviewSourceRow
): boolean {
  if (!row.analysis) return false;
  return row.analysis.warnings.some(
    (warning) =>
      isV2WarningRelevant(warning, row.submittedText, row.analysis!) &&
      classifyV2Doubt(
        warning.code,
        row.submittedText,
        warning.message,
        warning.field
      ) === "USER_INPUT"
  );
}

/**
 * Converte i dubbi rimasti in revisione strutturata, senza aprire domande.
 *
 * È pura per poter provare con provider simulati che INTERNAL/TAOBAO_CHECK e
 * bassa confidenza non fermino la pipeline. Un warning ancora USER_INPUT dopo
 * l'unico giro consentito ricade deliberatamente in ROW_REVIEW.
 */
export function buildPipelineReviewIssues(
  rows: readonly PipelineReviewSourceRow[],
  _confirmedRows: ReadonlySet<number>,
  minConfidence: number
): V2PipelineReviewIssue[] {
  const issues = new Map<string, V2PipelineReviewIssue>();

  for (const row of rows) {
    const analysis = row.analysis;
    const displayName =
      analysis?.productNameEnglish ??
      analysis?.productNameChinese ??
      analysis?.productFamily ??
      `#${row.rowNumber}`;

    if (!analysis) {
      issues.set(`${row.rowNumber}:ANALYSIS_FAILED`, {
        rowNumber: row.rowNumber,
        displayName,
        category: "ROW_REVIEW",
        code: "ANALYSIS_FAILED",
        attributeKey: null,
        detail: row.error,
        // Il fallimento è già un gap della riga; non è una decisione da
        // chiedere all'utente nella sezione azioni.
        resolvedAutomatically: true,
        humanAction: null,
      });
      continue;
    }

    // Una riga che non verrà cercata non ha dubbi da sciogliere: chiedere
    // l'unità di misura di un modulo da stampare è tempo di una persona
    // speso su una riga che non diventerà mai un acquisto.
    if (!isSearchableProcurement(procurementOf(analysis))) continue;

    for (const warning of analysis.warnings) {
      if (
        !isV2WarningRelevant(
          warning,
          row.submittedText,
          analysis
        )
      ) {
        continue;
      }
      const classified = classifyV2Doubt(
        warning.code,
        row.submittedText,
        warning.message,
        warning.field
      );
      const category = classified === "USER_INPUT" ? "ROW_REVIEW" : classified;
      const attributeKey = warning.field ?? warning.code;
      const key = `${row.rowNumber}:${category}:${warning.code}:${attributeKey}`;
      issues.set(key, {
        rowNumber: row.rowNumber,
        displayName,
        category,
        code: warning.code,
        attributeKey,
        detail: warning.message || null,
        // Soltanto una decisione che può prendere il cliente resta aperta.
        // Dubbi interni, Taobao o informativi sono già stati normalizzati,
        // verificati o convertiti in un gap dopo i retry.
        resolvedAutomatically: classified !== "USER_INPUT",
        humanAction:
          classified === "USER_INPUT"
            ? v2HumanActionForWarning(warning)
            : null,
      });
    }

    if (analysis.confidence < minConfidence) {
      issues.set(`${row.rowNumber}:ROW_REVIEW:LOW_CONFIDENCE`, {
        rowNumber: row.rowNumber,
        displayName,
        category: "ROW_REVIEW",
        code: "LOW_CONFIDENCE",
        attributeKey: "confidence",
        detail: null,
        // La confidenza non è mai una decisione commerciale. Un eventuale
        // fallimento della ricerca è rappresentato nei gap, non come azione.
        resolvedAutomatically: true,
        humanAction: null,
      });
    }
  }

  return [...issues.values()].sort(
    (left, right) =>
      left.rowNumber - right.rowNumber ||
      left.code.localeCompare(right.code) ||
      (left.attributeKey ?? "").localeCompare(right.attributeKey ?? "")
  );
}

/** Stato di avanzamento scritto in una volta sola. */
interface StepPatch {
  phase?: TaobaoPipelinePhase;
  step?: TaobaoPipelineStep;
  params?: Record<string, string | number>;
  /** Quota della fase completata, 0-1. */
  ratio?: number;
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger("Pipeline");
  /** Corse vive in questo processo: evita che due `resume` si accavallino. */
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly clients: ClientService,
    private readonly datasets: TaobaoDatasetService,
    private readonly analysis: TaobaoAnalysisService,
    private readonly jobs: TaobaoJobService,
    private readonly coherence: CoherenceService,
    private readonly refine: RefineService,
    private readonly clarifications: ClarificationService
  ) {}

  /* ---------------------------------------------------------------- */
  /* Preventivo                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Cosa costerà, prima di spendere un centesimo.
   *
   * Legge il foglio già caricato e stima. Le stime sono al rialzo di proposito:
   * si mostrano per decidere se partire, e un numero ottimista che poi sfora
   * toglie senso alla schermata.
   */
  async estimate(clientId: string, datasetId: string): Promise<TaobaoPipelineEstimate> {
    const preview = await this.datasets.getDataset(clientId, datasetId, 5);
    const mapping = preview.suggestedMapping.length
      ? (preview.suggestedMapping as DatasetMapping[])
      : preview.columns
          .filter((column) => column.suggestedField && column.suggestedField !== "ignore")
          .map((column) => ({
            columnIndex: column.index,
            field: column.suggestedField!,
          }));

    const blockers: string[] = [];
    if (!mapping.some((entry) => entry.field === "name")) {
      blockers.push(t("err.needNameColumn"));
    }
    if (preview.totalRows === 0) blockers.push(t("err.fileNoRows"));

    const { rows, columnIndexes } = await this.datasets.loadRows(datasetId);
    const nameColumns = mapping
      .filter((entry) => entry.field === "name")
      .map((entry) => columnIndexes.indexOf(entry.columnIndex))
      .filter((index) => index >= 0);

    // Righe utilizzabili e varianti approssimate: due righe con lo stesso
    // testo nelle colonne di nome pagheranno una ricerca sola.
    const signatures = new Set<string>();
    let usableRows = 0;
    for (const row of rows) {
      const name = nameColumns
        .map((index) => (row.cells[index] ?? "").trim())
        .filter(Boolean)
        .join(" ");
      if (!name) continue;
      usableRows += 1;
      signatures.add(name.toLowerCase().replace(/\s+/g, " "));
    }

    // Costo per riga e per candidato verificato: sono i due prezzi unitari
    // che cambiano se si cambia provider, e per questo stanno nel `.env`.
    const perRowUsd = numericEnv("PIPELINE_COST_PER_ROW_USD", 0.00035);
    const perVerifyUsd = numericEnv("PIPELINE_COST_PER_VERIFY_USD", 0.00008);
    // Il caso peggiore: ogni variante paga rilettura, scala delle query e
    // dettagli, e ogni giro di ri-ricerca rifà query e dettagli.
    const refineRounds = numericEnv("PIPELINE_DEFAULT_REFINE_ROUNDS", 2);
    const maxSearchCalls = maxSearchCallsCeiling(signatures.size, refineRounds);

    return {
      datasetId: preview.datasetId,
      fileName: preview.fileName,
      sheet: preview.sheet,
      totalRows: preview.totalRows,
      usableRows,
      estimatedVariants: signatures.size,
      maxCostUsd: Number((usableRows * perRowUsd + usableRows * 3 * perVerifyUsd).toFixed(4)),
      maxSearchCalls,
      // Le chiamate non sono seriali: il runner ne tiene diverse in volo.
      estimatedSeconds: Math.round(usableRows * 1.2 + maxSearchCalls * 0.5 + 20),
      mapping,
      blockers,
      warnings: preview.warnings,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Avvio, ripresa, risposta                                          */
  /* ---------------------------------------------------------------- */

  async start(
    clientId: string,
    datasetId: string,
    input: StartTaobaoPipelineRequest
  ): Promise<TaobaoPipelineState> {
    const estimate = await this.estimate(clientId, datasetId);
    const mapping = input.mapping?.length ? input.mapping : estimate.mapping;
    if (!mapping.some((entry) => entry.field === "name")) {
      throw new BadRequestException(t("err.needNameColumn"));
    }

    // Un doppio click o la riapertura della pagina non deve creare una seconda
    // corsa sullo stesso file mentre la prima è ancora viva.
    const active = await prisma.taobaoPipeline.findFirst({
      where: {
        clientId,
        datasetId,
        status: { in: ["RUNNING", "WAITING_ANSWERS"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (active) {
      if (active.status === "RUNNING") this.resume(active.id);
      return this.state(clientId, active.id);
    }

    const pipeline = await prisma.taobaoPipeline.create({
      data: {
        clientId,
        datasetId,
        mapping: toJson(mapping),
        markupPct: input.markupPct,
        maxRefineRounds: input.maxRefineRounds,
        forceFullSearch: input.forceFullSearch,
        locale: input.locale,
        status: "RUNNING",
        phase: "QUEUED",
        step: "step.queued",
        startedAt: new Date(),
      },
      select: { id: true },
    });

    this.resume(pipeline.id);
    return this.state(clientId, pipeline.id);
  }

  /**
   * Registra le risposte e riprende.
   *
   * Le risposte entrano nella conoscenza permanente (`ClarificationService`),
   * quindi valgono anche per i file successivi: la stessa domanda non si ripete
   * mai, che è la ragione per cui vale la pena fermarsi a chiedere.
   */
  async answer(
    clientId: string,
    pipelineId: string,
    input: AnswerTaobaoPipelineRequest
  ): Promise<TaobaoPipelineState> {
    const pipeline = await this.load(clientId, pipelineId);
    if (pipeline.status !== "WAITING_ANSWERS") {
      throw new BadRequestException(t("err.pipelineNotWaiting"));
    }

    for (const entry of input.answers) {
      await this.clarifications.answerForPipeline(clientId, pipelineId, entry.clarificationId, {
        ...(entry.skip ? { dismiss: true } : { answer: entry.answer }),
      });
    }

    // Accetta anche risposte parziali senza perdere lo stato: la pipeline resta
    // in pausa finché tutte e sole le sue domande sono state chiuse.
    const remaining = await this.clarifications.listForPipeline(
      clientId,
      pipelineId,
      "OPEN"
    );
    if (remaining.length > 0) return this.state(clientId, pipelineId);

    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: { status: "RUNNING", questionRound: { increment: 1 } },
    });
    this.resume(pipelineId);
    return this.state(clientId, pipelineId);
  }

  async cancel(clientId: string, pipelineId: string): Promise<TaobaoPipelineState> {
    const pipeline = await this.load(clientId, pipelineId);
    this.cancelled.add(pipelineId);
    if (pipeline.jobId) this.jobs.cancel(clientId, pipeline.jobId).catch(() => undefined);
    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: { status: "CANCELLED", step: "step.cancelled", finishedAt: new Date() },
    });
    return this.state(clientId, pipelineId);
  }

  /** Fa ripartire una corsa senza bloccare la richiesta che l'ha chiesta. */
  private resume(pipelineId: string): void {
    if (this.running.has(pipelineId)) return;
    this.running.add(pipelineId);
    void this.run(pipelineId)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : t("err.unexpected");
        this.logger.error(`pipeline ${pipelineId} interrotta: ${message}`);
        await prisma.taobaoPipeline
          .update({
            where: { id: pipelineId },
            data: {
              status: "FAILED",
              step: "step.failed",
              error: message.slice(0, 500),
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(pipelineId);
        this.cancelled.delete(pipelineId);
      });
  }

  /* ---------------------------------------------------------------- */
  /* La macchina a stati                                               */
  /* ---------------------------------------------------------------- */

  private async run(pipelineId: string): Promise<void> {
    // Il ciclo riprende dalla fase salvata: la stessa funzione serve sia la
    // prima partenza sia il rientro dopo una pausa per domande.
    for (;;) {
      if (this.cancelled.has(pipelineId)) return;
      const pipeline = await prisma.taobaoPipeline.findUnique({ where: { id: pipelineId } });
      if (!pipeline) return;
      if (pipeline.status !== "RUNNING") return;

      switch (pipeline.phase) {
        case "QUEUED":
        case "ANALYSIS":
          await this.runAnalysis(pipelineId);
          break;
        case "QUESTIONS":
          // Ci si arriva solo dopo aver risposto: le domande aperte sono state
          // chiuse, quindi si rianalizza per applicarle alle righe ferme.
          await this.runAnalysis(pipelineId);
          break;
        case "REVIEW":
          await this.runReview(pipelineId);
          break;
        case "SEARCH":
          await this.runSearch(pipelineId);
          break;
        case "VERIFY":
          await this.runVerify(pipelineId);
          break;
        case "REFINE":
          await this.runRefine(pipelineId);
          break;
        case "REPORT":
          await this.runReport(pipelineId);
          return;
      }
    }
  }

  /** 1-2. Analisi delle righe, poi le domande che ne sono uscite. */
  private async runAnalysis(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    const reanalysis = pipeline.questionRound > 0;

    await this.step(pipelineId, {
      phase: "ANALYSIS",
      step: reanalysis ? "step.reanalysing" : "step.analysing",
      ratio: 0.05,
    });

    const run = await this.analysis.startRun(
      pipeline.clientId,
      pipeline.datasetId,
      {
        mapping: pipeline.mapping as DatasetMapping[],
        ignoreCache: false,
      },
      {
        pipelineId,
        locale: pipeline.locale,
        allowQuestions: canOpenPipelineQuestions(pipeline.questionRound),
      }
    );

    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: { analysisRunId: run.runId },
    });
    await this.step(pipelineId, {
      phase: "ANALYSIS",
      step: "step.analysingRows",
      params: { analysed: run.analyzedRows, total: run.totalRows },
      ratio: 1,
    });

    // Solo domande appartenenti a questa corsa. Bassa confidenza, problemi di
    // singola riga e dati da verificare sull'inserzione restano in revisione.
    const open = await this.clarifications.listForPipeline(
      pipeline.clientId,
      pipelineId,
      "OPEN"
    );

    const askable = open.length > 0 && canOpenPipelineQuestions(pipeline.questionRound);
    if (askable) {
      await this.step(pipelineId, {
        phase: "QUESTIONS",
        step: "step.questions",
        params: { count: open.length },
        ratio: 0,
      });
      await prisma.taobaoPipeline.update({
        where: { id: pipelineId },
        data: { status: "WAITING_ANSWERS", phase: "QUESTIONS" },
      });
      return;
    }

    await this.completePhase(pipelineId, "ANALYSIS");
    if (pipeline.questionRound > 0) await this.completePhase(pipelineId, "QUESTIONS");
    await this.step(pipelineId, { phase: "REVIEW", step: "step.approving", ratio: 0 });
    await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { phase: "REVIEW" } });
  }

  /**
   * 3. Approvazione automatica.
   *
   * Restano `NEEDS_REVIEW` le righe su cui l'IA ha dubbi che nessuna domanda
   * ha risolto — o perché le domande sono finite, o perché il dubbio riguarda
   * quella riga sola. La v2 non le spaccia per «approvate dall'utente»: le
   * conserva come revisione tecnica e autorizza il proprio job a cercarle.
   * Il percorso v1 continua invece a richiedere la conferma esplicita.
   */
  private async runReview(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    if (!pipeline.analysisRunId) throw new BadRequestException(t("err.analysisNotFound", { id: "-" }));

    const pending = await prisma.taobaoAnalysisRow.findMany({
      where: {
        runId: pipeline.analysisRunId,
        state: "NEEDS_REVIEW",
        effectiveAnalysis: { not: Prisma.DbNull },
      },
      select: { id: true },
    });

    if (this.cancelled.has(pipelineId)) return;
    await this.step(pipelineId, {
      phase: "REVIEW",
      step: "step.approving",
      params: { done: pending.length, total: pending.length },
      ratio: 1,
    });

    await this.completePhase(pipelineId, "REVIEW");
    await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { phase: "SEARCH" } });
  }

  /** 4. Ricerca su Taobao, seguita fino alla fine. */
  private async runSearch(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    if (!pipeline.analysisRunId) throw new BadRequestException(t("err.jobNoAnalysis"));

    let jobId = pipeline.jobId;
    if (!jobId) {
      await this.step(pipelineId, { phase: "SEARCH", step: "step.searchStarting", ratio: 0 });
      const job = await this.jobs.createJob(pipeline.clientId, pipeline.datasetId, {
        mapping: pipeline.mapping as DatasetMapping[],
        analysisRunId: pipeline.analysisRunId,
        forceFullSearch: pipeline.forceFullSearch,
        // I provider secondari restano in standby come nella v1: accenderli
        // qui cambierebbe i costi senza che nessuno lo abbia chiesto.
        useBrowser: false,
        useElim: false,
        use1688: false,
        maxCandidates: 10,
        detailTopN: DETAIL_TOP_N,
        reviewTopN: 0,
      }, {
        // Solo la v2: i dubbi tecnici non bloccano le altre righe e restano
        // visibili nel riepilogo invece di fingersi approvati da una persona.
        allowReviewRows: true,
      });
      jobId = job.jobId;
      await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { jobId } });
    }

    await this.waitForJob(pipelineId, jobId);
    await this.completePhase(pipelineId, "SEARCH");
    await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { phase: "VERIFY" } });
  }

  /** Segue un job fino alla fine, raccontando a che riga è arrivato. */
  private async waitForJob(pipelineId: string, jobId: string): Promise<void> {
    for (;;) {
      if (this.cancelled.has(pipelineId)) return;
      const job = await prisma.taobaoJob.findUnique({
        where: { id: jobId },
        select: {
          status: true,
          processedRows: true,
          totalRows: true,
          error: true,
          rows: {
            where: { status: { in: ["SEARCHING_API", "SEARCHING_BROWSER", "REFRESHING"] } },
            select: { displayName: true },
            take: 1,
          },
        },
      });
      if (!job) throw new NotFoundException(t("err.jobNotFound", { id: jobId }));

      await this.step(pipelineId, {
        phase: "SEARCH",
        step: "step.searchRows",
        params: {
          done: job.processedRows,
          total: job.totalRows,
          name: job.rows[0]?.displayName ?? "",
        },
        ratio: job.totalRows ? job.processedRows / job.totalRows : 0,
      });

      if (job.status === "FAILED") {
        throw new Error(job.error ?? t("err.unexpected"));
      }
      if (job.status === "COMPLETED" || job.status === "COMPLETED_WITH_ERRORS") return;
      if (job.status === "CANCELLED") {
        this.cancelled.add(pipelineId);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
  }

  /** 5. Verifica di coerenza sui primi candidati di ogni riga. */
  private async runVerify(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    if (!pipeline.jobId) throw new NotFoundException(t("err.jobNotFound", { id: "-" }));

    await this.step(pipelineId, { phase: "VERIFY", step: "step.verifying", ratio: 0.1 });
    try {
      const summary = await this.coherence.verifyJob(pipeline.clientId, pipeline.jobId, {
        topN: V2_VERIFY_TOP_N,
        force: false,
      }, { mode: "v2-review" });

      // Seconda passata sui candidati già acquistati.
      //
      // La ricerca porta dieci candidati per riga, la prima verifica ne guarda
      // tre. Quando quei tre non convincono, gli altri sette sono già in
      // archivio: giudicarli non costa una sola chiamata di ricerca in più e
      // recupera righe che altrimenti finirebbero fra i «nessun risultato».
      // Le righe già risolte vengono saltate, quindi non si ripaga nulla.
      const deep = await this.coherence.verifyJob(
        pipeline.clientId,
        pipeline.jobId,
        { topN: V2_VERIFY_DEEP_TOP_N, force: false },
        { mode: "v2-review", onlyUnresolvedRows: true }
      );

      await this.step(pipelineId, {
        phase: "VERIFY",
        step: "step.verifying",
        params: {
          checked: summary.checkedCandidates + deep.checkedCandidates,
          coherent: summary.coherent + deep.coherent,
        },
        ratio: 1,
      });
    } catch (error) {
      // Senza chiave o con il fornitore giù la verifica salta, ma i prodotti
      // trovati restano validi: fermare tutto qui butterebbe la ricerca già
      // pagata per un controllo che è un di più.
      this.logger.warn(
        `pipeline ${pipelineId}: verifica saltata (${error instanceof Error ? error.message : error})`
      );
    }

    await this.completePhase(pipelineId, "VERIFY");
    await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { phase: "REFINE" } });
  }

  /**
   * 6. Ri-ricerca guidata, finché recupera.
   *
   * Un giro che non recupera nessuna riga chiude la fase: se riscrivere la
   * query non ha aiutato, riscriverla di nuovo non aiuterà, e ogni giro costa
   * chiamate di ricerca vere.
   */
  private async runRefine(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });

    if (pipeline.jobId && pipeline.refineRounds < pipeline.maxRefineRounds) {
      const round = pipeline.refineRounds + 1;
      await this.step(pipelineId, {
        phase: "REFINE",
        step: "step.refineRound",
        params: { round, total: pipeline.maxRefineRounds },
        ratio: (round - 1) / Math.max(1, pipeline.maxRefineRounds),
      });

      try {
        const summary = await this.refine.refineJob(
          pipeline.clientId,
          pipeline.jobId,
          { topN: 3 },
          { mode: "v2-review" }
        );
        await prisma.taobaoPipeline.update({
          where: { id: pipelineId },
          data: {
            refineRounds: round,
            recoveredRows: { increment: summary.rowsRecovered },
          },
        });
        await this.step(pipelineId, {
          phase: "REFINE",
          step: "step.refining",
          params: { recovered: summary.rowsRecovered, redone: summary.rowsRefined },
          ratio: round / Math.max(1, pipeline.maxRefineRounds),
        });

        // Ancora righe scoperte e il giro ha prodotto qualcosa: si riprova.
        if (summary.rowsRecovered > 0 && summary.rowsProblematic > summary.rowsRecovered) return;
      } catch (error) {
        this.logger.warn(
          `pipeline ${pipelineId}: ri-ricerca saltata (${error instanceof Error ? error.message : error})`
        );
      }
    }

    // Ultima passata prima del report, sui candidati già acquistati.
    //
    // La ri-ricerca porta candidati nuovi ma ne fa giudicare solo i primi:
    // gli altri restano senza verdetto, e una riga finisce fra i «nessun
    // risultato» mentre in archivio ha candidati che nessuno ha guardato. È
    // stato il caso di 15 righe su 28, ognuna con 7 candidati inesaminati.
    // Qui si chiude il conto: costa solo giudizi, nessuna nuova ricerca.
    if (pipeline.jobId) {
      try {
        const closing = await this.coherence.verifyJob(
          pipeline.clientId,
          pipeline.jobId,
          { topN: V2_VERIFY_DEEP_TOP_N, force: false },
          { mode: "v2-review", onlyUnresolvedRows: true }
        );
        if (closing.checkedCandidates > 0) {
          this.logger.log(
            `pipeline ${pipelineId}: passata finale su ${closing.checkedCandidates} candidati già acquistati, ${closing.coherent} recuperati`
          );
        }
      } catch (error) {
        this.logger.warn(
          `pipeline ${pipelineId}: passata finale saltata (${error instanceof Error ? error.message : error})`
        );
      }
    }

    await this.completePhase(pipelineId, "REFINE");
    await prisma.taobaoPipeline.update({ where: { id: pipelineId }, data: { phase: "REPORT" } });
  }

  /** 7. Riepilogo finale: cosa è coperto, cosa no e quanto è costato. */
  private async runReport(pipelineId: string): Promise<void> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    await this.step(pipelineId, { phase: "REPORT", step: "step.report", ratio: 0.5 });

    const outcome = await this.buildOutcome(
      pipeline.clientId,
      pipeline.analysisRunId,
      pipeline.jobId,
      pipeline.refineRounds,
      pipeline.recoveredRows
    );

    await this.completePhase(pipelineId, "REPORT");
    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: {
        status: "COMPLETED",
        step: "step.done",
        progress: 100,
        outcome: toJson(outcome),
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Rifà il conto finale di una corsa già chiusa, senza rieseguirla.
   *
   * Serve quando i verdetti cambiano sotto una corsa conclusa — un rigiudizio
   * dopo una modifica alle regole, il ritentativo di una singola riga. Senza
   * questo l'`outcome` resta quello congelato a fine corsa e le caselle in
   * alto contraddicono i gruppi del report, che invece si ricalcolano dai
   * candidati a ogni apertura della pagina.
   */
  async recomputeOutcome(pipelineId: string): Promise<TaobaoPipelineOutcome> {
    const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({
      where: { id: pipelineId },
    });
    const outcome = await this.buildOutcome(
      pipeline.clientId,
      pipeline.analysisRunId,
      pipeline.jobId,
      pipeline.refineRounds,
      pipeline.recoveredRows
    );
    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: { outcome: toJson(outcome) },
    });
    return outcome;
  }

  /**
   * Il conto finale, letto dai risultati veri.
   *
   * Le tre categorie non si sovrappongono e coprono tutte le righe:
   * **confermata** (almeno un candidato giudicato coerente), **incerta**
   * (prodotti trovati ma nessun verdetto positivo), **scoperta** (niente da
   * mostrare). L'ultima è l'unica che richiede lavoro umano, e per questo è
   * l'unica dettagliata riga per riga.
   */
  private async buildOutcome(
    clientId: string,
    analysisRunId: string | null,
    jobId: string | null,
    refineRounds: number,
    recoveredRows: number
  ): Promise<TaobaoPipelineOutcome> {
    const analysisRun = analysisRunId
      ? await prisma.taobaoAnalysisRun.findUnique({
          where: { id: analysisRunId },
          select: {
            totalRows: true,
            costUsd: true,
            rows: {
              orderBy: { rowNumber: "asc" },
              select: {
                rowNumber: true,
                signatureText: true,
                effectiveAnalysis: true,
                error: true,
                analysis: { select: { submittedText: true } },
              },
            },
          },
        })
      : null;
    const reviewSourceRows: PipelineReviewSourceRow[] =
      analysisRun?.rows.map((row) => {
        const parsed = ProductAnalysisSchema.safeParse(row.effectiveAnalysis);
        return {
          rowNumber: row.rowNumber,
          submittedText: row.analysis?.submittedText ?? row.signatureText ?? "",
          analysis: parsed.success ? parsed.data : null,
          error: row.error,
        };
      }) ?? [];

    const emptyGaps: TaobaoPipelineGap[] = reviewSourceRows.map(
      (row) =>
        procurementGap(row) ?? {
          rowNumber: row.rowNumber,
          displayName:
            row.analysis?.productNameEnglish ??
            row.analysis?.productNameChinese ??
            row.analysis?.productFamily ??
            `#${row.rowNumber}`,
          searchQuery: row.analysis?.searchQueryChinese ?? null,
          reason: row.analysis ? "no_results" : "failed",
          detail: row.error,
        }
    );
    const emptyNotProcurable = emptyGaps.filter(
      (gap) => gap.reason === "not_procurable"
    ).length;
    const empty: TaobaoPipelineOutcome = {
      totalRows: analysisRun?.totalRows ?? 0,
      confirmedRows: 0,
      uncertainRows: 0,
      uncoveredRows: emptyGaps.length - emptyNotProcurable,
      notProcurableRows: emptyNotProcurable,
      reusedRows: 0,
      totalCostUsd: analysisRun?.costUsd ?? 0,
      searchCalls: 0,
      cacheHits: 0,
      refineRounds,
      recoveredRows,
      gaps: emptyGaps,
      reviewIssues: buildPipelineReviewIssues(
        reviewSourceRows,
        new Set<number>(),
        this.analysis.minConfidence
      ),
    };
    if (!jobId) return empty;

    // La pipeline accetta fino a 1000 righe: il default paginato (500) è
    // corretto per la UI legacy, ma qui farebbe sparire metà outcome.
    const results = await this.jobs.getResults(clientId, jobId, { limit: 1000 });
    const gaps: TaobaoPipelineGap[] = [];
    const variantReviewIssues: V2PipelineReviewIssue[] = [];
    const confirmedRows = new Set<number>();
    const seenRows = new Set<number>();
    const analysisByRow = new Map(reviewSourceRows.map((row) => [row.rowNumber, row]));
    let confirmed = 0;
    let uncertain = 0;

    for (const row of results.rows) {
      seenRows.add(row.rowNumber);
      const source = analysisByRow.get(row.rowNumber);
      const usableCandidates = row.candidates.filter(
        (candidate) => !candidate.product.unavailable
      );
      // Accettati dall'IA: promossi, oppure non contestati.
      //
      // «Incerto» non è un rifiuto: è il giudice che non riesce a confermare
      // un dettaglio leggendo il solo titolo — e altra evidenza non ne
      // arriverà, perché la scheda prodotto la fonte non la serve. Trattarlo
      // come una domanda all'operatore significa mandargli a mano metà del
      // foglio: su 500 righe ne tornavano indietro 250. Chi decide resta l'IA;
      // all'operatore restano i rifiuti espliciti e le scelte commerciali.
      const coherentCandidates = usableCandidates.filter((candidate) => {
        const verdict = candidate.coherence?.verdict;
        return verdict === "coherent" || verdict === "unsure";
      });
      const readyCoherent = coherentCandidates.find(
        (candidate) =>
          v2CandidateCoherence(candidate)?.variantSelectionRequired !== true
      );
      if (readyCoherent) {
        // Un prodotto tecnicamente coerente non chiude una decisione
        // commerciale ancora aperta (equivalente/tolleranza). La workspace
        // lo mostra in "Da controllare", quindi anche i contatori outcome
        // devono classificarlo come incerto.
        if (source && hasPendingPipelineDecision(source)) {
          uncertain += 1;
          continue;
        }
        confirmed += 1;
        confirmedRows.add(row.rowNumber);
        continue;
      }
      const coherentNeedingVariant = coherentCandidates[0];
      if (coherentNeedingVariant) {
        const coherence = v2CandidateCoherence(coherentNeedingVariant);
        uncertain += 1;
        variantReviewIssues.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          category: "ROW_REVIEW",
          code: "VARIANT_SELECTION_REQUIRED",
          attributeKey: "variant",
          detail:
            coherence?.variantChoices?.join(" · ") ?? null,
          resolvedAutomatically: false,
          humanAction: "CHOOSE_VARIANT",
        });
        continue;
      }
      // Da qui in giù la riga è scoperta. Prima di dire «non trovata» si
      // guarda se fosse trovabile: un modulo da stampare o un codice che solo
      // il costruttore risolve non è un fallimento della ricerca, ed è la
      // differenza fra una riga da riprovare e una da girare al cliente.
      // L'ordine conta: chi un prodotto coerente ce l'ha è già passato dai
      // rami sopra e resta fra i confermati, qualunque cosa dica l'analisi.
      const notProcurable = procurementGap(source, {
        displayName: row.displayName,
        searchQuery: row.searchQuery,
      });
      if (notProcurable) {
        gaps.push(notProcurable);
        continue;
      }

      if (!source?.analysis || row.status === "FAILED") {
        gaps.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          searchQuery: row.searchQuery,
          reason: "failed",
          detail: source?.error ?? row.error ?? row.apiError ?? row.hwhError,
        });
        continue;
      }
      if (usableCandidates.length === 0) {
        gaps.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          searchQuery: row.searchQuery,
          reason:
            source.analysis.confidence < this.analysis.minConfidence
              ? "low_confidence"
              : "no_results",
          detail:
            row.reuseReason ??
            (row.candidates.length > 0
              ? "Tutti i candidati trovati risultano non disponibili."
              : null),
        });
        continue;
      }

      // Una vera decisione commerciale resta una riga incerta e vive nelle
      // reviewIssues; non viene spacciata per "nessun risultato".
      if (hasPendingPipelineDecision(source)) {
        uncertain += 1;
        continue;
      }

      // Dopo i retry, candidati tecnicamente incompatibili sono un buco
      // autonomamente classificato, non un'altra domanda all'utente.
      const issues = [
        ...new Set(
          usableCandidates.flatMap(
            (candidate) => candidate.coherence?.issues ?? []
          )
        ),
      ].slice(0, 3);
      // La riga ha candidati, ma il giudice li ha respinti tutti: non c'è
      // niente da confermare. «Da confermare» deve contenere solo ciò che
      // l'IA non può decidere — una scelta commerciale, una variante da
      // scegliere — non righe dove semplicemente non è stato trovato nulla
      // di buono. Su una corsa da 498 righe erano 110 su 129: si aprivano a
      // una a una per scoprire che non contenevano una proposta.
      //
      // `no_coherent` le distingue da `no_results`: la ricerca ha prodotto
      // candidati, è la verifica a non averne promosso nessuno. Il motivo
      // resta leggibile in `detail`.
      if (isV2NoCompatibleReason(row.reuseReason)) {
        gaps.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          searchQuery: row.searchQuery,
          reason: "no_coherent",
          detail: issues.length > 0 ? issues.join(" · ") : row.reuseReason,
        });
        continue;
      }

      // Se la verifica non è stata disponibile non si inventa un fallimento:
      // i candidati restano visibili come incerti, senza un'azione utente.
      const hasVerdict = usableCandidates.some(
        (candidate) => candidate.coherence?.verdict
      );
      if (!hasVerdict) {
        uncertain += 1;
        continue;
      }

      // Nessun candidato promosso e nessuno dei casi sopra: stessa sostanza
      // del ramo `no_compatible` — c'è un verdetto, ed è un rifiuto. Non è una
      // decisione che l'operatore possa prendere al posto del giudice.
      gaps.push({
        rowNumber: row.rowNumber,
        displayName: row.displayName,
        searchQuery: row.searchQuery,
        reason: "no_coherent",
        detail: issues.length > 0 ? issues.join(" · ") : null,
      });
    }

    // In caso di dati storici incompleti, nessuna riga dell'analisi deve
    // sparire soltanto perché il job non la contiene più.
    for (const source of reviewSourceRows) {
      if (seenRows.has(source.rowNumber)) continue;
      const notProcurable = procurementGap(source);
      if (notProcurable) {
        gaps.push(notProcurable);
        continue;
      }
      gaps.push({
        rowNumber: source.rowNumber,
        displayName:
          source.analysis?.productNameEnglish ??
          source.analysis?.productNameChinese ??
          source.analysis?.productFamily ??
          `#${source.rowNumber}`,
        searchQuery: source.analysis?.searchQueryChinese ?? null,
        reason:
          !source.analysis
            ? "failed"
            : source.analysis.confidence < this.analysis.minConfidence
              ? "low_confidence"
              : "no_results",
        detail: source.error,
      });
    }

    const reviewIssues = [
      ...buildPipelineReviewIssues(
        reviewSourceRows,
        confirmedRows,
        this.analysis.minConfidence
      ),
      ...variantReviewIssues,
    ].sort(
      (left, right) =>
        left.rowNumber - right.rowNumber ||
        left.code.localeCompare(right.code) ||
        (left.attributeKey ?? "").localeCompare(right.attributeKey ?? "")
    );

    // Le righe non acquistabili escono dal conto degli scoperti: restano tutte
    // in `gaps`, ma contarle insieme alle altre prometterebbe un recupero che
    // nessuna ri-ricerca può dare. I quattro numeri continuano a sommare al
    // totale, ognuno con il proprio significato.
    const notProcurable = gaps.filter(
      (gap) => gap.reason === "not_procurable"
    ).length;

    return {
      totalRows: analysisRun?.totalRows ?? results.rows.length,
      confirmedRows: confirmed,
      uncertainRows: uncertain,
      uncoveredRows: gaps.length - notProcurable,
      notProcurableRows: notProcurable,
      reusedRows: results.job.reusedRows,
      totalCostUsd: analysisRun?.costUsd ?? 0,
      searchCalls:
        results.job.usage.apiCalls +
        results.job.usage.hwhCalls +
        results.job.usage.elimCalls +
        results.job.usage.browserCalls,
      cacheHits: results.job.usage.apiCacheHits,
      refineRounds,
      recoveredRows,
      gaps,
      reviewIssues,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Lettura                                                           */
  /* ---------------------------------------------------------------- */

  async state(clientId: string, pipelineId: string): Promise<TaobaoPipelineState> {
    const pipeline = await this.load(clientId, pipelineId);
    const questions =
      pipeline.status === "WAITING_ANSWERS"
        ? await this.clarifications.listForPipeline(clientId, pipelineId, "OPEN")
        : ([] as TaobaoClarification[]);

    const rawOutcome = (pipeline.outcome as TaobaoPipelineOutcome | null) ?? null;
    const state: TaobaoPipelineState = {
      pipelineId: pipeline.id,
      clientId: pipeline.clientId,
      clientName: pipeline.client.name,
      datasetId: pipeline.datasetId,
      fileName: pipeline.dataset.fileName,
      totalRows: pipeline.dataset.rowCount,
      status: pipeline.status,
      phase: pipeline.phase,
      progress: pipeline.progress,
      step: pipeline.step as TaobaoPipelineStep,
      stepParams: (pipeline.stepParams as Record<string, string | number> | null) ?? {},
      completedPhases: pipeline.completedPhases,
      questions,
      questionRound: pipeline.questionRound,
      analysisRunId: pipeline.analysisRunId,
      jobId: pipeline.jobId,
      markupPct: pipeline.markupPct,
      outcome: rawOutcome
        ? { ...rawOutcome, reviewIssues: rawOutcome.reviewIssues ?? [] }
        : null,
      error: pipeline.error,
      uploadedAt: pipeline.dataset.createdAt.toISOString(),
      startedAt: pipeline.startedAt?.toISOString() ?? null,
      finishedAt: pipeline.finishedAt?.toISOString() ?? null,
    };
    if (state.status === "RUNNING") this.resume(state.pipelineId);
    return state;
  }

  /** Le ultime corse di un cliente, per riaprirne una senza cercarla. */
  async list(clientId: string, limit = 10): Promise<TaobaoPipelineState[]> {
    const rows = await prisma.taobaoPipeline.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    return Promise.all(rows.map((row) => this.state(clientId, row.id)));
  }

  private async load(clientId: string, pipelineId: string) {
    const pipeline = await prisma.taobaoPipeline.findUnique({
      where: { id: pipelineId },
      include: {
        client: { select: { name: true } },
        dataset: { select: { fileName: true, rowCount: true, createdAt: true } },
      },
    });
    if (!pipeline) throw new NotFoundException(t("err.pipelineNotFound", { id: pipelineId }));
    this.clients.assertOwnership(clientId, pipeline.clientId, "resource.pipeline");
    return pipeline;
  }

  /* ---------------------------------------------------------------- */
  /* Avanzamento                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Scrive il passo corrente.
   *
   * La percentuale non torna mai indietro: fra un giro di ri-ricerca e l'altro
   * il rapporto interno alla fase può calare, e una barra che arretra fa
   * pensare a un errore anche quando tutto procede.
   */
  private async step(pipelineId: string, patch: StepPatch): Promise<void> {
    const current = await prisma.taobaoPipeline.findUnique({
      where: { id: pipelineId },
      select: { progress: true, phase: true },
    });
    if (!current) return;

    const phase = patch.phase ?? current.phase;
    const next = pipelineProgress(phase, patch.ratio ?? 0);

    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: {
        phase,
        progress: Math.max(current.progress, next),
        ...(patch.step ? { step: patch.step } : {}),
        ...(patch.params ? { stepParams: toJson(patch.params) } : {}),
      },
    });
  }

  /** Spunta una fase, senza ripeterla se ci si ripassa. */
  private async completePhase(pipelineId: string, phase: TaobaoPipelinePhase): Promise<void> {
    const current = await prisma.taobaoPipeline.findUnique({
      where: { id: pipelineId },
      select: { completedPhases: true, progress: true },
    });
    if (!current) return;
    if (current.completedPhases.includes(phase)) return;

    await prisma.taobaoPipeline.update({
      where: { id: pipelineId },
      data: {
        completedPhases: { push: phase },
        progress: Math.max(
          current.progress,
          pipelineProgress(phase, 1) + TAOBAO_PIPELINE_PHASE_WEIGHTS[phase] * 0
        ),
      },
    });
  }
}
