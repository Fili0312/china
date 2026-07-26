import type { TaobaoPlatform } from "@china/shared";
import type { RawTaobaoProduct } from "./taobao-item";

/**
 * Dalla risposta ElimAPI al prodotto normalizzato.
 *
 * Puro e senza rete, come il gemello di DataHub: è il pezzo che i test possono
 * coprire davvero, ed è quello che cambia quando cambia il fornitore.
 *
 * I nomi dei campi sono quelli **reali**, letti da due risposte vere (una per
 * piattaforma) il 2026-07-22, non quelli dello Swagger: lo Swagger dichiara
 * `whosesale_price` mentre la risposta usa `wholesale_price`, e non documenta
 * `seller_name`, `mi_id`, `promotion_displays` e `promotion_url`, che invece
 * arrivano. Dove i due divergono, vince ciò che arriva davvero.
 *
 * Le due piattaforme non restituiscono gli stessi campi: Taobao porta
 * `seller_name` e le promozioni, 1688 porta prezzi all'ingrosso, vendite e
 * tasso di riacquisto. La normalizzazione tiene ciò che c'è e lascia `null` il
 * resto, senza inventare: un MOQ dedotto sarebbe peggio di un MOQ mancante.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intOrNull(value: unknown): number | null {
  const parsed = num(value);
  return parsed == null ? null : Math.round(parsed);
}

/**
 * Estrae la lista di prodotti dalla risposta.
 *
 * La forma è `{ success, code, message, paginate, items[] }`. Si controlla
 * anche `success`: l'API può rispondere 201 con `success: false`, e trattarlo
 * come «nessun risultato» nasconderebbe un errore vero.
 */
export function elimItems(payload: unknown): { items: Json[]; ok: boolean; message: string | null } {
  if (!isObject(payload)) return { items: [], ok: false, message: "risposta non riconosciuta" };
  const ok = payload.success !== false;
  const items = Array.isArray(payload.items) ? payload.items.filter(isObject) : [];
  return { items, ok, message: text(payload.message) };
}

/**
 * Un prodotto ElimAPI nella forma comune a tutte le fonti.
 *
 * `null` quando manca l'identificativo o il titolo: senza quei due il prodotto
 * non è né deduplicabile né mostrabile, e tenerlo servirebbe solo a gonfiare i
 * conteggi.
 */
export function mapElimProduct(
  entry: Json,
  platform: TaobaoPlatform
): RawTaobaoProduct | null {
  const itemId = text(entry.id) ?? text(entry.mi_id);
  const title = text(entry.title) ?? text(entry.titleEn);
  if (!itemId || !title) return null;

  const listPrice = num(entry.price);
  const promotionPrice = num(entry.promotion_price);
  // Il prezzo mostrato è quello che si paga oggi; quello di listino resta
  // dentro `raw` e la promozione si vede perché `promotionPrice` è valorizzato.
  const effectivePrice = promotionPrice ?? listPrice;

  const specs: Record<string, string> = {};
  const sellerType = text(entry.seller_type);
  if (sellerType) specs["tipo venditore"] = sellerType;
  const unit = text(entry.unit);
  if (unit) specs["unità"] = unit;
  const retention = text(entry.retention_rate);
  if (retention) specs["tasso di riacquisto"] = retention;
  const wholesale = num(entry.wholesale_price ?? entry.whosesale_price);
  if (wholesale != null) specs["prezzo all'ingrosso"] = String(wholesale);

  return {
    platform,
    itemId,
    title,
    titleEn: text(entry.titleEn),
    url: text(entry.link) ?? text(entry.promotion_url),
    imageUrl: text(entry.img_url),

    price: effectivePrice,
    // Entrambe le piattaforme quotano in yuan.
    currency: "CNY",
    variantPrice: null,
    promotionPrice: promotionPrice != null && promotionPrice !== listPrice ? promotionPrice : null,

    // `seller_name` arriva da Taobao; su 1688 la lista non lo espone.
    shopName: text(entry.seller_name) ?? text(entry.shop_name),
    shopUrl: null,
    sellerId: text(entry.shop_id) ?? null,

    totalSales: intOrNull(entry.sales_volume),
    reviewCount: null,
    // `level` è il voto del prodotto (4.9 su 1688); su Taobao può essere nullo.
    rating: num(entry.level),

    // MOQ e SKU **non** sono nella risposta di ricerca: stanno solo nel
    // dettaglio (`POST /v1/products/detail`). Restano nulli invece di essere
    // dedotti da `quantity`, che è la disponibilità, non il minimo d'ordine.
    moq: intOrNull(entry.moq),
    sku: text(entry.sku),

    specs: Object.keys(specs).length > 0 ? specs : null,
    variants: null,
    availability: null,
    shipping: null,
    raw: entry,
    source: "elim",
  };
}

/** Tutti i prodotti di una risposta, senza ripetizioni. */
export function mapElimSearch(payload: unknown, platform: TaobaoPlatform): RawTaobaoProduct[] {
  const { items } = elimItems(payload);
  const seen = new Set<string>();
  const products: RawTaobaoProduct[] = [];
  for (const entry of items) {
    const product = mapElimProduct(entry, platform);
    if (!product || seen.has(product.itemId)) continue;
    seen.add(product.itemId);
    products.push(product);
  }
  return products;
}

/** Richieste residue del piano, per non scoprire il limite con un 402. */
export function readPlanStatus(payload: unknown): {
  planName: string | null;
  includedLimit: number | null;
  totalRequests: number | null;
  remaining: number | null;
} {
  if (!isObject(payload)) {
    return { planName: null, includedLimit: null, totalRequests: null, remaining: null };
  }
  const subscription = isObject(payload.subscription) ? payload.subscription : null;
  const plan = subscription && isObject(subscription.plan) ? subscription.plan : null;
  const usage = isObject(payload.usage) ? payload.usage : null;

  const includedLimit = intOrNull(usage?.included_limit);
  const totalRequests = intOrNull(usage?.total_requests);
  const remaining =
    intOrNull(usage?.remaining_requests) ??
    (includedLimit != null && totalRequests != null
      ? Math.max(0, includedLimit - totalRequests)
      : null);

  return {
    planName: text(plan?.name),
    includedLimit,
    totalRequests,
    remaining,
  };
}
