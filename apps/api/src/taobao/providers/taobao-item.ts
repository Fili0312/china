import type { TaobaoPlatform, TaobaoSource } from "@china/shared";
import { t } from "../../i18n/messages";

/**
 * Dal JSON di Taobao al prodotto, e ritorno.
 *
 * Tutto ciò che sta qui è **puro**: nessuna rete, nessun database. È voluto —
 * è il pezzo che i test possono coprire davvero, ed è anche il pezzo che
 * cambia più spesso, perché la forma delle risposte di un aggregatore non è
 * un contratto stabile.
 *
 * La lettura è deliberatamente **tollerante**: si cercano i campi per nome fra
 * più alias noti invece di pretendere una forma sola. Un aggregatore che
 * rinomina `num_iid` in `item_id` non deve far sparire i risultati; se invece
 * manca l'identificativo o il titolo, il prodotto viene scartato, perché senza
 * quei due non è deduplicabile né mostrabile.
 */

export interface RawTaobaoProduct {
  /**
   * Marketplace di provenienza.
   *
   * Entra nella deduplica insieme all'id: gli identificativi sono numerici su
   * entrambe le piattaforme e niente garantisce che non collidano.
   */
  platform: TaobaoPlatform;
  /** Identificativo sul suo marketplace: è la chiave di deduplica primaria. */
  itemId: string;
  title: string;
  /** Titolo tradotto, quando la fonte lo espone. */
  titleEn: string | null;
  url: string | null;
  imageUrl: string | null;

  price: number | null;
  currency: string | null;
  /** Prezzo della variante specifica, quando la fonte lo espone separato. */
  variantPrice: number | null;
  /** Prezzo promozionale, valorizzato solo se c'è davvero una promozione. */
  promotionPrice: number | null;
  /** Quantità minima d'ordine. */
  moq: number | null;
  /** SKU/variante indicata dalla fonte. */
  sku: string | null;

  shopName: string | null;
  shopUrl: string | null;
  sellerId: string | null;

  totalSales: number | null;
  reviewCount: number | null;
  rating: number | null;

  specs: Record<string, string> | null;
  variants: Array<{ name: string; options: string[] }> | null;
  availability: string | null;
  /** Spedizione interna in Cina, come dichiarata dalla fonte. */
  shipping: string | null;
  /** Risposta grezza della fonte, per non perdere ciò che non normalizziamo. */
  raw?: unknown;
  /**
   * Prodotto risultato non più ordinabile.
   *
   * Lo valorizza solo la memoria, che conserva l'esito dell'ultimo controllo:
   * una fonte appena interrogata che restituisce il prodotto lo sta di fatto
   * dichiarando ancora esistente, e in `merge.ts` la lettura fresca ha la
   * precedenza su quella salvata.
   */
  unavailable?: boolean;

  source: TaobaoSource;
}

/* -------------------------------------------------------------------------- */
/* Identità del prodotto                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Estrae l'`itemId` da un link Taobao/Tmall o da un identificativo nudo.
 *
 * Serve in tre punti diversi — i link già presenti nell'Excel, i risultati
 * dell'API, quelli di Playwright — e in tutti e tre la domanda è la stessa:
 * «di quale prodotto stiamo parlando?». Due URL con parametri di tracciamento
 * diversi sono lo stesso prodotto, ed è questa funzione a saperlo.
 */
export function extractItemId(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;

  // Identificativo nudo: 9-16 cifre.
  if (/^\d{6,20}$/.test(text)) return text;

  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    // Non è un URL: resta l'ipotesi che contenga un id come parametro.
    const loose = text.match(/(?:^|[?&])(?:id|item_id|itemId|num_iid)=(\d{6,20})/);
    return loose?.[1] ?? null;
  }

  const host = url.hostname.toLowerCase();
  if (!/(^|\.)(taobao|tmall|tb|liangxinyao)\.com$/.test(host) && !host.endsWith("taobao.com")) {
    // Un link di un altro sito non è un prodotto Taobao: meglio nessun id che
    // un id preso da un dominio che non c'entra.
    if (!/taobao|tmall/.test(host)) return null;
  }

  for (const key of ["id", "item_id", "itemId", "num_iid", "itemid"]) {
    const found = url.searchParams.get(key);
    if (found && /^\d{6,20}$/.test(found)) return found;
  }

  const inPath = url.pathname.match(/\/i(\d{6,20})\.htm/);
  return inPath?.[1] ?? null;
}

/** Link canonico di un prodotto: senza tracciamenti, sempre uguale a sé stesso. */
export function canonicalItemUrl(itemId: string): string {
  return `https://item.taobao.com/item.htm?id=${itemId}`;
}

/**
 * Rimette in chiaro un link salvato con le entità HTML.
 *
 * I collegamenti letti dai fogli arrivano spesso con `&amp;` al posto di `&`:
 * il link resta cliccabile ma i parametri dopo il primo si perdono, e con
 * loro la variante che il cliente aveva scelto.
 */
export function decodeLinkEntities(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/* -------------------------------------------------------------------------- */
/* Lettura tollerante dei campi                                                */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Primo valore non vuoto fra gli alias indicati. */
function pick(source: Json, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Numero da un campo che può essere numero, stringa con valuta, o cinese.
 *
 * `"¥12.50"`, `"12.50"`, `"1.2万"` e `12.5` devono dare tutti un numero: le
 * fonti mescolano le tre forme nello stesso payload, e trattarne una sola
 * significa perdere silenziosamente prezzi e vendite.
 */
export function parseLooseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const cleaned = value.normalize("NFKC").replace(/[,\s]/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return null;

  // `万` = diecimila, `亿` = cento milioni: compaiono nelle vendite.
  if (/万|w\b/i.test(cleaned)) return Math.round(amount * 10_000);
  if (/亿/.test(cleaned)) return Math.round(amount * 100_000_000);
  return amount;
}

/**
 * Chiavi dell'identificativo prodotto.
 *
 * `itemIdStr` è deliberatamente **escluso**: su Taobao DataHub è un token
 * cifrato che cambia a ogni richiesta (verificato: 20 risultati su 20 diversi
 * fra due chiamate identiche). Usarlo come identità farebbe apparire nuovo
 * ogni prodotto a ogni ricerca, azzerando deduplica, memoria e storico prezzi.
 */
const ID_KEYS = ["itemId", "num_iid", "item_id", "itemid", "id", "nid", "goods_id"] as const;
const TITLE_KEYS = ["title", "raw_title", "item_title", "name", "goods_name", "subject"] as const;
const PRICE_KEYS = [
  "promotion_price",
  "zk_final_price",
  "price",
  "current_price",
  "sale_price",
  "view_price",
  "reserve_price",
  "orginal_price",
] as const;
const IMAGE_KEYS = ["pic_url", "picUrl", "pic", "main_image", "image", "img", "white_image", "imageUrl"] as const;
const URL_KEYS = ["itemUrl", "detail_url", "item_url", "url", "link", "detailUrl"] as const;
const GALLERY_KEYS = ["images", "item_imgs", "itemImgs", "pics", "gallery"] as const;
const SHOP_KEYS = ["storeTitle", "shop_title", "shop_name", "shopName", "nick", "seller_nick", "seller_name"] as const;
const SHOP_URL_KEYS = ["shop_url", "shopUrl", "seller_url", "shop_link"] as const;
const SELLER_KEYS = ["seller_id", "sellerId", "user_id", "userId"] as const;
const SALES_KEYS = ["sales", "volume", "sold", "view_sales", "month_sales", "sales_count", "totalSales"] as const;
const REVIEW_KEYS = ["comment_count", "commentCount", "rate_count", "reviewCount", "evaluate_count", "reviews"] as const;
const RATING_KEYS = ["rating", "score", "avg_score", "item_score"] as const;
const AVAILABILITY_KEYS = ["quantity", "stock", "sell_out", "status", "availability"] as const;

/**
 * Appiattisce la forma annidata di Taobao DataHub.
 *
 * La ricerca non restituisce prodotti «piatti» ma buste:
 *
 * ```
 * { item: { itemId, title, sales, itemUrl, image, sku: { def: { price, promotionPrice } } },
 *   seller: { storeTitle, storeType },
 *   delivery: { shippingFrom, deliveryFee } }
 * ```
 *
 * Tenere la lettura dei campi indipendente dalla profondità sarebbe stato
 * fragile; appiattire una volta sola qui rende tutto il resto — ricerca,
 * dettaglio, test — un unico dizionario di chiavi.
 */
function flattenEntry(value: unknown): Json | null {
  if (!isObject(value)) return null;

  const item = isObject(value.item) ? value.item : null;
  const seller = isObject(value.seller) ? value.seller : null;
  const delivery = isObject(value.delivery) ? value.delivery : null;
  if (!item && !seller && !delivery) return value;

  const flat: Json = { ...(item ?? {}), ...(seller ?? {}), ...(delivery ?? {}) };

  // Il prezzo sta due livelli sotto, e quello che conta è il promozionale:
  // è la cifra che pagherebbe davvero chi compra oggi.
  const sku = isObject(flat.sku) ? flat.sku : null;
  const def = sku && isObject(sku.def) ? sku.def : null;
  if (def) {
    if (def.promotionPrice !== undefined) flat.promotion_price = def.promotionPrice;
    if (def.price !== undefined) flat.price = def.price;
  }

  // `images` arriva come `{ string: [...] }`: l'immagine principale resta
  // `image`, ma se manca si prende la prima della galleria.
  const images = isObject(flat.images) ? flat.images : null;
  if (!flat.image && images && Array.isArray(images.string) && images.string.length > 0) {
    flat.image = images.string[0];
  }

  return flat;
}

/** Un elemento del payload assomiglia a un prodotto? */
function looksLikeProduct(value: unknown): value is Json {
  const flat = flattenEntry(value);
  if (!flat) return false;
  const hasId = pick(flat, ID_KEYS) !== undefined;
  const hasTitle = pick(flat, TITLE_KEYS) !== undefined;
  return hasId && hasTitle;
}

/**
 * Trova l'elenco dei prodotti dentro una risposta di forma ignota.
 *
 * Gli aggregatori annidano i risultati in modi diversi (`result.item`,
 * `data.items`, `items`, `result.resultList`…). Invece di elencare tutte le
 * forme possibili si cerca in profondità il primo array i cui elementi
 * assomigliano a prodotti: è una regola sola, e regge anche alle forme che non
 * abbiamo ancora visto.
 */
export function findProductArray(payload: unknown, depth = 0): Json[] {
  if (depth > 6) return [];

  if (Array.isArray(payload)) {
    const products = payload.filter(looksLikeProduct);
    if (products.length > 0) return products;
    for (const entry of payload) {
      const nested = findProductArray(entry, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  if (!isObject(payload)) return [];

  // Le chiavi più probabili si guardano per prime: con payload grandi evita di
  // scendere in rami che non contengono prodotti.
  const preferred = ["items", "item", "list", "results", "result", "data", "products", "docs"];
  for (const key of preferred) {
    if (key in payload) {
      const found = findProductArray(payload[key], depth + 1);
      if (found.length > 0) return found;
    }
  }
  for (const [key, value] of Object.entries(payload)) {
    if (preferred.includes(key)) continue;
    const found = findProductArray(value, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Prima immagine della galleria, qualunque forma abbia.
 *
 * Le fonti la impacchettano in modi diversi — `{images: {string: [...]}}`,
 * `{images: [...]}`, `{item_imgs: [{url}]}` — e nessuna delle tre è quella
 * cercata da `IMAGE_KEYS`. Si accetta la prima stringa che somigli a un URL.
 */
function firstGalleryImage(entry: Json): string | null {
  const candidates: unknown[] = [];
  for (const key of GALLERY_KEYS) {
    const value = (entry as Record<string, unknown> | null)?.[key];
    if (value == null) continue;
    if (Array.isArray(value)) candidates.push(...value);
    else if (typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(nested)) candidates.push(...nested);
        else candidates.push(nested);
      }
    } else candidates.push(value);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = text(pick(candidate as Json, IMAGE_KEYS));
      if (nested) return nested;
    }
  }
  return null;
}

/** Traduce un elemento grezzo in prodotto; `null` se non è identificabile. */
export function mapRawProduct(raw: Json, source: TaobaoSource): RawTaobaoProduct | null {
  const entry = flattenEntry(raw) ?? raw;
  const rawUrl = text(pick(entry, URL_KEYS));
  const itemId = text(pick(entry, ID_KEYS))?.match(/\d{6,20}/)?.[0] ?? extractItemId(rawUrl);
  const title = text(pick(entry, TITLE_KEYS));
  if (!itemId || !title) return null;

  // Alcune inserzioni non hanno il campo immagine principale ma portano la
  // galleria (`images.string[]`): senza questo ripiego la scheda resta muta
  // pur avendo le foto a disposizione.
  const image = text(pick(entry, IMAGE_KEYS)) ?? firstGalleryImage(entry);

  const listPrice = parseLooseNumber(pick(entry, ["price", "reserve_price", "orginal_price"]));
  const promotion = parseLooseNumber(pick(entry, ["promotion_price", "zk_final_price"]));

  return {
    // DataHub interroga solo Taobao.
    platform: "taobao",
    itemId,
    title,
    titleEn: null,
    url: rawUrl ? absoluteUrl(rawUrl) : canonicalItemUrl(itemId),
    imageUrl: image ? absoluteUrl(image) : null,
    // `price` è il **listino**, non il prezzo scontato.
    //
    // `PRICE_KEYS` mette `promotion_price` per prima, quindi qui finiva lo
    // stesso numero che va in `promotionPrice`: i due campi risultavano
    // identici e il listino andava perso. Restava una sola cifra, quella
    // promozionale, che sulla pagina Taobao spesso non è quella esposta — di
    // qui i prezzi che «non corrispondono». Tenendoli separati la differenza
    // resta spiegabile invece che invisibile.
    price: listPrice ?? parseLooseNumber(pick(entry, PRICE_KEYS)),
    // Taobao quota in yuan: la valuta non arriva dal payload, e inventarne una
    // diversa sarebbe peggio che dichiarare quella vera del marketplace.
    currency: "CNY",
    variantPrice: null,
    promotionPrice: promotion != null && promotion !== listPrice ? promotion : null,
    moq: parseLooseNumber(pick(entry, ["moq", "min_order", "minOrder"])),
    sku: null,
    shopName: text(pick(entry, SHOP_KEYS)),
    shopUrl: (() => {
      const value = text(pick(entry, SHOP_URL_KEYS));
      return value ? absoluteUrl(value) : null;
    })(),
    sellerId: text(pick(entry, SELLER_KEYS)),
    totalSales: intOrNull(parseLooseNumber(pick(entry, SALES_KEYS))),
    reviewCount: intOrNull(parseLooseNumber(pick(entry, REVIEW_KEYS))),
    rating: parseLooseNumber(pick(entry, RATING_KEYS)),
    specs: null,
    variants: null,
    availability: text(pick(entry, AVAILABILITY_KEYS)),
    // La spedizione interna arriva già dentro la ricerca: nessuna chiamata in
    // più serve per sapere da dove parte la merce e quanto costa.
    shipping: readShipping(entry),
    raw: entry,
    source,
  };
}

/** Spedizione interna in Cina: provenienza e costo, come li espone la fonte. */
function readShipping(source: Json): string | null {
  const from = text(pick(source, ["shippingFrom", "location", "area", "provcity"]));
  const fee = pick(source, ["deliveryFee", "post_fee", "express_fee", "freight"]);
  const feeValue = parseLooseNumber(fee);

  if (from && feeValue != null) {
    const label = feeValue === 0 ? t("ship.free") : t("ship.fee", { fee: feeValue });
    return `${from} · ${label}`;
  }
  if (from) return from;
  if (feeValue != null) return feeValue === 0 ? t("ship.free") : t("ship.fee", { fee: feeValue });
  return text(pick(source, ["delivery", "shipping"]));
}

/** Prodotti di una risposta di ricerca. */
export function mapSearchPayload(payload: unknown, source: TaobaoSource = "api"): RawTaobaoProduct[] {
  const seen = new Set<string>();
  const products: RawTaobaoProduct[] = [];
  for (const entry of findProductArray(payload)) {
    const product = mapRawProduct(entry, source);
    if (!product || seen.has(product.itemId)) continue;
    seen.add(product.itemId);
    products.push(product);
  }
  return products;
}

/**
 * Campi aggiuntivi di una scheda prodotto.
 *
 * Il dettaglio non sostituisce il risultato di ricerca: lo completa. Restituire
 * solo i campi presenti, invece di un prodotto intero, evita che una risposta
 * povera cancelli dati già validi (è successo: un dettaglio senza `sales`
 * azzerava le vendite lette in ricerca).
 */
export function mapDetailPayload(payload: unknown): Partial<RawTaobaoProduct> {
  const found = findDetailObject(payload);
  // La busta va aperta anche qui: `findDetailObject` restituisce l'oggetto che
  // *contiene* il prodotto, che nella forma DataHub è `{item: {...}}`.
  const root = found ? (flattenEntry(found) ?? found) : null;
  if (!root) return {};

  const result: Partial<RawTaobaoProduct> = {};

  const price = parseLooseNumber(pick(root, PRICE_KEYS));
  if (price != null) result.price = price;

  const sales = intOrNull(parseLooseNumber(pick(root, SALES_KEYS)));
  if (sales != null) result.totalSales = sales;

  const reviews = intOrNull(parseLooseNumber(pick(root, REVIEW_KEYS)));
  if (reviews != null) result.reviewCount = reviews;

  const rating = parseLooseNumber(pick(root, RATING_KEYS));
  if (rating != null) result.rating = rating;

  const shop = text(pick(root, SHOP_KEYS));
  if (shop) result.shopName = shop;

  const specs = readSpecs(root);
  if (specs) result.specs = specs;

  const variants = readVariants(root);
  if (variants) result.variants = variants;

  const availability = text(pick(root, AVAILABILITY_KEYS));
  if (availability) result.availability = availability;

  const shipping = readShipping(root);
  if (shipping) result.shipping = shipping;

  return result;
}

/**
 * Numero di recensioni e voto medio da una risposta `Item Review`.
 *
 * Una risposta di recensioni **non** contiene un prodotto: cercarvi un oggetto
 * con id e titolo non troverebbe nulla. Si cerca invece il primo oggetto che
 * porti uno dei campi attesi, a qualunque profondità stia.
 */
export function mapReviewPayload(payload: unknown): {
  reviewCount: number | null;
  rating: number | null;
} {
  const countKeys = [...REVIEW_KEYS, "total", "count"] as const;
  const root =
    findObjectWith(payload, [...countKeys, ...RATING_KEYS]) ??
    (isObject(payload) ? payload : null);
  if (!root) return { reviewCount: null, rating: null };
  return {
    reviewCount: intOrNull(parseLooseNumber(pick(root, countKeys))),
    rating: parseLooseNumber(pick(root, RATING_KEYS)),
  };
}

/** Primo oggetto, in profondità, che contiene almeno una delle chiavi. */
function findObjectWith(payload: unknown, keys: readonly string[], depth = 0): Json | null {
  if (depth > 6) return null;

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = findObjectWith(entry, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (!isObject(payload)) return null;
  if (pick(payload, keys) !== undefined) return payload;

  for (const value of Object.values(payload)) {
    const found = findObjectWith(value, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Utilità                                                                     */
/* -------------------------------------------------------------------------- */

function intOrNull(value: number | null): number | null {
  if (value == null) return null;
  return Math.round(value);
}

/** `//img.alicdn.com/...` è un URL valido a cui manca solo lo schema. */
function absoluteUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `https://item.taobao.com${trimmed}`;
  return trimmed;
}

/** Oggetto che descrive un singolo prodotto dentro una risposta annidata. */
function findDetailObject(payload: unknown, depth = 0): Json | null {
  if (depth > 6 || !isObject(payload)) return null;
  if (looksLikeProduct(payload)) return payload;

  for (const key of ["item", "data", "result", "detail", "product"]) {
    if (key in payload) {
      const found = findDetailObject(payload[key], depth + 1);
      if (found) return found;
    }
  }
  for (const value of Object.values(payload)) {
    const found = findDetailObject(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Specifiche in forma `chiave: valore`, da tutte le forme note. */
function readSpecs(root: Json): Record<string, string> | null {
  const raw = pick(root, ["props", "attributes", "specs", "item_attributes", "props_list", "attrs"]);
  if (!raw) return null;

  const specs: Record<string, string> = {};

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") {
        // Forma `"材质:不锈钢"`.
        const [key, ...rest] = entry.split(/[:：]/);
        if (key && rest.length > 0) specs[key.trim()] = rest.join(":").trim();
        continue;
      }
      if (!isObject(entry)) continue;
      const key = text(pick(entry, ["name", "key", "attr_name", "propertyName"]));
      const value = text(pick(entry, ["value", "val", "attr_value", "propertyValue"]));
      if (key && value) specs[key] = value;
    }
  } else if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const asText = text(value);
      if (asText) specs[key] = asText;
    }
  }

  return Object.keys(specs).length > 0 ? specs : null;
}

/** Varianti acquistabili (`colore`, `misura`) con le loro opzioni. */
function readVariants(root: Json): Array<{ name: string; options: string[] }> | null {
  const raw = pick(root, ["skus", "sku", "variants", "props_list", "sale_props", "skuProps"]);
  if (!Array.isArray(raw)) return null;

  const groups = new Map<string, Set<string>>();
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const name = text(pick(entry, ["name", "prop_name", "propertyName", "key"]));
    const values = pick(entry, ["values", "value", "options", "vals"]);

    if (name && Array.isArray(values)) {
      const bucket = groups.get(name) ?? new Set<string>();
      for (const value of values) {
        const label = isObject(value) ? text(pick(value, ["name", "value", "text"])) : text(value);
        if (label) bucket.add(label);
      }
      groups.set(name, bucket);
      continue;
    }

    // Forma piatta: ogni sku porta la propria descrizione (`红色 XL`).
    const label = text(pick(entry, ["properties_name", "spec", "sku_name", "propPath", "title"]));
    if (label) {
      const bucket = groups.get("varianti") ?? new Set<string>();
      bucket.add(label);
      groups.set("varianti", bucket);
    }
  }

  const variants = [...groups.entries()]
    .filter(([, options]) => options.size > 0)
    .map(([name, options]) => ({ name, options: [...options] }));
  return variants.length > 0 ? variants : null;
}
