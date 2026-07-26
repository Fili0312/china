import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  ProductAnalysisSchema,
  TAOBAO_SOURCES,
  computeVariantIdentity,
  type ProductAnalysis,
  type RerunTaobaoJobRequest,
  type StartTaobaoJobRequest,
  type TaobaoCandidate,
  type TaobaoJobResults,
  type TaobaoJobSummary,
  type TaobaoProductHistory,
  type TaobaoProductRecord,
  type TaobaoRowResults,
  type TaobaoSource,
} from "@china/shared";
import { ClientService } from "./client.service";
import { mergeProducts } from "./merge";
import { DataHubProvider } from "./providers/datahub.provider";
import { TaobaoMemoryService } from "./taobao-memory.service";
import { TaobaoRunnerService } from "./taobao-runner.service";
import { t } from "../i18n/messages";

/**
 * Creazione e lettura dei job di ricerca.
 *
 * Il job nasce **sempre** da una sessione di revisione: senza, non si saprebbe
 * quali righe sono pronte, e l'unica alternativa sarebbe cercare tutto — anche
 * ciò che l'operatore aveva marcato come dubbio. È la differenza fra spendere
 * crediti su richieste verificate e spenderli su richieste qualsiasi.
 *
 * Entrano nel job solo le righe che la revisione mostra come pronte. Le altre
 * ci entrano lo stesso, ma come `SKIPPED` con il motivo scritto: farle sparire
 * darebbe l'impressione che il file fosse più corto di com'è.
 */

/** Stati della revisione dai quali una riga può essere cercata. */
const READY_STATES = new Set(["READY", "KNOWN_PRODUCT", "NEW_PRODUCT", "NEW_VARIANT"]);

export interface TaobaoJobBuildOptions {
  /**
   * La v2 prosegue anche sulle righe segnalate, conservando il motivo nella
   * revisione tecnica finale. Il default `false` è il comportamento storico
   * della v1: una riga non confermata resta SKIPPED.
   */
  allowReviewRows?: boolean;
}

export function isTaobaoJobRowReady(
  state: string,
  hasAnalysis: boolean,
  options: TaobaoJobBuildOptions = {}
): boolean {
  return (
    hasAnalysis &&
    (READY_STATES.has(state) ||
      (options.allowReviewRows === true && state === "NEEDS_REVIEW"))
  );
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value);
}

@Injectable()
export class TaobaoJobService {
  constructor(
    private readonly clients: ClientService,
    private readonly memory: TaobaoMemoryService,
    private readonly runner: TaobaoRunnerService,
    private readonly api: DataHubProvider
  ) {}

  /**
   * Crea il job e lo avvia.
   *
   * Le righe che chiedono la stessa variante vengono legate alla **stessa**
   * `TaobaoRequest`: è così che «una sola ricerca per variantKey» diventa un
   * fatto strutturale invece di una buona intenzione del runner.
   */
  async createJob(
    clientId: string,
    datasetId: string,
    input: StartTaobaoJobRequest,
    options: TaobaoJobBuildOptions = {}
  ): Promise<TaobaoJobSummary> {
    const dataset = await prisma.taobaoDataset.findUnique({
      where: { id: datasetId },
      select: { id: true, clientId: true },
    });
    if (!dataset) throw new NotFoundException(t("err.datasetNotFound", { id: datasetId }));
    this.clients.assertOwnership(clientId, dataset.clientId, "resource.file");

    const run = await prisma.taobaoAnalysisRun.findUnique({
      where: { id: input.analysisRunId },
      select: { id: true, clientId: true, datasetId: true },
    });
    if (!run) throw new NotFoundException(t("err.analysisNotFound", { id: input.analysisRunId }));
    this.clients.assertOwnership(clientId, run.clientId, "resource.analysis");
    if (run.datasetId !== datasetId) {
      throw new BadRequestException(
        t("err.analysisOtherFile")
      );
    }

    const analysisRows = await prisma.taobaoAnalysisRow.findMany({
      where: { runId: run.id },
      orderBy: { rowNumber: "asc" },
      include: { datasetRow: { select: { id: true, cells: true, hyperlink: true } } },
    });
    if (analysisRows.length === 0) {
      throw new BadRequestException(t("err.reviewNoRows"));
    }

    const selected = input.maxRows ? analysisRows.slice(0, input.maxRows) : analysisRows;

    const job = await prisma.taobaoJob.create({
      data: {
        clientId,
        datasetId,
        analysisRunId: run.id,
        status: "QUEUED",
        mapping: toJson(input.mapping),
        forceFullSearch: input.forceFullSearch,
        useBrowser: input.useBrowser,
        maxCandidates: input.maxCandidates,
        detailTopN: input.detailTopN,
        reviewTopN: input.reviewTopN,
        useElim: input.useElim,
        use1688: input.use1688,
      },
      select: { id: true },
    });

    const created = await this.buildJobRows(job.id, selected, options);

    // Il totale si scrive **dopo** aver creato le righe, dal conteggio reale:
    // scriverlo prima significherebbe promettere un numero che una riga
    // saltata in silenzio renderebbe falso.
    await prisma.taobaoJob.update({
      where: { id: job.id },
      data: { totalRows: created },
    });

    this.runner.start(job.id);
    return this.getJob(clientId, job.id);
  }

  /**
   * Rilancia una ricerca già fatta.
   *
   * Nasce da un caso concreto: 118 righe fallite perché la chiave RapidAPI non
   * era configurata. Una volta collegata, ricaricare il file e rianalizzarlo
   * per rifare quelle righe sarebbe costato una seconda analisi completa —
   * mentre l'unica cosa mancata era la ricerca.
   *
   * Il rilancio crea un job **nuovo** invece di riscrivere quello vecchio: lo
   * storico resta leggibile («questa ricerca ha fallito, questa l'ha rifatta»)
   * e i due risultati si possono confrontare. La configurazione — mappatura,
   * candidati, dettagli, recensioni — viene ereditata, così rilanciare non
   * significa ricomporre a mano le stesse impostazioni.
   *
   * La revisione viene **riletta**: le righe confermate a mano nel frattempo
   * entrano nel nuovo job anche se nel precedente erano saltate.
   */
  async rerunJob(
    clientId: string,
    jobId: string,
    input: RerunTaobaoJobRequest
  ): Promise<TaobaoJobSummary> {
    const previous = await prisma.taobaoJob.findUnique({
      where: { id: jobId },
      include: { rows: { include: { _count: { select: { results: true } } } } },
    });
    if (!previous) throw new NotFoundException(t("err.jobNotFound", { id: jobId }));
    this.clients.assertOwnership(clientId, previous.clientId, "resource.job");

    if (!previous.analysisRunId) {
      throw new BadRequestException(
        t("err.jobNoAnalysis")
      );
    }

    // Quali righe rifare. `all` non filtra: si rileggono tutte le righe della
    // revisione, comprese quelle che nel frattempo sono state confermate.
    const wanted = new Set(
      previous.rows
        .filter((row) => {
          if (input.scope === "failed") return row.status === "FAILED";
          if (input.scope === "empty") return row._count.results === 0;
          return true;
        })
        .map((row) => row.datasetRowId)
    );
    if (wanted.size === 0) {
      throw new BadRequestException(
        t("err.rerunEmptyScope", { scope: input.scope })
      );
    }

    const analysisRows = await prisma.taobaoAnalysisRow.findMany({
      where: { runId: previous.analysisRunId, datasetRowId: { in: [...wanted] } },
      orderBy: { rowNumber: "asc" },
    });
    if (analysisRows.length === 0) {
      throw new BadRequestException(t("err.rerunRowsGone"));
    }

    const job = await prisma.taobaoJob.create({
      data: {
        clientId,
        datasetId: previous.datasetId,
        analysisRunId: previous.analysisRunId,
        status: "QUEUED",
        mapping: previous.mapping as Prisma.InputJsonValue,
        // Chi rilancia vuole interrogare la fonte, non rileggere la memoria.
        forceFullSearch: input.forceFullSearch,
        useBrowser: input.useBrowser ?? previous.useBrowser,
        maxCandidates: input.maxCandidates ?? previous.maxCandidates,
        detailTopN: input.detailTopN ?? previous.detailTopN,
        reviewTopN: input.reviewTopN ?? previous.reviewTopN,
        useElim: input.useElim ?? previous.useElim,
        use1688: input.use1688 ?? previous.use1688,
      },
      select: { id: true },
    });

    const created = await this.buildJobRows(job.id, analysisRows);
    await prisma.taobaoJob.update({
      where: { id: job.id },
      data: { totalRows: created },
    });

    this.runner.start(job.id);
    return this.getJob(clientId, job.id);
  }

  /**
   * Crea le righe di un job a partire dalle righe di revisione.
   *
   * Condivisa fra creazione e rilancio di proposito: sono lo stesso atto — «da
   * questa revisione, fai queste righe» — e due copie della regola su cosa è
   * pronto e cosa no divergerebbero al primo cambiamento.
   */
  private async buildJobRows(
    jobId: string,
    analysisRows: ReadonlyArray<{
      id: string;
      datasetRowId: string;
      rowNumber: number;
      state: string;
      error: string | null;
      signatureText: string | null;
      effectiveAnalysis: Prisma.JsonValue | null;
    }>,
    options: TaobaoJobBuildOptions = {}
  ): Promise<number> {
    let created = 0;
    for (const row of analysisRows) {
      const analysis = this.readAnalysis(row.effectiveAnalysis);
      const ready = isTaobaoJobRowReady(row.state, analysis != null, options);

      let requestId: string | null = null;
      if (ready && analysis) {
        const identity = computeVariantIdentity(analysis, row.signatureText);
        requestId = await this.memory.upsertRequest(
          analysis,
          identity,
          analysis.productNameChinese ?? analysis.productFamily
        );
      }

      const query =
        analysis?.searchQueryChinese ??
        analysis?.productNameChinese ??
        analysis?.searchQueryEnglish ??
        "";

      await prisma.taobaoJobRow.create({
        data: {
          jobId,
          datasetRowId: row.datasetRowId,
          analysisRowId: row.id,
          requestId,
          rowNumber: row.rowNumber,
          displayName:
            analysis?.productNameChinese ??
            analysis?.productFamily ??
            t("reason.rowLabel", { number: row.rowNumber }),
          searchQuery: query,
          status: ready && query ? "PENDING" : "SKIPPED",
          reuseReason: ready
            ? query
              ? null
              : t("reason.noChineseQuery")
            : (row.error ??
              t("reason.notConfirmed")),
        },
      });
      created += 1;
    }
    return created;
  }

  /** Riepilogo di un job. */
  async getJob(clientId: string, jobId: string): Promise<TaobaoJobSummary> {
    const job = await prisma.taobaoJob.findUnique({
      where: { id: jobId },
      include: {
        client: { select: { name: true } },
        dataset: { select: { fileName: true } },
      },
    });
    if (!job) throw new NotFoundException(t("err.jobNotFound", { id: jobId }));
    this.clients.assertOwnership(clientId, job.clientId, "resource.job");

    return {
      jobId: job.id,
      clientId: job.clientId,
      clientName: job.client.name,
      datasetId: job.datasetId,
      fileName: job.dataset.fileName,
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      reusedRows: job.reusedRows,
      searchedRows: job.searchedRows,
      failedRows: job.failedRows,
      usage: {
        hwhCalls: job.hwhCalls,
        apiCalls: job.apiCalls,
        apiCacheHits: job.apiCacheHits,
        browserCalls: job.browserCalls,
        elimCalls: job.elimCalls,
        reusedProducts: job.reusedProducts,
        newProducts: job.newProducts,
      },
      browserUsed: job.useBrowser && job.browserCalls > 0,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      error: job.error,
    };
  }

  /** Ricerche di un cliente, dalla più recente. */
  async listJobs(clientId: string, limit = 30): Promise<TaobaoJobSummary[]> {
    await this.clients.get(clientId);
    const jobs = await prisma.taobaoJob.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    return Promise.all(jobs.map((job) => this.getJob(clientId, job.id)));
  }

  /** Risultati completi: ogni riga con tutti i suoi candidati. */
  async getResults(
    clientId: string,
    jobId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<TaobaoJobResults> {
    const job = await this.getJob(clientId, jobId);

    const rows = await prisma.taobaoJobRow.findMany({
      where: { jobId },
      orderBy: { rowNumber: "asc" },
      skip: options.offset ?? 0,
      take: options.limit ?? 500,
      include: {
        datasetRow: { select: { cells: true } },
        analysisRow: { select: { effectiveAnalysis: true } },
        request: { select: { variantKey: true } },
        results: {
          orderBy: { rank: "asc" },
          include: { product: true },
        },
      },
    });

    const mapped: TaobaoRowResults[] = rows.map((row) => {
      const analysis = this.readAnalysis(row.analysisRow?.effectiveAnalysis ?? null);
      return {
        jobRowId: row.id,
        rowNumber: row.rowNumber,
        displayName: row.displayName,
        searchQuery: row.searchQuery,
        status: row.status,
        reused: row.reused,
        reuseReason: row.reuseReason,
        variantKey: row.request?.variantKey ?? null,
        originalCells: (row.datasetRow.cells as unknown as string[]) ?? [],
        // Quantità e unità chieste dal foglio: servono al report per il
        // cliente, dove il prezzo va moltiplicato per ciò che si compra.
        requestedQuantity: analysis?.requestedQuantity ?? null,
        requestedUnit: analysis?.unit ?? null,
        hwhStatus: row.hwhStatus,
        hwhError: row.hwhError,
        hwhCount: row.hwhCount,
        apiStatus: row.apiStatus,
        apiError: row.apiError,
        apiCount: row.apiCount,
        elimStatus: row.elimStatus,
        elimError: row.elimError,
        elimCount: row.elimCount,
        browserStatus: row.browserStatus,
        browserError: row.browserError,
        browserCount: row.browserCount,
        error: row.error,
        candidates: row.results.map((result) => toCandidate(result)),
      };
    });

    return { job, rows: mapped };
  }

  /**
   * Storico di un prodotto: quando è cambiato, e cosa.
   *
   * L'appartenenza si verifica **per risultato**, non per prodotto: la memoria
   * dei prodotti è condivisa fra clienti, quindi un `productId` da solo non
   * dice di chi sia. Un cliente può leggere lo storico solo dei prodotti che
   * una sua ricerca ha effettivamente proposto — altrimenti, conoscendo un id,
   * si potrebbe sfogliare il lavoro fatto per qualcun altro.
   */
  async productHistory(clientId: string, productId: string): Promise<TaobaoProductHistory> {
    await this.clients.get(clientId);

    const product = await prisma.taobaoProduct.findFirst({
      where: {
        id: productId,
        results: { some: { jobRow: { job: { clientId } } } },
      },
      include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 50 } },
    });
    if (!product) {
      throw new NotFoundException(t("err.productNotFound"));
    }

    return {
      productId: product.id,
      itemId: product.itemId,
      title: product.title,
      url: product.url,
      currentPrice: decimalToNumber(product.price),
      currency: product.currency,
      firstSeenAt: product.firstSeenAt.toISOString(),
      lastCheckedAt: product.lastCheckedAt.toISOString(),
      lastChangedAt: product.lastChangedAt?.toISOString() ?? null,
      unavailable: product.unavailable,
      entries: product.snapshots.map((snapshot) => ({
        capturedAt: snapshot.capturedAt.toISOString(),
        price: decimalToNumber(snapshot.price),
        currency: snapshot.currency,
        totalSales: snapshot.totalSales,
        reviewCount: snapshot.reviewCount,
        available: snapshot.available,
        changedFields: snapshot.changedFields,
      })),
    };
  }

  /**
   * Riverifica un prodotto alla fonte, adesso.
   *
   * Nasce da un fatto osservato: il prezzo mostrato è quello dell'ultimo
   * controllo, e cliccando il link il prezzo su Taobao può essere già un
   * altro. Questo metodo rilegge la scheda **senza cache** e aggiorna memoria
   * e storico, così la carta mostra il prezzo di adesso e dice se è cambiato.
   */
  async refreshProduct(
    clientId: string,
    productId: string
  ): Promise<{ product: TaobaoProductRecord; priceBefore: number | null }> {
    await this.clients.get(clientId);

    // Stessa regola dello storico: si può riverificare solo un prodotto che
    // una ricerca di questo cliente ha davvero proposto.
    const product = await prisma.taobaoProduct.findFirst({
      where: {
        id: productId,
        results: { some: { jobRow: { job: { clientId } } } },
      },
    });
    if (!product) {
      throw new NotFoundException(t("err.productNotFound"));
    }
    if (!this.api.isConfigured) {
      throw new BadRequestException(
        t("err.rapidapiMissing")
      );
    }
    if (product.platform !== "taobao") {
      throw new BadRequestException(
        t("err.refreshTaobaoOnly")
      );
    }

    const priceBefore = decimalToNumber(product.price);
    const known = await this.memory.loadProducts(product.requestId);
    const raw = known.find(
      (entry) => entry.itemId === product.itemId && entry.platform === product.platform
    );
    if (!raw) {
      throw new NotFoundException(t("err.productGone"));
    }

    try {
      // `ttlHours: 0`: la domanda è «quanto costa adesso», non ieri.
      const detail = await this.api.detail(product.itemId, { ttlHours: 0 });
      const merged = mergeProducts([{ ...raw, ...detail.patch, source: "api" }]);
      await this.memory.recordProducts(product.requestId, merged, product.foundQuery);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Errore imprevisto";
      await this.memory.markUnavailable(product.id, message);
    }

    const fresh = await prisma.taobaoProduct.findUnique({ where: { id: productId } });
    if (!fresh) throw new NotFoundException(t("err.productAfterRefresh"));
    return { product: toProductRecord(fresh), priceBefore };
  }

  /** Ferma un job in corso: le righe già fatte restano. */
  async cancel(clientId: string, jobId: string): Promise<TaobaoJobSummary> {
    const job = await this.getJob(clientId, jobId);
    if (job.status === "RUNNING" || job.status === "QUEUED") {
      this.runner.cancel(jobId);
      await prisma.taobaoJob.update({
        where: { id: jobId },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
    }
    return this.getJob(clientId, jobId);
  }

  private readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
    if (value == null) return null;
    const parsed = ProductAnalysisSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}

/** Forma minima del prodotto a database usata dal contratto pubblico. */
interface ProductRow {
  id: string;
  platform: string;
  itemId: string;
  title: string;
  titleEn: string | null;
  url: string | null;
  imageUrl: string | null;
  price: Prisma.Decimal | null;
  currency: string | null;
  variantPrice: Prisma.Decimal | null;
  promotionPrice: Prisma.Decimal | null;
  moq: number | null;
  sku: string | null;
  shopName: string | null;
  shopUrl: string | null;
  totalSales: number | null;
  reviewCount: number | null;
  rating: number | null;
  specs: Prisma.JsonValue | null;
  variants: Prisma.JsonValue | null;
  availability: string | null;
  shipping: Prisma.JsonValue | null;
  foundQuery: string;
  sources: string[];
  lastCheckedAt: Date;
  changedFields: string[];
  unavailable: boolean;
}

/** Prodotto a database → contratto pubblico. */
function toProductRecord(product: ProductRow): TaobaoProductRecord {
  return {
    productId: product.id,
    platform: product.platform === "1688" ? "1688" : "taobao",
    itemId: product.itemId,
    title: product.title,
    titleEn: product.titleEn,
    url: product.url,
    imageUrl: product.imageUrl,
    price: decimalToNumber(product.price),
    currency: product.currency,
    variantPrice: decimalToNumber(product.variantPrice),
    promotionPrice: decimalToNumber(product.promotionPrice),
    moq: product.moq,
    sku: product.sku,
    shopName: product.shopName,
    shopUrl: product.shopUrl,
    totalSales: product.totalSales,
    reviewCount: product.reviewCount,
    rating: product.rating,
    specs: (product.specs as Record<string, string> | null) ?? null,
    variants:
      (product.variants as Array<{ name: string; options: string[] }> | null) ?? null,
    availability: product.availability,
    shipping: typeof product.shipping === "string" ? product.shipping : null,
    foundQuery: product.foundQuery,
    sources: product.sources.filter(isSource),
    lastCheckedAt: product.lastCheckedAt.toISOString(),
    changedFields: product.changedFields,
    unavailable: product.unavailable,
  };
}

/** Riga di risultato → contratto pubblico. */
function toCandidate(result: {
  rank: number;
  score: number;
  scoreBreakdown: Prisma.JsonValue | null;
  matchedRequirements: string[];
  missingRequirements: string[];
  warnings: string[];
  sources: string[];
  sourceConflicts: string[];
  coherence: Prisma.JsonValue | null;
  product: ProductRow;
}): TaobaoCandidate {
  return {
    rank: result.rank,
    score: result.score,
    scoreBreakdown: result.scoreBreakdown as TaobaoCandidate["scoreBreakdown"],
    matchedRequirements: result.matchedRequirements,
    missingRequirements: result.missingRequirements,
    warnings: result.warnings,
    sourceConflicts: result.sourceConflicts,
    coherence: (result.coherence as TaobaoCandidate["coherence"]) ?? null,
    product: toProductRecord(result.product),
  };
}

/**
 * Provenienze riconosciute.
 *
 * Deriva dall'elenco condiviso invece di ripeterlo: quando è stata aggiunta
 * `elim` questa funzione non è stata aggiornata, e i prodotti trovati da
 * ElimAPI sono arrivati in interfaccia **senza provenienza** — visibili ma
 * senza il dato che dice da dove vengono.
 */
function isSource(value: string): value is TaobaoSource {
  return (TAOBAO_SOURCES as readonly string[]).includes(value);
}
