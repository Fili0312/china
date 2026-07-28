import type { Locale, TaobaoCandidate, TaobaoJobResults, TaobaoRowResults } from "@china/shared";
import * as XLSX from "xlsx";
import { currentLocale } from "../i18n/request-locale";
import { exportFileName } from "./export-workbook";
import { effectivePrice, markedUpPrice, reportCandidates, reportFileName } from "./report-workbook";
import { v2CandidateCoherence } from "./v2-review-contract";

/**
 * Export dedicati esclusivamente a scouting-v2.
 *
 * La v1 continua a usare i workbook storici senza alcuna modifica. SheetJS
 * Community non incorpora immagini nei file XLSX: per questo i fogli v2
 * includono sempre URL immagine e link prodotto come hyperlink reali.
 */

const labels: Record<
  Locale,
  {
    row: string;
    requested: string;
    status: string;
    correct: string;
    check: string;
    none: string;
    title: string;
    sku: string;
    saleUnit: string;
    price: string;
    markedUp: string;
    currency: string;
    imageUrl: string;
    productLink: string;
    query: string;
    rank: string;
    requestsSheet: string;
    productsSheet: string;
    reportSheet: string;
  }
> = {
  en: {
    row: "Row",
    requested: "Requested product",
    status: "Status",
    correct: "Correct product",
    check: "Needs checking",
    none: "No compatible result",
    title: "Found title",
    sku: "Selected variant / SKU",
    saleUnit: "Sale unit",
    price: "Price",
    markedUp: "Price with markup",
    currency: "Currency",
    imageUrl: "Image URL",
    productLink: "Product link",
    query: "Search query",
    rank: "Rank",
    requestsSheet: "Requests",
    productsSheet: "Products",
    reportSheet: "Report",
  },
  zh: {
    row: "行",
    requested: "所需产品",
    status: "状态",
    correct: "产品正确",
    check: "需要检查",
    none: "无兼容结果",
    title: "找到的标题",
    sku: "所选款式 / SKU",
    saleUnit: "销售单位",
    price: "价格",
    markedUp: "加价后价格",
    currency: "货币",
    imageUrl: "图片 URL",
    productLink: "产品链接",
    query: "搜索词",
    rank: "排名",
    requestsSheet: "请求",
    productsSheet: "产品",
    reportSheet: "报告",
  },
  it: {
    row: "Riga",
    requested: "Prodotto richiesto",
    status: "Stato",
    correct: "Prodotto corretto",
    check: "Da controllare",
    none: "Nessun risultato compatibile",
    title: "Titolo trovato",
    sku: "Variante / SKU selezionata",
    saleUnit: "Unità di vendita",
    price: "Prezzo",
    markedUp: "Prezzo con ricarico",
    currency: "Valuta",
    imageUrl: "URL immagine",
    productLink: "Link prodotto",
    query: "Query di ricerca",
    rank: "Posizione",
    requestsSheet: "Richieste",
    productsSheet: "Prodotti",
    reportSheet: "Report",
  },
};

export type V2ReviewStatus = "correct" | "check" | "none";

/**
 * Ciò che i workbook sanno oltre ai risultati della ricerca.
 *
 * Le righe su cui l'esito ha lasciato una decisione umana — una variante da
 * scegliere, un prezzo da leggere, un dubbio che nessun prodotto ha sciolto —
 * non possono comparire nel file del cliente come «prodotto corretto». Il
 * dato vive nell'esito della pipeline, non nella riga di job, e per questo
 * arriva da fuori.
 */
export interface V2WorkbookOptions {
  needsPerson?: ReadonlySet<number>;
}

/**
 * Stato sintetico della riga nel report.
 *
 * Decide **il verdetto**, non il motivo scritto sulla riga di job.
 * `reuseReason` è una nota lasciata da un giro di ri-ricerca («nessun
 * risultato compatibile»), e la verifica successiva può smentirla: su una
 * corsa da 498 righe il report dichiarava «nessun risultato compatibile» su
 * 206 righe, di cui centosessantacinque avevano un prodotto che la pagina
 * mostrava fra i confermati. Un report che contraddice la schermata da cui
 * nasce è peggio di un report mancante — e quello è il file che arriva al
 * cliente.
 *
 * Le tre categorie qui corrispondono una a una a quelle dell'esito:
 * confermata, da controllare, scoperta. Un «incerto» conta come accettato,
 * esattamente come nella workspace: è il giudice che non riesce a verificare
 * un dettaglio leggendo il solo titolo, non un rifiuto.
 */
export function v2ReviewStatus(
  row: TaobaoRowResults,
  /** `true` se l'esito ha lasciato su questa riga una decisione umana. */
  needsPerson = false
): V2ReviewStatus {
  const available = row.candidates.filter((candidate) => !candidate.product.unavailable);
  const accepted = available.filter((candidate) => {
    const verdict = candidate.coherence?.verdict;
    return verdict === "coherent" || verdict === "unsure";
  });
  const ready = accepted.find(
    (candidate) =>
      v2CandidateCoherence(candidate)?.variantSelectionRequired !== true
  );
  if (ready) return needsPerson ? "check" : "correct";
  // Accettato ma con una variante da scegliere: la decisione è di una persona.
  if (accepted.length > 0) return "check";
  return "none";
}

/** Candidati utilizzabili: gli incompatibili sono esclusi, non segnalati. */
export function v2UsableCandidates(
  candidates: readonly TaobaoCandidate[]
): TaobaoCandidate[] {
  return candidates.filter(
    (candidate) =>
      !candidate.product.unavailable &&
      candidate.coherence?.verdict !== "incoherent"
  );
}

export function selectedCandidate(
  row: TaobaoRowResults
): TaobaoCandidate | undefined {
  const usable = v2UsableCandidates(row.candidates);
  return (
    usable.find(
      (candidate) => {
        const coherence = v2CandidateCoherence(candidate);
        return (
          coherence?.verdict === "coherent" &&
          coherence.variantSelectionRequired !== true
        );
      }
    ) ??
    usable.find((candidate) => candidate.coherence?.verdict === "coherent") ??
    usable[0]
  );
}

/**
 * Unità di vendita dichiarata dalla scheda prodotto.
 *
 * Non usa l'unità richiesta nell'Excel come ripiego: richiesta e confezione di
 * vendita sono fatti diversi, e confonderli produrrebbe prezzi ingannevoli.
 */
export function productSaleUnit(candidate: TaobaoCandidate): string | null {
  const specs = candidate.product.specs;
  if (!specs) return null;
  const wanted = new Set([
    "saleunit",
    "salesunit",
    "unit",
    "packunit",
    "packagingunit",
    "销售单位",
    "计量单位",
    "单位",
    "包装单位",
  ]);
  for (const [key, value] of Object.entries(specs)) {
    const normalized = key.normalize("NFKC").replace(/[\s_-]+/g, "").toLowerCase();
    if (wanted.has(normalized) && value.trim()) return value.trim();
  }
  return null;
}

export function selectedVariantOrSku(candidate: TaobaoCandidate): string | null {
  return (
    candidate.product.sku?.trim() ||
    v2CandidateCoherence(candidate)?.selectedVariant?.trim() ||
    null
  );
}

function statusLabel(
  row: TaobaoRowResults,
  locale: Locale,
  needsPerson: boolean
): string {
  return labels[locale][v2ReviewStatus(row, needsPerson)];
}

function linkCell(
  sheet: XLSX.WorkSheet,
  rowIndex: number,
  columnIndex: number,
  target: string | null
): void {
  if (!target) return;
  const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  if (cell) cell.l = { Target: target };
}

function widthSheet(sheet: XLSX.WorkSheet, widths: number[]): void {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
}

export function buildV2TaobaoExport(
  results: TaobaoJobResults,
  options: V2WorkbookOptions = {}
): Buffer {
  const needsPerson = options.needsPerson ?? new Set<number>();
  const locale = currentLocale();
  const l = labels[locale];
  const workbook = XLSX.utils.book_new();

  const requestHeaders = [
    l.row,
    l.requested,
    l.status,
    l.title,
    l.sku,
    l.saleUnit,
    l.price,
    l.currency,
    l.imageUrl,
    l.productLink,
    l.query,
  ];
  const requestRows = results.rows.map((row) => {
    const candidate = selectedCandidate(row);
    return [
      row.rowNumber,
      row.displayName,
      statusLabel(row, locale, needsPerson.has(row.rowNumber)),
      candidate?.product.title ?? "",
      candidate ? (selectedVariantOrSku(candidate) ?? "") : "",
      candidate ? (productSaleUnit(candidate) ?? "") : "",
      candidate ? (effectivePrice(candidate) ?? "") : "",
      candidate?.product.currency ?? "",
      candidate?.product.imageUrl ?? "",
      candidate?.product.url ?? "",
      row.searchQuery,
    ];
  });
  const requests = XLSX.utils.aoa_to_sheet([requestHeaders, ...requestRows]);
  requestRows.forEach((_, index) => {
    const candidate = selectedCandidate(results.rows[index]!);
    linkCell(requests, index + 1, 8, candidate?.product.imageUrl ?? null);
    linkCell(requests, index + 1, 9, candidate?.product.url ?? null);
  });
  widthSheet(requests, [7, 34, 24, 52, 28, 16, 12, 10, 48, 48, 32]);
  XLSX.utils.book_append_sheet(workbook, requests, l.requestsSheet);

  const productHeaders = [
    l.row,
    l.requested,
    l.rank,
    l.status,
    l.title,
    l.sku,
    l.saleUnit,
    l.price,
    l.currency,
    l.imageUrl,
    l.productLink,
  ];
  const productRows = results.rows.flatMap((row) =>
    v2UsableCandidates(row.candidates).map((candidate) => ({
      candidate,
      values: [
        row.rowNumber,
        row.displayName,
        candidate.rank,
        candidate.coherence?.verdict ?? "",
        candidate.product.title,
        selectedVariantOrSku(candidate) ?? "",
        productSaleUnit(candidate) ?? "",
        effectivePrice(candidate) ?? "",
        candidate.product.currency ?? "",
        candidate.product.imageUrl ?? "",
        candidate.product.url ?? "",
      ],
    }))
  );
  const products = XLSX.utils.aoa_to_sheet([
    productHeaders,
    ...productRows.map((entry) => entry.values),
  ]);
  productRows.forEach((entry, index) => {
    linkCell(products, index + 1, 9, entry.candidate.product.imageUrl);
    linkCell(products, index + 1, 10, entry.candidate.product.url);
  });
  widthSheet(products, [7, 34, 8, 16, 52, 28, 16, 12, 10, 48, 48]);
  XLSX.utils.book_append_sheet(workbook, products, l.productsSheet);

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function buildV2ClientReport(
  results: TaobaoJobResults,
  options: { markupPct: number } & V2WorkbookOptions
): Buffer {
  const needsPerson = options.needsPerson ?? new Set<number>();
  const locale = currentLocale();
  const l = labels[locale];
  const workbook = XLSX.utils.book_new();
  const candidateHeaders = (position: number) => [
    `${l.title} ${position}`,
    `${l.sku} ${position}`,
    `${l.saleUnit} ${position}`,
    `${l.price} ${position}`,
    `${l.markedUp} ${position}`,
    `${l.imageUrl} ${position}`,
    `${l.productLink} ${position}`,
  ];
  const headers = [
    l.row,
    l.requested,
    l.status,
    ...candidateHeaders(1),
    ...candidateHeaders(2),
    ...candidateHeaders(3),
  ];

  const rows = results.rows.map((row) => {
    const candidates = reportCandidates(v2UsableCandidates(row.candidates));
    const cells = (candidate: TaobaoCandidate | undefined) => {
      if (!candidate) return ["", "", "", "", "", "", ""];
      const price = effectivePrice(candidate);
      return [
        candidate.product.title,
        selectedVariantOrSku(candidate) ?? "",
        productSaleUnit(candidate) ?? "",
        price ?? "",
        markedUpPrice(price, options.markupPct) ?? "",
        candidate.product.imageUrl ?? "",
        candidate.product.url ?? "",
      ];
    };
    return [
      row.rowNumber,
      row.displayName,
      statusLabel(row, locale, needsPerson.has(row.rowNumber)),
      ...cells(candidates[0]),
      ...cells(candidates[1]),
      ...cells(candidates[2]),
    ];
  });

  const report = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  results.rows.forEach((row, rowIndex) => {
    const candidates = reportCandidates(v2UsableCandidates(row.candidates));
    candidates.slice(0, 3).forEach((candidate, candidateIndex) => {
      const start = 3 + candidateIndex * 7;
      linkCell(report, rowIndex + 1, start + 5, candidate.product.imageUrl);
      linkCell(report, rowIndex + 1, start + 6, candidate.product.url);
    });
  });
  widthSheet(report, [
    7, 34, 24,
    52, 28, 16, 12, 16, 48, 48,
    52, 28, 16, 12, 16, 48, 48,
    52, 28, 16, 12, 16, 48, 48,
  ]);
  XLSX.utils.book_append_sheet(workbook, report, l.reportSheet);

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function v2ExportFileName(clientName: string, fileName: string): string {
  return exportFileName(clientName, fileName).replace(/\.xlsx$/, "-v2.xlsx");
}

export function v2ReportFileName(clientName: string, fileName: string): string {
  return reportFileName(clientName, fileName).replace(/\.xlsx$/, "-v2.xlsx");
}
