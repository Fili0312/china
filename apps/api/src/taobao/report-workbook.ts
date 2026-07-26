import type { TaobaoCandidate, TaobaoJobResults } from "@china/shared";
import * as XLSX from "xlsx";
import { t } from "../i18n/messages";
import { exportFileName } from "./export-workbook";

/**
 * Il report per il cliente: un foglio solo, pronto da inoltrare.
 *
 * È un documento diverso dall'export dei risultati. L'export serve a chi fa
 * scouting — tutti i candidati, i requisiti, gli errori. Il report serve a chi
 * **vende**: una riga per richiesta, la quantità chiesta dal foglio originale,
 * i 3 migliori prodotti con link, e i prezzi già ricaricati della percentuale
 * scelta al momento del download.
 *
 * Il ricarico si applica al momento della generazione, non viene salvato: lo
 * stesso job può produrre un report al 10% per un cliente e al 25% per un
 * altro senza toccare i dati.
 */

/** Quanti prodotti entrano nel report per ogni richiesta. */
const TOP_N = 3;

export interface ReportOptions {
  /** Percentuale di ricarico sul prezzo (0 = prezzi originali). */
  markupPct: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Prezzo effettivo di un candidato: la promozione, se c'è, è ciò che si paga. */
export function effectivePrice(candidate: TaobaoCandidate): number | null {
  return candidate.product.promotionPrice ?? candidate.product.price;
}

/** Prezzo con il ricarico applicato, arrotondato al centesimo. */
export function markedUpPrice(price: number | null, markupPct: number): number | null {
  if (price == null) return null;
  return round2(price * (1 + markupPct / 100));
}

/** `true` se il candidato arriva dal link già presente nel foglio. */
function usedBefore(candidate: TaobaoCandidate): boolean {
  return candidate.product.sources.includes("excel");
}

function candidateColumns(index: number): string[] {
  const n = index + 1;
  return [
    t("xls.product", { n }),
    t("xls.priceCny", { n }),
    t("xls.priceMarkedUp", { n }),
    t("xls.linkN", { n }),
    t("xls.noteN", { n }),
  ];
}

function candidateCells(
  candidate: TaobaoCandidate | undefined,
  markupPct: number
): (string | number)[] {
  if (!candidate) return ["", "", "", "", ""];
  const price = effectivePrice(candidate);
  const notes: string[] = [];
  if (usedBefore(candidate)) notes.push(t("xls.usedBefore"));
  if (candidate.product.promotionPrice != null) notes.push(t("xls.promoPrice"));
  if (candidate.scoreBreakdown) {
    notes.push(
      t("xls.compatibilityPct", {
        percent: Math.round(candidate.scoreBreakdown.compatibility * 100),
      })
    );
  }
  return [
    candidate.product.title,
    price ?? "",
    markedUpPrice(price, markupPct) ?? "",
    candidate.product.url ?? "",
    notes.join(" · "),
  ];
}

/**
 * I candidati del report: il prodotto del foglio per primo (è la base), poi i
 * migliori per classifica. Il runner li ordina già così: qui ci si limita a
 * prendere i primi N e a non dare mai peso a un prodotto non più disponibile.
 */
export function reportCandidates(candidates: readonly TaobaoCandidate[]): TaobaoCandidate[] {
  return candidates.filter((candidate) => !candidate.product.unavailable).slice(0, TOP_N);
}

export function buildClientReport(
  results: TaobaoJobResults,
  options: ReportOptions
): Buffer {
  const workbook = XLSX.utils.book_new();
  const markupPct = options.markupPct;

  const headers = [
    t("xls.row"),
    t("xls.request"),
    t("xls.quantity"),
    t("xls.unit"),
    ...candidateColumns(0),
    ...candidateColumns(1),
    ...candidateColumns(2),
  ];

  const rows = results.rows.map((row) => {
    const top = reportCandidates(row.candidates);
    return [
      row.rowNumber,
      row.displayName,
      row.requestedQuantity ?? "",
      row.requestedUnit ?? "",
      ...candidateCells(top[0], markupPct),
      ...candidateCells(top[1], markupPct),
      ...candidateCells(top[2], markupPct),
    ];
  });

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const candidateWidths = [44, 12, 14, 44, 26];
  sheet["!cols"] = [
    { wch: 6 },
    { wch: 32 },
    { wch: 10 },
    { wch: 8 },
    ...candidateWidths.map((wch) => ({ wch })),
    ...candidateWidths.map((wch) => ({ wch })),
    ...candidateWidths.map((wch) => ({ wch })),
  ];
  XLSX.utils.book_append_sheet(workbook, sheet, t("xls.sheet.report"));

  const info = XLSX.utils.aoa_to_sheet([
    [t("xls.client"), results.job.clientName],
    [t("xls.sourceFile"), results.job.fileName],
    [t("xls.markupApplied"), `${markupPct}%`],
    [t("xls.currency"), t("xls.currencyNote")],
    [t("xls.generatedOn"), new Date().toISOString().slice(0, 19).replace("T", " ")],
    [t("xls.note"), t("xls.reportDisclaimer")],
  ]);
  info["!cols"] = [{ wch: 22 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(workbook, info, t("xls.sheet.details"));

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Nome del file scaricato, con la stessa pulizia ASCII dell'export. */
export function reportFileName(clientName: string, fileName: string): string {
  const results = t("xls.fileSuffix.results");
  return exportFileName(clientName, fileName).replace(
    new RegExp(`-${results}\\.xlsx$`),
    `-${t("xls.fileSuffix.report")}.xlsx`
  );
}
