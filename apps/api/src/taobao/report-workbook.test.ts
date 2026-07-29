import assert from "node:assert/strict";
import test from "node:test";
import type { TaobaoCandidate, TaobaoJobResults } from "@china/shared";
import * as XLSX from "xlsx";
import { runWithLocale } from "../i18n/request-locale";
import {
  buildClientReport,
  effectivePrice,
  markedUpPrice,
  reportCandidates,
  reportFileName,
} from "./report-workbook";

/**
 * Il report è il documento che finisce in mano al cliente: qui si verifica che
 * i prezzi ricaricati siano giusti al centesimo, che i candidati siano al
 * massimo tre (senza gli esauriti) e che la quantità del foglio arrivi intatta.
 */

function candidate(overrides: {
  title: string;
  price?: number | null;
  promotionPrice?: number | null;
  sources?: string[];
  unavailable?: boolean;
  rank?: number;
}): TaobaoCandidate {
  return {
    rank: overrides.rank ?? 1,
    score: 1,
    scoreBreakdown: { compatibility: 0.8, price: 0, sales: 0, reviews: 0 },
    matchedRequirements: [],
    missingRequirements: [],
    warnings: [],
    sourceConflicts: [],
    coherence: null,
    product: {
      productId: `p-${overrides.title}`,
      platform: "taobao",
      itemId: "1",
      title: overrides.title,
      titleEn: null,
      url: `https://item.taobao.com/item.htm?id=${overrides.title}`,
      imageUrl: null,
      price: overrides.price ?? 10,
      currency: "CNY",
      variantPrice: null,
      promotionPrice: overrides.promotionPrice ?? null,
      moq: null,
      sku: null,
      shopName: null,
      shopUrl: null,
      totalSales: null,
      reviewCount: null,
      rating: null,
      specs: null,
      variants: null,
      availability: null,
      shipping: null,
      foundQuery: "q",
      sources: (overrides.sources ?? ["api"]) as TaobaoCandidate["product"]["sources"],
      lastCheckedAt: "2026-07-23T08:00:00.000Z",
      changedFields: [],
      unavailable: overrides.unavailable ?? false,
    },
  };
}

function results(candidates: TaobaoCandidate[]): TaobaoJobResults {
  return {
    columns: [],
    job: {
      jobId: "j1",
      clientId: "c1",
      clientName: "Cliente Prova",
      datasetId: "d1",
      fileName: "richieste.xlsx",
      status: "COMPLETED",
      totalRows: 1,
      processedRows: 1,
      reusedRows: 0,
      searchedRows: 1,
      failedRows: 0,
      usage: {
        hwhCalls: 1,
        apiCalls: 0,
        apiCacheHits: 0,
        browserCalls: 0,
        elimCalls: 0,
        reusedProducts: 0,
        newProducts: 1,
      },
      browserUsed: false,
      createdAt: "2026-07-23T08:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    rows: [
      {
        jobRowId: "r1",
        rowNumber: 2,
        displayName: "陶瓷针规 5mm",
        searchQuery: "陶瓷针规 5mm",
        status: "DONE",
        reused: false,
        reuseReason: null,
  attemptedQueries: [],
        variantKey: "ceramic-pin-gauge:abc",
        originalTitle: null,
    originalCells: [],
        requestedQuantity: 50,
        requestedUnit: "支",
        hwhStatus: "DONE",
        hwhError: null,
        hwhCount: 3,
        apiStatus: null,
        apiError: null,
        apiCount: 0,
        elimStatus: null,
        elimError: null,
        elimCount: 0,
        browserStatus: "DISABLED",
        browserError: null,
        browserCount: 0,
        error: null,
        candidates,
      },
    ],
  };
}

test("il ricarico si applica al centesimo, sul prezzo promozionale se c'è", () => {
  assert.equal(markedUpPrice(100, 15), 115);
  assert.equal(markedUpPrice(9.99, 10), 10.99);
  assert.equal(markedUpPrice(null, 15), null);
  assert.equal(markedUpPrice(100, 0), 100);

  const promo = candidate({ title: "promo", price: 100, promotionPrice: 80 });
  assert.equal(effectivePrice(promo), 80);
});

test("nel report entrano al massimo 3 candidati, mai gli esauriti", () => {
  const list = [
    candidate({ title: "a", rank: 1 }),
    candidate({ title: "sparito", rank: 2, unavailable: true }),
    candidate({ title: "b", rank: 3 }),
    candidate({ title: "c", rank: 4 }),
    candidate({ title: "d", rank: 5 }),
  ];
  const top = reportCandidates(list);
  assert.deepEqual(
    top.map((entry) => entry.product.title),
    ["a", "b", "c"]
  );
});

test("il foglio riporta quantità, prezzi ricaricati e nota «usato in precedenza»", () => {
  const buffer = buildClientReport(
    results([
      candidate({ title: "base", price: 20, sources: ["excel", "api"], rank: 1 }),
      candidate({ title: "alt", price: 10, rank: 2 }),
    ]),
    { markupPct: 25 }
  );

  const workbook = XLSX.read(buffer, { type: "buffer" });
  // Fuori da una richiesta HTTP non c'è lingua scelta: vale il predefinito.
  const sheet = workbook.Sheets["Report"]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  assert.equal(rows.length, 1);

  const row = rows[0]!;
  assert.equal(row["Quantity"], 50);
  assert.equal(row["Unit"], "支");
  // Il primo prodotto è quello del foglio: prezzo 20 → 25 col 25%.
  assert.equal(row["Product 1"], "base");
  assert.equal(row["Price 1 (CNY)"], 20);
  assert.equal(row["Price 1 with markup"], 25);
  assert.match(String(row["Note 1"]), /used before/);
  // Il secondo è l'alternativa: 10 → 12,5.
  assert.equal(row["Product 2"], "alt");
  assert.equal(row["Price 2 with markup"], 12.5);

  const info = workbook.Sheets["Details"]!;
  const infoRows = XLSX.utils.sheet_to_json<string[]>(info, { header: 1 });
  assert.ok(
    infoRows.some((entry) => entry[0] === "Markup applied" && entry[1] === "25%")
  );
});

test("le intestazioni seguono la lingua della richiesta, i dati no", () => {
  // Il foglio scaricato da una pagina in cinese arriva con le intestazioni in
  // cinese; il titolo del prodotto e l'unità restano quelli del file.
  const buffer = runWithLocale("zh", () =>
    buildClientReport(results([candidate({ title: "base", price: 20, rank: 1 })]), {
      markupPct: 10,
    })
  );

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["报告"]!
  );
  const row = rows[0]!;
  assert.equal(row["数量"], 50);
  assert.equal(row["单位"], "支");
  assert.equal(row["产品 1"], "base");
  assert.equal(row["加价后价格 1"], 22);
});

test("il nome del report resta ASCII e distinguibile dall'export", () => {
  assert.equal(
    reportFileName("Cliente Prova", "richieste 采购.xlsx"),
    "Cliente-Prova-richieste-report.xlsx"
  );
});
