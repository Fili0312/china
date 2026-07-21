import { Injectable, Logger } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import type {
  ProductRequirement,
  SearchEngine,
  SearchQuality,
} from "@china/shared";
import { queryLanguageForEngine } from "@china/shared";
import { SearchService } from "../search/search.service";
import { piloterrClient } from "../search/providers/piloterr.client";
import { persistCandidates, toCandidateData } from "./candidate-store";
import { KnownProductService } from "./known-product.service";
import {
  selectFinalists,
  type CandidateForSelection,
  type StoredEvaluation,
} from "./selection";

/**
 * Motore di esecuzione dei job di scouting.
 *
 * Gira **dentro il processo API**, non nel worker BullMQ. Non è una scorciatoia:
 * i provider di ricerca vivono qui — Chromium condiviso compreso, chiuso da
 * `SearchService.onModuleDestroy` — e ogni marketplace ha già in questo processo
 * la propria coda, la propria cache e il proprio cooldown anti-captcha.
 * Spostare l'esecuzione nel worker significherebbe un secondo Chromium e due
 * cache che si ignorano a vicenda, cioè il doppio delle visite agli stessi siti.
 *
 * Lo stato vive interamente su Postgres, mai in memoria: pausa, ripresa e
 * riavvio del servizio funzionano perché la verità è la riga a database, non
 * una variabile di processo.
 */

/** Soglia di ammissione ai finalisti, per profilo di precisione. */
function selectionThreshold(quality: SearchQuality): number {
  const thresholds: Record<SearchQuality, number> = {
    strict: 65,
    balanced: 50,
    broad: 35,
  };
  return thresholds[quality] ?? 50;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Errore tipizzato di una fonte, nella forma già usata dall'aggregatore. */
function describeError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const message =
    error instanceof Error ? error.message : "Errore imprevisto della fonte";
  const status =
    typeof (error as { getStatus?: () => number }).getStatus === "function"
      ? (error as { getStatus: () => number }).getStatus()
      : 0;
  const codes: Record<number, [string, boolean]> = {
    429: ["SOURCE_BUSY", true],
    500: ["SOURCE_CONFIGURATION", false],
    502: ["SOURCE_UPSTREAM", true],
    503: ["SOURCE_UNAVAILABLE", true],
    504: ["SOURCE_TIMEOUT", true],
  };
  const [code, retryable] = codes[status] ?? ["SOURCE_INTERNAL", false];
  return { code, message, retryable };
}

@Injectable()
export class ScoutingRunnerService {
  private readonly logger = new Logger("ScoutingRunner");
  /** Job che questo processo sta già guidando: evita due cicli sullo stesso. */
  private readonly driving = new Set<string>();

  constructor(
    private readonly search: SearchService,
    private readonly known: KnownProductService
  ) {}

  isDriving(jobId: string): boolean {
    return this.driving.has(jobId);
  }

  /**
   * Avvia (o riprende) l'esecuzione di un job. Ritorna subito: il ciclo
   * prosegue in background e l'avanzamento si legge dal database.
   */
  start(jobId: string): void {
    if (this.driving.has(jobId)) return;
    this.driving.add(jobId);
    void this.drive(jobId)
      .catch(async (error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Errore imprevisto";
        this.logger.error(`job ${jobId} interrotto: ${message}`);
        await prisma.importJob
          .update({
            where: { id: jobId },
            data: { status: "FAILED", error: message, finishedAt: new Date() },
          })
          .catch(() => undefined);
      })
      .finally(() => {
        this.driving.delete(jobId);
      });
  }

  private async drive(jobId: string): Promise<void> {
    const job = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.status === "CANCELLED" || job.status === "COMPLETED") return;

    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "RUNNING",
        startedAt: job.startedAt ?? new Date(),
        error: null,
      },
    });

    // Righe rimaste "in corso" da un arresto precedente: vanno rimesse in coda,
    // altrimenti resterebbero bloccate per sempre.
    await prisma.importJobRow.updateMany({
      where: { jobId, status: { in: ["SEARCHING", "REFRESHING", "SCORING"] } },
      data: { status: "PENDING" },
    });

    const concurrency = Math.min(
      8,
      Math.floor(numericEnv("SCOUTING_ROW_CONCURRENCY", 2))
    );

    for (;;) {
      const current = await prisma.importJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (!current) return;
      if (current.status === "PAUSED" || current.status === "CANCELLED") {
        if (current.status === "CANCELLED") {
          // Le righe già in corso vengono lasciate finire — il lavoro è
          // fatto e i prodotti sono salvati — ma quelle mai iniziate vanno
          // chiuse, altrimenti resterebbero in attesa per sempre e
          // «ritenta» non saprebbe quali riprendere.
          await prisma.importJobRow.updateMany({
            where: { jobId, status: "PENDING" },
            data: { status: "CANCELLED", finishedAt: new Date() },
          });
        }
        this.logger.log(`job ${jobId} fermato su richiesta (${current.status})`);
        return;
      }

      const batch = await prisma.importJobRow.findMany({
        where: { jobId, status: "PENDING" },
        orderBy: { rowNumber: "asc" },
        take: concurrency,
      });
      if (batch.length === 0) break;

      // Prenotazione: due cicli concorrenti non devono prendere la stessa riga.
      await prisma.importJobRow.updateMany({
        where: { id: { in: batch.map((row) => row.id) }, status: "PENDING" },
        data: { status: "SEARCHING", startedAt: new Date() },
      });

      await Promise.all(batch.map((row) => this.processRow(jobId, row.id)));
    }

    await this.finalize(jobId);
  }

  /** Chiude il job scegliendo lo stato in base a com'è andata. */
  private async finalize(jobId: string): Promise<void> {
    const [failed, pending] = await Promise.all([
      prisma.importJobRow.count({ where: { jobId, status: "FAILED" } }),
      prisma.importJobRow.count({ where: { jobId, status: "PENDING" } }),
    ]);
    if (pending > 0) return;

    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        finishedAt: new Date(),
      },
    });
    this.logger.log(
      `job ${jobId} concluso (${failed} righe con errori su tutte le fonti)`
    );
  }

  /**
   * Elabora una riga: decide se riusare i candidati già noti o interrogare i
   * marketplace, e registra l'esito **separatamente per ogni fonte**.
   */
  private async processRow(jobId: string, jobRowId: string): Promise<void> {
    const row = await prisma.importJobRow.findUnique({
      where: { id: jobRowId },
      include: { job: true, request: true },
    });
    if (!row) return;

    if (!row.request || !row.searchQuery) {
      await prisma.importJobRow.update({
        where: { id: jobRowId },
        data: {
          status: "SKIPPED",
          error: "Riga senza richiesta utilizzabile.",
          finishedAt: new Date(),
        },
      });
      await this.bumpJobCounters(jobId, { processed: 1 });
      return;
    }

    const engines = row.job.engines as SearchEngine[];

    // Caso A della specifica: la variante è conosciuta. Prima di rifare la
    // ricerca si controllano i link che già abbiamo — prezzo, disponibilità,
    // MOQ, venditore — e solo se **non** bastano si riparte da zero. È ciò che
    // rende un secondo passaggio sullo stesso file quasi gratuito.
    await prisma.importJobRow.update({
      where: { id: jobRowId },
      data: { status: "REFRESHING" },
    });
    const reuse = await this.known.prepareReuse(row.requestId!, {
      forceFullSearch: row.job.forceFullSearch,
      refreshLimit: row.job.candidatesPerEngine * engines.length,
    });

    if (reuse.reuse) {
      await prisma.importJobRowEngine.updateMany({
        where: { jobRowId },
        data: {
          status: "SKIPPED",
          error: reuse.reason,
          finishedAt: new Date(),
        },
      });
      // Anche una riga riusata va valutata: i finalisti appartengono alla
      // riga, non alla richiesta, e questa riga non li ha ancora. Dopo
      // l'aggiornamento i prezzi possono essere cambiati, quindi la classifica
      // va rifatta comunque.
      await this.scoreRow(jobRowId, row.requestId!, row.job);
      await prisma.importJobRow.update({
        where: { id: jobRowId },
        data: {
          status: "DONE",
          reused: true,
          reuseReason: reuse.reason,
          finishedAt: new Date(),
        },
      });
      await this.bumpJobCounters(jobId, { processed: 1, reused: 1 });
      return;
    }

    // Casi B e C: si cerca davvero. La riga registra **perché** — «i prodotti
    // noti non bastavano più» è un'informazione che l'utente merita di vedere
    // accanto al risultato.
    await prisma.importJobRow.update({
      where: { id: jobRowId },
      data: { status: "SEARCHING", reuseReason: reuse.reason },
    });

    const outcomes = await Promise.all(
      engines.map((engine) =>
        this.runEngineWithRetry(
          jobRowId,
          row.requestId!,
          this.queryForEngine(engine, row.request, row.searchQuery),
          engine,
          {
            quality: row.job.quality as SearchQuality,
            frameSize: row.job.candidatesPerEngine,
          }
        )
      )
    );

    const succeeded = outcomes.filter((outcome) => outcome.ok).length;
    const creditsSpent = outcomes.reduce(
      (total, outcome) => total + outcome.creditsSpent,
      0
    );

    await prisma.scoutingRequest.update({
      where: { id: row.requestId! },
      data: { lastSearchedAt: new Date(), searchCount: { increment: 1 } },
    });

    const failed = succeeded === 0;
    if (!failed) {
      await prisma.importJobRow.update({
        where: { id: jobRowId },
        data: { status: "SCORING" },
      });
      await this.scoreRow(jobRowId, row.requestId!, row.job);
    }

    // Una riga fallisce solo se **nessuna** fonte ha risposto: un captcha su
    // Alibaba non deve invalidare i prodotti trovati su Yiwugo.
    await prisma.importJobRow.update({
      where: { id: jobRowId },
      data: {
        status: failed ? "FAILED" : "DONE",
        error: failed
          ? "Nessuna fonte ha restituito risultati: vedi il dettaglio per marketplace."
          : null,
        finishedAt: new Date(),
      },
    });
    await this.bumpJobCounters(jobId, {
      processed: 1,
      failed: failed ? 1 : 0,
      credits: creditsSpent,
    });
  }

  /**
   * Query da mandare a una fonte, nella lingua che quella fonte capisce.
   *
   * Taobao, Tmall, Chinagoods e Yiwugo indicizzano il mercato interno e vanno
   * interrogati in cinese; Alibaba, AliExpress e Made-in-China sono vetrine
   * per l'export con titoli in inglese. Sbagliare lingua non produce un
   * errore — produce zero risultati, o risultati fuori tema, che è molto più
   * difficile da diagnosticare.
   *
   * Se la query nella lingua giusta manca si usa l'altra: una ricerca
   * imperfetta vale più di una riga saltata.
   */
  private queryForEngine(
    engine: SearchEngine,
    request: { searchQueryChinese: string | null; searchQueryEnglish: string | null } | null,
    fallback: string
  ): string {
    if (!request) return fallback;
    const wanted =
      queryLanguageForEngine(engine) === "zh"
        ? request.searchQueryChinese
        : request.searchQueryEnglish;
    const other =
      queryLanguageForEngine(engine) === "zh"
        ? request.searchQueryEnglish
        : request.searchQueryChinese;
    return wanted?.trim() || other?.trim() || fallback;
  }

  /**
   * Interroga un marketplace, ritentando da sola una fonte occupata.
   *
   * `SOURCE_BUSY` non è un guasto: è la coda della fonte che dice «troppe
   * richieste insieme, aspetta». Sul primo file vero sono stati 38 errori su
   * 232 ricerche — un sesto del lavoro buttato via per una coda piena, con la
   * riga che risultava fallita e nessuno che riprovava. Ora si aspetta e si
   * riprova, con attese crescenti.
   */
  private async runEngineWithRetry(
    jobRowId: string,
    requestId: string,
    query: string,
    engine: SearchEngine,
    options: { quality: SearchQuality; frameSize: number }
  ): Promise<{ ok: boolean; creditsSpent: number }> {
    const attempts = Math.max(1, Math.floor(numericEnv("SCOUTING_ENGINE_ATTEMPTS", 3)));
    let creditsSpent = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcome = await this.runEngine(jobRowId, requestId, query, engine, options);
      creditsSpent += outcome.creditsSpent;
      if (outcome.ok) return { ok: true, creditsSpent };
      if (!outcome.retryable || attempt === attempts) {
        return { ok: false, creditsSpent };
      }

      // Attesa crescente: 2s, 4s, 8s… Una coda piena si svuota da sola, ma
      // solo se si smette di spingere.
      const waitMs = Math.min(15_000, 2_000 * 2 ** (attempt - 1));
      this.logger.log(
        `${engine}: fonte occupata, nuovo tentativo fra ${waitMs / 1000}s ` +
          `(${attempt}/${attempts - 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return { ok: false, creditsSpent };
  }

  /** Interroga un singolo marketplace e ne registra l'esito. */
  private async runEngine(
    jobRowId: string,
    requestId: string,
    query: string,
    engine: SearchEngine,
    options: { quality: SearchQuality; frameSize: number }
  ): Promise<{ ok: boolean; creditsSpent: number; retryable: boolean }> {
    const startedAt = Date.now();
    await prisma.importJobRowEngine.updateMany({
      where: { jobRowId, engine },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        attempts: { increment: 1 },
        error: null,
        errorCode: null,
      },
    });

    // Consumo Piloterr prima e dopo: la differenza dice se questa ricerca ha
    // davvero speso crediti o è arrivata dalla cache.
    const before = piloterrClient.getUsage();

    try {
      const result = await this.search.search({
        q: query,
        engine,
        framePosition: 0,
        frameSize: options.frameSize,
        sort: "default",
        quality: options.quality,
      });

      const after = piloterrClient.getUsage();
      const creditsSpent = after.creditsSpent - before.creditsSpent;
      const servedFromCache =
        creditsSpent === 0 && after.cacheHits > before.cacheHits;

      await persistCandidates(
        requestId,
        result.diagnostics?.queryUsed || query,
        result.items.map((product) => toCandidateData(product, engine))
      );

      await prisma.importJobRowEngine.updateMany({
        where: { jobRowId, engine },
        data: {
          status: "DONE",
          queryUsed: result.diagnostics?.queryUsed ?? query,
          fetchedCount: result.diagnostics?.fetchedCount ?? result.items.length,
          acceptedCount: result.items.length,
          durationMs: Date.now() - startedAt,
          servedFromCache,
          finishedAt: new Date(),
        },
      });
      return { ok: true, creditsSpent, retryable: false };
    } catch (error) {
      const described = describeError(error);
      await prisma.importJobRowEngine.updateMany({
        where: { jobRowId, engine },
        data: {
          status: "ERROR",
          durationMs: Date.now() - startedAt,
          errorCode: described.code,
          error: described.message.slice(0, 500),
          retryable: described.retryable,
          finishedAt: new Date(),
        },
      });
      return { ok: false, creditsSpent: 0, retryable: described.retryable };
    }
  }

  /**
   * Applica vincoli, punteggi e scelta dei finalisti ai candidati della riga.
   *
   * I prodotti i cui dati non sono cambiati dall'ultima valutazione
   * conservano **esattamente** il punteggio precedente: è la regola richiesta,
   * e senza di essa la classifica si muoverebbe senza che nulla sia cambiato.
   */
  /** Rivaluta una riga dopo un aggiornamento dei prodotti. */
  async rescoreRow(
    jobRowId: string,
    requestId: string,
    job: { quality: string; finalists: number }
  ): Promise<void> {
    await this.scoreRow(jobRowId, requestId, job);
  }

  private async scoreRow(
    jobRowId: string,
    requestId: string,
    job: { quality: string; finalists: number }
  ): Promise<void> {
    const request = await prisma.scoutingRequest.findUnique({
      where: { id: requestId },
      select: {
        requirements: true,
        targetPrice: true,
        requestedQuantity: true,
      },
    });
    if (!request) return;

    const records = await prisma.productCandidateRecord.findMany({
      where: { requestId },
    });
    if (records.length === 0) return;

    // Punteggi già calcolati per candidati rimasti identici da allora.
    const previous = await prisma.scoutingResult.findMany({
      where: {
        candidateId: { in: records.map((record) => record.id) },
        jobRow: { requestId },
      },
      orderBy: { createdAt: "desc" },
    });
    const stored = new Map<string, StoredEvaluation>();
    for (const record of records) {
      const last = previous.find((entry) => entry.candidateId === record.id);
      if (!last || last.score == null) continue;
      const changedSince =
        record.lastChangedAt != null && record.lastChangedAt > last.createdAt;
      if (changedSince) continue;
      stored.set(record.id, {
        score: last.score,
        breakdown:
          (last.scoreBreakdown as unknown as Record<string, number>) ?? {},
        rejectionCode:
          (last.rejectionCode as StoredEvaluation["rejectionCode"]) ?? null,
        rejectionReason: last.rejectionReason,
        checks: [],
      });
    }

    const candidates: CandidateForSelection[] = records.map((record) => ({
      candidateId: record.id,
      engine: record.engine,
      title: record.title,
      specs: (record.specs as unknown as Record<string, string>) ?? undefined,
      price: record.price == null ? null : Number(record.price),
      currency: record.currency,
      moq: record.moq,
      rating: record.rating,
      reviewCount: record.reviewCount,
      totalSales: record.totalSales,
      relevanceScore: record.relevanceScore,
      unavailable: record.unavailable,
    }));

    const outcomes = selectFinalists(
      candidates,
      {
        request: {
          requirements:
            (request.requirements as unknown as ProductRequirement[]) ?? [],
          targetPrice: request.targetPrice,
          requestedQuantity: request.requestedQuantity,
        },
        threshold: selectionThreshold(job.quality as SearchQuality),
      },
      job.finalists,
      stored
    );

    for (const outcome of outcomes) {
      const data = {
        outcome: outcome.outcome,
        rank: outcome.rank,
        score: outcome.evaluation.score,
        scoreBreakdown: outcome.evaluation.breakdown as Prisma.InputJsonValue,
        rejectionCode: outcome.evaluation.rejectionCode,
        rejectionReason: outcome.evaluation.rejectionReason,
        scoreReused: outcome.scoreReused,
      };
      await prisma.scoutingResult.upsert({
        where: {
          jobRowId_candidateId: { jobRowId, candidateId: outcome.candidateId },
        },
        create: { jobRowId, candidateId: outcome.candidateId, ...data },
        update: data,
      });
    }
  }

  private async bumpJobCounters(
    jobId: string,
    delta: { processed?: number; reused?: number; failed?: number; credits?: number }
  ): Promise<void> {
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        processedRows: { increment: delta.processed ?? 0 },
        reusedRows: { increment: delta.reused ?? 0 },
        failedRows: { increment: delta.failed ?? 0 },
        creditsSpent: { increment: delta.credits ?? 0 },
      },
    });
  }
}
