import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProductAnalysis, type ProductAnalysis } from "@china/shared";

/**
 * La pulizia delle query è deterministica e stretta: toglie SOLO la coppia
 * quantità+unità dichiarata dall'analisi. Il caso che l'ha resa necessaria è
 * reale — «打标测试板 0.21银色 86*54 100张» con richiesta di 100 张 — e sta
 * qui come primo test.
 */

function analysis(overrides: Partial<ProductAnalysis>): ProductAnalysis {
  return {
    productFamily: "targhette di prova",
    familyKey: "laser-marking-test-board",
    variantKey: "86x54",
    productNameChinese: "打标测试板",
    productNameEnglish: "marking test board",
    model: null,
    material: null,
    color: null,
    dimensions: [],
    technicalSpecifications: [],
    includedAccessories: [],
    hardRequirements: [],
    softRequirements: [],
    requestedQuantity: 100,
    unit: "张",
    searchQueryChinese: "打标测试板 0.21银色 86*54 100张",
    searchQueryEnglish: null,
    confidence: 0.9,
    warnings: [],
    ...overrides,
  };
}

test("la quantità con unità CJK sparisce dalla query, anche attaccata", () => {
  const cleaned = sanitizeProductAnalysis(analysis({}));
  assert.equal(cleaned.searchQueryChinese, "打标测试板 0.21银色 86*54");

  const attached = sanitizeProductAnalysis(
    analysis({ searchQueryChinese: "测试板100张 86*54" })
  );
  assert.equal(attached.searchQueryChinese, "测试板 86*54");
});

test("un numero uguale alla quantità ma senza l'unità non si tocca", () => {
  // 100 potrebbe essere una misura: senza «张» accanto non è la quantità.
  const kept = sanitizeProductAnalysis(
    analysis({ searchQueryChinese: "测试板 100mm 银色" })
  );
  assert.equal(kept.searchQueryChinese, "测试板 100mm 银色");
});

test("con unità latina serve il confine di parola", () => {
  const cleaned = sanitizeProductAnalysis(
    analysis({
      requestedQuantity: 10,
      unit: "pcs",
      searchQueryChinese: null,
      searchQueryEnglish: "test board 86x54 10 pcs silver",
    })
  );
  assert.equal(cleaned.searchQueryEnglish, "test board 86x54 silver");

  // «10pcs» dentro un codice (X10PCS-2) non deve essere mutilato.
  const kept = sanitizeProductAnalysis(
    analysis({
      requestedQuantity: 10,
      unit: "pcs",
      searchQueryChinese: null,
      searchQueryEnglish: "adapter X10PCS-2 silver",
    })
  );
  assert.equal(kept.searchQueryEnglish, "adapter X10PCS-2 silver");
});

test("senza quantità o unità dichiarate non cambia nulla (stessa identità)", () => {
  const untouched = analysis({ requestedQuantity: null });
  assert.equal(sanitizeProductAnalysis(untouched), untouched);

  const noUnit = analysis({ unit: null });
  assert.equal(sanitizeProductAnalysis(noUnit), noUnit);
});
