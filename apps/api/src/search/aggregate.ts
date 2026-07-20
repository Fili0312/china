import type { NormalizedProduct } from "@china/shared";

/**
 * Offerta conservata dentro un prodotto aggregato.
 *
 * Questo e `AggregatedProduct` sono intenzionalmente tipi locali: il modulo
 * definisce il contratto proposto per un futuro endpoint multi-motore senza
 * modificare il contratto pubblico corrente di `GET /api/search`.
 */
export interface AggregatedOffer {
  provider: string;
  id: string;
  url: string | null;
  price: number | null;
  currency: string;
  vendor: string | null;
  score: number;
}

export interface AggregatedProduct {
  /** Identità deterministica del cluster, indipendente dall'ordine di input. */
  canonicalKey: string;
  /** Candidato col relevanceScore più alto (pareggi risolti deterministicamente). */
  representative: NormalizedProduct;
  relevanceScore: number;
  /** Una voce per offerta sorgente distinta, ordinata per score decrescente. */
  offers: AggregatedOffer[];
}

const SHARED_OTAPI_PROVIDERS = new Set(["taobao", "tmall"]);
const TRACKING_PARAMETERS = new Set([
  "aff_fcid",
  "aff_fsk",
  "aff_platform",
  "aff_short_key",
  "affiliate_id",
  "algo_exp_id",
  "algo_pvid",
  "from",
  "gatewayadapt",
  "gps-id",
  "pvid",
  "ref",
  "scm",
  "scm_id",
  "scm-url",
  "sk",
  "source",
  "spm",
  "src",
  "tracking",
]);

interface IdentityParts {
  scopedId: string | null;
  sharedOtapiId: string | null;
  url: string | null;
  image: string | null;
  normalizedTitle: string;
}

/**
 * Raggruppa candidati già normalizzati provenienti da più motori.
 *
 * Regole, dalla più affidabile alla più euristica:
 * 1. stesso ID sorgente; gli ID Taobao/Tmall condividono lo stesso namespace;
 * 2. stesso URL canonico (tracking, protocollo e `www` non contano);
 * 3. stessa immagine canonica e titoli sufficientemente simili.
 *
 * Non viene mai usato il solo titolo: titoli commerciali generici causerebbero
 * falsi positivi. Il risultato non muta gli oggetti ricevuti.
 */
export function aggregateProducts(
  candidates: readonly NormalizedProduct[]
): AggregatedProduct[] {
  if (candidates.length === 0) return [];

  const identities = candidates.map(identityParts);
  const disjointSet = new DisjointSet(candidates.length);
  unionByExactIdentity(identities, disjointSet);
  unionByTitleAndImage(identities, disjointSet);

  const clusters = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = disjointSet.find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(index);
    else clusters.set(root, [index]);
  }

  return [...clusters.values()]
    .map((indexes) => buildAggregatedProduct(candidates, identities, indexes))
    .sort(compareAggregatedProducts);
}

/**
 * Seleziona il top-N senza lasciare che una sola fonte monopolizzi tutti i
 * pareggi. La diversificazione può incidere al massimo 12 punti: un risultato
 * chiaramente più pertinente continua quindi a prevalere su uno mediocre.
 */
export function selectDiverseProducts(
  products: readonly AggregatedProduct[],
  limit: number
): AggregatedProduct[] {
  const target = Math.max(0, Math.floor(limit));
  const remaining = [...products];
  const selected: AggregatedProduct[] = [];
  const providerCounts = new Map<string, number>();

  while (remaining.length > 0 && selected.length < target) {
    remaining.sort((left, right) => {
      const exposure = (product: AggregatedProduct): number => {
        const providers = uniqueSorted(
          product.offers.map((offer) => normalizeProvider(offer.provider))
        );
        return providers.length
          ? Math.min(
              ...providers.map(
                (provider) => providerCounts.get(provider) ?? 0
              )
            )
          : providerCounts.get(
              normalizeProvider(product.representative.provider)
            ) ?? 0;
      };
      const leftExposure = exposure(left);
      const rightExposure = exposure(right);
      const leftAdjusted =
        left.relevanceScore - Math.min(12, leftExposure * 6);
      const rightAdjusted =
        right.relevanceScore - Math.min(12, rightExposure * 6);
      return (
        rightAdjusted - leftAdjusted ||
        leftExposure - rightExposure ||
        confidenceOf(right.representative) -
          confidenceOf(left.representative) ||
        compareAggregatedProducts(left, right)
      );
    });

    const next = remaining.shift()!;
    selected.push(next);
    const representedProviders = uniqueSorted(
      next.offers.map((offer) => normalizeProvider(offer.provider))
    );
    for (const provider of representedProviders.length
      ? representedProviders
      : [normalizeProvider(next.representative.provider)]) {
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    }
  }

  return selected;
}

/**
 * Restituisce la chiave canonica che il candidato avrebbe da solo. Per un
 * cluster completo `aggregateProducts` può scegliere una fingerprint comune
 * più forte, per esempio l'ID OTAPI condiviso tra Taobao e Tmall.
 */
export function canonicalProductKey(product: NormalizedProduct): string {
  const identity = identityParts(product);
  if (identity.sharedOtapiId) return identity.sharedOtapiId;
  if (identity.url) return `url:${identity.url}`;
  if (identity.image && identity.normalizedTitle) {
    return fingerprintKey(identity.image, identity.normalizedTitle);
  }
  if (identity.scopedId) return identity.scopedId;
  return `content:${stableHash(
    `${normalizeProvider(product.provider)}|${identity.normalizedTitle}`
  )}`;
}

/** Canonicalizzazione conservativa: rimuove tracking, non parametri identità. */
export function canonicalizeProductUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const port =
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
        ? ""
        : url.port;
    let pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");

    const parameters = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingParameter(name))
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName === rightName
          ? leftValue.localeCompare(rightValue)
          : leftName.localeCompare(rightName)
      );
    const search = new URLSearchParams(parameters).toString();
    return `${hostname}${port ? `:${port}` : ""}${pathname}${
      search ? `?${search}` : ""
    }`;
  } catch {
    return null;
  }
}

function identityParts(product: NormalizedProduct): IdentityParts {
  const provider = normalizeProvider(product.provider);
  const id = product.id.trim();
  const sharedOtapiId =
    id && SHARED_OTAPI_PROVIDERS.has(provider) ? `otapi:${id}` : null;
  return {
    scopedId: id ? `provider:${provider}:${id}` : null,
    sharedOtapiId,
    url: canonicalizeProductUrl(product.productUrl),
    image: canonicalizeImageUrl(product.imageUrl),
    normalizedTitle: normalizeTitle(product.originalTitle || product.title),
  };
}

function unionByExactIdentity(
  identities: readonly IdentityParts[],
  disjointSet: DisjointSet
): void {
  const seen = new Map<string, number>();
  identities.forEach((identity, index) => {
    for (const key of [
      identity.scopedId,
      identity.sharedOtapiId,
      identity.url ? `url:${identity.url}` : null,
    ]) {
      if (!key) continue;
      const previous = seen.get(key);
      if (previous == null) seen.set(key, index);
      else disjointSet.union(previous, index);
    }
  });
}

function unionByTitleAndImage(
  identities: readonly IdentityParts[],
  disjointSet: DisjointSet
): void {
  const byImage = new Map<string, number[]>();
  identities.forEach((identity, index) => {
    if (!identity.image || !identity.normalizedTitle) return;
    const previous = byImage.get(identity.image) ?? [];
    for (const otherIndex of previous) {
      if (
        titlesReasonablyEqual(
          identity.normalizedTitle,
          identities[otherIndex].normalizedTitle
        )
      ) {
        disjointSet.union(otherIndex, index);
      }
    }
    previous.push(index);
    byImage.set(identity.image, previous);
  });
}

function buildAggregatedProduct(
  candidates: readonly NormalizedProduct[],
  identities: readonly IdentityParts[],
  indexes: readonly number[]
): AggregatedProduct {
  const orderedCandidates = indexes
    .map((index) => candidates[index])
    .sort(compareCandidates);
  const canonicalKey = canonicalKeyForCluster(identities, indexes);
  const representative = { ...orderedCandidates[0], canonicalKey };

  const bestOffers = new Map<string, AggregatedOffer>();
  for (const candidate of orderedCandidates) {
    const offer = toOffer(candidate);
    const offerKey = `${normalizeProvider(offer.provider)}|${offer.id.trim()}|${
      canonicalizeProductUrl(offer.url) ?? ""
    }`;
    const current = bestOffers.get(offerKey);
    if (!current || compareOffers(offer, current) < 0) {
      bestOffers.set(offerKey, offer);
    }
  }

  return {
    canonicalKey,
    representative,
    relevanceScore: scoreOf(representative),
    offers: [...bestOffers.values()].sort(compareOffers),
  };
}

function canonicalKeyForCluster(
  identities: readonly IdentityParts[],
  indexes: readonly number[]
): string {
  const values = indexes.map((index) => identities[index]);
  const sharedIds = uniqueSorted(values.flatMap((value) => value.sharedOtapiId ?? []));
  if (sharedIds[0]) return sharedIds[0];

  const urls = uniqueSorted(values.flatMap((value) => value.url ?? []));
  if (urls.length === 1) return `url:${urls[0]}`;

  const images = uniqueSorted(values.flatMap((value) => value.image ?? []));
  if (images.length === 1) {
    const titles = uniqueSorted(
      values.flatMap((value) => value.normalizedTitle || [])
    );
    if (titles[0]) return fingerprintKey(images[0], titles[0]);
  }

  const scopedIds = uniqueSorted(values.flatMap((value) => value.scopedId ?? []));
  if (scopedIds[0]) return scopedIds[0];

  const fallback = values
    .map((value) => `${value.normalizedTitle}|${value.image ?? ""}`)
    .sort()
    .join("||");
  return `content:${stableHash(fallback)}`;
}

function toOffer(candidate: NormalizedProduct): AggregatedOffer {
  return {
    provider: candidate.provider,
    id: candidate.id,
    url: candidate.productUrl,
    price: candidate.originalPrice,
    currency: candidate.currency,
    vendor: candidate.vendorName,
    score: scoreOf(candidate),
  };
}

function compareAggregatedProducts(
  left: AggregatedProduct,
  right: AggregatedProduct
): number {
  return (
    right.relevanceScore - left.relevanceScore ||
    left.canonicalKey.localeCompare(right.canonicalKey)
  );
}

function compareCandidates(
  left: NormalizedProduct,
  right: NormalizedProduct
): number {
  return (
    scoreOf(right) - scoreOf(left) ||
    confidenceOf(right) - confidenceOf(left) ||
    normalizeProvider(left.provider).localeCompare(normalizeProvider(right.provider)) ||
    left.id.localeCompare(right.id) ||
    left.title.localeCompare(right.title)
  );
}

function confidenceOf(product: NormalizedProduct): number {
  const score = product.sourceConfidenceScore;
  return typeof score === "number" && Number.isFinite(score)
    ? Math.min(100, Math.max(0, score))
    : 100;
}

function compareOffers(left: AggregatedOffer, right: AggregatedOffer): number {
  return (
    right.score - left.score ||
    normalizeProvider(left.provider).localeCompare(normalizeProvider(right.provider)) ||
    left.id.localeCompare(right.id) ||
    (left.url ?? "").localeCompare(right.url ?? "")
  );
}

function scoreOf(product: NormalizedProduct): number {
  const score = product.relevanceScore;
  return typeof score === "number" && Number.isFinite(score)
    ? Math.min(100, Math.max(0, score))
    : 0;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLocaleLowerCase("en-US");
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/([a-z])(?=\d)|([0-9])(?=[a-z])/g, "$1$2 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titlesReasonablyEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (Math.min(leftTokens.size, rightTokens.size) < 3) return false;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const dice = (2 * intersection) / (leftTokens.size + rightTokens.size);
  const containment = intersection / Math.min(leftTokens.size, rightTokens.size);
  return dice >= 0.78 || (containment >= 0.9 && intersection >= 4);
}

function canonicalizeImageUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (/\/(?:blank|default|no-?image|placeholder|loading)[^/]*\.(?:gif|jpe?g|png|webp)$/i.test(pathname)) {
      return null;
    }
    // Varianti CDN comuni: `photo.jpg_300x300q90.jpg` e `photo_300x300.jpg`.
    pathname = pathname
      .replace(/\.(jpe?g|png|webp)_[^/]+?\.(?:jpe?g|png|webp)$/i, ".$1")
      .replace(/_\d{2,5}x\d{2,5}(?:q\d+)?\.(jpe?g|png|webp)$/i, ".$1");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${pathname}`;
  } catch {
    return null;
  }
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized);
}

function fingerprintKey(image: string, title: string): string {
  return `fingerprint:${stableHash(`${image}|${title}`)}`;
}

/** FNV-1a 64 bit: piccolo, stabile fra processi e sufficiente per una chiave. */
function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

class DisjointSet {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(value: number): number {
    const parent = this.parent[value];
    if (parent !== value) this.parent[value] = this.find(parent);
    return this.parent[value];
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      this.parent[leftRoot] = rightRoot;
    } else {
      this.parent[rightRoot] = leftRoot;
      if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot] += 1;
    }
  }
}
