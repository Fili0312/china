import {
  INQUIRY_DEFAULT_SHEET,
  type InquiryImportResult,
  type InquiryRow,
} from "@china/shared";
import * as XLSX from "xlsx";
import { buildInquiryQuery, cleanReferenceTitle } from "./inquiry-query";

/**
 * Lettura dei fogli di richiesta d'acquisto cinesi (`询价`).
 *
 * Le colonne vengono riconosciute dalle intestazioni cinesi, non dalla loro
 * posizione: i fogli reali spostano spesso le colonne e aggiungono note. Il
 * link prodotto sta in una colonna senza intestazione, quindi viene cercato
 * come collegamento ipertestuale o come URL scritto nella cella.
 */

/** Intestazioni riconosciute, per ciascun campo della richiesta. */
const COLUMN_HEADERS = {
  sequence: ["序号"],
  requestDate: ["申请日期"],
  name: ["品名", "名称", "物品名称"],
  spec: ["规格型号", "规格", "型号"],
  quantity: ["申请数量", "数量"],
  unit: ["单位"],
  supplier: ["供应商"],
  unitPrice: ["含税单价", "单价"],
  costCenter: ["成本中心"],
  purpose: ["用途"],
  notes: ["备注"],
  requester: ["申请人"],
  department: ["申请部门", "部门"],
} as const;

type ColumnKey = keyof typeof COLUMN_HEADERS;

/** Quante righe in testa vengono ispezionate cercando l'intestazione. */
const HEADER_SCAN_LIMIT = 30;

export class InquiryWorkbookError extends Error {
  constructor(
    message: string,
    readonly availableSheets: string[] = []
  ) {
    super(message);
    this.name = "InquiryWorkbookError";
  }
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const formatted = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return formatted.replace(/\s+/g, " ").trim();
}

function rawText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const formatted = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return formatted.trim();
}

function parseNumber(value: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullable(value: string): string | null {
  return value ? value : null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Riga di intestazione = la prima che contiene sia 品名 sia 规格型号. */
function findHeaderRow(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range
): { row: number; columns: Partial<Record<ColumnKey, number>> } {
  const limit = Math.min(range.e.r, range.s.r + HEADER_SCAN_LIMIT);
  for (let row = range.s.r; row <= limit; row += 1) {
    const columns: Partial<Record<ColumnKey, number>> = {};
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const text = cellText(
        sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
          | XLSX.CellObject
          | undefined
      );
      if (!text) continue;
      for (const [key, headers] of Object.entries(COLUMN_HEADERS) as [
        ColumnKey,
        readonly string[],
      ][]) {
        if (columns[key] === undefined && headers.includes(text)) {
          columns[key] = column;
        }
      }
    }
    if (columns.name !== undefined && columns.spec !== undefined) {
      return { row, columns };
    }
  }
  throw new InquiryWorkbookError(
    "Nel foglio non è stata trovata l'intestazione con le colonne 品名 e 规格型号."
  );
}

interface Reference {
  url: string | null;
  title: string | null;
}

/**
 * Cerca il prodotto già scelto: un collegamento ipertestuale nella riga,
 * altrimenti una cella che contiene direttamente un URL. Il testo della cella,
 * quando non è l'URL stesso, è il titolo cinese del prodotto di riferimento.
 */
function findReference(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  row: number,
  usedColumns: ReadonlySet<number>
): Reference {
  let fallback: Reference | null = null;
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    if (usedColumns.has(column)) continue;
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
      | (XLSX.CellObject & { l?: { Target?: string } })
      | undefined;
    if (!cell) continue;

    const text = rawText(cell);
    const target = cell.l?.Target?.trim();
    if (target && isHttpUrl(target)) {
      return {
        url: target,
        title: text && !isHttpUrl(text) ? cleanReferenceTitle(text) : null,
      };
    }
    if (!fallback && isHttpUrl(text)) {
      fallback = { url: text, title: null };
    }
  }
  return fallback ?? { url: null, title: null };
}

export interface ParseInquiryOptions {
  /** Nome del file, riportato nel risultato. */
  source: string;
  /** Foglio da leggere; default `询价`. */
  sheet?: string;
}

/** Legge un foglio di richieste e costruisce la query cinese di ogni riga. */
export function parseInquiryWorkbook(
  data: Buffer | ArrayBuffer,
  options: ParseInquiryOptions
): InquiryImportResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, { type: "buffer", cellHTML: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InquiryWorkbookError(`File Excel non leggibile: ${detail}`);
  }

  const availableSheets = workbook.SheetNames;
  const sheetName = options.sheet?.trim() || INQUIRY_DEFAULT_SHEET;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new InquiryWorkbookError(
      `Il foglio “${sheetName}” non esiste in questo file.`,
      availableSheets
    );
  }
  if (!sheet["!ref"]) {
    throw new InquiryWorkbookError(
      `Il foglio “${sheetName}” è vuoto.`,
      availableSheets
    );
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const { row: headerRow, columns } = findHeaderRow(sheet, range);
  const usedColumns = new Set(
    Object.values(columns).filter((value): value is number => value != null)
  );

  const read = (row: number, key: ColumnKey): string => {
    const column = columns[key];
    if (column === undefined) return "";
    return cellText(
      sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
        | XLSX.CellObject
        | undefined
    );
  };

  const rows: InquiryRow[] = [];
  let skippedRows = 0;

  for (let row = headerRow + 1; row <= range.e.r; row += 1) {
    const name = read(row, "name");
    const spec = read(row, "spec");
    if (!name) {
      // Righe di separazione, totali o note in coda al foglio.
      if (spec || read(row, "quantity")) skippedRows += 1;
      continue;
    }

    const built = buildInquiryQuery(name, spec);
    if (!built.query) {
      skippedRows += 1;
      continue;
    }

    const reference = findReference(sheet, range, row, usedColumns);
    rows.push({
      rowNumber: row + 1,
      sequence: nullable(read(row, "sequence")),
      name,
      spec,
      quantity: parseNumber(read(row, "quantity")),
      unit: nullable(read(row, "unit")),
      purpose: nullable(read(row, "purpose")),
      notes: nullable(read(row, "notes")),
      department: nullable(read(row, "department")),
      requester: nullable(read(row, "requester")),
      costCenter: nullable(read(row, "costCenter")),
      supplier: nullable(read(row, "supplier")),
      requestDate: nullable(read(row, "requestDate")),
      unitPrice: parseNumber(read(row, "unitPrice")),
      referenceUrl: reference.url,
      referenceTitle: reference.title,
      query: built.query,
      queryParts: built.parts,
      droppedTerms: built.dropped,
    });
  }

  return {
    source: options.source,
    sheet: sheetName,
    availableSheets,
    totalRows: rows.length,
    skippedRows,
    rows,
  };
}
