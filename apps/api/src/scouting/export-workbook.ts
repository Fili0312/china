import type { ImportJobResults, ScoutingSelection } from "@china/shared";
import * as XLSX from "xlsx";

/**
 * Esportazione dei risultati in Excel.
 *
 * Quattro fogli invece di uno solo: i finalisti servono per decidere, gli
 * scartati per capire **perché** un prodotto non è stato proposto, l'elenco
 * completo per controllare a mano, il riepilogo per sapere quali fonti hanno
 * risposto. Le colonne originali del file di partenza restano in testa a ogni
 * riga, così il foglio esportato si affianca a quello di richiesta senza
 * doverli riconciliare a mano.
 */

/** Intestazioni delle colonne che descrivono il prodotto trovato. */
const PRODUCT_HEADERS = [
  "Marketplace",
  "Titolo",
  "Prezzo",
  "Valuta",
  "MOQ",
  "Stock",
  "Venditore",
  "Voto",
  "Recensioni",
  "Vendite",
  "Pertinenza",
  "Link",
  "Query che l'ha trovato",
  "Ultimo controllo",
  "Campi cambiati",
];

function productCells(selection: ScoutingSelection): unknown[] {
  const product = selection.product;
  return [
    product.engine,
    product.title,
    product.price,
    product.currency,
    product.moq,
    product.stock,
    product.vendorName,
    product.rating,
    product.reviewCount,
    product.totalSales,
    product.relevanceScore,
    product.url,
    product.foundQuery,
    product.lastCheckedAt.slice(0, 19).replace("T", " "),
    product.changedFields.join(", "),
  ];
}

/** Larghezze di colonna ragionevoli: senza, il titolo è illeggibile. */
function widths(sizes: number[]): XLSX.ColInfo[] {
  return sizes.map((width) => ({ wch: width }));
}

export function buildExportWorkbook(results: ImportJobResults): Buffer {
  const workbook = XLSX.utils.book_new();

  // Le intestazioni delle colonne originali non sono note qui (dipendono dal
  // file caricato): si numerano, ma i valori restano quelli veri.
  const originalColumns = Math.max(
    0,
    ...results.rows.map((row) => row.cells.length)
  );
  const originalHeaders = Array.from(
    { length: originalColumns },
    (_, index) => `File col. ${XLSX.utils.encode_col(index)}`
  );

  const rowHeaders = ["Riga", "Richiesta", "Query", "Impronta", "Riusata"];

  /** Foglio dei prodotti proposti o scartati. */
  const productSheet = (
    pick: (row: ImportJobResults["rows"][number]) => ScoutingSelection[],
    extraHeaders: string[],
    extraCells: (selection: ScoutingSelection) => unknown[]
  ): XLSX.WorkSheet => {
    const data: unknown[][] = [
      [...rowHeaders, ...originalHeaders, ...extraHeaders, ...PRODUCT_HEADERS],
    ];
    for (const row of results.rows) {
      for (const selection of pick(row)) {
        data.push([
          row.rowNumber,
          row.displayName,
          row.searchQuery,
          row.fingerprint,
          row.reused ? "sì" : "no",
          ...Array.from(
            { length: originalColumns },
            (_, index) => row.cells[index] ?? ""
          ),
          ...extraCells(selection),
          ...productCells(selection),
        ]);
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet["!cols"] = widths([
      6, 26, 26, 34, 8,
      ...Array.from({ length: originalColumns }, () => 16),
      ...extraHeaders.map(() => 14),
      14, 52, 10, 8, 8, 8, 24, 7, 10, 10, 11, 46, 26, 19, 20,
    ]);
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    return sheet;
  };

  XLSX.utils.book_append_sheet(
    workbook,
    productSheet(
      (row) => row.finalists.filter((entry) => entry.outcome === "FINALIST"),
      ["Posizione", "Punteggio", "Punteggio riusato", "Motivazione"],
      (selection) => [
        selection.rank,
        selection.score,
        selection.scoreReused ? "sì" : "no",
        selection.aiRationale ?? "",
      ]
    ),
    "Finalisti"
  );

  XLSX.utils.book_append_sheet(
    workbook,
    productSheet(
      (row) => row.finalists.filter((entry) => entry.outcome === "SHORTLISTED"),
      ["Posizione", "Punteggio", "Perché non proposto"],
      (selection) => [
        selection.rank,
        selection.score,
        selection.rejectionReason ?? "",
      ]
    ),
    "In elenco"
  );

  XLSX.utils.book_append_sheet(
    workbook,
    productSheet(
      (row) => row.rejected,
      ["Codice scarto", "Motivo dello scarto", "Punteggio"],
      (selection) => [
        selection.rejectionCode ?? "",
        selection.rejectionReason ?? "",
        selection.score,
      ]
    ),
    "Scartati"
  );

  // --- Riepilogo -----------------------------------------------------------
  const summary: unknown[][] = [
    ["File", results.job.fileName],
    ["Stato", results.job.status],
    ["Righe totali", results.job.totalRows],
    ["Righe elaborate", results.job.processedRows],
    ["Righe riusate", results.job.reusedRows],
    ["Righe fallite", results.job.failedRows],
    ["Marketplace", results.job.engines.join(", ")],
    ["Precisione", results.job.quality],
    ["Crediti Piloterr", results.job.creditsSpent],
    ["Avviato", results.job.startedAt ?? ""],
    ["Concluso", results.job.finishedAt ?? ""],
    [],
    ["Riga", "Marketplace", "Stato", "Prodotti", "Durata (s)", "Errore"],
  ];
  for (const row of results.rows) {
    for (const engine of row.engines) {
      summary.push([
        row.rowNumber,
        engine.engine,
        engine.status,
        engine.acceptedCount,
        Math.round(engine.durationMs / 100) / 10,
        engine.error ?? "",
      ]);
    }
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summary);
  summarySheet["!cols"] = widths([22, 18, 14, 10, 12, 60]);
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Riepilogo");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Nome del file scaricato, ricavato da quello di partenza. */
export function exportFileName(originalName: string): string {
  const base = originalName.replace(/\.[^.]+$/, "") || "scouting";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-scouting-${stamp}.xlsx`;
}

/**
 * Intestazione `Content-Disposition` con un nome file di qualsiasi lingua.
 *
 * Un header HTTP accetta solo ASCII: mettere `副本博工询价-scouting.xlsx` nel
 * `filename=` fa fallire la risposta con `ERR_INVALID_CHAR`, ed è il motivo
 * per cui l'export di un foglio cinese restituiva 500 — cioè non ha mai
 * funzionato proprio sui file per cui esiste questa piattaforma.
 *
 * Si mandano quindi due nomi, come previsto dalla RFC 6266: `filename=` con
 * una versione ASCII di ripiego, e `filename*=` con quello vero codificato in
 * UTF-8. I browser usano il secondo; chi non lo capisce ha comunque un nome
 * valido invece di un errore.
 */
export function contentDisposition(fileName: string): string {
  const asciiFallback =
    fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "scouting.xlsx";
  return (
    `attachment; filename="${asciiFallback}"; ` +
    `filename*=UTF-8''${encodeURIComponent(fileName)}`
  );
}
