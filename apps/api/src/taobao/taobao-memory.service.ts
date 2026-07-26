import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { prisma, Prisma } from "@china/db";
import type {
  ProductAnalysis,
  TaobaoPlatform,
  TaobaoMemoryMatch,
  TaobaoSource,
  VariantIdentity,
} from "@china/shared";
import type { MergedProduct } from "./merge";
import type { RawTaobaoProduct } from "./providers/taobao-item";
import { t } from "../i18n/messages";

/**
 * La memoria dei prodotti: cosa sappiamo già, e quando non vale più.
 *
 * È la ragione per cui il secondo file che chiede lo stesso pezzo non costa
 * nulla. La memoria è **condivisa fra clienti** — un pezzo trovato per uno
 * vale per tutti — ma non è mai visibile a un cliente se non attraverso le
 * righe di job che ha chiesto lui: la condivisione riguarda il lavoro, non i
 * dati di chi l'ha commissionato.
 *
 * Il punto delicato è il secondo: **quando un prodotto noto non vale più**. Un
 * link Taobao di sei mesi fa può essere sparito, esaurito, raddoppiato di
 * prezzo o cambiato di venditore. Riusarlo senza controllare significa
 * consegnare un preventivo su prezzi che non esistono, che è peggio che non
 * averlo.
 */

export interface ReuseSettings {
  /** Oltre questa età un controllo non è più una garanzia. */
  maxCacheAgeHours: number;
  /** Variazione di prezzo oltre la quale il prodotto va riverificato. */
  maxPriceChangePct: number;
  /** Sotto questo numero di prodotti validi si rifà la ricerca. */
  minValidProducts: number;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readReuseSettings(): ReuseSettings {
  return {
    maxCacheAgeHours: numericEnv("TAOBAO_PRODUCT_CACHE_HOURS", 336),
    maxPriceChangePct: numericEnv("TAOBAO_MAX_PRICE_CHANGE_PCT", 25),
    minValidProducts: numericEnv("TAOBAO_MIN_VALID_PRODUCTS", 2),
  };
}

/** Impronta dei dati commerciali: se non cambia, non è cambiato niente. */
export function contentHashOf(product: {
  price: number | null;
  currency: string | null;
  variantPrice: number | null;
  availability: string | null;
  totalSales: number | null;
  reviewCount: number | null;
  rating: number | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        product.price,
        product.currency,
        product.variantPrice,
        product.availability,
        product.totalSales,
        product.reviewCount,
        product.rating,
      ])
    )
    .digest("hex")
    .slice(0, 24);
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value);
}

export interface StoredProduct {
  id: string;
  itemId: string;
  platform: TaobaoPlatform;
  price: number | null;
  currency: string | null;
  unavailable: boolean;
  lastCheckedAt: Date;
  previousPrice: number | null;
  variants: unknown;
  sources: string[];
}

@Injectable()
export class TaobaoMemoryService {
  private readonly logger = new Logger("TaobaoMemory");

  get settings(): ReuseSettings {
    return readReuseSettings();
  }

  /** Famiglia di una variante: la chiave la porta in testa (`famiglia:hash`). */
  private familyOf(variantKey: string): string {
    const separator = variantKey.indexOf(":");
    return separator > 0 ? variantKey.slice(0, separator) : variantKey;
  }

  /**
   * Cosa sa la memoria di ciascuna variante.
   *
   * Lettura pura: nessuna rete. Deve poter girare su tutte le righe di un file
   * mentre l'operatore guarda la revisione.
   */
  async lookupVariants(
    variantKeys: readonly string[]
  ): Promise<Map<string, TaobaoMemoryMatch>> {
    const result = new Map<string, TaobaoMemoryMatch>();
    const unique = [...new Set(variantKeys)].filter(Boolean);
    if (unique.length === 0) return result;

    const families = [...new Set(unique.map((key) => this.familyOf(key)))];
    const requests = await prisma.taobaoRequest.findMany({
      where: { familyKey: { in: families } },
      select: {
        id: true,
        familyKey: true,
        variantKey: true,
        lastSearchedAt: true,
        lastVerifiedAt: true,
        searchQueryChinese: true,
        searchQueryEnglish: true,
        _count: { select: { products: true } },
      },
    });

    const byVariant = new Map(requests.map((request) => [request.variantKey, request]));
    const byFamily = new Map<string, typeof requests>();
    for (const request of requests) {
      const bucket = byFamily.get(request.familyKey) ?? [];
      bucket.push(request);
      byFamily.set(request.familyKey, bucket);
    }

    const settings = this.settings;
    const cutoff = new Date(Date.now() - settings.maxCacheAgeHours * 3_600_000);
    const requestIds = requests.map((request) => request.id);
    const validCounts = requestIds.length
      ? await prisma.taobaoProduct.groupBy({
          by: ["requestId"],
          where: {
            requestId: { in: requestIds },
            unavailable: false,
            price: { not: null },
            lastCheckedAt: { gte: cutoff },
          },
          _count: { _all: true },
        })
      : [];
    const validByRequest = new Map(
      validCounts.map((entry) => [entry.requestId, entry._count._all])
    );

    for (const variantKey of unique) {
      const family = this.familyOf(variantKey);
      const exact = byVariant.get(variantKey);
      const siblings = (byFamily.get(family) ?? []).filter(
        (request) => request.variantKey !== variantKey
      );

      result.set(variantKey, {
        requestId: exact?.id ?? null,
        productCount: exact?._count.products ?? 0,
        validProductCount: exact ? (validByRequest.get(exact.id) ?? 0) : 0,
        lastSearchedAt: exact?.lastSearchedAt?.toISOString() ?? null,
        lastVerifiedAt: exact?.lastVerifiedAt?.toISOString() ?? null,
        familyRequestCount: siblings.length,
        // Le query che hanno già funzionato sulla famiglia sono un punto di
        // partenza, non un risultato: la variante nuova va verificata da sé.
        familyQueries: [
          ...new Set(
            siblings
              .flatMap((request) => [request.searchQueryChinese, request.searchQueryEnglish])
              .filter((query): query is string => !!query)
          ),
        ].slice(0, 8),
      });
    }

    return result;
  }

  /**
   * Lo storico della memoria: le varianti già cercate, sfogliabili.
   *
   * È la risposta alla domanda «cosa conosce già il sistema?» senza dover
   * caricare un file per scoprirlo. Restituisce solo dati di prodotto — mai
   * per quale cliente sono stati cercati: la memoria è condivisa, il lavoro no.
   */
  async listRequests(query: string | undefined, limit = 30) {
    const cleaned = (query ?? "").trim();
    const requests = await prisma.taobaoRequest.findMany({
      where: cleaned
        ? {
            OR: [
              { displayName: { contains: cleaned, mode: "insensitive" } },
              { productNameChinese: { contains: cleaned, mode: "insensitive" } },
              { productNameEnglish: { contains: cleaned, mode: "insensitive" } },
              { familyKey: { contains: cleaned, mode: "insensitive" } },
              { searchQueryChinese: { contains: cleaned, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { lastSearchedAt: { sort: "desc", nulls: "last" } },
      take: Math.min(200, Math.max(1, limit)),
      select: {
        id: true,
        variantKey: true,
        familyKey: true,
        displayName: true,
        productNameChinese: true,
        searchQueryChinese: true,
        firstSeenAt: true,
        lastSearchedAt: true,
        lastVerifiedAt: true,
        searchCount: true,
        _count: { select: { products: true } },
        products: {
          orderBy: { lastCheckedAt: "desc" },
          take: 1,
          select: { title: true, price: true, currency: true, url: true },
        },
      },
    });

    return requests.map((request) => ({
      requestId: request.id,
      variantKey: request.variantKey,
      familyKey: request.familyKey,
      displayName: request.displayName,
      productNameChinese: request.productNameChinese,
      searchQueryChinese: request.searchQueryChinese,
      productCount: request._count.products,
      searchCount: request.searchCount,
      firstSeenAt: request.firstSeenAt.toISOString(),
      lastSearchedAt: request.lastSearchedAt?.toISOString() ?? null,
      lastVerifiedAt: request.lastVerifiedAt?.toISOString() ?? null,
      topProduct: request.products[0]
        ? {
            title: request.products[0].title,
            price: decimalToNumber(request.products[0].price),
            currency: request.products[0].currency,
            url: request.products[0].url,
          }
        : null,
    }));
  }

  /** Crea o aggiorna la variante: da qui in poi ha un'identità persistente. */
  async upsertRequest(
    analysis: ProductAnalysis,
    identity: Pick<VariantIdentity, "familyKey" | "variantKey" | "duplicateKey">,
    displayName: string
  ): Promise<string> {
    const common = {
      familyKey: identity.familyKey,
      duplicateKey: identity.duplicateKey,
      displayName,
      productNameChinese: analysis.productNameChinese,
      productNameEnglish: analysis.productNameEnglish,
      model: analysis.model,
      material: analysis.material,
      color: analysis.color,
      searchQueryChinese: analysis.searchQueryChinese,
      searchQueryEnglish: analysis.searchQueryEnglish,
      analysis: analysis as unknown as Prisma.InputJsonValue,
      hardRequirements: analysis.hardRequirements ?? [],
      softRequirements: analysis.softRequirements ?? [],
    };

    const record = await prisma.taobaoRequest.upsert({
      where: { variantKey: identity.variantKey },
      create: { variantKey: identity.variantKey, ...common },
      update: common,
      select: { id: true },
    });
    return record.id;
  }

  /** Prodotti già salvati per una variante, nella forma dei candidati. */
  async loadProducts(requestId: string): Promise<RawTaobaoProduct[]> {
    const products = await prisma.taobaoProduct.findMany({
      where: { requestId },
      orderBy: { lastCheckedAt: "desc" },
    });

    return products.map((product) => ({
      platform: (product.platform === "1688" ? "1688" : "taobao") as TaobaoPlatform,
      itemId: product.itemId,
      title: product.title,
      titleEn: product.titleEn,
      url: product.url,
      imageUrl: product.imageUrl,
      price: decimalToNumber(product.price),
      currency: product.currency,
      variantPrice: decimalToNumber(product.variantPrice),
      promotionPrice: decimalToNumber(product.promotionPrice),
      moq: product.moq,
      sku: product.sku,
      shopName: product.shopName,
      shopUrl: product.shopUrl,
      sellerId: product.sellerId,
      totalSales: product.totalSales,
      reviewCount: product.reviewCount,
      rating: product.rating,
      specs: (product.specs as Record<string, string> | null) ?? null,
      variants:
        (product.variants as Array<{ name: string; options: string[] }> | null) ?? null,
      availability: product.availability,
      shipping: typeof product.shipping === "string" ? product.shipping : null,
      unavailable: product.unavailable,
      raw: product.raw,
      source: "memory" as TaobaoSource,
    }));
  }

  /** Chiave con cui il runner ritrova un prodotto salvato. */
  static key(product: { platform: TaobaoPlatform; itemId: string }): string {
    return productKey(product);
  }

  /** Stato dei prodotti di una variante, per decidere il riuso. */
  async loadStored(requestId: string): Promise<StoredProduct[]> {
    const products = await prisma.taobaoProduct.findMany({
      where: { requestId },
      select: {
        id: true,
        itemId: true,
        platform: true,
        price: true,
        currency: true,
        unavailable: true,
        lastCheckedAt: true,
        variants: true,
        sources: true,
        snapshots: {
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { price: true },
        },
      },
    });

    return products.map((product) => ({
      id: product.id,
      itemId: product.itemId,
      platform: (product.platform === "1688" ? "1688" : "taobao") as TaobaoPlatform,
      price: decimalToNumber(product.price),
      currency: product.currency,
      unavailable: product.unavailable,
      lastCheckedAt: product.lastCheckedAt,
      previousPrice: decimalToNumber(product.snapshots[0]?.price ?? null),
      variants: product.variants,
      sources: product.sources,
    }));
  }

  /**
   * Salva i prodotti trovati e registra ciò che è cambiato.
   *
   * Lo storico non è un log di passaggi: è una riga per ogni **cambiamento
   * reale**. Salvare un'istantanea a ogni controllo riempirebbe la tabella di
   * righe identiche e renderebbe illeggibile l'unica domanda che conta —
   * «quando è cambiato il prezzo?».
   */
  async recordProducts(
    requestId: string,
    products: readonly MergedProduct[],
    foundQuery: string
  ): Promise<{ productIds: Map<string, string>; created: number; updated: number }> {
    const productIds = new Map<string, string>();
    let created = 0;
    let updated = 0;

    for (const product of products) {
      const hash = contentHashOf(product);
      const existing = await prisma.taobaoProduct.findUnique({
        where: {
          requestId_platform_itemId: {
            requestId,
            platform: product.platform,
            itemId: product.itemId,
          },
        },
      });

      const shared = {
        url: product.url,
        title: product.title,
        titleEn: product.titleEn,
        imageUrl: product.imageUrl,
        price: product.price,
        currency: product.currency,
        variantPrice: product.variantPrice,
        promotionPrice: product.promotionPrice,
        moq: product.moq,
        sku: product.sku,
        shopName: product.shopName,
        shopUrl: product.shopUrl,
        sellerId: product.sellerId,
        totalSales: product.totalSales,
        reviewCount: product.reviewCount,
        rating: product.rating,
        specs: (product.specs ?? Prisma.DbNull) as Prisma.InputJsonValue,
        variants: (product.variants ?? Prisma.DbNull) as Prisma.InputJsonValue,
        availability: product.availability,
        shipping: (product.shipping ?? Prisma.DbNull) as Prisma.InputJsonValue,
        raw: (product.raw ?? Prisma.DbNull) as Prisma.InputJsonValue,
        foundQuery,
        sources: product.sources,
        contentHash: hash,
        lastCheckedAt: new Date(),
        // Due modi di essere esaurito: dichiarato dalla fonte adesso, oppure
        // già risultato tale e non smentito da questa lettura.
        unavailable: product.unavailable || isUnavailable(product),
      };

      if (!existing) {
        const record = await prisma.taobaoProduct.create({
          data: {
            requestId,
            platform: product.platform,
            itemId: product.itemId,
            ...shared,
            changedFields: [],
          },
          select: { id: true },
        });
        productIds.set(productKey(product), record.id);
        created += 1;
        continue;
      }

      const changedFields =
        existing.contentHash === hash
          ? []
          : diffFields(
              {
                price: decimalToNumber(existing.price),
                currency: existing.currency,
                variantPrice: decimalToNumber(existing.variantPrice),
                availability: existing.availability,
                totalSales: existing.totalSales,
                reviewCount: existing.reviewCount,
                rating: existing.rating,
              },
              product
            );

      const record = await prisma.taobaoProduct.update({
        where: { id: existing.id },
        data: {
          ...shared,
          // Le provenienze si sommano: un prodotto visto prima dall'API e poi
          // da Playwright è stato visto da entrambe.
          sources: [...new Set([...existing.sources, ...product.sources])],
          ...(changedFields.length > 0
            ? { changedFields, lastChangedAt: new Date() }
            : {}),
        },
        select: { id: true },
      });
      productIds.set(productKey(product), record.id);
      updated += 1;

      if (changedFields.length > 0) {
        await prisma.taobaoPriceSnapshot.create({
          data: {
            productId: existing.id,
            // L'istantanea fotografa il valore **precedente**: è ciò che
            // permette di dire «costava X, ora costa Y».
            price: existing.price,
            currency: existing.currency,
            totalSales: existing.totalSales,
            reviewCount: existing.reviewCount,
            available: !existing.unavailable,
            contentHash: existing.contentHash,
            changedFields,
          },
        });
      }
    }

    await prisma.taobaoRequest.update({
      where: { id: requestId },
      data: {
        lastSearchedAt: new Date(),
        lastVerifiedAt: new Date(),
        searchCount: { increment: 1 },
      },
    });

    return { productIds, created, updated };
  }

  /** Segna un prodotto come non più raggiungibile. */
  async markUnavailable(productId: string, reason: string): Promise<void> {
    await prisma.taobaoProduct
      .update({
        where: { id: productId },
        data: { unavailable: true, lastCheckedAt: new Date(), changedFields: ["disponibilità"] },
      })
      .catch(() => undefined);
    this.logger.log(`prodotto ${productId} non più disponibile: ${reason}`);
  }

  /** Registra la verifica di una variante anche quando nulla è cambiato. */
  async markVerified(requestId: string): Promise<void> {
    await prisma.taobaoRequest
      .update({ where: { id: requestId }, data: { lastVerifiedAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Decide se i prodotti noti bastano.
   *
   * Va chiamata **dopo** aver riletto i prodotti alla fonte: giudicare su dati
   * vecchi darebbe la risposta giusta alla domanda sbagliata.
   */
  evaluateReuse(
    stored: readonly StoredProduct[],
    options: { forceFullSearch?: boolean; refreshFailed?: ReadonlySet<string> } = {}
  ): { reuse: boolean; reason: string; validProductIds: string[] } {
    const settings = this.settings;

    if (options.forceFullSearch) {
      return {
        reuse: false,
        reason: t("reason.fullSearchRequested"),
        validProductIds: [],
      };
    }
    if (stored.length === 0) {
      return {
        reuse: false,
        reason: t("reason.noStoredProducts"),
        validProductIds: [],
      };
    }

    const cutoff = Date.now() - settings.maxCacheAgeHours * 3_600_000;
    const valid: string[] = [];
    const discarded: string[] = [];

    for (const product of stored) {
      if (options.refreshFailed?.has(product.id)) {
        discarded.push("link non più raggiungibile");
        continue;
      }
      if (product.unavailable) {
        discarded.push("prodotto non disponibile");
        continue;
      }
      if (product.price == null) {
        discarded.push("prezzo non recuperabile");
        continue;
      }
      if (product.lastCheckedAt.getTime() < cutoff) {
        discarded.push("ultimo controllo troppo vecchio");
        continue;
      }
      if (
        product.previousPrice != null &&
        product.previousPrice > 0 &&
        Math.abs(product.price - product.previousPrice) / product.previousPrice >
          settings.maxPriceChangePct / 100
      ) {
        discarded.push("prezzo variato oltre la soglia");
        continue;
      }
      valid.push(product.id);
    }

    if (valid.length < settings.minValidProducts) {
      const why = [...new Set(discarded)].join(", ");
      return {
        reuse: false,
        reason: t("reason.tooFewValid", {
          valid: valid.length,
          total: stored.length,
          why: why ? ` (${why})` : "",
        }),
        validProductIds: valid,
      };
    }

    return {
      reuse: true,
      reason: t("reason.reusable", { valid: valid.length }),
      validProductIds: valid,
    };
  }
}

/**
 * Chiave di un prodotto dentro una variante.
 *
 * Comprende la piattaforma perché la stessa variante può avere un prodotto
 * Taobao e un'offerta 1688 con id numerici indipendenti.
 */
function productKey(product: { platform: TaobaoPlatform; itemId: string }): string {
  return `${product.platform}:${product.itemId}`;
}

/** Un prodotto è considerato esaurito quando la fonte lo dichiara. */
function isUnavailable(product: MergedProduct): boolean {
  const availability = (product.availability ?? "").toLowerCase();
  if (!availability) return false;
  return /sold\s*out|已售罄|下架|无货|0$/.test(availability);
}

/** Campi cambiati fra due letture, con nomi leggibili in interfaccia. */
function diffFields(
  previous: {
    price: number | null;
    currency: string | null;
    variantPrice: number | null;
    availability: string | null;
    totalSales: number | null;
    reviewCount: number | null;
    rating: number | null;
  },
  next: MergedProduct
): string[] {
  const changed: string[] = [];
  if (previous.price !== next.price) changed.push("prezzo");
  if (previous.variantPrice !== next.variantPrice) changed.push("prezzo variante");
  if (previous.currency !== next.currency) changed.push("valuta");
  if (previous.availability !== next.availability) changed.push("disponibilità");
  if (previous.totalSales !== next.totalSales) changed.push("vendite");
  if (previous.reviewCount !== next.reviewCount) changed.push("recensioni");
  if (previous.rating !== next.rating) changed.push("voto");
  return changed;
}
