import { z } from "zod";

/**
 * Un articolo estratto dal messaggio libero dell'utente.
 * Output strutturato del passo di parsing (Claude).
 */
export const ParsedItemSchema = z.object({
  name: z.string().describe("Nome del prodotto, normalizzato e conciso"),
  quantity: z
    .number()
    .int()
    .min(1)
    .describe("Quantità richiesta; 1 se non specificata"),
  color: z.string().nullable().describe("Colore richiesto, se presente"),
  size: z
    .string()
    .nullable()
    .describe("Misura/taglia richiesta, se presente (es. '50x70cm', 'XL')"),
  attributes: z
    .record(z.string(), z.string())
    .describe(
      "Altre caratteristiche chiave-valore (materiale, voltaggio, capacità, ...). Oggetto vuoto se nessuna."
    ),
  notes: z
    .string()
    .nullable()
    .describe("Note libere dell'utente su questo articolo"),
});
export type ParsedItem = z.infer<typeof ParsedItemSchema>;

export const ParsedRequestSchema = z.object({
  items: z.array(ParsedItemSchema).describe("Tutti gli articoli richiesti"),
});
export type ParsedRequest = z.infer<typeof ParsedRequestSchema>;

/**
 * Query di ricerca generate per un articolo (Claude).
 */
export const ItemQueriesSchema = z.object({
  index: z.number().int().describe("Indice dell'articolo nella lista di input"),
  queryEn: z
    .string()
    .describe("Query di ricerca in inglese ottimizzata per marketplace B2B"),
  queryZh: z
    .string()
    .describe("Query di ricerca in cinese semplificato per marketplace cinesi"),
});
export type ItemQueries = z.infer<typeof ItemQueriesSchema>;

export const GeneratedQueriesSchema = z.object({
  queries: z.array(ItemQueriesSchema),
});
export type GeneratedQueries = z.infer<typeof GeneratedQueriesSchema>;

/** Body per POST /api/quotes */
export const CreateQuoteRequestSchema = z.object({
  text: z.string().min(3, "Il messaggio è vuoto"),
  markupPct: z.number().min(0).max(1000).optional(),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;
