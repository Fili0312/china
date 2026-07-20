import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "@china/db";
import type { SearchEngine, SearchQuality } from "@china/shared";
import { SearchService } from "../search/search.service";
import { piloterrClient } from "../search/providers/piloterr.client";
import { persistCandidates, toCandidateData } from "./candidate-store";

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

  constructor(private readonly search: SearchService) {}

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
    const reusable = await this.canReuse(row.requestId!, row.job.forceFullSearch);

    if (reusable) {
      // La richiesta è già stata elaborata: i prodotti salvati vengono riusati
      // così com'è, senza spendere né tempo né crediti. L'aggiornamento dei
      // loro dati è un passo separato (M6), esplicito e ordinabile.
      await prisma.importJobRowEngine.updateMany({
        where: { jobRowId },
        data: {
          status: "SKIPPED",
          error: "Richiesta già elaborata: candidati riusati.",
          finishedAt: new Date(),
        },
      });
      await prisma.importJobRow.update({
        where: { id: jobRowId },
        data: { status: "DONE", reused: true, finishedAt: new Date() },
      });
      await this.bumpJobCounters(jobId, { processed: 1, reused: 1 });
      return;
    }

    const outcomes = await Promise.all(
      engines.map((engine) =>
        this.runEngine(jobRowId, row.requestId!, row.searchQuery, engine, {
          quality: row.job.quality as SearchQuality,
          frameSize: row.job.candidatesPerEngine,
        })
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

    // Una riga fallisce solo se **nessuna** fonte ha risposto: un captcha su
    // Alibaba non deve invalidare i prodotti trovati su Yiwugo.
    const failed = succeeded === 0;
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
   * Una richiesta è riusabile se ha già candidati salvati e la ricerca non è
   * troppo vecchia. `forceFullSearch` ignora entrambe le condizioni.
   */
  private async canReuse(
    requestId: string,
    forceFullSearch: boolean
  ): Promise<boolean> {
    if (forceFullSearch) return false;
    const request = await prisma.scoutingRequest.findUnique({
      where: { id: requestId },
      select: { lastSearchedAt: true, _count: { select: { candidates: true } } },
    });
    if (!request || request._count.candidates === 0) return false;
    if (!request.lastSearchedAt) return false;

    const maxAgeDays = numericEnv("SCOUTING_REFRESH_AFTER_DAYS", 14);
    const ageMs = Date.now() - request.lastSearchedAt.getTime();
    return ageMs < maxAgeDays * 24 * 60 * 60_000;
  }

  /** Interroga un singolo marketplace e ne registra l'esito. */
  private async runEngine(
    jobRowId: string,
    requestId: string,
    query: string,
    engine: SearchEngine,
    options: { quality: SearchQuality; frameSize: number }
  ): Promise<{ ok: boolean; creditsSpent: number }> {
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
      return { ok: true, creditsSpent };
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
      return { ok: false, creditsSpent: 0 };
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
