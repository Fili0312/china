import type {
  NormalizedProduct,
  ProductSearchResult,
  ProductSort,
} from "@china/shared";
import {
  ProductSearchProvider,
  ProviderConfigError,
  ProviderTimeoutError,
  ProviderUpstreamError,
} from "./provider";

const ENDPOINT = "https://otapi.net/service-json/BatchSearchItemsFrame";

/**
 * Mappa sort interno → <OrderBy> OTAPI. Solo questi funzionano davvero su
 * Taobao: Rating/Popularity rispondono Ok ma vengono ignorati.
 */
const ORDER_BY: Record<ProductSort, string | null> = {
  default: null,
  // Il riordino combinato avviene dopo, sui risultati già normalizzati.
  "best-match": null,
  "orders-desc": "Volume:Desc",
  "price-asc": "Price:Asc",
  "price-desc": "Price:Desc",
};

/** Forma (parziale) della risposta di BatchSearchItemsFrame che ci interessa. */
interface OtApiResponse {
  ErrorCode?: string;
  ErrorDescription?: string | null;
  Result?: {
    Items?: {
      Provider?: string | null;
      SearchMethod?: string | null;
      Items?: {
        TotalCount?: number | null;
        Content?: OtApiItem[] | null;
      };
    };
  };
}

interface OtApiItem {
  Id?: string | number;
  Title?: string;
  OriginalTitle?: string;
  MainPictureUrl?: string;
  VendorName?: string;
  VendorDisplayName?: string;
  ExternalItemUrl?: string;
  TaobaoItemUrl?: string;
  Features?: string[];
  FeaturedValues?: { Name?: string; Value?: string }[];
  IsSellAllowed?: boolean;
  SellDisallowReason?: string;
  Price?: {
    OriginalPrice?: number;
    OriginalCurrencyCode?: string;
    IsDeliverable?: boolean;
  };
}

interface OtApiProviderOptions {
  name?: string;
  provider?: string;
  searchMethod?: string;
  expectedSearchMethod?: string;
  featureFilters?: Record<string, boolean>;
  defaultCurrency?: string;
}

interface OtApiSearchParams {
  query: string;
  framePosition: number;
  frameSize: number;
  sort: ProductSort;
}

interface OtApiCacheEntry {
  expiresAt: number;
  result: ProductSearchResult;
}

type NormalizedOtApiProduct = NormalizedProduct & {
  sourceFeatures: string[];
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class OtApiProvider implements ProductSearchProvider {
  readonly name: string;
  private readonly provider: string;
  private readonly searchMethod: string;
  private readonly expectedSearchMethod?: string;
  private readonly featureFilters: Readonly<Record<string, boolean>>;
  private readonly cacheNamespace: string;
  private readonly defaultCurrency: string;
  private readonly cache = new Map<string, OtApiCacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ProductSearchResult>
  >();

  constructor(options: OtApiProviderOptions = {}) {
    this.name = options.name ?? "taobao";
    this.provider = options.provider ?? "Taobao";
    this.searchMethod = options.searchMethod ?? "Default";
    this.expectedSearchMethod = options.expectedSearchMethod;
    this.featureFilters = Object.freeze({ ...(options.featureFilters ?? {}) });
    this.cacheNamespace = [
      this.name,
      this.provider,
      this.searchMethod,
      this.expectedSearchMethod ?? "",
      ...Object.entries(this.featureFilters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([feature, enabled]) => `${feature}=${enabled}`),
    ].join("|");
    this.defaultCurrency = options.defaultCurrency ?? "CNY";
  }

  getHealth() {
    return {
      transport: "otapi" as const,
      provider: this.provider,
      searchMethod: this.searchMethod,
      expectedSearchMethod: this.expectedSearchMethod ?? null,
      featureFilters: this.featureFilters,
      cacheEntries: this.cache.size,
      inFlight: this.inFlight.size,
      configured: Boolean(process.env.OTAPI_INSTANCE_KEY),
    };
  }

  async search(params: OtApiSearchParams): Promise<ProductSearchResult> {
    const key = [
      this.cacheNamespace,
      params.query.trim().toLocaleLowerCase(),
      params.framePosition,
      params.frameSize,
      params.sort,
    ].join("|");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.cache.delete(key);

    const current = this.inFlight.get(key);
    if (current) return current;

    const request = this.fetchSearch(params)
      .then((result) => {
        const parsedTtl = Number(process.env.OTAPI_CACHE_TTL_MS);
        const ttl = Number.isFinite(parsedTtl) && parsedTtl >= 0
          ? parsedTtl
          : 5 * 60_000;
        if (ttl > 0) {
          if (this.cache.size >= 500) {
            const oldest = this.cache.keys().next().value as
              | string
              | undefined;
            if (oldest) this.cache.delete(oldest);
          }
          this.cache.set(key, { expiresAt: Date.now() + ttl, result });
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchSearch(
    params: OtApiSearchParams
  ): Promise<ProductSearchResult> {
    const instanceKey = process.env.OTAPI_INSTANCE_KEY;
    if (!instanceKey) {
      throw new ProviderConfigError(
        "OTAPI_INSTANCE_KEY non configurata nel .env del server"
      );
    }

    const orderBy = ORDER_BY[params.sort];
    const featureEntries = Object.entries(this.featureFilters).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    const featuresXml = featureEntries.length
      ? "<Features>" +
        featureEntries
          .map(
            ([feature, enabled]) =>
              `<Feature Name="${escapeXml(feature)}">${enabled ? "true" : "false"}</Feature>`
          )
          .join("") +
        "</Features>"
      : "";
    const xmlParameters =
      "<SearchItemsParameters>" +
      `<Provider>${escapeXml(this.provider)}</Provider>` +
      `<SearchMethod>${escapeXml(this.searchMethod)}</SearchMethod>` +
      `<ItemTitle>${escapeXml(params.query)}</ItemTitle>` +
      featuresXml +
      (orderBy ? `<OrderBy>${orderBy}</OrderBy>` : "") +
      "</SearchItemsParameters>";

    const search = new URLSearchParams({
      instanceKey,
      language: "en",
      sessionId: "godMode",
      framePosition: String(params.framePosition),
      frameSize: String(params.frameSize),
      blockList: "",
      xmlParameters,
    });

    // OTAPI a cache fredda impiega anche ~20s: timeout largo.
    const timeoutMs = Number(process.env.OTAPI_TIMEOUT_MS || 45_000);

    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}?${search}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new ProviderTimeoutError(
          `OTAPI non ha risposto entro ${Math.round(timeoutMs / 1000)}s`
        );
      }
      throw new ProviderUpstreamError(
        `OTAPI non raggiungibile: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (!res.ok) {
      throw new ProviderUpstreamError(`OTAPI HTTP ${res.status}`);
    }

    const body = (await res.json()) as OtApiResponse;
    if (body.ErrorCode !== "Ok") {
      throw new ProviderUpstreamError(
        `OTAPI ErrorCode: ${body.ErrorCode ?? "sconosciuto"}` +
          (body.ErrorDescription ? ` — ${body.ErrorDescription}` : "")
      );
    }

    const resultFrame = body.Result?.Items;
    if (
      this.expectedSearchMethod &&
      resultFrame?.SearchMethod !== this.expectedSearchMethod
    ) {
      const actualMethod = resultFrame?.SearchMethod || "assente";
      const actualProvider = resultFrame?.Provider || "sconosciuto";
      throw new ProviderUpstreamError(
        `OTAPI ha applicato ${actualProvider}/${actualMethod} invece del metodo atteso ${this.expectedSearchMethod}`
      );
    }

    const frame = resultFrame?.Items;
    const filteredContent = (frame?.Content ?? []).filter((raw) => {
      const features = new Set(raw.Features ?? []);
      return featureEntries.every(
        ([feature, enabled]) => features.has(feature) === enabled
      );
    });
    return {
      provider: this.name,
      query: params.query,
      framePosition: params.framePosition,
      frameSize: params.frameSize,
      sort: params.sort,
      totalCount: frame?.TotalCount ?? null,
      items: filteredContent.map((raw) => this.normalize(raw)),
    };
  }

  private normalize(raw: OtApiItem): NormalizedOtApiProduct {
    // In Features convivono warning veri e tag neutri di piattaforma
    // (Tmall, Taobao, TbkItem…): mostriamo solo i primi.
    const WARN_FEATURES = new Set(["FakeQuantity", "Expired"]);
    const warnings: string[] = [];
    for (const f of raw.Features ?? []) {
      if (typeof f === "string" && WARN_FEATURES.has(f)) warnings.push(f);
    }
    if (raw.Price?.IsDeliverable === false) warnings.push("IsDeliverable=false");
    if (raw.IsSellAllowed === false && raw.SellDisallowReason) {
      warnings.push(`SellDisallowed: ${raw.SellDisallowReason}`);
    }

    const salesRaw = (raw.FeaturedValues ?? []).find(
      (fv) => fv?.Name === "TotalSales"
    )?.Value;
    const sales = salesRaw != null && salesRaw !== "" ? Number(salesRaw) : NaN;

    return {
      id: String(raw.Id ?? ""),
      provider: this.name,
      title: raw.Title ?? "",
      originalTitle: raw.OriginalTitle ?? null,
      imageUrl: raw.MainPictureUrl ?? null,
      originalPrice:
        typeof raw.Price?.OriginalPrice === "number"
          ? raw.Price.OriginalPrice
          : null,
      currency: raw.Price?.OriginalCurrencyCode ?? this.defaultCurrency,
      vendorName: raw.VendorDisplayName || raw.VendorName || null,
      totalSales: Number.isFinite(sales) ? sales : null,
      moq: null,
      productUrl: raw.ExternalItemUrl || raw.TaobaoItemUrl || null,
      warnings,
      sourceFeatures: [...(raw.Features ?? [])],
    };
  }
}
