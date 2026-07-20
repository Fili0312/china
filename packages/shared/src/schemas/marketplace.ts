import { z } from "zod";

export const SearchLanguageSchema = z.enum(["en", "zh"]);
export type SearchLanguage = z.infer<typeof SearchLanguageSchema>;

/** Input di MarketplaceAdapter.search() */
export const SearchQuerySchema = z.object({
  text: z.string(),
  language: SearchLanguageSchema,
  maxResults: z.number().int().min(1).max(50).default(8),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const PriceSchema = z.object({
  value: z.number(),
  currency: z.string().default("USD"),
});
export type Price = z.infer<typeof PriceSchema>;

/**
 * Risultato "leggero" di una ricerca su marketplace.
 * `productId` è un identificativo opaco, scoped all'adapter
 * (per gli scraper è tipicamente l'URL del prodotto).
 */
export const ProductCandidateSchema = z.object({
  marketplace: z.string(),
  productId: z.string(),
  title: z.string(),
  url: z.string(),
  imageUrl: z.string().nullable().optional(),
  price: PriceSchema.nullable().optional(),
  moq: z.number().int().nullable().optional(),
  snippet: z.string().nullable().optional(),
});
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const PriceTierSchema = z.object({
  minQty: z.number().int(),
  price: PriceSchema,
});
export type PriceTier = z.infer<typeof PriceTierSchema>;

/** Risultato di MarketplaceAdapter.getDetails() */
export const ProductDetailsSchema = ProductCandidateSchema.extend({
  description: z.string().nullable().optional(),
  images: z.array(z.string()).default([]),
  priceTiers: z.array(PriceTierSchema).default([]),
  variants: z
    .array(
      z.object({
        name: z.string(),
        options: z.array(z.string()),
      })
    )
    .default([]),
  attributes: z.record(z.string(), z.string()).default({}),
});
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

/**
 * Output strutturato del matching AI: i migliori 2-3 candidati per un articolo.
 */
export const CandidateSelectionSchema = z.object({
  candidateId: z
    .string()
    .describe("id del candidato scelto (campo 'id' fornito in input)"),
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Fiducia che il prodotto corrisponda alla richiesta (0-1)"),
  reason: z
    .string()
    .describe("Motivazione breve in italiano della scelta"),
  variant: z
    .string()
    .nullable()
    .describe(
      "Variante consigliata (es. 'colore: rosso, taglia: XL') se deducibile, altrimenti null"
    ),
});
export type CandidateSelection = z.infer<typeof CandidateSelectionSchema>;

export const MatchResultSchema = z.object({
  selections: z
    .array(CandidateSelectionSchema)
    .describe("I migliori 2-3 candidati in ordine di preferenza; vuoto se nessuno è adeguato"),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;
