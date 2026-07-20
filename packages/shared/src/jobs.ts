/**
 * Nomi delle code BullMQ e payload dei job.
 * Il fan-out/fan-in è realizzato con BullMQ Flows:
 *
 *   quote-assemble (root, fan-in finale)
 *   └─ item-select (per articolo: matching AI + dettagli)      [fan-in per articolo]
 *      └─ item-search (per articolo × marketplace)             [fan-out]
 *
 * Il job quote-parse è separato: crea gli articoli e POI costruisce il flow,
 * perché il numero di figli è noto solo dopo il parsing.
 */
export const QUEUES = {
  parse: "quote-parse",
  search: "item-search",
  select: "item-select",
  assemble: "quote-assemble",
} as const;

export interface ParseJobData {
  requestId: string;
}

export interface SearchJobData {
  requestId: string;
  itemId: string;
  marketplace: string;
}

export interface SelectJobData {
  requestId: string;
  itemId: string;
}

export interface AssembleJobData {
  requestId: string;
}

/** Canale Redis pub/sub per gli eventi di avanzamento di una richiesta. */
export const eventsChannel = (requestId: string) => `china:events:${requestId}`;

export type QuoteEvent =
  | {
      type: "request_status";
      requestId: string;
      status: string;
      error?: string;
      ts: string;
    }
  | {
      type: "item_status";
      requestId: string;
      itemId: string;
      status: string;
      error?: string;
      ts: string;
    }
  | { type: "log"; requestId: string; message: string; ts: string }
  | { type: "quote_ready"; requestId: string; ts: string };
