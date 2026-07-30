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
  extractSkuId,
  canonicalItemUrl,
  decodeLinkEntities,
  type RawTaobaoProduct,
} from "./providers/taobao-item";
import {
  elimDetailToProduct,
  pickElimSku,
  type ElimDetail,
  type ElimSku,
} from "./providers/elim-detail";
import { pickVariantWithAi } from "@china/ai";
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

/** Dopo quante schede vuote di fila si smette di chiederle. */
const EMPTY_DETAIL_GIVE_UP = 3;

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
/**
 * Sotto questa confidenza la scelta del modello non vale: la riga torna a
 * essere una domanda per una persona. Una variante sbagliata scelta con
 * sicurezza è peggio di una casella vuota, perché nessuno la ricontrolla.
 */
const VARIANT_AI_MIN_CONFIDENCE = 0.7;

/**
 * Oltre questo numero di varianti non si chiede: un'inserzione con settanta
 * SKU che il confronto testuale non ha saputo restringere non è una scelta
 * difficile, è una riga che non combacia.
 */
const VARIANT_AI_MAX_CHOICES = 30;

interface JobTotals {
  /** Quanto è costato far scegliere le varianti al modello. */
  variantAiCostUsd?: number;
  /** Quante varianti ha scelto il modello: va detto, non nascosto. */
  variantAiPicks?: number;
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
    datasetRow: { select: { hyperlink: true; cells: true } };
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

  /**
   * Chiede al modello quale variante comprare, quando il confronto non decide.
   *
   * Si arriva qui solo dopo che uguaglianza, contenimento, numeri e fasce hanno
   * fallito: il modello non sostituisce quel lavoro, lo raccoglie quando si
   * ferma. Serve perché certe differenze non sono scritte nei numeri —
   * «110CM平板拖把 蓝色» combacia sia con il mocio completo sia con il solo
   * panno di ricambio, e a separarli è il significato.
   *
   * Due limiti deliberati. Il modello sceglie **fra le varianti che esistono**,
   * indicandole per numero, e non può inventarne una. E una scelta poco sicura
   * non vale: sotto la soglia la riga torna a essere una domanda per una
   * persona, che è quello che era prima di questa chiamata.
   */
  private async chiediVarianteAllIa(
    detail: ElimDetail,
    candidati: readonly ElimSku[],
    spec: string | null,
    displayName: string,
    totals: JobTotals
  ): Promise<ElimSku | null> {
    if (!spec?.trim() || candidati.length < 2) return null;
    if (candidati.length > VARIANT_AI_MAX_CHOICES) return null;

    const result = await pickVariantWithAi({
      productName: displayName,
      spec,
      listingTitle: detail.title,
      variants: candidati.map((sku) => ({ label: sku.label, price: sku.price })),
    });
    totals.variantAiCostUsd = (totals.variantAiCostUsd ?? 0) + result.costUsd;

    const choice = result.choice;
    if (!choice || choice.index == null) return null;
    if (choice.confidence < VARIANT_AI_MIN_CONFIDENCE) {
      this.logger.log(
        `variante proposta dal modello scartata: confidenza ${choice.confidence}`
      );
      return null;
    }
    const scelta = candidati[choice.index];
    if (!scelta) return null;
    totals.variantAiPicks = (totals.variantAiPicks ?? 0) + 1;
    return scelta;
  }

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
        datasetRow: { select: { hyperlink: true, cells: true } },
      },
    });

    // In v3 serve sapere quale cella è la specifica: è lei a scegliere la
    // variante sulla pagina che il link apre. Si calcola una volta per job.
    const dataset = await prisma.taobaoDataset.findUnique({
      where: { id: job.datasetId },
      select: { columns: true },
    });
    const columnPosition = new Map(
      ((dataset?.columns ?? []) as Array<{ index: number }>).map(
        (column, position) => [column.index, position]
      )
    );
    const specEntry = (
      (job.mapping ?? []) as Array<{ columnIndex: number; field: string }>
    ).find((entry) => entry.field === "spec");
    const specPosition = specEntry
      ? (columnPosition.get(specEntry.columnIndex) ?? null)
      : null;

    // Righe con la stessa variante: una ricerca sola, risultato condiviso.
    const groups = new Map<string, JobRow[]>();
    for (const row of rows) {
      const key = row.requestId ?? `riga:${row.id}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    // I contatori ripartono da quello che il job ha già registrato, non da
    // zero: un job può essere ripreso — con righe aggiunte dopo una risposta,
    // o dopo un'interruzione — e ricominciare da zero cancellerebbe dal
    // riepilogo le chiamate già pagate nella passata precedente. Le righe già
    // lavorate non sono più `PENDING`, quindi nessun conteggio si ripete.
    const totals: JobTotals = {
      hwhCalls: job.hwhCalls,
      apiCalls: job.apiCalls,
      apiCacheHits: job.apiCacheHits,
      elimCalls: job.elimCalls,
      browserCalls: job.browserCalls,
      reusedProducts: job.reusedProducts,
      newProducts: job.newProducts,
      processedRows: job.processedRows,
      reusedRows: job.reusedRows,
      searchedRows: job.searchedRows,
      failedRows: job.failedRows,
    };

    for (const [, group] of groups) {
      if (this.cancelled.has(jobId)) {
        this.logger.log(`job ${jobId} annullato dopo ${totals.processedRows} righe`);
        return;
      }

      try {
        await this.processVariant({ ...job, specPosition }, group, totals);
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
      /** `v3` risolve i link del foglio invece di cercarli. */
      mode?: string | null;
      /** Posizione della cella «specifiche» dentro `originalCells`. */
      specPosition?: number | null;
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

    // 1b-v3. Il link del foglio si apre davvero.
    //
    // È la differenza della v3: invece di cercare un prodotto simile a quello
    // che il cliente ha già scelto, si apre la sua pagina e se ne prende la
    // variante indicata nella colonna delle specifiche — con il **suo**
    // prezzo, non quello di testa dell'inserzione. Per queste righe la ricerca
    // non parte affatto: su un foglio reale sono 378 righe su 498, e ognuna
    // era una chiamata spesa per riprodurre una scelta già fatta.
    let resolvedFromLink = false;
    let variantUnresolved = 0;
    let variantePrezzoConcorde = false;
    let variantChosenByAi = false;
    if (job.mode === "v3" && excelItemIds.size > 0 && this.elim.isConfigured) {
      const spec =
        job.specPosition != null
          ? ((leader.datasetRow?.cells as string[] | null)?.[job.specPosition] ?? null)
          : null;
      for (const candidate of candidates) {
        if (candidate.source !== "excel") continue;
        const hyperlink = decodeLinkEntities(leader.datasetRow?.hyperlink ?? null);
        try {
          const { detail, calls } = await this.elim.detail(candidate.itemId);
          totals.elimCalls += calls;
          if (!detail) continue;
          const choice = pickElimSku(detail, {
            skuId: extractSkuId(hyperlink),
            spec,
          });
          Object.assign(
            candidate,
            elimDetailToProduct(detail, choice, candidate.url ?? hyperlink)
          );
          resolvedFromLink = true;
          if (!choice.sku && choice.match === "ambiguous") {
            // Il prodotto è quello giusto, la variante no: il prezzo resta
            // vuoto e la riga finisce in «da controllare» con il link da
            // aprire. È lo stesso meccanismo dei prodotti senza prezzo, e per
            // la stessa ragione: meglio una cella vuota che una cifra falsa.
            //
            // A meno che le rimaste non costino tutte uguale — quattro colori
            // dello stesso modello a 1200 — nel qual caso il prezzo c'è e a
            // restare aperta è solo la scelta: la riga lo dice diversamente,
            // perché chi la legge non deve andare a cercare un prezzo che ha
            // già sotto gli occhi.
            const scelta = await this.chiediVarianteAllIa(
              detail,
              choice.candidates,
              spec,
              leader.displayName,
              totals
            );
            if (scelta) {
              Object.assign(
                candidate,
                elimDetailToProduct(
                  detail,
                  { sku: scelta, match: "from_spec", candidates: [] },
                  candidate.url ?? hyperlink
                )
              );
              variantChosenByAi = true;
              this.logger.log(
                `riga ${leader.rowNumber}: variante scelta dal modello fra ${choice.candidates.length} possibili`
              );
            } else {
              variantUnresolved = choice.candidates.length;
              variantePrezzoConcorde = candidate.price != null;
              this.logger.log(
                `riga ${leader.rowNumber}: variante non risolta fra ${choice.candidates.length} possibili`
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "errore";
          this.logger.warn(
            `riga ${leader.rowNumber}: dettaglio del link non letto (${message})`
          );
        }
      }
    }

    // 1b. Un link del foglio che la memoria non conosce ancora arriverebbe in
    //     classifica senza prezzo né foto — un candidato «primo» ma vuoto. Una
    //     chiamata di dettaglio lo riempie; se la memoria lo conosce già, i
    //     suoi dati arrivano al merge dal passo 2 senza spendere nulla.
    if (!resolvedFromLink && excelItemIds.size > 0 && this.api.isConfigured) {
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
        // Riusare la memoria vale solo se il prezzo è stato **riconfermato**.
        // Se nessuna rilettura ha portato dati, quello che sappiamo è vecchio
        // quanto prima: si cerca. Costa una chiamata di ricerca invece di
        // dodici di dettaglio andate a vuoto, riporta prezzi freschi e fa
        // riemergere eventuali offerte migliori — che saltando la ricerca non
        // si sarebbero mai viste.
        if (decision.reuse && known.length > 0 && refresh.verified === 0) {
          reuse = false;
          reuseReason = t("reason.knownUnverifiable");
        } else {
          reuse = decision.reuse;
          reuseReason = decision.reason;
        }
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

    if (resolvedFromLink) {
      // La riga ha già il suo prodotto, scelto dal cliente e letto alla
      // fonte: cercarne altri costerebbe una chiamata per proporre alternative
      // a una decisione già presa.
      reuse = true;
      reuseReason =
        variantUnresolved > 0
          ? t(
              variantePrezzoConcorde
                ? "reason.variantSamePrice"
                : "reason.variantUnresolved",
              { count: variantUnresolved }
            )
          : variantChosenByAi
            ? t("reason.variantChosenByAi")
            : t("reason.resolvedFromLink");
    }

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

    // 7-bis. La variante anche per le righe che il link non ce l'hanno.
    //
    // Fin qui la scelta della variante era un privilegio delle righe con il
    // link: per le altre si quotava il prezzo che la ricerca restituisce, che
    // è il prezzo **di testa** dell'inserzione — su un'inserzione a fasce è il
    // minimo fra tutte, e infatti un calibro da 1,999 mm usciva a 10 (la fascia
    // 0.200-1.000) invece che a 15, e un mocio da 110 cm usciva a 16, che è il
    // panno di ricambio da 40 cm.
    //
    // Costa una chiamata Elim per riga cercata, e la si spende solo sul
    // vincitore: gli altri quattordici candidati restano con i dati della
    // ricerca, che è giusto — non sono quelli che si compra.
    if (
      job.mode === "v3" &&
      !reuse &&
      this.elim.isConfigured &&
      ranked.length > 0
    ) {
      const spec =
        job.specPosition != null
          ? ((leader.datasetRow?.cells as string[] | null)?.[job.specPosition] ?? null)
          : null;
      const vincitore = ranked[0]!.product;
      try {
        const { detail, calls } = await this.elim.detail(
          vincitore.itemId,
          vincitore.platform
        );
        totals.elimCalls += calls;
        if (detail && detail.skus.length > 1) {
          let choice = pickElimSku(detail, { spec });
          if (!choice.sku && choice.match === "ambiguous") {
            const scelta = await this.chiediVarianteAllIa(
              detail,
              choice.candidates.length > 0 ? choice.candidates : detail.skus,
              spec,
              leader.displayName,
              totals
            );
            if (scelta) {
              choice = { sku: scelta, match: "from_spec", candidates: [] };
              variantChosenByAi = true;
            }
          }
          if (choice.sku) {
            Object.assign(
              vincitore,
              elimDetailToProduct(detail, choice, vincitore.url)
            );
            this.logger.log(
              `riga ${leader.rowNumber}: variante «${choice.sku.label}» sul prodotto trovato dalla ricerca`
            );
          }
        }
      } catch (error) {
        // Una variante non risolta lascia la riga com'era: con il prodotto
        // della ricerca e il suo prezzo di testa. È il comportamento di prima,
        // non un peggioramento.
        const message = error instanceof Error ? error.message : "errore";
        this.logger.warn(
          `riga ${leader.rowNumber}: variante del prodotto trovato non letta (${message})`
        );
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
  /**
   * Rilegge alla fonte i prodotti che già conosciamo.
   *
   * Serve a rispondere a «quanto costa adesso?», ed è il passo da cui dipende
   * se si può riusare la memoria invece di cercare. Ma la scheda prodotto può
   * rispondere **vuota** — su questo piano lo fa sempre — e allora la rilettura
   * non conferma niente: restituisce il prodotto identico a com'era. Prima
   * quel silenzio passava per conferma: il prezzo restava quello vecchio, la
   * riga risultava «verificata» e la ricerca veniva saltata. Ora si contano le
   * risposte utili, così chi chiama sa se ha davvero verificato qualcosa.
   */
  private async refreshKnown(
    known: readonly RawTaobaoProduct[],
    totals: JobTotals
  ): Promise<{
    products: RawTaobaoProduct[];
    failedProductIds: Set<string>;
    verified: number;
  }> {
    const products: RawTaobaoProduct[] = [];
    const failed = new Set<string>();
    let verified = 0;
    let emptyInARow = 0;

    for (const product of known.slice(0, numericEnv("TAOBAO_REFRESH_LIMIT", REFRESH_LIMIT))) {
      // Se la fonte non serve schede, insistere costa una chiamata per
      // prodotto senza aggiungere un solo dato.
      if (emptyInARow >= EMPTY_DETAIL_GIVE_UP) break;
      try {
        // `ttlHours: 0`: una risposta in cache risponderebbe alla domanda di
        // ieri, e la domanda qui è «quanto costa adesso?».
        const detail = await this.api.detail(product.itemId, { ttlHours: 0 });
        totals.apiCalls += 1;
        const informative = Object.keys(detail.patch).length > 0;
        if (informative) {
          verified += 1;
          emptyInARow = 0;
        } else {
          emptyInARow += 1;
        }
        products.push({ ...product, ...detail.patch, source: "api" });
      } catch {
        failed.add(product.itemId);
      }
    }

    return { products, failedProductIds: failed, verified };
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
 * Un link del foglio vale come punto di partenza solo se mostra qualcosa.
 *
 * La regola concordata resta: se il cliente ha già comprato da quel link,
 * quello va in cima e i candidati con corrispondenza migliore stanno sotto.
 * Ma un link ricavato dal foglio nasce senza prezzo e senza immagine — la
 * fonte non li espone per un id noto — e messo in cima diventa la scheda che
 * rappresenta la riga: l'operatore si trova un riquadro vuoto al posto del
 * prodotto trovato. Un guscio così non è un punto di partenza, è un buco.
 *
 * Quindi: in cima ci va il link del foglio **che porta un dato utile**; gli
 * altri restano visibili, dopo i candidati completi.
 */
function excelCandidateIsInformative(entry: ScoredProduct): boolean {
  const product = entry.product;
  const hasPrice =
    product.price != null ||
    product.promotionPrice != null ||
    product.variantPrice != null;
  return hasPrice || Boolean(product.imageUrl);
}

export function pinExcelFirst(ranked: ScoredProduct[]): ScoredProduct[] {
  const fromExcel = (entry: ScoredProduct) =>
    entry.product.sources.includes("excel");
  const pinned = ranked.filter(
    (entry) => fromExcel(entry) && excelCandidateIsInformative(entry)
  );
  if (pinned.length === 0) return ranked;
  const rest = ranked.filter((entry) => !pinned.includes(entry));
  return [...pinned, ...rest];
}

/** Riesportato per i test del punteggio. */
export type { MergedProduct };
