import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import type {
  AnalysisRowState,
  ImportJobProgress,
  ImportJobResults,
  ImportJobSummary,
  NormalizedRequest,
  ProductAnalysis,
  ProductIdentity,
  ProductRequirement,
  RetryJobRequest,
  ScoutingEngineProgress,
  ScoutingEngineSummary,
  ScoutingProduct,
  StartImportJobRequest,
  SearchQuality,
} from "@china/shared";
import { RequestAnalysisService } from "../analysis/request-analysis.service";
import { CandidateRefreshService } from "./candidate-refresh.service";
import { loadCandidates } from "./candidate-store";
import { KnownProductService } from "./known-product.service";
import { buildNormalizedRequest } from "./normalize-request";
import { ScoutingRunnerService } from "./scouting-runner.service";
import { ScoutingService } from "./scouting.service";

/**
 * Ciclo di vita di un job di importazione: creazione, avanzamento, pausa,
 * ripresa, annullamento, nuovo tentativo e lettura dei risultati.
 *
 * Il servizio non esegue nulla: prepara lo stato a database e lascia che sia
 * `ScoutingRunnerService` a muoverlo. Questa separazione è ciò che rende
 * pausa e ripresa affidabili — cambiano una riga, non un oggetto in memoria.
 */

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Stati dai quali un job può ancora essere mosso. */
const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "PAUSED"] as const;

@Injectable()
export class ImportJobService {
  constructor(
    private readonly scouting: ScoutingService,
    private readonly runner: ScoutingRunnerService,
    private readonly refresh: CandidateRefreshService,
    private readonly known: KnownProductService,
    private readonly analysis: RequestAnalysisService
  ) {}

  /**
   * Crea il job: una ScoutingRequest per ogni impronta distinta, una riga di
   * job per ogni riga del file, e una casella di stato per ogni marketplace
   * scelto. Le righe duplicate puntano alla **stessa** richiesta.
   */
  async createJob(
    datasetId: string,
    input: StartImportJobRequest
  ): Promise<ImportJobSummary> {
    const dataset = await prisma.scoutingDataset.findUnique({
      where: { id: datasetId },
      select: { id: true, fileName: true },
    });
    if (!dataset) {
      throw new NotFoundException(`Dataset non trovato: ${datasetId}`);
    }

    const { columnIndexes, rows } = await this.scouting.loadRows(datasetId);
    const selected = input.maxRows ? rows.slice(0, input.maxRows) : rows;
    if (selected.length === 0) {
      throw new BadRequestException("Il file non contiene righe da elaborare.");
    }

    const normalized = selected.map((row) => ({
      row,
      request: buildNormalizedRequest(row, {
        columnIndexes,
        mapping: input.mapping,
      }),
    }));

    // Con una sessione di analisi, l'identità di ogni riga arriva dalla
    // revisione: variante, query per lingua e correzioni manuali comprese.
    const analysisByRowNumber = await this.loadAnalysisRows(input.analysisRunId);

    // Una sola ScoutingRequest per identità. Con l'analisi l'identità è la
    // `variantKey`; senza, resta l'impronta. È qui che le righe duplicate —
    // nello stesso file o in file caricati mesi fa — si ricongiungono.
    const requestIdByKey = new Map<string, string>();
    for (const { request } of normalized) {
      if (request.issues.length > 0) continue;
      const analysisRow = analysisByRowNumber.get(request.rowNumber);
      const key = analysisRow?.variantKey ?? request.fingerprint;
      if (requestIdByKey.has(key)) continue;

      if (analysisRow?.analysis && analysisRow.identity) {
        const id = await this.known.upsertVariantRequest(
          analysisRow.analysis,
          analysisRow.identity,
          {
            fingerprint: request.fingerprint,
            normalizedNameKey: request.normalizedNameKey,
            displayName: request.displayName,
            normalizedName: request.normalizedName,
            requirements: request.requirements,
            dimensions: request.dimensions,
            requiredVariant: request.requiredVariant,
            certifications: request.certifications,
            targetPrice: request.targetPrice,
            notes: request.notes,
            referenceUrl: request.referenceUrl,
            searchQuery:
              analysisRow.analysis.searchQueryChinese ||
              analysisRow.analysis.searchQueryEnglish ||
              request.searchQuery,
            language: request.language,
          }
        );
        requestIdByKey.set(key, id);
        continue;
      }

      const id = await this.scouting.upsertScoutingRequest(request);
      requestIdByKey.set(key, id);
    }

    const job = await prisma.importJob.create({
      data: {
        datasetId,
        analysisRunId: input.analysisRunId ?? null,
        status: "QUEUED",
        engines: input.engines,
        quality: input.quality,
        candidatesPerEngine: input.candidatesPerEngine,
        finalists: input.finalists,
        forceFullSearch: input.forceFullSearch,
        aiRationale: input.aiRationale,
        mapping: toJson(input.mapping),
        totalRows: normalized.length,
      },
    });

    // La mappatura appena usata diventa quella predefinita del dataset.
    await this.scouting.saveMapping(datasetId, input.mapping).catch(() => undefined);

    for (const { row, request } of normalized) {
      const datasetRow = await prisma.scoutingDatasetRow.findUnique({
        where: { datasetId_rowNumber: { datasetId, rowNumber: row.rowNumber } },
        select: { id: true },
      });
      if (!datasetRow) continue;

      const analysisRow = analysisByRowNumber.get(request.rowNumber);
      // Con l'analisi attiva, una riga entra nel job solo se la revisione l'ha
      // dichiarata pronta: le righe con warning critici o confidenza bassa
      // restano ferme finché qualcuno non le guarda. È il punto della fase.
      const blockedByReview =
        input.analysisRunId != null &&
        (!analysisRow || analysisRow.state === "ANALYSIS_FAILED" || analysisRow.state === "NEEDS_REVIEW");
      const usable = request.issues.length === 0 && !blockedByReview;

      const skipReason = blockedByReview
        ? (analysisRow?.error ??
          "Riga non confermata nella revisione dell'analisi IA.")
        : request.issues.join(" ");

      const jobRow = await prisma.importJobRow.create({
        data: {
          jobId: job.id,
          datasetRowId: datasetRow.id,
          analysisRowId: analysisRow?.analysisRowId ?? null,
          requestId: usable
            ? (requestIdByKey.get(analysisRow?.variantKey ?? request.fingerprint) ?? null)
            : null,
          rowNumber: request.rowNumber,
          displayName: request.displayName,
          searchQuery:
            analysisRow?.analysis?.searchQueryChinese ||
            analysisRow?.analysis?.searchQueryEnglish ||
            request.searchQuery,
          status: usable ? "PENDING" : "SKIPPED",
          error: usable ? null : skipReason,
          finishedAt: usable ? null : new Date(),
        },
        select: { id: true },
      });

      if (usable) {
        await prisma.importJobRowEngine.createMany({
          data: input.engines.map((engine) => ({
            jobRowId: jobRow.id,
            engine,
          })),
        });
      }
    }

    this.runner.start(job.id);
    return this.toSummary(job.id);
  }

  /**
   * Righe di una sessione di analisi, indicizzate per numero di riga.
   *
   * Passa da `RequestAnalysisService.getRun()` invece di leggere le righe a
   * database, e non è un dettaglio: lo stato di una riga **si ricalcola** —
   * dipende dalle correzioni manuali e da cosa il database sa in questo
   * momento della variante. Leggere la colonna salvata darebbe la fotografia
   * scattata al momento dell'analisi, e una riga confermata a mano subito dopo
   * verrebbe saltata pur mostrandosi «pronta» in interfaccia.
   *
   * La regola che ne segue è quella che conta per chi usa il sistema: parte
   * esattamente ciò che la revisione mostra come pronto.
   *
   * Torna vuota quando il job non nasce da un'analisi: è ciò che tiene in vita
   * il percorso storico senza un ramo `if` in ogni punto del metodo.
   */
  private async loadAnalysisRows(analysisRunId: string | undefined) {
    const result = new Map<
      number,
      {
        analysisRowId: string;
        state: AnalysisRowState;
        variantKey: string | null;
        error: string | null;
        analysis: ProductAnalysis | null;
        identity: ProductIdentity | null;
      }
    >();
    if (!analysisRunId) return result;

    const run = await this.analysis.getRun(analysisRunId);
    for (const row of run.rows) {
      result.set(row.rowNumber, {
        analysisRowId: row.analysisRowId,
        state: row.state,
        variantKey: row.identity?.variantKey ?? null,
        error: row.error,
        analysis: row.analysis,
        identity: row.identity,
      });
    }
    return result;
  }

  async listJobs(limit = 30): Promise<ImportJobSummary[]> {
    const jobs = await prisma.importJob.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { dataset: { select: { fileName: true } } },
    });
    return jobs.map((job) => ({
      jobId: job.id,
      datasetId: job.datasetId,
      fileName: job.dataset.fileName,
      status: job.status,
      engines: job.engines,
      quality: job.quality as SearchQuality,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      reusedRows: job.reusedRows,
      failedRows: job.failedRows,
      creditsSpent: job.creditsSpent,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      error: job.error,
    }));
  }

  private async toSummary(jobId: string): Promise<ImportJobSummary> {
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      include: { dataset: { select: { fileName: true } } },
    });
    if (!job) throw new NotFoundException(`Job non trovato: ${jobId}`);
    return {
      jobId: job.id,
      datasetId: job.datasetId,
      fileName: job.dataset.fileName,
      status: job.status,
      engines: job.engines,
      quality: job.quality as SearchQuality,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      reusedRows: job.reusedRows,
      failedRows: job.failedRows,
      creditsSpent: job.creditsSpent,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      error: job.error,
    };
  }

  /** Avanzamento per file, per riga e per marketplace. */
  async progress(jobId: string, rowLimit = 500): Promise<ImportJobProgress> {
    const summary = await this.toSummary(jobId);
    const rows = await prisma.importJobRow.findMany({
      where: { jobId },
      orderBy: { rowNumber: "asc" },
      take: rowLimit,
      include: {
        engines: { orderBy: { engine: "asc" } },
        request: { select: { fingerprint: true, id: true } },
      },
    });

    // Conteggio dei candidati per richiesta, in una sola interrogazione.
    const requestIds = [
      ...new Set(rows.map((row) => row.requestId).filter((id): id is string => !!id)),
    ];
    const counts = requestIds.length
      ? await prisma.productCandidateRecord.groupBy({
          by: ["requestId"],
          where: { requestId: { in: requestIds } },
          _count: { _all: true },
        })
      : [];
    const countByRequest = new Map(
      counts.map((entry) => [entry.requestId, entry._count._all])
    );

    const engineSummary = new Map<string, ScoutingEngineSummary>();
    for (const engine of summary.engines) {
      engineSummary.set(engine, {
        engine,
        pending: 0,
        running: 0,
        done: 0,
        error: 0,
        skipped: 0,
        acceptedCount: 0,
        lastError: null,
      });
    }

    const progressRows = rows.map((row) => {
      const engines: ScoutingEngineProgress[] = row.engines.map((entry) => {
        const bucket = engineSummary.get(entry.engine);
        if (bucket) {
          if (entry.status === "PENDING") bucket.pending += 1;
          else if (entry.status === "RUNNING") bucket.running += 1;
          else if (entry.status === "DONE") bucket.done += 1;
          else if (entry.status === "ERROR") bucket.error += 1;
          else bucket.skipped += 1;
          bucket.acceptedCount += entry.acceptedCount;
          if (entry.error) bucket.lastError = entry.error;
        }
        return {
          engine: entry.engine,
          status: entry.status,
          queryUsed: entry.queryUsed,
          fetchedCount: entry.fetchedCount,
          acceptedCount: entry.acceptedCount,
          durationMs: entry.durationMs,
          errorCode: entry.errorCode,
          error: entry.error,
          retryable: entry.retryable,
          attempts: entry.attempts,
          servedFromCache: entry.servedFromCache,
        };
      });

      return {
        jobRowId: row.id,
        rowNumber: row.rowNumber,
        displayName: row.displayName,
        searchQuery: row.searchQuery,
        status: row.status,
        reused: row.reused,
        fingerprint: row.request?.fingerprint ?? null,
        candidateCount: row.requestId
          ? (countByRequest.get(row.requestId) ?? 0)
          : 0,
        engines,
        error: row.error,
      };
    });

    return {
      job: summary,
      engineSummary: [...engineSummary.values()],
      rows: progressRows,
    };
  }

  /** Risultati completi: per ogni riga, tutti i prodotti trovati. */
  async results(
    jobId: string,
    options: { limit: number; offset: number }
  ): Promise<ImportJobResults> {
    const summary = await this.toSummary(jobId);
    const rows = await prisma.importJobRow.findMany({
      where: { jobId },
      orderBy: { rowNumber: "asc" },
      skip: options.offset,
      take: options.limit,
      include: {
        engines: { orderBy: { engine: "asc" } },
        datasetRow: { select: { cells: true } },
        request: {
          select: { id: true, fingerprint: true, requirements: true },
        },
      },
    });

    const resultRows = [];
    for (const row of rows) {
      const candidates = row.requestId
        ? await loadCandidates(row.requestId)
        : [];
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const selections = await prisma.scoutingResult.findMany({
        where: { jobRowId: row.id },
        orderBy: [{ rank: "asc" }, { score: "desc" }],
      });
      const toSelection = (entry: (typeof selections)[number]) => {
        const candidate = byId.get(entry.candidateId);
        if (!candidate) return null;
        return {
          outcome: entry.outcome,
          rank: entry.rank,
          score: entry.score,
          scoreBreakdown:
            (entry.scoreBreakdown as unknown as Record<string, number>) ?? {},
          rejectionCode: entry.rejectionCode,
          rejectionReason: entry.rejectionReason,
          aiRationale: entry.aiRationale,
          scoreReused: entry.scoreReused,
          product: toScoutingProduct(candidate),
        };
      };
      const mapped = selections
        .map(toSelection)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      resultRows.push({
        jobRowId: row.id,
        rowNumber: row.rowNumber,
        displayName: row.displayName,
        searchQuery: row.searchQuery,
        status: row.status,
        reused: row.reused,
        fingerprint: row.request?.fingerprint ?? null,
        cells: row.datasetRow.cells as unknown as string[],
        requirements:
          (row.request?.requirements as unknown as ProductRequirement[]) ?? [],
        candidates: candidates.map(toScoutingProduct),
        finalists: mapped.filter(
          (entry) => entry.outcome === "FINALIST" || entry.outcome === "SHORTLISTED"
        ),
        rejected: mapped.filter((entry) => entry.outcome === "REJECTED"),
        engines: row.engines.map((entry) => ({
          engine: entry.engine,
          status: entry.status,
          queryUsed: entry.queryUsed,
          fetchedCount: entry.fetchedCount,
          acceptedCount: entry.acceptedCount,
          durationMs: entry.durationMs,
          errorCode: entry.errorCode,
          error: entry.error,
          retryable: entry.retryable,
          attempts: entry.attempts,
          servedFromCache: entry.servedFromCache,
        })),
        error: row.error,
      });
    }

    return { job: summary, rows: resultRows };
  }

  /**
   * Aggiorna i prodotti della richiesta a cui punta una riga, e rivaluta
   * subito la classifica: dopo un cambio di prezzo i finalisti possono
   * cambiare, e mostrarli fermi sarebbe fuorviante.
   */
  async refreshRow(
    jobRowId: string,
    options: { limit: number }
  ) {
    const row = await prisma.importJobRow.findUnique({
      where: { id: jobRowId },
      include: { job: { select: { quality: true, finalists: true } } },
    });
    if (!row) throw new NotFoundException(`Riga non trovata: ${jobRowId}`);
    if (!row.requestId) {
      throw new BadRequestException(
        "Questa riga non ha una richiesta associata: non c'è nulla da aggiornare."
      );
    }

    const outcomes = await this.refresh.refreshRequest(row.requestId, {
      limit: options.limit,
    });
    await this.runner.rescoreRow(jobRowId, row.requestId, row.job);

    return {
      jobRowId,
      refreshed: outcomes.length,
      updated: outcomes.filter((entry) => entry.status === "updated").length,
      unchanged: outcomes.filter((entry) => entry.status === "unchanged").length,
      unavailable: outcomes.filter((entry) => entry.status === "unavailable")
        .length,
      failed: outcomes.filter((entry) => entry.status === "error").length,
      outcomes,
    };
  }

  async pause(jobId: string): Promise<ImportJobSummary> {
    const job = await this.requireActiveJob(jobId);
    if (job.status === "PAUSED") return this.toSummary(jobId);
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "PAUSED" },
    });
    return this.toSummary(jobId);
  }

  async resume(jobId: string): Promise<ImportJobSummary> {
    const job = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job non trovato: ${jobId}`);
    // Si riprende solo ciò che è davvero interrotto. Un job concluso o
    // annullato non va "ripreso": o si ritenta ciò che è fallito, o se ne
    // avvia uno nuovo. Senza questo controllo la ripresa di un job finito lo
    // riportava a QUEUED per poi richiuderlo subito, un giro a vuoto che in
    // interfaccia sembra un errore.
    const resumable = ["PAUSED", "QUEUED", "RUNNING", "FAILED"];
    if (!resumable.includes(job.status)) {
      throw new BadRequestException(
        `Il job è in stato ${job.status}: usa “ritenta” per rifare le righe ` +
          "o avvia una nuova elaborazione."
      );
    }
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "QUEUED", error: null, finishedAt: null },
    });
    this.runner.start(jobId);
    return this.toSummary(jobId);
  }

  async cancel(jobId: string): Promise<ImportJobSummary> {
    const job = await this.requireActiveJob(jobId);
    await prisma.$transaction([
      prisma.importJob.update({
        where: { id: job.id },
        data: { status: "CANCELLED", finishedAt: new Date() },
      }),
      // Le righe non ancora elaborate non verranno mai fatte: dirlo
      // esplicitamente è meglio che lasciarle in attesa per sempre.
      prisma.importJobRow.updateMany({
        where: { jobId, status: "PENDING" },
        data: { status: "CANCELLED", finishedAt: new Date() },
      }),
    ]);
    return this.toSummary(jobId);
  }

  /**
   * Rimette in coda ciò che non è riuscito.
   *
   * `scope=failed` ritenta le righe fallite e le fonti in errore; `all` rifà
   * tutte le righe. Con `engine` si ritenta un solo marketplace: è il caso
   * tipico di un captcha che si è sbloccato dopo il cooldown.
   */
  async retry(
    jobId: string,
    input: RetryJobRequest
  ): Promise<ImportJobSummary> {
    const job = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job non trovato: ${jobId}`);

    const rowFilter: Prisma.ImportJobRowWhereInput =
      input.scope === "all"
        ? { jobId }
        : { jobId, status: { in: ["FAILED", "CANCELLED"] } };

    const rows = await prisma.importJobRow.findMany({
      where: rowFilter,
      select: { id: true },
    });
    const rowIds = rows.map((row) => row.id);

    if (input.engine) {
      // Solo la fonte indicata torna in attesa; le altre conservano l'esito.
      const engineRows = await prisma.importJobRowEngine.findMany({
        where: {
          engine: input.engine,
          jobRow: { jobId },
          ...(input.scope === "failed" ? { status: "ERROR" } : {}),
        },
        select: { jobRowId: true },
      });
      const targets = engineRows.map((entry) => entry.jobRowId);
      if (targets.length === 0) {
        throw new BadRequestException(
          `Nessuna riga da ritentare su ${input.engine}.`
        );
      }
      await prisma.importJobRowEngine.updateMany({
        where: { jobRowId: { in: targets }, engine: input.engine },
        data: { status: "PENDING", error: null, errorCode: null },
      });
      await prisma.importJobRow.updateMany({
        where: { id: { in: targets } },
        data: { status: "PENDING", error: null, finishedAt: null },
      });
    } else {
      if (rowIds.length === 0) {
        throw new BadRequestException(
          input.scope === "failed"
            ? "Nessuna riga fallita o annullata da ritentare: usa “rifai tutto” " +
              "per rieseguire comunque l'intero file."
            : "Il job non ha righe da ritentare."
        );
      }
      await prisma.importJobRowEngine.updateMany({
        where: {
          jobRowId: { in: rowIds },
          ...(input.scope === "failed" ? { status: "ERROR" } : {}),
        },
        data: { status: "PENDING", error: null, errorCode: null },
      });
      await prisma.importJobRow.updateMany({
        where: { id: { in: rowIds } },
        data: { status: "PENDING", error: null, finishedAt: null, reused: false },
      });
    }

    // I contatori ripartono dal conteggio reale, non da una sottrazione a
    // occhio: dopo più tentativi sarebbe l'unico modo per non derivare.
    const [processed, failed, reused] = await Promise.all([
      prisma.importJobRow.count({
        where: { jobId, status: { notIn: ["PENDING"] } },
      }),
      prisma.importJobRow.count({ where: { jobId, status: "FAILED" } }),
      prisma.importJobRow.count({ where: { jobId, reused: true } }),
    ]);
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "QUEUED",
        error: null,
        finishedAt: null,
        processedRows: processed,
        failedRows: failed,
        reusedRows: reused,
      },
    });

    this.runner.start(jobId);
    return this.toSummary(jobId);
  }

  private async requireActiveJob(jobId: string) {
    const job = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job non trovato: ${jobId}`);
    if (!(ACTIVE_STATUSES as readonly string[]).includes(job.status)) {
      throw new BadRequestException(
        `Il job è in stato ${job.status} e non può più essere modificato.`
      );
    }
    return job;
  }
}

type CandidateRow = Awaited<ReturnType<typeof loadCandidates>>[number];

/** Record di database → prodotto esposto dall'API. */
function toScoutingProduct(candidate: CandidateRow): ScoutingProduct {
  return {
    candidateId: candidate.id,
    engine: candidate.engine,
    externalId: candidate.externalId,
    title: candidate.title,
    url: candidate.url,
    imageUrl: candidate.imageUrl,
    foundQuery: candidate.foundQuery,
    vendorName: candidate.vendorName,
    vendorUrl: candidate.vendorUrl,
    price: candidate.price == null ? null : Number(candidate.price),
    currency: candidate.currency,
    moq: candidate.moq,
    stock: candidate.stock,
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    totalSales: candidate.totalSales,
    relevanceScore: candidate.relevanceScore,
    matchReasons: candidate.matchReasons,
    matchWarnings: candidate.matchWarnings,
    variants:
      (candidate.variants as unknown as ScoutingProduct["variants"]) ?? [],
    specs: (candidate.specs as unknown as Record<string, string>) ?? {},
    priceTiers:
      (candidate.priceTiers as unknown as ScoutingProduct["priceTiers"]) ?? [],
    firstSeenAt: candidate.firstSeenAt.toISOString(),
    lastCheckedAt: candidate.lastCheckedAt.toISOString(),
    lastChangedAt: candidate.lastChangedAt?.toISOString() ?? null,
    changedFields: candidate.changedFields,
    unavailable: candidate.unavailable,
  };
}

export { toScoutingProduct };
