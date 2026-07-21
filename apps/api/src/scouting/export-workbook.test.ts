import assert from "node:assert/strict";
import test from "node:test";
import type { ImportJobResults, ScoutingSelection } from "@china/shared";
import * as XLSX from "xlsx";
import { buildExportWorkbook, exportFileName,
  contentDisposition,
} from "./export-workbook";

function selection(
  overrides: Partial<ScoutingSelection> = {}
): ScoutingSelection {
  return {
    outcome: "FINALIST",
    rank: 1,
    score: 72.4,
    scoreBreakdown: { relevance: 30 },
    rejectionCode: null,
    rejectionReason: null,
    aiRationale: null,
    scoreReused: false,
    product: {
      candidateId: "c1",
      engine: "yiwugo",
      externalId: "1",
      title: "防静电台垫 长200*宽40",
      url: "https://www.yiwugo.com/p/1",
      imageUrl: null,
      foundQuery: "防静电台垫 长200*宽40",
      vendorName: "义乌供应商",
      vendorUrl: null,
      price: 28.5,
      currency: "CNY",
      moq: 2,
      stock: null,
      rating: 4.6,
      reviewCount: 12,
      totalSales: 340,
      relevanceScore: 78,
      matchReasons: [],
      matchWarnings: [],
      variants: [],
      specs: {},
      priceTiers: [],
      firstSeenAt: "2026-07-20T10:00:00.000Z",
      lastCheckedAt: "2026-07-20T12:30:00.000Z",
      lastChangedAt: null,
      changedFields: [],
      unavailable: false,
    },
    ...overrides,
  };
}

const results: ImportJobResults = {
  job: {
    jobId: "j1",
    datasetId: "d1",
    fileName: "richieste.xlsx",
    status: "COMPLETED",
    engines: ["yiwugo", "chinagoods"],
    quality: "balanced",
    totalRows: 1,
    processedRows: 1,
    reusedRows: 0,
    failedRows: 0,
    creditsSpent: 0,
    createdAt: "2026-07-20T10:00:00.000Z",
    startedAt: "2026-07-20T10:00:01.000Z",
    finishedAt: "2026-07-20T10:02:00.000Z",
    error: null,
  },
  rows: [
    {
      jobRowId: "r1",
      rowNumber: 7,
      displayName: "防静电台垫",
      searchQuery: "防静电台垫 长200*宽40",
      status: "DONE",
      reused: false,
      fingerprint: "abc123",
      cells: ["防静电台垫", "长200*宽40", "4"],
      requirements: [],
      error: null,
      candidates: [],
      finalists: [
        selection(),
        selection({
          outcome: "SHORTLISTED",
          rank: 2,
          rejectionReason: "Nessun requisito verificabile.",
        }),
      ],
      rejected: [
        selection({
          outcome: "REJECTED",
          rank: null,
          rejectionCode: "MOQ_TOO_HIGH",
          rejectionReason: "Minimo d'ordine 500 superiore alla quantità 4.",
        }),
      ],
      engines: [
        {
          engine: "yiwugo",
          status: "DONE",
          queryUsed: "防静电台垫",
          fetchedCount: 8,
          acceptedCount: 3,
          durationMs: 68200,
          errorCode: null,
          error: null,
          retryable: false,
          attempts: 1,
          servedFromCache: false,
        },
      ],
    },
  ],
};

test("l'export produce i quattro fogli previsti", () => {
  const workbook = XLSX.read(buildExportWorkbook(results), { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, [
    "Finalisti",
    "In elenco",
    "Scartati",
    "Riepilogo",
  ]);
});

test("il foglio dei finalisti riporta riga originale, prodotto e punteggio", () => {
  const workbook = XLSX.read(buildExportWorkbook(results), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["Finalisti"]!
  );
  assert.equal(rows.length, 1, "solo i FINALIST, non gli SHORTLISTED");
  const row = rows[0]!;
  assert.equal(row["Riga"], 7);
  assert.equal(row["Impronta"], "abc123");
  // Le celle originali del file restano nell'export.
  assert.equal(row["File col. A"], "防静电台垫");
  assert.equal(row["File col. B"], "长200*宽40");
  assert.equal(row["Punteggio"], 72.4);
  assert.equal(row["Prezzo"], 28.5);
  assert.equal(row["Valuta"], "CNY");
  assert.equal(row["MOQ"], 2);
  assert.equal(row["Query che l'ha trovato"], "防静电台垫 长200*宽40");
});

test("ogni prodotto scartato porta il codice e il motivo", () => {
  const workbook = XLSX.read(buildExportWorkbook(results), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["Scartati"]!
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["Codice scarto"], "MOQ_TOO_HIGH");
  assert.match(String(rows[0]!["Motivo dello scarto"]), /Minimo d'ordine 500/);
});

test("i prodotti in elenco spiegano perché non sono proposti", () => {
  const workbook = XLSX.read(buildExportWorkbook(results), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["In elenco"]!
  );
  assert.equal(rows.length, 1);
  assert.match(String(rows[0]!["Perché non proposto"]), /Nessun requisito/);
});

test("il riepilogo riporta l'esito per marketplace", () => {
  const workbook = XLSX.read(buildExportWorkbook(results), { type: "buffer" });
  const text = XLSX.utils.sheet_to_csv(workbook.Sheets["Riepilogo"]!);
  assert.match(text, /richieste\.xlsx/);
  assert.match(text, /yiwugo,DONE,3,68\.2/);
});

test("il nome del file scaricato deriva da quello caricato", () => {
  assert.match(exportFileName("副本博工询价.xls"), /^副本博工询价-scouting-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

/* -------------------------------------------------------------------------- */
/* Nome del file scaricato                                                     */
/* -------------------------------------------------------------------------- */

test("un nome file cinese non rompe l'intestazione HTTP", () => {
  // Un header accetta solo ASCII: prima questo caso restituiva 500, cioè
  // l'export non funzionava proprio sui fogli per cui esiste la piattaforma.
  const disposition = contentDisposition("副本博工询价-scouting-2026-07-21.xlsx");

  assert.match(disposition, /^attachment; /);
  // Nessun carattere fuori dall'ASCII stampabile può finire nell'header.
  assert.ok(!/[^\x20-\x7e]/.test(disposition));
  assert.match(disposition, /filename\*=UTF-8''/);
  // Il nome vero resta recuperabile dal browser.
  assert.match(disposition, new RegExp(encodeURIComponent("副本博工询价")));
});

test("un nome file latino resta leggibile", () => {
  const disposition = contentDisposition("richieste-scouting-2026-07-21.xlsx");

  assert.match(disposition, /filename="richieste-scouting-2026-07-21\.xlsx"/);
});

test("virgolette e barre non possono uscire dal nome fra apici", () => {
  const disposition = contentDisposition('cattivo"nome\\.xlsx');

  assert.ok(!/filename="[^"]*"[^;]/.test(disposition));
  assert.match(disposition, /filename="cattivo_nome_\.xlsx"/);
});
