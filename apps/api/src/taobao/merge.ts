import type { TaobaoSource } from "@china/shared";
import type { RawTaobaoProduct } from "./providers/taobao-item";

/**
 * Unione dei candidati provenienti da fonti diverse.
 *
 * Lo stesso prodotto può arrivare quattro volte: dall'API, da Playwright, dal
 * link già presente nell'Excel e dalla memoria del sistema. Mostrarlo quattro
 * volte sarebbe inutile; sceglierne una sola a caso farebbe perdere i dati che
 * hanno solo le altre. Qui si fondono, tenendo traccia di **chi** l'ha visto e
 * di **dove** le fonti non sono d'accordo.
 *
 * ## Come si decide che due schede sono lo stesso prodotto
 *
 * In ordine:
 *
 * 1. **`itemId`** — l'identificativo Taobao. È la chiave vera, e vale anche
 *    per gli URL: un link con dieci parametri di tracciamento e uno pulito
 *    danno lo stesso id, quindi «URL canonico» e «item id» sono la stessa
 *    domanda posta due volte.
 * 2. **SKU** — quando entrambe le schede lo espongono e appartengono allo
 *    stesso venditore.
 * 3. **venditore + titolo + prezzo identici** — la stessa scheda ripubblicata.
 *    Servono tutti e tre.
 *
 * Il titolo **da solo non basta mai**: su Taobao decine di venditori copiano
 * la stessa riga di testo, e fonderli cancellerebbe alternative reali — spesso
 * proprio quelle più economiche.
 *
 * ## Quale valore vince
 *
 * Per ogni campo c'è un ordine di fiducia, e il primo che ha un valore vince.
 * Il prezzo di Playwright batte quello dell'API perché è il prezzo che vede un
 * compratore reale con la sessione aperta; le specifiche dell'API battono
 * quelle del browser perché arrivano strutturate invece che da un testo.
 * Quando due fonti si contraddicono in modo significativo il valore non viene
 * scelto in silenzio: la differenza diventa un avviso sul candidato.
 */

/** Divario di prezzo oltre il quale due fonti sono «in disaccordo». */
const PRICE_CONFLICT_RATIO = 0.05;

export interface MergedProduct extends RawTaobaoProduct {
  /** Tutte le provenienze che hanno visto questo prodotto. */
  sources: TaobaoSource[];
  /** Differenze fra fonti, in italiano, pronte da mostrare. */
  conflicts: string[];
  /** Risolto in `false` quando nessuna fonte dichiara l'esaurimento. */
  unavailable: boolean;
}

/** Ordine di fiducia per i campi commerciali (prezzo, disponibilità). */
const COMMERCIAL_ORDER: readonly TaobaoSource[] = ["playwright", "api", "hwh", "elim", "memory", "excel"];
/** Ordine di fiducia per i campi descrittivi (titolo, specifiche, immagini). */
const DESCRIPTIVE_ORDER: readonly TaobaoSource[] = ["api", "hwh", "elim", "playwright", "memory", "excel"];

function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Chiavi alternative di uno stesso prodotto.
 *
 * La prima è sempre l'`itemId`; le altre servono a riconoscere la stessa
 * scheda quando arriva senza id dalla stessa bottega.
 */
function secondaryKeys(product: RawTaobaoProduct): string[] {
  const keys: string[] = [];
  const sku = product.sku ?? product.specs?.sku ?? product.specs?.SKU ?? null;
  if (sku && product.sellerId) keys.push(`sku:${product.sellerId}:${sku}`);
  if (product.sellerId && product.price != null) {
    keys.push(`vtp:${product.sellerId}:${normalizeTitle(product.title)}:${product.price}`);
  }
  return keys;
}

/** Sceglie il primo valore non nullo secondo un ordine di fiducia. */
function preferred<T>(
  entries: ReadonlyArray<RawTaobaoProduct>,
  order: readonly TaobaoSource[],
  read: (product: RawTaobaoProduct) => T | null | undefined
): T | null {
  for (const source of order) {
    for (const entry of entries) {
      if (entry.source !== source) continue;
      const value = read(entry);
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  // Fonte sconosciuta o ordine esaurito: meglio un valore che nessun valore.
  for (const entry of entries) {
    const value = read(entry);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/** Differenze fra fonti che vale la pena mostrare. */
function describeConflicts(entries: ReadonlyArray<RawTaobaoProduct>): string[] {
  const conflicts: string[] = [];

  const priced = entries.filter(
    (entry): entry is RawTaobaoProduct & { price: number } => entry.price != null
  );
  if (priced.length > 1) {
    const min = Math.min(...priced.map((entry) => entry.price));
    const max = Math.max(...priced.map((entry) => entry.price));
    if (min > 0 && (max - min) / min > PRICE_CONFLICT_RATIO) {
      const detail = priced
        .map((entry) => `${entry.source} ${entry.price}`)
        .join(", ");
      conflicts.push(`Prezzo diverso fra le fonti: ${detail}.`);
    }
  }

  const availabilities = new Set(
    entries
      .map((entry) => entry.availability)
      .filter((value): value is string => !!value)
      .map((value) => value.trim().toLowerCase())
  );
  if (availabilities.size > 1) {
    conflicts.push(`Disponibilità discordante: ${[...availabilities].join(" / ")}.`);
  }

  return conflicts;
}

/**
 * Fonde i candidati di tutte le fonti.
 *
 * L'ordine dell'array in ingresso non conta: il risultato è deterministico
 * perché ogni campo si sceglie per fonte, non per posizione.
 */
export function mergeProducts(products: readonly RawTaobaoProduct[]): MergedProduct[] {
  const groups = new Map<string, RawTaobaoProduct[]>();
  const keyAliases = new Map<string, string>();

  for (const product of products) {
    // La chiave porta la piattaforma: gli id sono numerici su Taobao e su
    // 1688, e due offerte diverse con lo stesso numero non vanno fuse.
    const identity = `id:${product.platform}:${product.itemId}`;
    let groupKey = keyAliases.get(identity) ?? identity;

    // Una chiave secondaria già vista riporta il prodotto nel gruppo giusto
    // anche se l'id è diverso (stessa scheda ripubblicata).
    for (const alias of secondaryKeys(product)) {
      const existing = keyAliases.get(alias);
      if (existing) {
        groupKey = existing;
        break;
      }
    }

    const bucket = groups.get(groupKey) ?? [];
    bucket.push(product);
    groups.set(groupKey, bucket);

    keyAliases.set(identity, groupKey);
    for (const alias of secondaryKeys(product)) keyAliases.set(alias, groupKey);
  }

  const merged: MergedProduct[] = [];

  for (const entries of groups.values()) {
    const sources = [...new Set(entries.map((entry) => entry.source))];

    // L'id da tenere è quello della fonte più affidabile che ne ha uno: se due
    // schede sono state riconosciute come lo stesso prodotto, il link deve
    // portare a quella che abbiamo davvero verificato.
    const itemId =
      preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.itemId) ?? entries[0]!.itemId;

    merged.push({
      platform: entries[0]!.platform,
      itemId,
      title: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.title) ?? entries[0]!.title,
      titleEn: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.titleEn),
      url: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.url),
      imageUrl: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.imageUrl),

      price: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.price),
      currency: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.currency) ?? "CNY",
      variantPrice: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.variantPrice),
      promotionPrice: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.promotionPrice),
      moq: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.moq),
      sku: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.sku),

      shopName: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.shopName),
      shopUrl: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.shopUrl),
      sellerId: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.sellerId),

      totalSales: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.totalSales),
      reviewCount: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.reviewCount),
      rating: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.rating),

      specs: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.specs),
      variants: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.variants),
      availability: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.availability),
      shipping: preferred(entries, COMMERCIAL_ORDER, (entry) => entry.shipping),
      raw: preferred(entries, DESCRIPTIVE_ORDER, (entry) => entry.raw ?? null),
      // Una fonte appena interrogata che restituisce il prodotto lo dichiara
      // esistente: la lettura fresca batte il «non disponibile» salvato.
      unavailable:
        preferred(entries, COMMERCIAL_ORDER, (entry) =>
          entry.unavailable === undefined ? null : entry.unavailable
        ) ?? false,

      // La provenienza si conserva sempre: è ciò che permette di dire «questo
      // prezzo l'abbiamo visto con l'account collegato» invece di «fidati».
      source: sources[0]!,
      sources,
      conflicts: describeConflicts(entries),
    });
  }

  return merged;
}
