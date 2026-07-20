import { getAdapter } from "@china/adapters";
import type {
  ProductSearchResult,
  ProductSort,
  SearchLanguage,
} from "@china/shared";
import {
  ProductSearchProvider,
  ProviderBusyError,
  ProviderUpstreamError,
} from "./provider";

interface ScraperProviderOptions {
  name: string;
  adapterName: string;
  displayName: string;
  language?: SearchLanguage;
  defaultCurrency?: string;
}

interface SearchParams {
  query: string;
  framePosition: number;
  frameSize: number;
  sort: ProductSort;
}

interface CacheEntry {
  expiresAt: number;
  /** Numero massimo di risultati chiesto al marketplace per questa entry. */
  capacity: number;
  result: ProductSearchResult;
}

function envDuration(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * La ricerca dei marketplace cinesi combina i termini in AND: una richiesta
 * completa come `防静电椅 黑色 升降 无靠背` non trova nulla, mentre il solo nome
 * prodotto trova il catalogo. Quando una variante non restituisce risultati si
 * riprova con una query più corta, tagliando le specifiche in coda e tenendo
 * il nome prodotto, che sta in testa.
 *
 * Non è una scelta di prodotti — quella resta all'utente — ma un secondo
 * tentativo deterministico; la query davvero usata torna nella diagnostica.
 */
function narrowingVariants(query: string): string[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return [tokens.join(" ")].filter(Boolean);
  const lengths = [...new Set([tokens.length, Math.ceil(tokens.length / 2), 1])];
  return lengths.map((length) => tokens.slice(0, length).join(" "));
}

/**
 * Normalizza un MarketplaceAdapter Playwright nel contratto della ricerca
 * diretta. Ogni istanza ha coda, cache e circuit breaker propri: marketplace
 * diversi lavorano insieme, richieste ripetute allo stesso sito no.
 */
export class MarketplaceScraperProvider implements ProductSearchProvider {
  readonly name: string;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly cache = new Map<string, CacheEntry>();
  private blockedUntil = 0;

  constructor(private readonly options: ScraperProviderOptions) {
    this.name = options.name;
  }

  getHealth() {
    return {
      transport: "browser" as const,
      adapter: this.options.adapterName,
      pending: this.pending,
      cacheEntries: this.cache.size,
      blockedUntil:
        this.blockedUntil > Date.now()
          ? new Date(this.blockedUntil).toISOString()
          : null,
    };
  }

  search(params: SearchParams): Promise<ProductSearchResult> {
    const cached = this.getCached(params);
    if (cached) return Promise.resolve(cached);

    const maxPending = Math.max(
      1,
      Math.floor(envDuration("SCRAPER_MAX_PENDING", 50))
    );
    if (this.pending >= maxPending) {
      throw new ProviderBusyError(
        `Coda ${this.options.displayName} piena; riprova più tardi.`
      );
    }

    // Serializzazione lato server: protegge Chromium anche con più tab/utenti.
    this.pending += 1;
    const result = this.queue.then(() => this.runSearch(params));
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result.finally(() => {
      this.pending -= 1;
    });
  }

  private async runSearch(params: SearchParams): Promise<ProductSearchResult> {
    const cached = this.getCached(params);
    if (cached) return cached;

    if (Date.now() < this.blockedUntil) {
      const remainingMinutes = Math.max(
        1,
        Math.ceil((this.blockedUntil - Date.now()) / 60_000)
      );
      throw new ProviderUpstreamError(
        `${this.options.displayName} è temporaneamente in pausa dopo una ` +
          `verifica anti-bot; riprova fra circa ${remainingMinutes} min.`
      );
    }

    const adapter = getAdapter(this.options.adapterName);
    const variants = narrowingVariants(params.query);
    // La ricerca bulk può chiedere una sola card. Riempiamo comunque la cache
    // fino a 10 (configurabile), così una successiva ricerca singola non resta
    // bloccata per tutto il TTL con la granularità della prima richiesta.
    const cacheFillSize = Math.min(
      50,
      Math.max(
        params.frameSize,
        Math.floor(envDuration("SCRAPER_CACHE_FILL_SIZE", 10))
      )
    );
    let candidates: Awaited<ReturnType<typeof adapter.search>> = [];
    let effectiveQuery = params.query;
    for (const variant of variants) {
      try {
        candidates = await adapter.search({
          text: variant,
          // Una query in caratteri Han va cercata sulla vetrina cinese del
          // marketplace: quella internazionale non la indicizza.
          language:
            this.options.language ??
            (/\p{Script=Han}/u.test(variant) ? "zh" : "en"),
          maxResults: cacheFillSize,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (
          /captcha|anti-bot|unusual traffic|access denied|accesso limitato|punish|verifica/i.test(
            detail
          )
        ) {
          this.blockedUntil =
            Date.now() +
            envDuration("SCRAPER_CAPTCHA_COOLDOWN_MS", 10 * 60_000);
        }
        throw new ProviderUpstreamError(
          `Ricerca ${this.options.displayName} fallita: ${detail}`
        );
      }
      effectiveQuery = variant;
      if (candidates.length > 0) break;
    }

    const cachedResult: ProductSearchResult = {
      provider: this.name,
      query: effectiveQuery,
      framePosition: 0,
      frameSize: cacheFillSize,
      sort: params.sort,
      totalCount: null,
      items: candidates.map((candidate) => ({
        id: candidate.productId,
        provider: this.name,
        title: candidate.title,
        originalTitle: null,
        imageUrl: candidate.imageUrl ?? null,
        originalPrice: candidate.price?.value ?? null,
        currency:
          candidate.price?.currency ?? this.options.defaultCurrency ?? "USD",
        vendorName: null,
        totalSales: null,
        moq: candidate.moq ?? null,
        productUrl: candidate.url,
        warnings: [],
        sourceSnippet: candidate.snippet ?? null,
      })),
    };

    const key = this.cacheKey(params);
    const cacheTtl = envDuration("SCRAPER_CACHE_TTL_MS", 15 * 60_000);
    if (cacheTtl > 0) {
      if (this.cache.size >= 200) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(key, {
        expiresAt: Date.now() + cacheTtl,
        capacity: cacheFillSize,
        result: cachedResult,
      });
    }
    return this.sliceResult(cachedResult, params);
  }

  private cacheKey(params: SearchParams): string {
    // Una query già riuscita viene riusata anche se la UI chiede un numero
    // diverso di card: per gli scraper è meglio mostrare meno risultati
    // cached che colpire di nuovo il sito e attivare subito un captcha.
    return params.query.trim().toLocaleLowerCase();
  }

  private getCached(params: SearchParams): ProductSearchResult | null {
    const key = this.cacheKey(params);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    if (entry.capacity < params.frameSize) return null;
    return this.sliceResult(entry.result, params);
  }

  private sliceResult(
    result: ProductSearchResult,
    params: SearchParams
  ): ProductSearchResult {
    return {
      ...result,
      query: params.query,
      frameSize: params.frameSize,
      sort: params.sort,
      items: result.items.slice(0, params.frameSize),
    };
  }
}

/** Compatibilità col nome usato prima della generalizzazione multi-motore. */
export class MadeInChinaScraperProvider extends MarketplaceScraperProvider {
  constructor() {
    super({
      name: "made-in-china",
      adapterName: "made-in-china",
      displayName: "Made-in-China",
      defaultCurrency: "USD",
    });
  }
}
