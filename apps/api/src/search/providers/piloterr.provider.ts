import type { NormalizedProduct, ProductSearchResult, ProductSort } from "@china/shared";
import { z } from "zod";
import { PiloterrClient, piloterrClient } from "./piloterr.client";
import { ProductSearchProvider, ProviderUpstreamError } from "./provider";

/**
 * Provider di ricerca su Alibaba e AliExpress tramite Piloterr.
 *
 * Sostituisce l'adapter Playwright per queste due fonti — e solo per queste —
 * perché dall'IP del VPS rispondono con un captcha. Gli schemi sono quelli
 * pubblicati da Piloterr, letti in modo tollerante: i campi facoltativi
 * mancanti diventano `null`, mai valori inventati.
 */

/** Numeri che possono arrivare come stringa (`"14.90"`). */
const LooseNumber = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value) => {
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  });

const LooseString = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
  });

const PaginationSchema = z
  .object({
    page: LooseNumber,
    per_page: LooseNumber,
    total_results: LooseNumber,
    total_pages: LooseNumber,
    next: z.boolean().nullish(),
  })
  .partial()
  .nullish();

const AlibabaResultSchema = z.object({
  product_id: LooseString,
  title: LooseString,
  listing_url: LooseString,
  image_url: LooseString,
  price_text: LooseString,
  price_min: LooseNumber,
  price_max: LooseNumber,
  min_order: LooseString,
  category: LooseString,
  seller_name: LooseString,
  seller_id: LooseString,
  sold_count: LooseNumber,
  // Non presenti nello schema documentato della ricerca, ma restituiti in
  // alcuni esempi: si leggono se ci sono, senza pretenderli.
  rating: LooseNumber,
  review_count: LooseNumber,
});

const AlibabaSearchSchema = z.object({
  results: z.array(AlibabaResultSchema).nullish(),
  pagination: PaginationSchema,
});

const AliExpressResultSchema = z.object({
  product_id: LooseString,
  title: LooseString,
  listing_url: LooseString,
  image_url: LooseString,
  price: LooseNumber,
  currency: LooseString,
  condition: LooseString,
  sold_count: LooseNumber,
  rating: LooseNumber,
  review_count: LooseNumber,
  store_name: LooseString,
});

const AliExpressSearchSchema = z.object({
  results: z.array(AliExpressResultSchema).nullish(),
  pagination: PaginationSchema,
});

/**
 * MOQ da testo libero: Piloterr restituisce `min_order` come stringa
 * (`"500 pieces"`, `"1 piece"`, `"2 sets"`).
 */
export function parseMinOrder(value: string | null): number | null {
  if (!value) return null;
  const match = value.replace(/[,\s]/g, "").match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Valuta dal testo del prezzo (`"US $14.90-$19.90"`, `"€12,00"`).
 * Se non è riconoscibile si tiene il valore predefinito della fonte invece di
 * indovinare: un prezzo con la valuta sbagliata è peggio di nessun prezzo.
 */
export function parseCurrency(priceText: string | null, fallback: string): string {
  if (!priceText) return fallback;
  if (/US\s*\$|USD/i.test(priceText)) return "USD";
  if (/€|EUR/i.test(priceText)) return "EUR";
  if (/£|GBP/i.test(priceText)) return "GBP";
  if (/¥|CNY|RMB/i.test(priceText)) return "CNY";
  return fallback;
}

/**
 * Verifica che la risposta sia davvero una risposta di ricerca.
 *
 * Con `results` facoltativo, un corpo di forma completamente diversa
 * supererebbe lo schema e verrebbe letto come «nessun prodotto trovato»: il
 * guasto peggiore possibile, perché silenzioso. La chiave deve esserci.
 */
function assertSearchShape(raw: unknown, engine: string): void {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Object.hasOwn(raw, "results")
  ) {
    throw new ProviderUpstreamError(
      `Risposta ${engine} di Piloterr priva del campo "results": ` +
        "lo schema dell'API è cambiato."
    );
  }
}

interface SearchParams {
  query: string;
  framePosition: number;
  frameSize: number;
  sort: ProductSort;
}

export type PiloterrEngine = "alibaba" | "aliexpress";

interface PiloterrProviderOptions {
  engine: PiloterrEngine;
  client?: PiloterrClient;
  /** Locale del catalogo Alibaba (`www`, `italian`, `french`…). */
  subdomain?: string;
}

export class PiloterrSearchProvider implements ProductSearchProvider {
  readonly name: string;
  private readonly client: PiloterrClient;

  constructor(private readonly options: PiloterrProviderOptions) {
    this.name = options.engine;
    this.client = options.client ?? piloterrClient;
  }

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  getHealth() {
    return {
      transport: "piloterr" as const,
      configured: this.client.isConfigured,
      usage: this.client.getUsage(),
    };
  }

  async search(params: SearchParams): Promise<ProductSearchResult> {
    // Piloterr pagina a 20 risultati: chiedere più pagine costa più crediti,
    // quindi si resta su una pagina sola salvo richiesta esplicita.
    const page = Math.max(1, Math.floor(params.framePosition / 20) + 1);

    const items =
      this.options.engine === "alibaba"
        ? await this.searchAlibaba(params.query, page)
        : await this.searchAliExpress(params.query);

    return {
      provider: this.name,
      query: params.query,
      framePosition: params.framePosition,
      frameSize: params.frameSize,
      sort: params.sort,
      totalCount: items.totalCount,
      items: items.products.slice(0, Math.max(params.frameSize, 1)),
    };
  }

  private async searchAlibaba(
    query: string,
    page: number
  ): Promise<{ products: NormalizedProduct[]; totalCount: number | null }> {
    const raw = await this.client.get<unknown>("/v2/alibaba/search", {
      query,
      page,
      subdomain: this.options.subdomain ?? process.env.PILOTERR_ALIBABA_SUBDOMAIN,
    });

    assertSearchShape(raw, "Alibaba");
    const parsed = AlibabaSearchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderUpstreamError(
        "Risposta Alibaba di Piloterr non riconosciuta: lo schema dell'API è cambiato."
      );
    }

    const products: NormalizedProduct[] = [];
    for (const entry of parsed.data.results ?? []) {
      // Senza identificativo e senza indirizzo il prodotto non è apribile:
      // scartarlo è più corretto che mostrarne uno non verificabile.
      if (!entry.product_id || !entry.title || !entry.listing_url) continue;
      products.push({
        id: entry.product_id,
        provider: "alibaba",
        title: entry.title,
        originalTitle: null,
        imageUrl: entry.image_url,
        originalPrice: entry.price_min ?? entry.price_max,
        currency: parseCurrency(entry.price_text, "USD"),
        vendorName: entry.seller_name,
        totalSales: entry.sold_count,
        rating: entry.rating,
        reviewCount: entry.review_count == null ? null : Math.round(entry.review_count),
        moq: parseMinOrder(entry.min_order),
        productUrl: entry.listing_url,
        warnings: [],
        sourceSnippet: entry.category,
      });
    }

    return {
      products,
      totalCount: parsed.data.pagination?.total_results ?? null,
    };
  }

  private async searchAliExpress(
    query: string
  ): Promise<{ products: NormalizedProduct[]; totalCount: number | null }> {
    const raw = await this.client.get<unknown>("/v2/aliexpress/search", {
      query,
    });

    assertSearchShape(raw, "AliExpress");
    const parsed = AliExpressSearchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderUpstreamError(
        "Risposta AliExpress di Piloterr non riconosciuta: lo schema dell'API è cambiato."
      );
    }

    const products: NormalizedProduct[] = [];
    for (const entry of parsed.data.results ?? []) {
      if (!entry.product_id || !entry.title || !entry.listing_url) continue;
      products.push({
        id: entry.product_id,
        provider: "aliexpress",
        title: entry.title,
        originalTitle: null,
        imageUrl: entry.image_url,
        originalPrice: entry.price,
        currency: entry.currency ?? "USD",
        vendorName: entry.store_name,
        totalSales: entry.sold_count,
        rating: entry.rating,
        reviewCount: entry.review_count == null ? null : Math.round(entry.review_count),
        // AliExpress è vendita al dettaglio: non espone un minimo d'ordine.
        moq: null,
        productUrl: entry.listing_url,
        warnings: [],
        sourceSnippet: entry.condition,
      });
    }

    return {
      products,
      totalCount: parsed.data.pagination?.total_results ?? null,
    };
  }
}
