import { z } from "zod";

/**
 * Contratti dell'importazione richieste d'acquisto (foglio `询价`).
 *
 * Le righe arrivano da fogli di richiesta cinesi: la query di ricerca viene
 * costruita dal testo cinese originale (品名 + 规格型号), senza passare da una
 * traduzione italiana e da una riconversione, che perderebbero codici,
 * modelli, misure e materiali.
 */

/** Nome del foglio usato di default dai fogli di richiesta 博工. */
export const INQUIRY_DEFAULT_SHEET = "询价";

/**
 * Una riga della richiesta. I campi amministrativi restano disponibili per la
 * scheda in interfaccia, ma non entrano mai nella query di ricerca.
 */
export const InquiryRowSchema = z.object({
  /** Riga del foglio Excel (1-based), per ritrovare la richiesta nel file. */
  rowNumber: z.number().int().min(1),
  /** 序号 */
  sequence: z.string().nullable(),
  /** 品名 — nome prodotto cinese originale. */
  name: z.string(),
  /** 规格型号 — specifiche/modello cinesi originali. */
  spec: z.string(),
  /** 申请数量 — solo informativo, escluso dalla query. */
  quantity: z.number().nullable(),
  /** 单位 */
  unit: z.string().nullable(),
  /** 用途 — solo informativo. */
  purpose: z.string().nullable(),
  /** 备注 */
  notes: z.string().nullable(),
  /** 申请部门 — amministrativo, escluso dalla query. */
  department: z.string().nullable(),
  /** 申请人 — amministrativo, escluso dalla query. */
  requester: z.string().nullable(),
  /** 成本中心 — amministrativo, escluso dalla query. */
  costCenter: z.string().nullable(),
  /** 供应商 — escluso dalla query. */
  supplier: z.string().nullable(),
  /** 申请日期 — escluso dalla query. */
  requestDate: z.string().nullable(),
  /** 含税单价 — prezzo di riferimento indicato nella richiesta. */
  unitPrice: z.number().nullable(),
  /** Link prodotto già presente nel file, da aprire prima di cercare. */
  referenceUrl: z.string().nullable(),
  /** Titolo cinese del prodotto di riferimento, quando il file lo riporta. */
  referenceTitle: z.string().nullable(),
  /** Query cinese generata, usata così com'è sui marketplace. */
  query: z.string(),
  /** Pezzi che compongono la query, nell'ordine in cui sono stati uniti. */
  queryParts: z.array(z.string()),
  /** Termini amministrativi rimossi, mostrati per trasparenza. */
  droppedTerms: z.array(z.string()),
});
export type InquiryRow = z.infer<typeof InquiryRowSchema>;

export const InquiryImportResultSchema = z.object({
  /** Nome del file di origine. */
  source: z.string(),
  /** Foglio effettivamente letto. */
  sheet: z.string(),
  /** Fogli disponibili nel file, per segnalare un foglio sbagliato. */
  availableSheets: z.array(z.string()),
  /** Righe dati trovate sotto l'intestazione. */
  totalRows: z.number().int().min(0),
  /** Righe scartate perché prive di 品名. */
  skippedRows: z.number().int().min(0),
  rows: z.array(InquiryRowSchema),
});
export type InquiryImportResult = z.infer<typeof InquiryImportResultSchema>;

/** Un file di richiesta disponibile lato server. */
export const InquirySourceSchema = z.object({
  name: z.string(),
  sizeBytes: z.number().int().min(0),
  modifiedAt: z.string(),
});
export type InquirySource = z.infer<typeof InquirySourceSchema>;

/** Query string di GET /api/inquiry/rows. */
export const InquiryRowsQuerySchema = z.object({
  source: z.string().trim().min(1).max(255),
  sheet: z.string().trim().min(1).max(120).default(INQUIRY_DEFAULT_SHEET),
});
export type InquiryRowsQuery = z.infer<typeof InquiryRowsQuerySchema>;

/** Query string di POST /api/inquiry/import (corpo = file binario). */
export const InquiryImportQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(255).default("richiesta.xls"),
  sheet: z.string().trim().min(1).max(120).default(INQUIRY_DEFAULT_SHEET),
});
export type InquiryImportQuery = z.infer<typeof InquiryImportQuerySchema>;
