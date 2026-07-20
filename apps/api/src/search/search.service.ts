import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
} from "@nestjs/common";
import { closeBrowser } from "@china/adapters";
import type {
  AggregateSearchRequest,
  AggregateSearchResult,
  AggregateSourceStatus,
  NormalizedProduct,
  ProductSearchQuery,
  ProductSearchResult,
  ProductSort,
  SearchQuality,
} from "@china/shared";
import { createHash, randomUUID } from "node:crypto";
import { aggregateProducts, selectDiverseProducts } from "./aggregate";
import { planSearchQuery } from "./query-planner";
import { rankAndFilterProducts, type RankedProduct } from "./relevance";
import { OtApiProvider } from "./providers/otapi.provider";
import {
  ProductSearchProvider,
  ProviderBusyError,
  ProviderConfigError,
  ProviderTimeoutError,
  ProviderUpstreamError,
} from "./providers/provider";
import {
  MadeInChinaScraperProvider,
  MarketplaceScraperProvider,
} from "./providers/scraper.provider";

const OTAPI_ENGINES = new Set(["taobao", "tmall"]);

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function relevanceThreshold(quality: SearchQuality): number {
  const thresholds: Record<SearchQuality, [string, number]> = {
    strict: ["SEARCH_RELEVANCE_STRICT_THRESHOLD", 70],
    balanced: ["SEARCH_RELEVANCE_BALANCED_THRESHOLD", 55],
    broad: ["SEARCH_RELEVANCE_BROAD_THRESHOLD", 40],
  };
  const [envName, fallback] = thresholds[quality];
  return Math.max(0, Math.min(100, numericEnv(envName, fallback)));
}

function sourceFetchSize(input: ProductSearchQuery): number {
  // Questa istanza OTAPI espone al massimo 20 contenuti effettivi per frame.
  if (OTAPI_ENGINES.has(input.engine)) return 20;
  if (input.quality === "strict") {
    return Math.min(
      50,
      Math.max(
        input.frameSize * 3,
        Math.floor(numericEnv("SEARCH_STRICT_FETCH_SIZE", 30))
      )
    );
  }
  if (input.quality === "balanced") {
    return Math.min(50, Math.max(input.frameSize * 2, 20));
  }
  return input.frameSize;
}

function isExpired(product: NormalizedProduct): boolean {
  return (
    product.warnings.some((warning) => /^Expired$/i.test(warning)) ||
    product.sourceFeatures?.some((feature) => /^Expired$/i.test(feature)) ===
      true
  );
}

function sourceQuality(product: NormalizedProduct): {
  penalty: number;
  warnings: string[];
} {
  let penalty = 0;
  const warnings: string[] = [];
  for (const warning of product.warnings) {
    if (/^IsDeliverable=false$/i.test(warning)) {
      penalty += 5;
      warnings.push("Consegna tramite il provider non verificata.");
      continue;
    }
    if (/^FakeQuantity$/i.test(warning)) {
      penalty += 15;
      warnings.push("Quantità dichiarata dalla fonte non affidabile.");
      continue;
    }
    if (/^SellDisallowed:/i.test(warning)) {
      if (/IsUnknownQuantity/i.test(warning)) {
        penalty += 5;
        warnings.push("Disponibilità non verificata da OTAPI.");
      } else {
        penalty += 20;
        warnings.push("Acquisto diretto tramite il provider non verificato.");
      }
    }
  }
  return { penalty: Math.min(35, penalty), warnings: [...new Set(warnings)] };
}

function canonicalKey(product: NormalizedProduct): string {
  const identity = [
    product.provider.trim().toLocaleLowerCase(),
    product.id.trim().toLocaleLowerCase(),
    product.productUrl?.trim().toLocaleLowerCase() ?? "",
    product.originalTitle || product.title,
  ].join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function typedSourceError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const responseMessage =
      typeof response === "object" && response !== null && "message" in response
        ? (response as { message?: unknown }).message
        : null;
    const message =
      typeof responseMessage === "string"
        ? responseMessage
        : Array.isArray(responseMessage)
          ? responseMessage.join(", ")
          : error.message;
    const codes: Record<number, string> = {
      429: "SOURCE_BUSY",
      500: "SOURCE_CONFIGURATION",
      502: "SOURCE_UPSTREAM",
      503: "SOURCE_UNAVAILABLE",
      504: "SOURCE_TIMEOUT",
    };
    return {
      code: codes[status] ?? `SOURCE_HTTP_${status}`,
      message,
      retryable: status === 429 || status === 502 || status === 503 || status === 504,
    };
  }
  return {
    code: "SOURCE_INTERNAL",
    message: error instanceof Error ? error.message : "Errore imprevisto della fonte",
    retryable: false,
  };
}

interface ScoredProduct {
  ranked: RankedProduct;
  score: number;
  sourceConfidence: number;
  sourceWarnings: string[];
}

/**
 * Pesi del riordino combinato. La compatibilità delle parole (0-100) resta il
 * segnale dominante: prezzo, vendite e recensioni spostano la classifica fra
 * risultati già pertinenti, senza far salire un prodotto sbagliato ma
 * economico o molto venduto.
 */
const COMPOSITE_WEIGHTS = { sales: 10, price: 6, reviews: 5 } as const;

/**
 * Riordino combinato: compatibilità delle parole, prezzo, vendite e recensioni
 * quando disponibili.
 *
 * Il prezzo viene confrontato solo fra prodotti nella stessa valuta: importi in
 * valute diverse non sono comparabili e non vengono convertiti. Chi non espone
 * un segnale non viene penalizzato, resta neutro.
 */
function orderByComposite(items: ScoredProduct[]): ScoredProduct[] {
  const priceRank = new Map<ScoredProduct, number>();
  const byCurrency = new Map<string, ScoredProduct[]>();
  for (const item of items) {
    if (item.ranked.product.originalPrice == null) continue;
    const currency = item.ranked.product.currency || "?";
    const group = byCurrency.get(currency) ?? [];
    group.push(item);
    byCurrency.set(currency, group);
  }
  for (const group of byCurrency.values()) {
    const prices = group.map((item) => item.ranked.product.originalPrice!);
    const lowest = Math.min(...prices);
    const highest = Math.max(...prices);
    for (const item of group) {
      // 1 = il più economico del suo gruppo valuta, 0 = il più caro.
      priceRank.set(
        item,
        highest > lowest
          ? (highest - item.ranked.product.originalPrice!) / (highest - lowest)
          : 1
      );
    }
  }

  const maxSales = Math.max(
    0,
    ...items.map((item) => item.ranked.product.totalSales ?? 0)
  );
  const maxReviews = Math.max(
    0,
    ...items.map((item) => item.ranked.product.reviewCount ?? 0)
  );

  const compositeScore = (item: ScoredProduct): number => {
    const product = item.ranked.product;
    // Le vendite crescono per ordini di grandezza: la scala logaritmica evita
    // che un singolo best seller schiacci tutti gli altri risultati.
    const sales =
      maxSales > 0 && product.totalSales != null
        ? Math.log1p(product.totalSales) / Math.log1p(maxSales)
        : 0;
    const reviewVolume =
      maxReviews > 0 && product.reviewCount != null
        ? Math.log1p(product.reviewCount) / Math.log1p(maxReviews)
        : 0;
    // Un voto medio conta solo se ci sono recensioni a sostenerlo.
    const reviews =
      product.rating != null
        ? reviewVolume * (product.rating / 5)
        : reviewVolume;
    // Un prodotto senza prezzo non viene premiato né punito.
    const price = priceRank.get(item) ?? 0.5;

    return (
      item.score +
      COMPOSITE_WEIGHTS.sales * sales +
      COMPOSITE_WEIGHTS.price * price +
      COMPOSITE_WEIGHTS.reviews * reviews
    );
  };

  return [...items].sort(
    (left, right) =>
      compositeScore(right) - compositeScore(left) ||
      right.score - left.score ||
      right.sourceConfidence - left.sourceConfidence ||
      left.ranked.index - right.ranked.index
  );
}

function orderProducts(
  items: ScoredProduct[],
  sort: ProductSort
): ScoredProduct[] {
  const copy = [...items];
  const scoreTieBreak = (left: ScoredProduct, right: ScoredProduct) =>
    right.score - left.score ||
    right.sourceConfidence - left.sourceConfidence ||
    left.ranked.index - right.ranked.index;
  if (sort === "default") return copy.sort(scoreTieBreak);
  if (sort === "best-match") return orderByComposite(copy);
  if (sort === "orders-desc") {
    return copy.sort((left, right) => {
      const leftSales = left.ranked.product.totalSales;
      const rightSales = right.ranked.product.totalSales;
      if (leftSales == null && rightSales == null) return scoreTieBreak(left, right);
      if (leftSales == null) return 1;
      if (rightSales == null) return -1;
      return rightSales - leftSales || scoreTieBreak(left, right);
    });
  }
  return copy.sort((left, right) => {
    const leftPrice = left.ranked.product.originalPrice;
    const rightPrice = right.ranked.product.originalPrice;
    if (leftPrice == null && rightPrice == null) return scoreTieBreak(left, right);
    if (leftPrice == null) return 1;
    if (rightPrice == null) return -1;
    const difference =
      sort === "price-asc" ? leftPrice - rightPrice : rightPrice - leftPrice;
    return difference || scoreTieBreak(left, right);
  });
}

@Injectable()
export class SearchService implements OnModuleDestroy {
  private activeSearches = 0;
  // Chiave = valore di `engine` nella query string (SearchEngineSchema).
  private readonly providers = new Map<string, ProductSearchProvider>([
    [
      "taobao",
      new OtApiProvider({
        name: "taobao",
        provider: "Taobao",
        searchMethod: "Storage",
        expectedSearchMethod: "Storage",
        featureFilters: { Tmall: false },
        defaultCurrency: "CNY",
      }),
    ],
    [
      "tmall",
      new OtApiProvider({
        name: "tmall",
        provider: "Taobao",
        searchMethod: "Storage",
        expectedSearchMethod: "Storage",
        featureFilters: { Tmall: true },
        defaultCurrency: "CNY",
      }),
    ],
    [
      "alibaba",
      new MarketplaceScraperProvider({
        name: "alibaba",
        adapterName: "alibaba",
        displayName: "Alibaba",
        defaultCurrency: "USD",
      }),
    ],
    [
      "aliexpress",
      new MarketplaceScraperProvider({
        name: "aliexpress",
        adapterName: "aliexpress",
        displayName: "AliExpress",
        defaultCurrency: "EUR",
      }),
    ],
    ["made-in-china", new MadeInChinaScraperProvider()],
    [
      "chinagoods",
      new MarketplaceScraperProvider({
        name: "chinagoods",
        adapterName: "chinagoods",
        displayName: "Chinagoods",
        defaultCurrency: "USD",
      }),
    ],
    [
      "yiwugo",
      new MarketplaceScraperProvider({
        name: "yiwugo",
        adapterName: "yiwugo",
        displayName: "Yiwugo",
        defaultCurrency: "CNY",
      }),
    ],
  ]);

  health() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      activeSearches: this.activeSearches,
      providers: [...this.providers.entries()].map(([name, provider]) => ({
        name,
        ...((
          provider as ProductSearchProvider & {
            getHealth?: () => Record<string, unknown>;
          }
        ).getHealth?.() ?? {}),
      })),
    };
  }

  async search(input: ProductSearchQuery): Promise<ProductSearchResult> {
    const provider = this.providers.get(input.engine);
    if (!provider) {
      throw new InternalServerErrorException(
        `Motore non registrato: ${input.engine}`
      );
    }
    const maxInFlight = Math.max(
      1,
      Number.parseInt(process.env.SEARCH_MAX_IN_FLIGHT || "12", 10) || 12
    );
    if (this.activeSearches >= maxInFlight) {
      throw new HttpException(
        "Troppe ricerche contemporanee; riprova fra pochi secondi.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    this.activeSearches += 1;
    const startedAt = Date.now();
    try {
      const plan = planSearchQuery(input.q, input.engine);
      const fetchSize = sourceFetchSize(input);
      const pageIndex = Math.floor(input.framePosition / input.frameSize);
      const sourcePosition = OTAPI_ENGINES.has(input.engine)
        ? pageIndex * fetchSize
        : 0;
      const sourceResult = await provider.search({
        query: plan.providerQuery,
        framePosition: sourcePosition,
        frameSize: fetchSize,
        sort: input.sort,
      });
      const processingStartedAt = Date.now();
      const eligible = sourceResult.items.filter((product) => {
        return Boolean(product.id && product.title.trim() && product.productUrl) && !isExpired(product);
      });
      // minScore=0 consente di applicare dopo il ranking sia la penalità di
      // affidabilità della fonte sia la soglia scelta dall'utente.
      const ranked = rankAndFilterProducts(plan.providerQuery, eligible, {
        minScore: 0,
        deduplicate: true,
      });
      const threshold = relevanceThreshold(input.quality);
      const qualified = orderProducts(
        ranked.accepted
          .map<ScoredProduct>((entry) => {
            const source = sourceQuality(entry.product);
            return {
              ranked: entry,
              score: entry.relevance.score,
              sourceConfidence: Math.max(0, 100 - source.penalty),
              sourceWarnings: source.warnings,
            };
          })
          .filter((entry) => entry.score >= threshold),
        input.sort
      );
      const selected = qualified.slice(0, input.frameSize);
      const items = selected.map(({
        ranked: entry,
        score,
        sourceConfidence,
        sourceWarnings,
      }) => ({
        ...entry.product,
        relevanceScore: score,
        sourceConfidenceScore: sourceConfidence,
        matchReasons: entry.relevance.reasons,
        matchWarnings: [
          ...new Set([...entry.relevance.warnings, ...sourceWarnings]),
        ],
        canonicalKey: canonicalKey(entry.product),
      }));
      const processingMs = Date.now() - processingStartedAt;
      const hardRejectedCount = sourceResult.items.length - eligible.length;
      const relevanceRejectedCount = ranked.accepted.length - qualified.length;
      const result: ProductSearchResult = {
        provider: sourceResult.provider,
        query: plan.original,
        framePosition: input.framePosition,
        frameSize: input.frameSize,
        sort: input.sort,
        // Il totale della fonte è precedente ai filtri: non viene spacciato
        // per numero di risultati pertinenti, ma resta nella diagnostica.
        totalCount: null,
        hasMore:
          OTAPI_ENGINES.has(input.engine) &&
          sourceResult.items.length >= fetchSize &&
          (sourceResult.totalCount == null ||
            sourcePosition + sourceResult.items.length < sourceResult.totalCount),
        items,
        diagnostics: {
          quality: input.quality,
          // Gli scraper possono ripiegare su una query più corta quando quella
          // completa non trova nulla: qui compare quella davvero inviata.
          queryUsed: sourceResult.query || plan.providerQuery,
          sourceTotalCount: sourceResult.totalCount,
          fetchedCount: sourceResult.items.length,
          qualifiedCount: qualified.length,
          discardedCount: Math.max(
            0,
            hardRejectedCount + relevanceRejectedCount
          ),
          duplicatesRemoved: ranked.duplicates.length,
          truncatedCount: Math.max(0, qualified.length - selected.length),
          threshold,
          processingMs,
        },
      };
      console.info(
        JSON.stringify({
          event: "marketplace_search",
          engine: input.engine,
          quality: input.quality,
          durationMs: Date.now() - startedAt,
          fetched: sourceResult.items.length,
          returned: items.length,
          discarded: result.diagnostics?.discardedCount ?? 0,
          duplicates: ranked.duplicates.length,
        })
      );
      return result;
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "marketplace_search_error",
          engine: input.engine,
          durationMs: Date.now() - startedAt,
          error: e instanceof Error ? e.name : "unknown",
        })
      );
      if (e instanceof ProviderConfigError) {
        throw new InternalServerErrorException(e.message);
      }
      if (e instanceof ProviderTimeoutError) {
        throw new GatewayTimeoutException(e.message);
      }
      if (e instanceof ProviderUpstreamError) {
        throw new BadGatewayException(e.message);
      }
      if (e instanceof ProviderBusyError) {
        throw new HttpException(e.message, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw e;
    } finally {
      this.activeSearches -= 1;
    }
  }

  async searchMany(input: AggregateSearchRequest): Promise<AggregateSearchResult> {
    const startedAt = Date.now();
    const engines = [...new Set(input.engines)];
    const runs = await Promise.all(
      engines.map(async (engine) => {
        const sourceStartedAt = Date.now();
        try {
          const result = await this.search({
            q: input.q,
            engine,
            framePosition: 0,
            frameSize: input.frameSize,
            sort: input.sort,
            quality: input.quality,
          });
          return {
            engine,
            result,
            source: {
              engine,
              status: "done" as const,
              durationMs: Date.now() - sourceStartedAt,
              acceptedCount: result.items.length,
              diagnostics: result.diagnostics ?? null,
              error: null,
            } satisfies AggregateSourceStatus,
          };
        } catch (error) {
          return {
            engine,
            result: null,
            source: {
              engine,
              status: "error" as const,
              durationMs: Date.now() - sourceStartedAt,
              acceptedCount: 0,
              diagnostics: null,
              error: typedSourceError(error),
            } satisfies AggregateSourceStatus,
          };
        }
      })
    );

    const candidates = runs.flatMap((run) => run.result?.items ?? []);
    const aggregated = aggregateProducts(candidates);
    const items: NormalizedProduct[] = selectDiverseProducts(
      aggregated,
      input.frameSize
    )
      .map((group) => ({
        ...group.representative,
        canonicalKey: group.canonicalKey,
        offers: group.offers,
      }));
    const sources = runs.map((run) => run.source);
    const fetchedCount = sources.reduce(
      (total, source) => total + (source.diagnostics?.fetchedCount ?? 0),
      0
    );
    const succeededCount = sources.filter((source) => source.status === "done").length;
    const result: AggregateSearchResult = {
      searchId: randomUUID(),
      query: input.q.trim(),
      quality: input.quality,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sources,
      items,
      diagnostics: {
        engineCount: engines.length,
        succeededCount,
        failedCount: engines.length - succeededCount,
        fetchedCount,
        acceptedBeforeMerge: candidates.length,
        uniqueCount: aggregated.length,
        duplicatesMerged: Math.max(0, candidates.length - aggregated.length),
      },
    };
    console.info(
      JSON.stringify({
        event: "marketplace_search_aggregate",
        searchId: result.searchId,
        durationMs: result.durationMs,
        engines: engines.length,
        succeeded: succeededCount,
        fetched: fetchedCount,
        accepted: candidates.length,
        unique: aggregated.length,
      })
    );
    return result;
  }

  async onModuleDestroy() {
    // Il motore scraping tiene un Chromium condiviso nel processo API.
    await closeBrowser().catch(() => {});
  }
}
