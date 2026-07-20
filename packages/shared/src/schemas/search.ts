import { z } from "zod";

/**
 * Contratti della ricerca diretta multi-marketplace. Il backend applica una
 * pipeline deterministica di normalizzazione, matching, ranking e deduplica.
 */

/**
 * Ordinamenti supportati. Nota: OTAPI su Taobao ignora Rating/Popularity
 * (verificato: stessi risultati del default), quindi niente "per recensioni".
 *
 * `best-match` non viene chiesto alla fonte: i risultati arrivano nell'ordine
 * predefinito e vengono riordinati qui combinando compatibilità delle parole,
 * prezzo, vendite e recensioni, quando la fonte le espone.
 */
export const ProductSortSchema = z.enum([
  "default",
  "best-match",
  "orders-desc",
  "price-asc",
  "price-desc",
]);
export type ProductSort = z.infer<typeof ProductSortSchema>;

/**
 * Livello di selettività applicato dopo la risposta dei marketplace.
 * `strict` è il default commerciale: meno card, ma vincoli e prodotto devono
 * corrispondere. `broad` resta disponibile per esplorazione/manual review.
 */
export const SearchQualitySchema = z.enum(["strict", "balanced", "broad"]);
export type SearchQuality = z.infer<typeof SearchQualitySchema>;

/**
 * Motori di ricerca diretta disponibili. Taobao e Tmall usano OTAPI; gli
 * altri usano adapter browser best-effort. Non c'è IA: la query parte
 * letterale e ogni fonte fallisce in modo indipendente.
 */
export const SEARCH_ENGINES = [
  "taobao",
  "tmall",
  "alibaba",
  "aliexpress",
  "made-in-china",
  "chinagoods",
  "yiwugo",
] as const;
export const SearchEngineSchema = z.enum(SEARCH_ENGINES);
export type SearchEngine = z.infer<typeof SearchEngineSchema>;

/** Query string di GET /api/search (coerce: arrivano come stringhe). */
export const ProductSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  framePosition: z.coerce.number().int().min(0).default(0),
  frameSize: z.coerce.number().int().min(1).max(50).default(10),
  sort: ProductSortSchema.default("default"),
  engine: SearchEngineSchema.default("taobao"),
  quality: SearchQualitySchema.default("strict"),
});
export type ProductSearchQuery = z.infer<typeof ProductSearchQuerySchema>;

/** Una specifica offerta conservata dentro un prodotto multi-motore. */
export const ProductOfferSchema = z.object({
  provider: SearchEngineSchema.or(z.string().min(1)),
  id: z.string(),
  url: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string(),
  vendor: z.string().nullable(),
  score: z.number().min(0).max(100),
});
export type ProductOffer = z.infer<typeof ProductOfferSchema>;

/**
 * Prodotto normalizzato, indipendente dal provider esterno. Il prezzo resta
 * nella valuta esposta dalla fonte (CNY per Taobao; valuta geolocalizzata per
 * gli scraper): non vengono usate conversioni EUR fornite da terzi.
 */
export const NormalizedProductSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  imageUrl: z.string().nullable(),
  originalPrice: z.number().nullable(),
  currency: z.string(),
  vendorName: z.string().nullable(),
  totalSales: z.number().nullable(),
  /** Voto medio 0-5, quando la fonte lo pubblica. */
  rating: z.number().min(0).max(5).nullable().optional(),
  /** Numero di recensioni, quando la fonte lo pubblica. */
  reviewCount: z.number().int().min(0).nullable().optional(),
  moq: z.number().nullable(),
  productUrl: z.string().nullable(),
  warnings: z.array(z.string()),
  sourceFeatures: z.array(z.string()).optional(),
  sourceSnippet: z.string().nullable().optional(),
  relevanceScore: z.number().min(0).max(100).nullable().optional(),
  sourceConfidenceScore: z.number().min(0).max(100).nullable().optional(),
  matchReasons: z.array(z.string()).optional(),
  matchWarnings: z.array(z.string()).optional(),
  canonicalKey: z.string().optional(),
  offers: z.array(ProductOfferSchema).optional(),
});
export type NormalizedProduct = z.infer<typeof NormalizedProductSchema>;

export const ProductSearchResultSchema = z.object({
  provider: z.string(),
  query: z.string(),
  framePosition: z.number().int(),
  frameSize: z.number().int(),
  sort: ProductSortSchema,
  totalCount: z.number().nullable(),
  hasMore: z.boolean().optional(),
  items: z.array(NormalizedProductSchema),
  diagnostics: z
    .object({
      quality: SearchQualitySchema,
      queryUsed: z.string(),
      sourceTotalCount: z.number().nullable(),
      fetchedCount: z.number().int().min(0),
      qualifiedCount: z.number().int().min(0),
      discardedCount: z.number().int().min(0),
      duplicatesRemoved: z.number().int().min(0),
      truncatedCount: z.number().int().min(0),
      threshold: z.number().min(0).max(100),
      processingMs: z.number().min(0),
    })
    .optional(),
});
export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>;

/** POST /api/v1/searches: una richiesta coordinata su più fonti. */
export const AggregateSearchRequestSchema = z.object({
  q: z.string().trim().min(1).max(200),
  engines: z
    .array(SearchEngineSchema)
    .min(1)
    .max(SEARCH_ENGINES.length)
    .default([...SEARCH_ENGINES]),
  frameSize: z.coerce.number().int().min(1).max(50).default(10),
  sort: ProductSortSchema.default("default"),
  quality: SearchQualitySchema.default("strict"),
}).superRefine((value, context) => {
  if (new Set(value.engines).size !== value.engines.length) {
    context.addIssue({
      code: "custom",
      path: ["engines"],
      message: "Ogni motore può essere indicato una sola volta",
    });
  }
});
export type AggregateSearchRequest = z.infer<
  typeof AggregateSearchRequestSchema
>;

export const AggregateSourceStatusSchema = z.object({
  engine: SearchEngineSchema,
  status: z.enum(["done", "error"]),
  durationMs: z.number().min(0),
  acceptedCount: z.number().int().min(0),
  diagnostics: ProductSearchResultSchema.shape.diagnostics.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type AggregateSourceStatus = z.infer<
  typeof AggregateSourceStatusSchema
>;

export const AggregateSearchResultSchema = z.object({
  searchId: z.string().uuid(),
  query: z.string(),
  quality: SearchQualitySchema,
  createdAt: z.string().datetime(),
  durationMs: z.number().min(0),
  sources: z.array(AggregateSourceStatusSchema),
  items: z.array(NormalizedProductSchema),
  diagnostics: z.object({
    engineCount: z.number().int().min(1),
    succeededCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    fetchedCount: z.number().int().min(0),
    acceptedBeforeMerge: z.number().int().min(0),
    uniqueCount: z.number().int().min(0),
    duplicatesMerged: z.number().int().min(0),
  }),
});
export type AggregateSearchResult = z.infer<
  typeof AggregateSearchResultSchema
>;
