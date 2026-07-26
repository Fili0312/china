import { Injectable, Logger } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import { ProductAnalysisSchema, type ProductAnalysis } from "@china/shared";
import { TaobaoBrowserError } from "@china/adapters";
import { mergeProducts, type MergedProduct } from "./merge";
import { rankCandidates, type ScoredProduct } from "./scoring";
import { DataHubProvider } from "./providers/datahub.provider";
import { ElimApiProvider } from "./providers/elim.provider";
import { HwhProvider } from "./providers/hwh.provider";
import { TaobaoBrowserService } from "./providers/browser-search.service";
import {
  extractItemId,
  canonicalItemUrl,
  decodeLinkEntities,
  type RawTaobaoProduct,
} from "./providers/taobao-item";
import { TaobaoMemoryService } from "./taobao-memory.service";
import { t } from "../i18n/messages";

/**
 * L'esecuzione della ricerca, riga per riga.
 *
 * Il flusso di ogni variante è quello concordato, e l'ordine dei passi è la
 * cosa che fa risparmiare crediti:
 *
 * ```
 * link già nell'Excel
 *   → memoria: la variante è conosciuta?
 *       → sì  : rileggi i prodotti alla fonte, aggiorna prezzi e storico,
 *               e se bastano fermati qui (nessuna ricerca)
 *       → no  : ricerca API (1 chiamata) + ricerca Playwright se collegato
 *   → unione e deduplica di tutte le fonti
 *   → dettaglio solo sui migliori, recensioni solo sui finalisti
 *   → salvataggio in memoria, classifica, risultati
 * ```
 *
 * Due regole attraversano tutto:
 *
 * - **Una ricerca per variante, non per riga.** Le righe con la stessa
 *   `variantKey` vengono elaborate insieme e condividono il risultato: un
 *   foglio con 500 righe e 250 varianti fa 250 ricerche.
 * - **Un trasporto che fallisce non azzera l'altro.** L'esito di API e
 *   Playwright si registra separatamente; un captcha sul browser lascia
 *   intatti i prodotti trovati via API, e viceversa.
 */

/** Prodotti riletti alla fonte per un aggiornamento, al massimo. */
const REFRESH_LIMIT = 12;

/**
 * Sotto quanti risultati DataHub «non basta».
 *
 * Non è zero: un'unica scheda trovata è quasi sempre un caso, e proseguire con
 * la seconda fonte costa una richiesta ma evita di consegnare una riga con un
 * solo candidato — che l'operatore non può nemmeno confrontare.
 */
function minResultsBeforeElim(): number {
  return numericEnv("ELIM_MIN_RESULTS", 3);
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Fonte primaria della ricerca per parola chiave.
 *
 * `hwh` («Taobao API by H-W-H») di default: piano più capiente. DataHub resta
 * il fallback per errori, limiti o risultati scarsi — e l'unico per dettagli e
 * recensioni. `TAOBAO_PRIMARY_SEARCH=datahub` ripristina l'ordine vecchio.
 */
function primarySearch(): "hwh" | "datahub" {
  return (process.env.TAOBAO_PRIMARY_SEARCH ?? "hwh").trim().toLowerCase() === "datahub"
    ? "datahub"
    : "hwh";
}

/**
 * Il fallback DataHub della ricerca è attivo?
 *
 * Quando H-W-H è la primaria, `TAOBAO_SEARCH_FALLBACK=0` tiene DataHub fuori
 * dalla ricerca: durante una demo con le fonti secondarie in standby, così una
 * riga senza risultati resta «nessun prodotto», non una cascata di errori di
 * fonti che non si vogliono mostrare. DataHub resta disponibile per i dettagli
 * (silenziosi) e, quando è lui la primaria, non è toccato da questa opzione.
 */
function searchFallbackEnabled(): boolean {
  return (process.env.TAOBAO_SEARCH_FALLBACK ?? "1").trim() !== "0";
}

/** Contatori del job, aggiornati man mano. */
interface JobTotals {
  hwhCalls: number;
  apiCalls: number;
  apiCacheHits: number;
  elimCalls: number;
  browserCalls: number;
  reusedProducts: number;
  newProducts: number;
  processedRows: number;
  reusedRows: number;
  searchedRows: number;
  failedRows: number;
}

type JobRow = Prisma.TaobaoJobRowGetPayload<{
  include: {
    analysisRow: { select: { effectiveAnalysis: true; rowNumber: true } };
    datasetRow: { select: { hyperlink: true } };
  };
}>;

@Injectable()
export class TaobaoRunnerService {
  private readonly logger = new Logger("TaobaoRunner");
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly api: DataHubProvider,
    private readonly hwh: HwhProvider,
    private readonly elim: ElimApiProvider,
    private readonly browser: TaobaoBrowserService,
    private readonly memory: TaobaoMemoryService
  ) {}

  /** Avvia il job in background: chi chiama non aspetta la fine. */
  start(jobId: string): void {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    void this.run(jobId)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Errore imprevisto";
        this.logger.error(`job ${jobId} interrotto: ${message}`);
        await prisma.taobaoJob
          .update({
            where: { id: jobId },
            data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
          })
          .catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(jobId);
        this.cancelled.delete(jobId);
      });
  }

  cancel(jobId: string): void {
    this.cancelled.add(jobId);
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  private async run(jobId: string): Promise<void> {
    const job = await prisma.taobaoJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    await prisma.taobaoJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date(), error: null },
    });

    const rows = await prisma.taobaoJobRow.findMany({
      where: { jobId, status: "PENDING" },
      orderBy: { rowNumber: "asc" },
      include: {
        analysisRow: { select: { effectiveAnalysis: true, rowNumber: true } },
        datasetRow: { select: { hyperlink: true } },
      },
    });

    // Righe con la stessa variante: una ricerca sola, risultato condiviso.
    const groups = new Map<string, JobRow[]>();
    for (const row of rows) {
      const key = row.requestId ?? `riga:${row.id}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    const totals: JobTotals = {
      hwhCalls: 0,
      apiCalls: 0,
      apiCacheHits: 0,
      elimCalls: 0,
      browserCalls: 0,
      reusedProducts: 0,
      newProducts: 0,
      processedRows: 0,
      reusedRows: 0,
      searchedRows: 0,
      failedRows: 0,
    };

    for (const [, group] of groups) {
      if (this.cancelled.has(jobId)) {
        this.logger.log(`job ${jobId} annullato dopo ${totals.processedRows} righe`);
        return;
      }

      try {
        await this.processVariant(job, group, totals);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Errore imprevisto";
        totals.failedRows += group.length;
        totals.processedRows += group.length;
        await prisma.taobaoJobRow.updateMany({
          where: { id: { in: group.map((row) => row.id) } },
          data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
        });
      }

      await this.saveTotals(jobId, totals);
    }

    const status = totals.failedRows > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    await prisma.taobaoJob.update({
      where: { id: jobId },
      data: { status, finishedAt: new Date() },
    });
    this.logger.log(
      `job ${jobId} concluso: ${totals.processedRows} righe, ${totals.reusedRows} riusate, ` +
        `${totals.apiCalls} chiamate API, ${totals.browserCalls} ricerche browser`
    );
  }

  /**
   * Elabora una variante e scrive i risultati su tutte le righe che la
   * chiedono.
   */
  private async processVariant(
    job: {
      id: string;
      forceFullSearch: boolean;
      useBrowser: boolean;
      useElim: boolean;
      use1688: boolean;
      maxCandidates: number;
      detailTopN: number;
      reviewTopN: number;
    },
    group: JobRow[],
    totals: JobTotals
  ): Promise<void> {
    const leader = group[0]!;
    const analysis = readAnalysis(leader.analysisRow?.effectiveAnalysis ?? null);
    const requestId = leader.requestId;
    const query = leader.searchQuery;

    if (!analysis || !requestId || !query) {
      await prisma.taobaoJobRow.updateMany({
        where: { id: { in: group.map((row) => row.id) } },
        data: {
          status: "SKIPPED",
          reuseReason: t("reason.noQuery"),
          finishedAt: new Date(),
        },
      });
      totals.processedRows += group.length;
      return;
    }

    await prisma.taobaoJobRow.updateMany({
      where: { id: { in: group.map((row) => row.id) } },
      data: { status: "REFRESHING", startedAt: new Date(), error: null },
    });

    const candidates: RawTaobaoProduct[] = [];

    // 1. I link già presenti nel foglio: sono il **prodotto base** — quello
    //    che il cliente ha già usato in precedenza. Non compete con gli altri:
    //    va mostrato per primo, e con un prezzo vero.
    const excelItemIds = new Set<string>();
    for (const row of group) {
      const hyperlink = decodeLinkEntities(row.datasetRow?.hyperlink ?? null);
      const itemId = extractItemId(hyperlink);
      if (!itemId || excelItemIds.has(itemId)) continue;
      excelItemIds.add(itemId);
      candidates.push({
        platform: "taobao",
        itemId,
        title: row.displayName,
        titleEn: null,
        url: hyperlink ?? canonicalItemUrl(itemId),
        imageUrl: null,
        price: null,
        currency: "CNY",
        variantPrice: null,
        promotionPrice: null,
        moq: null,
        sku: null,
        shopName: null,
        shopUrl: null,
        sellerId: null,
        totalSales: null,
        reviewCount: null,
        rating: null,
        specs: null,
        variants: null,
        availability: null,
        shipping: null,
        source: "excel",
      });
    }

    // 2. La memoria: cosa sappiamo già di questa variante.
    const stored = await this.memory.loadStored(requestId);
    const known = await this.memory.loadProducts(requestId);
    candidates.push(...known);
    totals.reusedProducts += known.length;

    // 1b. Un link del foglio che la memoria non conosce ancora arriverebbe in
    //     classifica senza prezzo né foto — un candidato «primo» ma vuoto. Una
    //     chiamata di dettaglio lo riempie; se la memoria lo conosce già, i
    //     suoi dati arrivano al merge dal passo 2 senza spendere nulla.
    if (excelItemIds.size > 0 && this.api.isConfigured) {
      const knownIds = new Set(known.map((product) => product.itemId));
      for (const candidate of candidates) {
        if (candidate.source !== "excel" || knownIds.has(candidate.itemId)) continue;
        try {
          const detail = await this.api.detail(candidate.itemId);
          if (detail.fromCache) totals.apiCacheHits += 1;
          else totals.apiCalls += 1;
          Object.assign(candidate, { ...detail.patch, source: "excel" });
        } catch {
          // Il link resta un candidato anche senza dettaglio: dice comunque
          // «questo è il prodotto che il cliente usava».
        }
      }
    }

    let reuse = false;
    let reuseReason: string | null = null;
    let refreshedProducts: RawTaobaoProduct[] = [];

    if (stored.length > 0 && !job.forceFullSearch) {
      if (this.api.isConfigured) {
        // Prima si guarda, poi si giudica: riaprire le schede è l'unico modo
        // di sapere se un link di due mesi fa vale ancora qualcosa.
        const refresh = await this.refreshKnown(known, totals);
        refreshedProducts = refresh.products;

        if (refresh.products.length > 0) {
          const merged = mergeProducts(refresh.products);
          await this.memory.recordProducts(requestId, merged, query);
        }
        const rechecked = await this.memory.loadStored(requestId);
        const decision = this.memory.evaluateReuse(rechecked, {
          forceFullSearch: false,
          refreshFailed: refresh.failedProductIds,
        });
        reuse = decision.reuse;
        reuseReason = decision.reason;
      } else {
        await this.memory.markVerified(requestId);
        reuse = false;
        reuseReason = t("reason.knownUnverifiable");
      }
    }

    let searchQueryUsed = query;
    let hwhStatus: string | null = null;
    let hwhError: string | null = null;
    let hwhCount = 0;
    let apiStatus: string | null = null;
    let elimStatus: string | null = null;
    let elimError: string | null = null;
    let elimCount = 0;
    let apiError: string | null = null;
    let apiCount = 0;
    let browserStatus: string | null = null;
    let browserError: string | null = null;
    let browserCount = 0;

    if (!reuse) {
      // 3. Ricerca primaria: «Taobao API by H-W-H», quando è configurata e
      //    scelta come primaria. Una sola chiamata per variante (le varianti
      //    già cercate non arrivano qui: le ferma la memoria).
      await this.setGroupStatus(group, "SEARCHING_API");
      const useHwh = primarySearch() === "hwh" && this.hwh.isConfigured;

      if (useHwh) {
        try {
          const result = await this.hwh.search(query, { limit: job.maxCandidates * 2 });
          // I tentativi contano tutti: una query accorciata è una chiamata in
          // più, e nasconderla renderebbe il conto delle chiamate una bugia.
          if (result.fromCache) totals.apiCacheHits += result.attempts;
          else totals.hwhCalls += result.attempts;
          candidates.push(...result.products);
          hwhCount = result.products.length;
          hwhStatus = result.products.length > 0 ? "DONE" : "EMPTY";
          if (result.products.length > 0) searchQueryUsed = result.queryUsed;
        } catch (error) {
          hwhStatus = "ERROR";
          hwhError = error instanceof Error ? error.message : "Errore imprevisto";
        }
      }

      // 3b. DataHub: fonte primaria quando H-W-H non è in uso, fallback quando
      //     H-W-H fallisce (errore, limite del piano) o porta troppo poco. In
      //     modalità standby il fallback è spento: con H-W-H primaria, DataHub
      //     non partecipa alla ricerca.
      const hwhEnough = candidates.filter((c) => c.source === "hwh").length;
      const dataHubNeeded = !useHwh
        ? true
        : searchFallbackEnabled() &&
          (hwhStatus === "ERROR" || hwhEnough < minResultsBeforeElim());

      if (dataHubNeeded) {
        try {
          const result = await this.api.search(query, { limit: job.maxCandidates * 2 });
          if (result.fromCache) totals.apiCacheHits += result.attempts;
          else totals.apiCalls += result.attempts;
          candidates.push(...result.products);
          apiCount = result.products.length;
          apiStatus = result.products.length > 0 ? "DONE" : "EMPTY";
          // La query che ha funzionato può essere più corta di quella
          // richiesta: è quella che va salvata sui prodotti.
          if (result.products.length > 0 && hwhCount === 0) {
            searchQueryUsed = result.queryUsed;
          }
        } catch (error) {
          apiStatus = "ERROR";
          apiError = error instanceof Error ? error.message : "Errore imprevisto";
        }
      }

      // 3c. ElimAPI come riserva: quando le fonti RapidAPI vanno in errore o
      //     portano troppo poco. Non si chiama «per sicurezza» — è un piano
      //     con richieste contate, e chiamarlo quando le prime fonti sono
      //     bastate sarebbe spendere per un risultato che si ha già.
      const enough = candidates.filter(
        (c) => c.source === "api" || c.source === "hwh"
      ).length;
      const searchErrored =
        (useHwh ? hwhStatus === "ERROR" : true) &&
        (dataHubNeeded ? apiStatus === "ERROR" : false);
      const elimNeeded = searchErrored || enough < minResultsBeforeElim();

      if (job.useElim && this.elim.isConfigured) {
        // ElimAPI su **Taobao** è una riserva: si chiama solo se la prima
        // fonte non è bastata. Chiamarla comunque sarebbe pagare due volte lo
        // stesso catalogo.
        if (elimNeeded) {
          try {
            const result = await this.elim.search(query, "taobao", {
              limit: job.maxCandidates,
            });
            totals.elimCalls += result.calls;
            candidates.push(...result.products);
            elimCount += result.products.length;
            elimStatus = result.products.length > 0 ? "DONE" : "EMPTY";
            if (apiStatus === "ERROR" && result.products.length > 0) {
              searchQueryUsed = result.queryUsed;
            }
          } catch (error) {
            elimStatus = "ERROR";
            elimError = error instanceof Error ? error.message : "Errore imprevisto";
          }
        }

        // **1688 non è una riserva**: è un altro catalogo, all'ingrosso, con
        // prezzi e minimi d'ordine diversi. Chi lo chiede vuole quei prezzi,
        // non un ripiego a Taobao andato male — quindi parte quando è
        // richiesto, indipendentemente da come è andata la prima fonte.
        if (job.use1688) {
          try {
            const result = await this.elim.search(query, "1688", {
              limit: job.maxCandidates,
            });
            totals.elimCalls += result.calls;
            candidates.push(...result.products);
            elimCount += result.products.length;
            if (elimStatus !== "ERROR") {
              elimStatus = elimCount > 0 ? "DONE" : "EMPTY";
            }
          } catch (error) {
            // Un errore su 1688 non tocca i risultati Taobao già raccolti.
            elimError = error instanceof Error ? error.message : "Errore imprevisto";
            if (elimStatus == null) elimStatus = "ERROR";
          }
        }
      } else if (job.useElim && (elimNeeded || job.use1688) && !this.elim.isConfigured) {
        elimStatus = "SKIPPED";
        elimError = "ELI_API non configurata.";
      }

      // 4. Ricerca Playwright, se l'account è collegato.
      if (job.useBrowser) {
        const unavailable = await this.browser.unavailableReason();
        if (unavailable) {
          browserStatus = "SKIPPED";
          browserError = unavailable;
        } else {
          await this.setGroupStatus(group, "SEARCHING_BROWSER");
          try {
            const result = await this.browser.search(query, job.maxCandidates);
            totals.browserCalls += 1;
            candidates.push(...result.products);
            browserCount = result.products.length;
            browserStatus = result.products.length > 0 ? "DONE" : "EMPTY";
          } catch (error) {
            browserStatus =
              error instanceof TaobaoBrowserError && error.code === "VERIFICATION_REQUIRED"
                ? "VERIFICATION_REQUIRED"
                : "ERROR";
            browserError = error instanceof Error ? error.message : "Errore imprevisto";
          }
        }
      } else {
        browserStatus = "DISABLED";
      }
    } else {
      hwhStatus = "REUSED";
      apiStatus = "REUSED";
      elimStatus = "REUSED";
      browserStatus = "REUSED";
      candidates.push(...refreshedProducts);
    }

    // La ricerca per parola chiave è fallita solo se OGNI fonte tentata è in
    // errore: se il fallback ha risposto, l'errore del primario è un dettaglio.
    const searchError =
      (hwhStatus == null || hwhStatus === "ERROR") && apiStatus === "ERROR"
        ? (apiError ?? hwhError)
        : hwhStatus === "ERROR" && apiStatus == null
          ? hwhError
          : null;

    // 5. Unione di tutte le fonti.
    let merged = mergeProducts(candidates);

    if (merged.length === 0) {
      await this.finishGroup(group, {
        status: searchError && browserStatus !== "DONE" ? "FAILED" : "DONE",
        reused: reuse,
        reuseReason:
          reuseReason ??
          (searchError ?? t("reason.nothingFound")),
        hwhStatus,
        hwhError,
        hwhCount,
        apiStatus,
        apiError,
        apiCount,
        elimStatus,
        elimError,
        elimCount,
        browserStatus,
        browserError,
        browserCount,
        error: searchError && elimStatus !== "DONE" ? searchError : null,
      });
      // Una riga è in errore solo se **nessuna** fonte ha funzionato: se la
      // riserva ha trovato qualcosa, l'errore della prima è un dettaglio.
      if (searchError && elimStatus !== "DONE") totals.failedRows += group.length;
      totals.processedRows += group.length;
      if (reuse) totals.reusedRows += group.length;
      else totals.searchedRows += group.length;
      return;
    }

    // 6. Dettaglio solo sui migliori: una chiamata a candidato, e i candidati
    //    che non arriveranno mai in cima non la meritano.
    if (!reuse && job.detailTopN > 0 && this.api.isConfigured) {
      const preliminary = rankCandidates(analysis, merged)
        .filter((entry) => entry.product.platform === "taobao")
        .slice(0, job.detailTopN);
      const patched: RawTaobaoProduct[] = [];
      for (const entry of preliminary) {
        try {
          const detail = await this.api.detail(entry.product.itemId);
          if (detail.fromCache) totals.apiCacheHits += 1;
          else totals.apiCalls += 1;
          patched.push({ ...entry.product, ...detail.patch, source: "api" });
        } catch {
          // Un dettaglio mancante non toglie il candidato: resta con i dati
          // della ricerca, che sono meno ricchi ma veri.
        }
      }
      if (patched.length > 0) merged = mergeProducts([...candidates, ...patched]);
    }

    let ranked = pinExcelFirst(rankCandidates(analysis, merged)).slice(0, job.maxCandidates);

    // 7. Recensioni solo sui finalisti, e solo se richieste.
    if (!reuse && job.reviewTopN > 0 && this.api.isConfigured) {
      const enriched: RawTaobaoProduct[] = [];
      for (const entry of ranked
        .filter((entry) => entry.product.platform === "taobao")
        .slice(0, job.reviewTopN)) {
        try {
          const reviews = await this.api.reviews(entry.product.itemId);
          if (reviews.fromCache) totals.apiCacheHits += 1;
          else totals.apiCalls += 1;
          enriched.push({
            ...entry.product,
            reviewCount: reviews.reviewCount ?? entry.product.reviewCount,
            rating: reviews.rating ?? entry.product.rating,
            source: "api",
          });
        } catch {
          // Le recensioni sono un di più: la loro assenza non cambia il resto.
        }
      }
      if (enriched.length > 0) {
        merged = mergeProducts([...candidates, ...enriched]);
        ranked = pinExcelFirst(rankCandidates(analysis, merged)).slice(0, job.maxCandidates);
      }
    }

    // 8. Memoria e storico.
    const saved = await this.memory.recordProducts(
      requestId,
      ranked.map((entry) => entry.product),
      searchQueryUsed
    );
    totals.newProducts += saved.created;

    // 9. Risultati su tutte le righe del gruppo.
    await this.writeResults(group, ranked, saved.productIds);

    await this.finishGroup(group, {
      status: "DONE",
      reused: reuse,
      reuseReason,
      hwhStatus,
      hwhError,
      hwhCount,
      apiStatus,
      apiError,
      apiCount,
      elimStatus,
      elimError,
      elimCount,
      browserStatus,
      browserError,
      browserCount,
      error: null,
    });

    totals.processedRows += group.length;
    if (reuse) totals.reusedRows += group.length;
    else totals.searchedRows += group.length;
  }

  /**
   * Rilegge alla fonte i prodotti già noti.
   *
   * È l'operazione che completa il riuso: la richiesta non viene ricercata di
   * nuovo, ma quello che avevamo viene riaperto e riverificato.
   */
  private async refreshKnown(
    known: readonly RawTaobaoProduct[],
    totals: JobTotals
  ): Promise<{ products: RawTaobaoProduct[]; failedProductIds: Set<string> }> {
    const products: RawTaobaoProduct[] = [];
    const failed = new Set<string>();

    for (const product of known.slice(0, numericEnv("TAOBAO_REFRESH_LIMIT", REFRESH_LIMIT))) {
      try {
        // `ttlHours: 0`: una risposta in cache risponderebbe alla domanda di
        // ieri, e la domanda qui è «quanto costa adesso?».
        const detail = await this.api.detail(product.itemId, { ttlHours: 0 });
        totals.apiCalls += 1;
        products.push({ ...product, ...detail.patch, source: "api" });
      } catch {
        failed.add(product.itemId);
      }
    }

    return { products, failedProductIds: failed };
  }

  private async setGroupStatus(
    group: readonly JobRow[],
    status: "REFRESHING" | "SEARCHING_API" | "SEARCHING_BROWSER"
  ): Promise<void> {
    await prisma.taobaoJobRow.updateMany({
      where: { id: { in: group.map((row) => row.id) } },
      data: { status },
    });
  }

  /** Scrive i candidati su ogni riga del gruppo, con la stessa classifica. */
  private async writeResults(
    group: readonly JobRow[],
    ranked: readonly ScoredProduct[],
    productIds: Map<string, string>
  ): Promise<void> {
    for (const row of group) {
      // I risultati precedenti della riga se ne vanno: una nuova esecuzione
      // sostituisce la classifica, non la accoda.
      await prisma.taobaoJobResult.deleteMany({ where: { jobRowId: row.id } });

      let rank = 0;
      for (const entry of ranked) {
        const productId = productIds.get(
          `${entry.product.platform}:${entry.product.itemId}`
        );
        if (!productId) continue;
        rank += 1;
        await prisma.taobaoJobResult.create({
          data: {
            jobRowId: row.id,
            productId,
            rank,
            score: entry.score,
            scoreBreakdown: toJson(entry.breakdown),
            matchedRequirements: entry.matchedRequirements,
            missingRequirements: entry.missingRequirements,
            warnings: entry.warnings,
            sources: entry.product.sources,
            sourceConflicts: entry.product.conflicts,
          },
        });
      }
    }
  }

  private async finishGroup(
    group: readonly JobRow[],
    outcome: {
      status: "DONE" | "FAILED";
      reused: boolean;
      reuseReason: string | null;
      hwhStatus: string | null;
      hwhError: string | null;
      hwhCount: number;
      apiStatus: string | null;
      apiError: string | null;
      apiCount: number;
      elimStatus: string | null;
      elimError: string | null;
      elimCount: number;
      browserStatus: string | null;
      browserError: string | null;
      browserCount: number;
      error: string | null;
    }
  ): Promise<void> {
    const leader = group[0]!;
    for (const row of group) {
      const shared =
        row.id === leader.id
          ? outcome.reuseReason
          : // Le righe gemelle dicono da dove arriva il loro risultato: senza,
            // sembrerebbe che siano state cercate anche loro.
            `Stessa variante della riga ${leader.rowNumber}: risultati condivisi.`;

      await prisma.taobaoJobRow.update({
        where: { id: row.id },
        data: {
          status: outcome.status,
          reused: outcome.reused || row.id !== leader.id,
          reuseReason: shared,
          hwhStatus: outcome.hwhStatus,
          hwhError: outcome.hwhError,
          hwhCount: outcome.hwhCount,
          apiStatus: outcome.apiStatus,
          apiError: outcome.apiError,
          apiCount: outcome.apiCount,
          elimStatus: outcome.elimStatus,
          elimError: outcome.elimError,
          elimCount: outcome.elimCount,
          browserStatus: outcome.browserStatus,
          browserError: outcome.browserError,
          browserCount: outcome.browserCount,
          error: outcome.error,
          finishedAt: new Date(),
        },
      });
    }
  }

  private async saveTotals(jobId: string, totals: JobTotals): Promise<void> {
    await prisma.taobaoJob.update({
      where: { id: jobId },
      data: {
        processedRows: totals.processedRows,
        reusedRows: totals.reusedRows,
        searchedRows: totals.searchedRows,
        failedRows: totals.failedRows,
        hwhCalls: totals.hwhCalls,
        apiCalls: totals.apiCalls,
        apiCacheHits: totals.apiCacheHits,
        elimCalls: totals.elimCalls,
        browserCalls: totals.browserCalls,
        reusedProducts: totals.reusedProducts,
        newProducts: totals.newProducts,
      },
    });
  }
}

function readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
  if (value == null) return null;
  const parsed = ProductAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Il prodotto arrivato dal link del foglio sta sempre in cima.
 *
 * Non è un giudizio tecnico: è la regola concordata — se il cliente ha già
 * comprato da quel link, quello è il punto di partenza («prodotto usato in
 * precedenza»), e i candidati con corrispondenza migliore stanno subito sotto,
 * nell'ordine della classifica.
 */
function pinExcelFirst(ranked: ScoredProduct[]): ScoredProduct[] {
  const excel = ranked.filter((entry) => entry.product.sources.includes("excel"));
  if (excel.length === 0) return ranked;
  return [...excel, ...ranked.filter((entry) => !entry.product.sources.includes("excel"))];
}

/** Riesportato per i test del punteggio. */
export type { MergedProduct };
