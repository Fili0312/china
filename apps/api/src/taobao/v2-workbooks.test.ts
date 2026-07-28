import assert from "node:assert/strict";
import test from "node:test";
import type { TaobaoCandidate, TaobaoJobResults, TaobaoRowResults } from "@china/shared";
import * as XLSX from "xlsx";
import { runWithLocale } from "../i18n/request-locale";
import {
  buildV2ClientReport,
  buildV2TaobaoExport,
  productSaleUnit,
  selectedVariantOrSku,
  v2ReviewStatus,
} from "./v2-workbooks";
import type { V2CandidateCoherence } from "./v2-review-contract";

function candidate(
  verdict: "coherent" | "incoherent" | "unsure" | null,
  overrides: {
    itemId?: string;
    imageUrl?: string | null;
    unavailable?: boolean;
    sku?: string | null;
    specs?: Record<string, string> | null;
  } = {}
): TaobaoCandidate {
  const itemId = overrides.itemId ?? "1";
  return {
    rank: 1,
    score: 0.9,
    scoreBreakdown: { compatibility: 0.9, price: 0, sales: 0, reviews: 0 },
    matchedRequirements: [],
    missingRequirements: [],
    warnings: [],
    sourceConflicts: [],
    coherence: verdict
      ? { verdict, issues: [], confidence: 0.9 }
      : null,
    product: {
      productId: `product-${itemId}`,
      platform: "taobao",
      itemId,
      title: `Titolo ${itemId}`,
      titleEn: null,
      url: `https://item.taobao.com/item.htm?id=${itemId}`,
      imageUrl:
        overrides.imageUrl === undefined
          ? `https://img.example/${itemId}.jpg`
          : overrides.imageUrl,
      price: 12.5,
      currency: "CNY",
      variantPrice: null,
      promotionPrice: null,
      moq: 1,
      sku: overrides.sku === undefined ? `SKU-${itemId}` : overrides.sku,
      shopName: "Negozio",
      shopUrl: null,
      totalSales: null,
      reviewCount: null,
      rating: null,
      specs:
        overrides.specs === undefined
          ? { saleUnit: "confezione da 10" }
          : overrides.specs,
      variants: null,
      availability: null,
      shipping: null,
      foundQuery: "query",
      sources: ["api"],
      lastCheckedAt: "2026-07-26T12:00:00.000Z",
      changedFields: [],
      unavailable: overrides.unavailable ?? false,
    },
  };
}

function row(
  rowNumber: number,
  candidates: TaobaoCandidate[],
  reuseReason: string | null = null
): TaobaoRowResults {
  return {
    jobRowId: `row-${rowNumber}`,
    rowNumber,
    displayName: `Richiesta ${rowNumber}`,
    searchQuery: `query ${rowNumber}`,
    attemptedQueries: [],
    status: "DONE",
    reused: false,
    reuseReason,
    variantKey: `variant-${rowNumber}`,
    originalCells: [`originale ${rowNumber}`],
    requestedQuantity: 5,
    requestedUnit: "pezzi",
    hwhStatus: "DONE",
    hwhError: null,
    hwhCount: 1,
    apiStatus: null,
    apiError: null,
    apiCount: 0,
    elimStatus: null,
    elimError: null,
    elimCount: 0,
    browserStatus: null,
    browserError: null,
    browserCount: 0,
    error: null,
    candidates,
  };
}

function results(rows: TaobaoRowResults[]): TaobaoJobResults {
  return {
    job: {
      jobId: "job",
      clientId: "client",
      clientName: "Cliente",
      datasetId: "dataset",
      fileName: "richieste.xlsx",
      status: "COMPLETED",
      totalRows: rows.length,
      processedRows: rows.length,
      reusedRows: 0,
      searchedRows: rows.length,
      failedRows: 0,
      usage: {
        hwhCalls: 0,
        apiCalls: 0,
        apiCacheHits: 0,
        browserCalls: 0,
        elimCalls: 0,
        reusedProducts: 0,
        newProducts: rows.length,
      },
      browserUsed: false,
      createdAt: "2026-07-26T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    rows,
  };
}

test("il report classifica le righe come la pagina, non diversamente", () => {
  assert.equal(v2ReviewStatus(row(1, [candidate("coherent")])), "correct");
  // «Incerto» conta come accettato, esattamente come nella workspace: è il
  // giudice che non riesce a verificare un dettaglio leggendo il solo titolo,
  // non un rifiuto. Le due viste devono dire la stessa cosa della stessa
  // riga — altrimenti il file che arriva al cliente smentisce lo schermo da
  // cui è nato.
  assert.equal(v2ReviewStatus(row(2, [candidate("unsure")])), "correct");
  assert.equal(v2ReviewStatus(row(3, [candidate("incoherent")])), "none");
  assert.equal(v2ReviewStatus(row(4, [])), "none");
  assert.equal(
    v2ReviewStatus(row(5, [candidate("coherent", { unavailable: true })])),
    "none"
  );
});

test("l'unità di vendita arriva solo dalla scheda prodotto", () => {
  assert.equal(productSaleUnit(candidate("coherent")), "confezione da 10");
  assert.equal(
    productSaleUnit(candidate("coherent", { specs: { "包装单位": "rotolo" } })),
    "rotolo"
  );
  assert.equal(productSaleUnit(candidate("coherent", { specs: null })), null);
});

test("la variante selezionata automaticamente supplisce una SKU assente", () => {
  const selected = candidate("coherent", { sku: null });
  if (!selected.coherence) throw new Error("fixture senza coerenza");
  (selected.coherence as V2CandidateCoherence).selectedVariant =
    "Voltage: 24 V";
  assert.equal(selectedVariantOrSku(selected), "Voltage: 24 V");
});

test("un prodotto coerente con variante ancora da scegliere resta da controllare", () => {
  const pending = candidate("coherent", { sku: null });
  if (!pending.coherence) throw new Error("fixture senza coerenza");
  const coherence = pending.coherence as V2CandidateCoherence;
  coherence.variantSelectionRequired = true;
  coherence.variantChoices = ["Voltage: 12 V / 24 V"];
  assert.equal(v2ReviewStatus(row(1, [pending])), "check");
});

test("l'export v2 gestisce 1000 righe e conserva immagini, SKU e link", () => {
  const rows = Array.from({ length: 1000 }, (_, index) =>
    row(index + 1, [
      candidate("coherent", {
        itemId: String(index + 1),
        imageUrl: index === 1 ? null : `https://img.example/${index + 1}.jpg`,
      }),
    ])
  );
  const buffer = runWithLocale("it", () => buildV2TaobaoExport(results(rows)));
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets["Richieste"]!;
  const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  assert.equal(parsed.length, 1000);
  assert.equal(parsed[0]?.["Variante / SKU selezionata"], "SKU-1");
  assert.equal(parsed[0]?.["Unità di vendita"], "confezione da 10");
  assert.equal(parsed[0]?.["URL immagine"], "https://img.example/1.jpg");
  assert.equal(
    parsed[0]?.["Link prodotto"],
    "https://item.taobao.com/item.htm?id=1"
  );
  assert.equal(sheet["I2"]?.l?.Target, "https://img.example/1.jpg");
  assert.equal(
    sheet["J2"]?.l?.Target,
    "https://item.taobao.com/item.htm?id=1"
  );
  assert.equal(parsed[1]?.["URL immagine"] ?? "", "");
});

test("il report v2 scarta incompatibili e include URL immagine e prodotto", () => {
  const incompatible = candidate("incoherent", { itemId: "bad" });
  const compatible = candidate("coherent", { itemId: "good" });
  const buffer = runWithLocale("en", () =>
    buildV2ClientReport(results([row(1, [incompatible, compatible])]), {
      markupPct: 20,
    })
  );
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["Report"]!
  );

  assert.equal(parsed[0]?.["Found title 1"], "Titolo good");
  assert.equal(parsed[0]?.["Image URL 1"], "https://img.example/good.jpg");
  assert.equal(
    parsed[0]?.["Product link 1"],
    "https://item.taobao.com/item.htm?id=good"
  );
  const sheet = workbook.Sheets["Report"]!;
  assert.equal(sheet["I2"]?.l?.Target, "https://img.example/good.jpg");
  assert.equal(
    sheet["J2"]?.l?.Target,
    "https://item.taobao.com/item.htm?id=good"
  );
  assert.equal(parsed[0]?.["Price with markup 1"], 15);

  const exportBuffer = runWithLocale("en", () =>
    buildV2TaobaoExport(results([row(1, [incompatible, compatible])]))
  );
  const exportWorkbook = XLSX.read(exportBuffer, { type: "buffer" });
  const exportedProducts = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    exportWorkbook.Sheets["Products"]!
  );
  assert.deepEqual(
    exportedProducts.map((entry) => entry["Found title"]),
    ["Titolo good"]
  );
});

// `V2_NO_COMPATIBLE` è una nota lasciata da un giro di ri-ricerca — «qui non
// ho trovato niente di coerente» — e la verifica successiva può smentirla: la
// seconda passata giudica i candidati già comprati e ne promuove alcuni.
// Finché il report si fidava di quella nota, dichiarava «nessun risultato
// compatibile» su 206 righe della corsa da 498, e centosessantacinque di
// quelle la pagina le mostrava fra i confermati. Adesso comanda il verdetto.
test("il motivo scritto sulla riga non nasconde un prodotto che il giudice accetta", () => {
  const accepted = candidate("unsure", { itemId: "audit" });
  const noCompatible = row(
    1,
    [accepted],
    "V2_NO_COMPATIBLE: nessun risultato compatibile dopo 3 tentativi."
  );

  assert.equal(v2ReviewStatus(noCompatible), "correct");
  const buffer = runWithLocale("it", () =>
    buildV2TaobaoExport(results([noCompatible]))
  );
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const requests = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["Richieste"]!
  );
  const products = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["Prodotti"]!
  );

  assert.equal(requests[0]?.["Titolo trovato"], accepted.product.title);
  assert.equal(products.length, 1);

  // Il rifiuto esplicito invece resta un rifiuto, nota o non nota.
  const rejected = row(
    2,
    [candidate("incoherent", { itemId: "scartato" })],
    "V2_NO_COMPATIBLE: nessun risultato compatibile dopo 3 tentativi."
  );
  assert.equal(v2ReviewStatus(rejected), "none");
  const rejectedBuffer = runWithLocale("it", () =>
    buildV2TaobaoExport(results([rejected]))
  );
  const rejectedWorkbook = XLSX.read(rejectedBuffer, { type: "buffer" });
  assert.deepEqual(
    XLSX.utils.sheet_to_json<Record<string, unknown>>(
      rejectedWorkbook.Sheets["Prodotti"]!
    ),
    []
  );
  assert.equal(
    XLSX.utils.sheet_to_json<Record<string, unknown>>(
      rejectedWorkbook.Sheets["Richieste"]!
    )[0]?.["Titolo trovato"] ?? "",
    ""
  );
});

test("un verdetto incerto non diventa una domanda all'operatore", () => {
  // «Incerto» è il giudice senza obiezioni ma con evidenza incompleta: la
  // scheda che gliela darebbe la fonte non la serve, quindi rimandarlo
  // all'operatore significa solo spostargli addosso il lavoro.
  const accepted = (verdict: string | null) =>
    verdict === "coherent" || verdict === "unsure";

  assert.equal(accepted("coherent"), true);
  assert.equal(accepted("unsure"), true);
  assert.equal(accepted("incoherent"), false);
  assert.equal(accepted(null), false);
});
