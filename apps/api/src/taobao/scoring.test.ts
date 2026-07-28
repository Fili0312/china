import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROCUREMENT, type ProductAnalysis } from "@china/shared";
import type { MergedProduct } from "./merge";
import { checkRequirements, dimensionMatches, rankCandidates } from "./scoring";
import type { ScoredProduct } from "./scoring";
import { pinExcelFirst as pinExcelFirstForTest } from "./taobao-runner.service";

/**
 * La classifica.
 *
 * La regola da difendere è una sola e vale più di tutte le altre messe
 * insieme: **prima la compatibilità tecnica, poi il prezzo**. Un prodotto che
 * costa metà ma ha la misura sbagliata non deve arrivare primo, per nessuna
 * combinazione di vendite e recensioni.
 */

function analysis(overrides: Partial<ProductAnalysis> = {}): ProductAnalysis {
  return {
    productFamily: "calibri a spillo in ceramica",
    familyKey: "ceramic-pin-gauge",
    variantKey: "5 mm",
    productNameChinese: "陶瓷针规",
    productNameEnglish: "ceramic pin gauge",
    model: null,
    material: null,
    color: null,
    dimensions: [],
    technicalSpecifications: [],
    includedAccessories: [],
    hardRequirements: [],
    softRequirements: [],
    requestedQuantity: null,
    unit: null,
    searchQueryChinese: "陶瓷针规 5mm",
    searchQueryEnglish: "ceramic pin gauge 5mm",
    confidence: 0.9,
    procurement: DEFAULT_PROCUREMENT,
    warnings: [],
    ...overrides,
  };
}

function product(overrides: Partial<MergedProduct> = {}): MergedProduct {
  return {
    platform: "taobao",
    itemId: "1",
    title: "陶瓷针规 5mm 高精度",
    titleEn: null,
    url: null,
    imageUrl: null,
    price: 100,
    currency: "CNY",
    variantPrice: null,
    promotionPrice: null,
    moq: null,
    sku: null,
    shopName: null,
    shopUrl: null,
    sellerId: null,
    totalSales: 10,
    reviewCount: 5,
    rating: null,
    specs: null,
    variants: null,
    availability: null,
    shipping: null,
    unavailable: false,
    source: "api",
    sources: ["api"],
    conflicts: [],
    ...overrides,
  };
}

test("la misura giusta nel titolo conta come requisito soddisfatto", () => {
  const result = checkRequirements(
    analysis({
      dimensions: [{ axis: "diameter", label: null, value: 5, unit: "mm" }],
    }),
    product({ title: "陶瓷针规 5mm" })
  );

  assert.deepEqual(result.missing, []);
  assert.equal(result.compatibility, 1);
});

test("la misura sbagliata nel titolo resta un requisito mancante", () => {
  const result = checkRequirements(
    analysis({
      dimensions: [{ axis: "diameter", label: null, value: 5, unit: "mm" }],
    }),
    product({ title: "陶瓷针规 6mm" })
  );

  assert.equal(result.missing.length, 1);
  assert.equal(result.compatibility, 0);
});

test("una misura equivalente in un'altra unità viene riconosciuta", () => {
  // Il venditore scrive in centimetri, la richiesta in millimetri: è lo stesso
  // prodotto, e pretendere la stessa unità lo scarterebbe.
  assert.ok(dimensionMatches("平板灯 60厘米", { value: 600, unit: "mm" }));
  assert.ok(dimensionMatches("cavo 1.5m", { value: 1500, unit: "mm" }));
  assert.ok(!dimensionMatches("平板灯 30厘米", { value: 600, unit: "mm" }));
});

test("il prezzo più basso non supera la compatibilità più alta", () => {
  const ranked = rankCandidates(
    analysis({ dimensions: [{ axis: "diameter", label: null, value: 5, unit: "mm" }] }),
    [
      product({ itemId: "sbagliato", title: "陶瓷针规 6mm", price: 10, totalSales: 9999 }),
      product({ itemId: "giusto", title: "陶瓷针规 5mm", price: 300, totalSales: 1 }),
    ]
  );

  assert.equal(ranked[0]!.product.itemId, "giusto");
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("a parità di compatibilità decide il prezzo", () => {
  const ranked = rankCandidates(analysis(), [
    product({ itemId: "caro", price: 300 }),
    product({ itemId: "economico", price: 90 }),
  ]);

  assert.equal(ranked[0]!.product.itemId, "economico");
});

test("i requisiti obbligatori mancanti diventano un avviso, non un'esclusione", () => {
  const ranked = rankCandidates(
    analysis({ hardRequirements: ["certificazione CE"] }),
    [product({ title: "陶瓷针规 5mm" })]
  );

  // Il candidato resta in classifica: la scelta è di chi compra.
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0]!.missingRequirements, ["certificazione CE"]);
  assert.ok(ranked[0]!.warnings.some((warning) => /requisiti non verificabili/.test(warning)));
});

test("un prodotto senza prezzo viene segnalato", () => {
  const ranked = rankCandidates(analysis(), [product({ price: null })]);
  assert.ok(ranked[0]!.warnings.some((warning) => /Prezzo non recuperabile/.test(warning)));
});

test("i conflitti fra fonti arrivano fino agli avvisi del candidato", () => {
  const ranked = rankCandidates(analysis(), [
    product({ conflicts: ["Prezzo diverso fra le fonti: api 100, playwright 60."] }),
  ]);
  assert.ok(ranked[0]!.warnings.some((warning) => /Prezzo diverso/.test(warning)));
});

test("le specifiche del prodotto contano quanto il titolo", () => {
  const result = checkRequirements(
    analysis({ material: "陶瓷" }),
    product({ title: "针规 5mm", specs: { 材质: "陶瓷" } })
  );
  assert.deepEqual(result.missing, []);
});

test("senza vincoli strutturati si misura la sovrapposizione con la query", () => {
  const good = checkRequirements(analysis(), product({ title: "陶瓷针规 5mm 高精度" }));
  const bad = checkRequirements(analysis(), product({ title: "不锈钢螺丝 M8" }));
  assert.ok(good.compatibility > bad.compatibility);
});

test("il modello si riconosce anche scritto con separatori diversi", () => {
  const result = checkRequirements(
    analysis({ model: "DJM-050-485" }),
    product({ title: "驱动器 DJM050485 工业级" })
  );
  assert.deepEqual(result.missing, []);
});

test("un link del foglio senza prezzo né immagine non rappresenta la riga", () => {
  const complete = {
    product: {
      sources: ["api"],
      price: 12,
      promotionPrice: null,
      variantPrice: null,
      imageUrl: "https://img.example/a.jpg",
    },
  } as unknown as ScoredProduct;
  const emptyExcel = {
    product: {
      sources: ["excel", "api"],
      price: null,
      promotionPrice: null,
      variantPrice: null,
      imageUrl: null,
    },
  } as unknown as ScoredProduct;
  const usefulExcel = {
    product: {
      sources: ["excel"],
      price: 9,
      promotionPrice: null,
      variantPrice: null,
      imageUrl: "https://img.example/b.jpg",
    },
  } as unknown as ScoredProduct;

  // Un guscio senza dati resta in lista, ma dopo il candidato completo.
  assert.deepEqual(pinExcelFirstForTest([complete, emptyExcel]), [
    complete,
    emptyExcel,
  ]);
  // Un link del foglio che porta prezzo e immagine mantiene la precedenza.
  assert.deepEqual(pinExcelFirstForTest([complete, usefulExcel]), [
    usefulExcel,
    complete,
  ]);
});
