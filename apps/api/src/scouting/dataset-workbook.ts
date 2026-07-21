import type {
  DatasetColumn,
  DatasetField,
  DatasetFormat,
  DatasetMapping,
  DatasetRow,
} from "@china/shared";
import * as XLSX from "xlsx";

/**
 * Lettura di un file di richieste in formato arbitrario.
 *
 * A differenza di `inquiry/` — che conosce un solo foglio, quello 博工 `询价`,
 * con intestazioni cinesi fisse — qui il file è sconosciuto: può essere un
 * Excel, un XLS storico o un CSV, in qualsiasi lingua, con o senza
 * intestazione. Il modulo quindi **propone** una mappatura e lascia all'utente
 * l'ultima parola, e conserva sempre la riga originale per intero.
 */

/** Quante righe in testa vengono ispezionate cercando l'intestazione. */
const HEADER_SCAN_LIMIT = 25;

/** Valori di esempio mostrati per colonna nell'anteprima. */
const SAMPLE_SIZE = 3;

/** Quante righe di dati vengono lette per calcolare le statistiche colonna. */
const PROFILE_ROWS = 200;

export class DatasetWorkbookError extends Error {
  constructor(
    message: string,
    readonly availableSheets: string[] = []
  ) {
    super(message);
    this.name = "DatasetWorkbookError";
  }
}

/**
 * Sinonimi di intestazione per ciascun campo, nelle lingue che compaiono nei
 * fogli reali: cinese (fogli di richiesta), italiano (uso interno), inglese
 * (fogli ricevuti dai clienti).
 */
const HEADER_SYNONYMS: Record<Exclude<DatasetField, "ignore">, string[]> = {
  name: [
    "品名",
    "名称",
    "物品名称",
    "产品名称",
    "商品名称",
    "nome",
    "prodotto",
    "articolo",
    "descrizione",
    "denominazione",
    "name",
    "product",
    "product name",
    "item",
    "description",
    "designation",
  ],
  spec: [
    "规格型号",
    "规格",
    "型号",
    "技术参数",
    "参数",
    "specifiche",
    "specifica",
    "caratteristiche",
    "misure",
    "dimensioni",
    "spec",
    "specs",
    "specification",
    "specifications",
    "size",
    "dimensions",
    "model",
    "type",
  ],
  // Volutamente distinti da quelli di `name`: `品名`/`名称` restano il nome
  // della richiesta, `标题` è il titolo di un prodotto già individuato.
  title: [
    "标题",
    "商品标题",
    "产品标题",
    "参考商品",
    "titolo",
    "titolo prodotto",
    "title",
    "product title",
    "listing",
  ],
  category: [
    "类别",
    "分类",
    "品类",
    "categoria",
    "famiglia",
    "gruppo",
    "category",
    "family",
    "group",
  ],
  brand: ["品牌", "厂牌", "marca", "brand", "manufacturer", "produttore"],
  model: ["型号", "货号", "编码", "物料编码", "codice", "codice articolo", "sku", "code", "part number", "p/n", "mpn"],
  quantity: [
    "申请数量",
    "数量",
    "采购数量",
    "quantita",
    "quantità",
    "qta",
    "q.tà",
    "pezzi",
    "quantity",
    "qty",
    "amount",
  ],
  unit: ["单位", "计量单位", "unita", "unità", "um", "u.m.", "unit", "uom"],
  material: ["材质", "材料", "materiale", "material"],
  certifications: ["认证", "证书", "certificazioni", "certificazione", "certification", "certifications", "compliance"],
  targetPrice: [
    "含税单价",
    "单价",
    "目标价",
    "参考价",
    "prezzo",
    "prezzo obiettivo",
    "prezzo unitario",
    "target price",
    "unit price",
    "price",
    "budget",
  ],
  notes: ["备注", "说明", "用途", "note", "notes", "remark", "remarks", "comment", "comments"],
  referenceUrl: ["链接", "网址", "参考链接", "link", "url", "riferimento", "reference", "reference link"],
};

/** Normalizza un'intestazione per il confronto con i sinonimi. */
function headerKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .replace(/[()（）:：*]/g, "")
    .trim();
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const formatted = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return formatted.replace(/\s+/g, " ").trim();
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isNumeric(value: string): boolean {
  return /^-?\d+(?:[.,]\d+)?$/.test(value.replace(/\s/g, ""));
}

export function formatFromFileName(fileName: string): DatasetFormat {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "csv" || extension === "txt") return "csv";
  if (extension === "xls") return "xls";
  if (extension === "xlsm") return "xlsm";
  if (extension === "xlsx") return "xlsx";
  throw new DatasetWorkbookError(
    `Formato non supportato: “.${extension}”. Sono accettati .xlsx, .xls, .xlsm e .csv.`
  );
}

/**
 * Legge un CSV rispettandone la codifica.
 *
 * `xlsx` interpreta un buffer CSV come cp1252 se non gli si dice altro: un
 * file UTF-8 diventa allora `QuantitÃ ` e nessuna intestazione viene più
 * riconosciuta. Si prova quindi prima UTF-8 (che include l'ASCII puro) e si
 * ripiega su GBK, la codifica dei CSV esportati dai gestionali cinesi.
 */
function readCsv(data: Buffer): XLSX.WorkBook {
  const withoutBom =
    data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
      ? data.subarray(3)
      : data;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
    return XLSX.read(text, { type: "string" });
  } catch {
    return XLSX.read(withoutBom, { type: "buffer", codepage: 936 });
  }
}

/**
 * Riga di intestazione: la prima con almeno due celle non vuote in cui il
 * testo prevale sui numeri. Una riga di soli numeri è già un dato, non
 * un'intestazione.
 */
function findHeaderRow(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range
): number | null {
  const limit = Math.min(range.e.r, range.s.r + HEADER_SCAN_LIMIT);
  let best: { row: number; score: number } | null = null;

  for (let row = range.s.r; row <= limit; row += 1) {
    let filled = 0;
    let textual = 0;
    let recognized = 0;
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const text = cellText(
        sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
          | XLSX.CellObject
          | undefined
      );
      if (!text) continue;
      filled += 1;
      if (!isNumeric(text) && !isHttpUrl(text)) textual += 1;
      if (matchHeaderField(text)) recognized += 1;
    }
    if (filled < 2 || textual < filled / 2) continue;
    // Un'intestazione riconosciuta vale più di una riga generica di testo.
    const score = recognized * 10 + textual;
    if (!best || score > best.score) best = { row, score };
    // Una riga con almeno due intestazioni note è certamente quella giusta.
    if (recognized >= 2) return row;
  }
  return best?.row ?? null;
}

/** Campo suggerito per un'intestazione, o `null` se non riconosciuta. */
function matchHeaderField(header: string): DatasetField | null {
  const key = headerKey(header);
  if (!key) return null;

  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [
    Exclude<DatasetField, "ignore">,
    string[],
  ][]) {
    if (synonyms.some((synonym) => headerKey(synonym) === key)) return field;
  }
  // Corrispondenza parziale: `品名/规格` o `Descrizione prodotto`.
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [
    Exclude<DatasetField, "ignore">,
    string[],
  ][]) {
    if (
      synonyms.some((synonym) => {
        const normalized = headerKey(synonym);
        return normalized.length >= 3 && key.includes(normalized);
      })
    ) {
      return field;
    }
  }
  return null;
}

interface ColumnProfile {
  filled: number;
  urls: number;
  /** Celle con un collegamento ipertestuale, anche se il testo è un titolo. */
  links: number;
  numbers: number;
  totalLength: number;
  samples: string[];
}

/**
 * Suggerisce un campo osservando i valori quando l'intestazione non basta.
 * Serve per i file senza intestazione e per le colonne senza titolo, che nei
 * fogli reali contengono spesso proprio il link del prodotto di riferimento.
 */
function suggestFromValues(
  profile: ColumnProfile
): { field: DatasetField; reason: string } | null {
  if (profile.filled === 0) return null;
  if (profile.urls >= Math.max(1, profile.filled * 0.6)) {
    return { field: "referenceUrl", reason: "la colonna contiene link" };
  }
  // Nei fogli reali il prodotto già scelto sta in una colonna senza
  // intestazione, in cui il testo è il titolo cinese e l'URL è nascosto nel
  // collegamento ipertestuale della cella.
  if (profile.links >= Math.max(1, profile.filled * 0.6)) {
    return {
      field: "referenceUrl",
      reason: "le celle contengono collegamenti ipertestuali",
    };
  }
  return null;
}

export interface ParseDatasetOptions {
  fileName: string;
  format: DatasetFormat;
  /**
   * Foglio da leggere; se assente si usa il primo del file.
   *
   * `ALL_SHEETS` (`*`) li legge **tutti** e li unisce. È il caso normale dei
   * fogli di richiesta reali: le richieste sono divise per reparto su fogli
   * diversi con le stesse colonne, e importarne uno solo lascia fuori la
   * maggior parte del lavoro senza dirlo.
   */
  sheet?: string;
  /** Righe restituite nell'anteprima. */
  previewLimit: number;
}

/** Valore di `sheet` che chiede di leggere tutti i fogli del file. */
export const ALL_SHEETS = "*";

export interface ParsedDataset {
  sheet: string;
  availableSheets: string[];
  headerRowNumber: number | null;
  columns: DatasetColumn[];
  /** Tutte le righe dati del foglio, con i valori originali. */
  rows: DatasetRow[];
  /** Sottoinsieme mostrato in anteprima. */
  previewRows: DatasetRow[];
  suggestedMapping: DatasetMapping[];
  warnings: string[];
}

/** Legge un singolo foglio già individuato nel file. */
function parseSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  previewLimit: number
): ParsedDataset {
  const availableSheets = workbook.SheetNames;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new DatasetWorkbookError(
      `Il foglio “${sheetName}” non esiste in questo file.`,
      availableSheets
    );
  }
  if (!sheet["!ref"]) {
    throw new DatasetWorkbookError(
      `Il foglio “${sheetName}” è vuoto.`,
      availableSheets
    );
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const headerRow = findHeaderRow(sheet, range);
  const firstDataRow = headerRow == null ? range.s.r : headerRow + 1;
  const warnings: string[] = [];
  if (headerRow == null) {
    warnings.push(
      "Nessuna riga di intestazione riconosciuta: le colonne sono indicate " +
        "con la lettera Excel e vanno mappate a mano."
    );
  }

  // Profilo delle colonne sulle prime righe di dati.
  const profiles = new Map<number, ColumnProfile>();
  const profileLimit = Math.min(range.e.r, firstDataRow + PROFILE_ROWS - 1);
  for (let row = firstDataRow; row <= profileLimit; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
        | (XLSX.CellObject & { l?: { Target?: string } })
        | undefined;
      const text = cellText(cell);
      if (!text) continue;
      const profile = profiles.get(column) ?? {
        filled: 0,
        urls: 0,
        links: 0,
        numbers: 0,
        totalLength: 0,
        samples: [],
      };
      profile.filled += 1;
      profile.totalLength += text.length;
      if (isHttpUrl(text)) profile.urls += 1;
      if (isHttpUrl(cell?.l?.Target?.trim() ?? "")) profile.links += 1;
      if (isNumeric(text)) profile.numbers += 1;
      if (profile.samples.length < SAMPLE_SIZE) profile.samples.push(text);
      profiles.set(column, profile);
    }
  }

  const columns: DatasetColumn[] = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const header =
      headerRow == null
        ? ""
        : cellText(
            sheet[XLSX.utils.encode_cell({ r: headerRow, c: column })] as
              | XLSX.CellObject
              | undefined
          );
    const profile = profiles.get(column) ?? {
      filled: 0,
      urls: 0,
      links: 0,
      numbers: 0,
      totalLength: 0,
      samples: [],
    };
    // Una colonna sempre vuota non va proposta né mostrata: è rumore.
    if (!header && profile.filled === 0) continue;

    const fromHeader = header ? matchHeaderField(header) : null;
    const fromValues = fromHeader ? null : suggestFromValues(profile);
    columns.push({
      index: column,
      letter: XLSX.utils.encode_col(column),
      header,
      suggestedField: fromHeader ?? fromValues?.field ?? null,
      suggestionReason: fromHeader
        ? `intestazione “${header}” riconosciuta`
        : (fromValues?.reason ?? null),
      filledCount: profile.filled,
      sampleValues: profile.samples,
    });
  }

  if (columns.length === 0) {
    throw new DatasetWorkbookError(
      `Il foglio “${sheetName}” non contiene colonne con dati.`,
      availableSheets
    );
  }

  // Senza un nome prodotto non si può cercare nulla: in mancanza di
  // un'intestazione riconosciuta si propone la colonna testuale più ricca.
  if (!columns.some((column) => column.suggestedField === "name")) {
    const fallback = columns
      .filter(
        (column) =>
          column.filledCount > 0 &&
          !column.suggestedField &&
          (profiles.get(column.index)?.numbers ?? 0) <
            (profiles.get(column.index)?.filled ?? 0) / 2
      )
      .sort((left, right) => {
        const leftProfile = profiles.get(left.index)!;
        const rightProfile = profiles.get(right.index)!;
        return (
          rightProfile.totalLength / Math.max(1, rightProfile.filled) -
          leftProfile.totalLength / Math.max(1, leftProfile.filled)
        );
      })[0];
    if (fallback) {
      fallback.suggestedField = "name";
      fallback.suggestionReason =
        "colonna testuale più descrittiva: proposta come nome prodotto";
      warnings.push(
        `Nessuna colonna “nome prodotto” riconosciuta: è stata proposta la ` +
          `colonna ${fallback.letter}. Verificala prima di avviare lo scouting.`
      );
    }
  }

  // Colonne già destinate ad **altri** campi: un URL che vi compare è un dato
  // di quel campo, non il link del prodotto. La colonna dei link, invece, è
  // esattamente quella da cui leggerlo.
  const usedColumns = new Set(
    columns
      .filter(
        (column) =>
          column.suggestedField &&
          column.suggestedField !== "ignore" &&
          column.suggestedField !== "referenceUrl"
      )
      .map((column) => column.index)
  );

  const rows: DatasetRow[] = [];
  for (let row = firstDataRow; row <= range.e.r; row += 1) {
    const cells: string[] = [];
    let hyperlink: string | null = null;
    let hasContent = false;

    for (const column of columns) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column.index })] as
        | (XLSX.CellObject & { l?: { Target?: string } })
        | undefined;
      const text = cellText(cell);
      cells.push(text);
      if (text) hasContent = true;
      // Il link del prodotto di riferimento sta spesso in una colonna senza
      // intestazione, come collegamento ipertestuale invece che come testo.
      if (!hyperlink) {
        const target = cell?.l?.Target?.trim();
        if (target && isHttpUrl(target)) hyperlink = target;
        else if (isHttpUrl(text) && !usedColumns.has(column.index)) {
          hyperlink = text;
        }
      }
    }

    if (!hasContent) continue;
    rows.push({
      rowNumber: row + 1,
      sheetName,
      sheetRowNumber: row + 1,
      cells,
      hyperlink,
    });
  }

  const suggestedMapping: DatasetMapping[] = columns
    .filter(
      (column): column is DatasetColumn & { suggestedField: DatasetField } =>
        column.suggestedField != null && column.suggestedField !== "ignore"
    )
    .map((column) => ({ columnIndex: column.index, field: column.suggestedField }));

  return {
    sheet: sheetName,
    availableSheets,
    headerRowNumber: headerRow == null ? null : headerRow + 1,
    columns,
    rows,
    previewRows: rows.slice(0, previewLimit),
    suggestedMapping,
    warnings,
  };
}


/**
 * Legge un file di richieste: un foglio, oppure tutti.
 *
 * Con `sheet: ALL_SHEETS` i fogli vengono uniti in un solo dataset. È il caso
 * dei fogli di richiesta reali, dove le richieste sono divise per reparto su
 * fogli con le stesse colonne: leggerne uno solo lasciava fuori la maggior
 * parte del lavoro — e lo faceva in silenzio, che è la parte peggiore.
 *
 * L'unione richiede che i fogli condividano il **numero di colonne mappabili**.
 * Se un foglio ha una struttura diversa non viene mescolato agli altri: entra
 * comunque nel dataset, ma con un avvertimento, perché una colonna che slitta
 * di una posizione produce richieste sbagliate senza sembrare un errore.
 */
export function parseDataset(
  data: Buffer,
  options: ParseDatasetOptions
): ParsedDataset {
  let workbook: XLSX.WorkBook;
  try {
    workbook =
      options.format === "csv"
        ? readCsv(data)
        : XLSX.read(data, { type: "buffer", cellHTML: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DatasetWorkbookError(`File non leggibile: ${detail}`);
  }

  const availableSheets = workbook.SheetNames;
  if (availableSheets.length === 0) {
    throw new DatasetWorkbookError("Il file non contiene fogli.");
  }

  const wanted = options.sheet?.trim();
  if (wanted !== ALL_SHEETS) {
    const sheetName = wanted || availableSheets[0]!;
    if (!workbook.Sheets[sheetName]) {
      throw new DatasetWorkbookError(
        `Il foglio “${sheetName}” non esiste in questo file.`,
        availableSheets
      );
    }
    return parseSheet(workbook, sheetName, options.previewLimit);
  }

  // Tutti i fogli. Quelli vuoti o illeggibili non fermano gli altri: si
  // annotano e si va avanti, perché in un file da quattro reparti un foglio
  // di riepilogo vuoto è normale.
  const parsed: ParsedDataset[] = [];
  const warnings: string[] = [];
  for (const sheetName of availableSheets) {
    try {
      const sheet = parseSheet(workbook, sheetName, options.previewLimit);
      if (sheet.rows.length === 0) {
        warnings.push(`Foglio “${sheetName}”: nessuna riga con dati, ignorato.`);
        continue;
      }
      parsed.push(sheet);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "foglio non leggibile";
      warnings.push(`Foglio “${sheetName}” ignorato: ${detail}`);
    }
  }

  if (parsed.length === 0) {
    throw new DatasetWorkbookError(
      "Nessun foglio del file contiene righe leggibili.",
      availableSheets
    );
  }
  if (parsed.length === 1) {
    const only = parsed[0]!;
    return { ...only, warnings: [...only.warnings, ...warnings] };
  }

  // Le colonne le detta il foglio con più righe: è quello su cui l'euristica
  // ha avuto più dati per decidere.
  const reference = [...parsed].sort((a, b) => b.rows.length - a.rows.length)[0]!;
  const referenceColumns = reference.columns.length;

  const rows: DatasetRow[] = [];
  let rowNumber = 0;
  for (const sheet of parsed) {
    if (sheet.columns.length !== referenceColumns) {
      warnings.push(
        `Foglio “${sheet.sheet}”: ${sheet.columns.length} colonne invece di ` +
          `${referenceColumns} come “${reference.sheet}”. Le righe sono state ` +
          "importate ugualmente: controlla la mappatura prima di avviare."
      );
    }
    for (const row of sheet.rows) {
      rowNumber += 1;
      rows.push({ ...row, rowNumber });
    }
  }

  warnings.push(
    `Importati ${parsed.length} fogli (${parsed
      .map((sheet) => `${sheet.sheet}: ${sheet.rows.length}`)
      .join(", ")}) per un totale di ${rows.length} righe.`
  );

  return {
    sheet: parsed.map((sheet) => sheet.sheet).join(" + "),
    availableSheets,
    headerRowNumber: reference.headerRowNumber,
    columns: reference.columns,
    rows,
    previewRows: rows.slice(0, options.previewLimit),
    suggestedMapping: reference.suggestedMapping,
    warnings: [...reference.warnings, ...warnings],
  };
}
