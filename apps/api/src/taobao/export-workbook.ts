import type { TaobaoJobResults } from "@china/shared";
import { TAOBAO_ROW_STATUS_LABELS, TAOBAO_SOURCE_LABELS } from "@china/shared";
import * as XLSX from "xlsx";
import { currentLocale } from "../i18n/request-locale";
import { t } from "../i18n/messages";

/**
 * Export dei risultati Taobao.
 *
 * Tre fogli, e ognuno risponde a una domanda diversa:
 *
 * - **Richieste** — una riga per richiesta del file originale, con il miglior
 *   candidato accanto. È il foglio che si affianca al file di partenza.
 * - **Prodotti** — tutti i candidati di tutte le righe. È dove si sceglie:
 *   nessun prodotto viene eletto vincitore dal sistema, quindi qui c'è tutto
 *   ciò che serve per decidere, requisiti mancanti compresi.
 * - **Riepilogo** — quanto è costato e quanto è stato riusato.
 *
 * Intestazioni e nomi dei fogli seguono la lingua della richiesta: il file
 * scaricato da una pagina in cinese arriva in cinese. Restano fuori i dati —
 * titoli dei prodotti, nomi dei negozi, query — che sono cinesi in origine e
 * vanno letti come sono.
 */

/* Le intestazioni si costruiscono a ogni export, non una volta sola: la lingua
   cambia da una richiesta all'altra, e una costante di modulo la fisserebbe a
   quella della prima chiamata dopo il riavvio. */
function requestHeaders(): string[] {
  return [
    t("xls.row"),
    t("xls.request"),
    t("xls.chineseQuery"),
    t("xls.status"),
    t("xls.reused"),
    t("xls.reason"),
    t("xls.candidates"),
    t("xls.bestTitle"),
    t("xls.price"),
    t("xls.currency"),
    t("xls.shop"),
    t("xls.sales"),
    t("xls.link"),
    t("xls.missingRequirements"),
  ];
}

function productHeaders(): string[] {
  return [
    t("xls.row"),
    t("xls.request"),
    t("xls.rank"),
    t("xls.title"),
    t("xls.price"),
    t("xls.currency"),
    t("xls.variantPrice"),
    t("xls.sales"),
    t("xls.reviews"),
    t("xls.rating"),
    t("xls.shop"),
    t("xls.itemId"),
    t("xls.link"),
    t("xls.origin"),
    t("xls.compatibility"),
    t("xls.matchedRequirements"),
    t("xls.missingRequirements"),
    t("xls.warnings"),
    t("xls.lastCheck"),
  ];
}

function widths(sizes: number[]): XLSX.ColInfo[] {
  return sizes.map((width) => ({ wch: width }));
}

function timestamp(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}

export function buildTaobaoExport(results: TaobaoJobResults): Buffer {
  const workbook = XLSX.utils.book_new();
  const locale = currentLocale();

  const requestRows = results.rows.map((row) => {
    const best = row.candidates[0];
    return [
      row.rowNumber,
      row.displayName,
      row.searchQuery,
      TAOBAO_ROW_STATUS_LABELS[locale][row.status] ?? row.status,
      row.reused ? t("xls.yes") : t("xls.no"),
      row.reuseReason ?? row.error ?? "",
      row.candidates.length,
      best?.product.title ?? "",
      best?.product.price ?? "",
      best?.product.currency ?? "",
      best?.product.shopName ?? "",
      best?.product.totalSales ?? "",
      best?.product.url ?? "",
      best?.missingRequirements.join("; ") ?? "",
    ];
  });

  const requests = XLSX.utils.aoa_to_sheet([requestHeaders(), ...requestRows]);
  requests["!cols"] = widths([6, 30, 26, 16, 8, 40, 10, 46, 10, 8, 22, 10, 46, 34]);
  XLSX.utils.book_append_sheet(workbook, requests, t("xls.sheet.requests"));

  const productRows = results.rows.flatMap((row) =>
    row.candidates.map((candidate) => [
      row.rowNumber,
      row.displayName,
      candidate.rank,
      candidate.product.title,
      candidate.product.price ?? "",
      candidate.product.currency ?? "",
      candidate.product.variantPrice ?? "",
      candidate.product.totalSales ?? "",
      candidate.product.reviewCount ?? "",
      candidate.product.rating ?? "",
      candidate.product.shopName ?? "",
      candidate.product.itemId,
      candidate.product.url ?? "",
      candidate.product.sources
        .map((source) => TAOBAO_SOURCE_LABELS[locale][source] ?? source)
        .join(" + "),
      candidate.scoreBreakdown
        ? `${Math.round(candidate.scoreBreakdown.compatibility * 100)}%`
        : "",
      candidate.matchedRequirements.join("; "),
      candidate.missingRequirements.join("; "),
      [...candidate.warnings, ...candidate.sourceConflicts].join(" | "),
      timestamp(candidate.product.lastCheckedAt),
    ])
  );

  const products = XLSX.utils.aoa_to_sheet([productHeaders(), ...productRows]);
  products["!cols"] = widths([
    6, 26, 8, 50, 10, 8, 12, 10, 10, 8, 22, 14, 46, 18, 12, 34, 34, 40, 20,
  ]);
  XLSX.utils.book_append_sheet(workbook, products, t("xls.sheet.products"));

  const summary = XLSX.utils.aoa_to_sheet([
    [t("xls.client"), results.job.clientName],
    [t("xls.file"), results.job.fileName],
    [t("xls.status"), results.job.status],
    [t("xls.totalRows"), results.job.totalRows],
    [t("xls.processedRows"), results.job.processedRows],
    [t("xls.reusedRows"), results.job.reusedRows],
    [t("xls.searchedRows"), results.job.searchedRows],
    [t("xls.failedRows"), results.job.failedRows],
    [t("xls.hwhCalls"), results.job.usage.hwhCalls],
    [t("xls.dataHubCalls"), results.job.usage.apiCalls],
    [t("xls.cacheSaved"), results.job.usage.apiCacheHits],
    [t("xls.browserSearches"), results.job.usage.browserCalls],
    [t("xls.reusedProducts"), results.job.usage.reusedProducts],
    [t("xls.newProducts"), results.job.usage.newProducts],
    [t("xls.startedAt"), results.job.startedAt ? timestamp(results.job.startedAt) : ""],
    [t("xls.finishedAt"), results.job.finishedAt ? timestamp(results.job.finishedAt) : ""],
  ]);
  summary["!cols"] = widths([36, 40]);
  XLSX.utils.book_append_sheet(workbook, summary, t("xls.sheet.summary"));

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Nome del file scaricato.
 *
 * I caratteri non ASCII vengono tolti dal nome «semplice»: un'intestazione
 * `Content-Disposition` non li accetta, e un nome cinese faceva fallire il
 * download con un errore di header illegale.
 */
export function exportFileName(clientName: string, fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const safe = `${clientName}-${base}`
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${safe || "taobao"}-${t("xls.fileSuffix.results")}.xlsx`;
}
