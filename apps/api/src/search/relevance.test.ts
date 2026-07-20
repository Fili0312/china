import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedProduct, ProductSearchResult } from "@china/shared";

import {
  assessProductRelevance,
  extractSpecifications,
  filterAndRankSearchResult,
  normalizeSearchText,
  rankAndFilterProducts,
} from "./relevance.js";

function product(
  title: string,
  overrides: Partial<NormalizedProduct> = {},
): NormalizedProduct {
  return {
    id: overrides.id ?? title,
    provider: overrides.provider ?? "alibaba",
    title,
    originalTitle: overrides.originalTitle ?? null,
    imageUrl: overrides.imageUrl ?? null,
    originalPrice: overrides.originalPrice ?? null,
    currency: overrides.currency ?? "USD",
    vendorName: overrides.vendorName ?? null,
    totalSales: overrides.totalSales ?? null,
    moq: overrides.moq ?? null,
    productUrl: overrides.productUrl ?? null,
    warnings: overrides.warnings ?? [],
    sourceSnippet: overrides.sourceSnippet ?? null,
  };
}

test("scores an exact power-bank intent and technical specification", () => {
  const assessment = assessProductRelevance(
    "powerbank 10000mAh",
    product("10000mAh Portable Power Bank 22.5W USB-C Fast Charging"),
  );

  assert.equal(assessment.relevant, true);
  assert.ok(assessment.score >= 90, `unexpected score ${assessment.score}`);
  assert.ok(assessment.matchedTokens.includes("powerbank"));
  assert.equal(assessment.specificationComparisons[0]?.status, "match");
});

test("rejects a car jump starter even when it says power bank and matches mAh", () => {
  const assessment = assessProductRelevance(
    "power bank 10000mAh",
    product("12V Car Jump Starter 10000mAh Battery Booster Portable Power Bank"),
  );

  assert.equal(assessment.relevant, false);
  assert.ok(assessment.score < 55, `unexpected score ${assessment.score}`);
  assert.ok(assessment.warnings.some((warning) => warning.includes("avviatore")));
});

test("ranks a hybrid router-power-bank below a dedicated power bank", () => {
  const dedicated = assessProductRelevance(
    "powerbank 10000mAh",
    product("Slim dedicated Power Bank 10000mAh USB-C")
  );
  const hybrid = assessProductRelevance(
    "powerbank 10000mAh",
    product("4G WiFi 6 Wireless Router 10000mAh Power Bank")
  );

  assert.ok(dedicated.score > hybrid.score);
  assert.ok(hybrid.warnings.some((warning) => warning.includes("ibrido")));
});

test("strongly penalizes an incompatible 20mAh capacity", () => {
  const assessment = assessProductRelevance(
    "powerbank 10000mAh",
    product("Mini Portable Power Bank 20mAh USB Charger"),
  );

  assert.equal(assessment.relevant, false);
  assert.ok(assessment.score < 55, `unexpected score ${assessment.score}`);
  assert.equal(assessment.specificationComparisons[0]?.status, "mismatch");
  assert.ok(assessment.warnings.some((warning) => warning.includes("incompatibile")));
});

test("recovers a small buyer typo without hiding it", () => {
  const assessment = assessProductRelevance(
    "powebank 10000mAh",
    product("Powerbank 10000mAh Slim USB-C Portable Battery"),
  );

  assert.equal(assessment.relevant, true);
  assert.ok(assessment.score >= 75, `unexpected score ${assessment.score}`);
  assert.ok(assessment.reasons.some((reason) => reason.includes("errori")));
});

test("treats a requested model number as a required search term", () => {
  const exact = assessProductRelevance(
    "phone case iphone 16 pro",
    product("Protective Phone Case for iPhone 16 Pro")
  );
  const wrongModel = assessProductRelevance(
    "phone case iphone 16 pro",
    product("Protective Phone Case for iPhone 15 Pro"),
    { minScore: 70 }
  );

  assert.equal(exact.relevant, true);
  assert.equal(wrongModel.relevant, false);
  assert.ok(wrongModel.missingTokens.includes("16"));
});

test("can verify a specification exposed only in the source snippet", () => {
  const assessment = assessProductRelevance(
    "powerbank 10000mAh",
    product("Slim USB-C Portable Power Bank", {
      sourceSnippet: "Rated battery capacity: 10000 mAh; fast charging.",
    })
  );

  assert.equal(assessment.relevant, true);
  assert.equal(assessment.specificationComparisons[0]?.status, "match");
});

test("uses Chinese originalTitle and multilingual sourcing synonyms", () => {
  const chinese = product("PB-10 fast charge new arrival", {
    originalTitle: "10000毫安移动电源充电宝 快充 厂家批发",
  });

  const italian = assessProductRelevance(
    "fornitore all'ingrosso batteria esterna 10000mAh",
    chinese,
  );
  const german = assessProductRelevance("Hersteller Powerbank 10000mAh", chinese);

  assert.equal(italian.relevant, true);
  assert.equal(german.relevant, true);
  assert.ok(italian.score >= 85, `unexpected Italian score ${italian.score}`);
  assert.ok(italian.matchedTokens.includes("powerbank"));
  assert.equal(italian.specificationComparisons[0]?.status, "match");
});

test("normalizes Unicode and converts compatible units before comparison", () => {
  assert.equal(normalizeSearchText("  Großhandel—Borràccia  "), "wholesale waterbottle");

  const querySpecs = extractSpecifications("borraccia da 1 L e 0,5 kg");
  assert.deepEqual(
    querySpecs.map(({ dimension, value, unit }) => ({ dimension, value, unit })),
    [
      { dimension: "volume", value: 1_000, unit: "ml" },
      { dimension: "weight", value: 500, unit: "g" },
    ],
  );

  const assessment = assessProductRelevance(
    "borraccia 1L",
    product("Stainless Steel Water Bottle 1000 ml Leakproof"),
  );
  assert.equal(assessment.relevant, true);
  assert.equal(assessment.specificationComparisons[0]?.status, "match");
});

test("deduplicates only within a provider by URL, id and normalized title", () => {
  const title = "Power Bank 10000mAh USB-C Fast Charge";
  const products = [
    product(title, {
      id: "item-1",
      provider: "alibaba",
      productUrl: "https://www.alibaba.com/product-detail/123.html?utm_source=test",
    }),
    product(`${title} Wholesale`, {
      id: "item-2",
      provider: "alibaba",
      productUrl: "http://alibaba.com/product-detail/123.html?utm_campaign=x",
    }),
    product("10000mAh Powerbank Supplier", {
      id: "item-1",
      provider: "alibaba",
      productUrl: "https://alibaba.com/product-detail/different.html",
    }),
    product(title, {
      id: "item-4",
      provider: "alibaba",
      productUrl: "https://alibaba.com/product-detail/other.html",
    }),
    product(title, {
      id: "item-1",
      provider: "made-in-china",
      productUrl: "https://www.alibaba.com/product-detail/123.html?utm_source=test",
    }),
  ];

  const ranked = rankAndFilterProducts("powerbank 10000mAh", products);
  assert.equal(ranked.accepted.length, 2);
  assert.equal(ranked.duplicates.length, 3);
  assert.deepEqual(new Set(ranked.duplicates.map((duplicate) => duplicate.matchedBy)), new Set(["url", "id", "title"]));
  assert.deepEqual(
    new Set(ranked.accepted.map((entry) => entry.product.provider)),
    new Set(["alibaba", "made-in-china"]),
  );
});

test("returns a non-mutating filtered ProductSearchResult with audit details", () => {
  const input: ProductSearchResult = {
    provider: "alibaba",
    query: "powerbank 10000mAh",
    framePosition: 0,
    frameSize: 10,
    sort: "default",
    totalCount: 100,
    items: [
      product("Power Bank 10000mAh USB-C"),
      product("Car Jump Starter 12V 10000mAh Battery Booster"),
      product("Power Bank 20mAh"),
    ],
  };

  const refined = filterAndRankSearchResult(input);
  assert.equal(refined.result.items.length, 1);
  assert.equal(refined.result.totalCount, 1);
  assert.equal(refined.originalTotalCount, 100);
  assert.equal(refined.rejected.length, 2);
  assert.equal(input.items.length, 3);
  assert.equal(input.totalCount, 100);
});

test("una query cinese non viene azzerata da un titolo in inglese", () => {
  const assessment = assessProductRelevance(
    "防静电椅 黑色 升降 无靠背",
    product(
      "Laboratory backrest chair with casters, PU foam anti-static industrial chair",
    ),
  );
  // Nessun termine è confrontabile: il risultato resta valutabile a mano
  // invece di essere scartato, con l'avviso che lo spiega.
  assert.ok(assessment.score > 40, `punteggio troppo basso: ${assessment.score}`);
  assert.ok(
    assessment.warnings.some((warning) => warning.includes("non in cinese")),
    "manca l'avviso sulla lingua del titolo",
  );
});

test("i codici prodotto restano confrontabili anche fra lingue diverse", () => {
  const matching = assessProductRelevance(
    "激光测距传感器 DJM-050-485",
    product("DJM-050-485 laser distance measuring sensor RS485"),
  );
  const other = assessProductRelevance(
    "激光测距传感器 DJM-050-485",
    product("Generic laser distance sensor without model reference"),
  );
  assert.ok(
    matching.score > other.score,
    `il codice deve premiare la corrispondenza: ${matching.score} vs ${other.score}`,
  );
  assert.ok(matching.matchedTokens.includes("djm"));
});

test("fra titoli cinesi la copertura resta quella misurata", () => {
  const assessment = assessProductRelevance(
    "防静电椅 黑色",
    product("防静电椅子 黑色 无尘室专用"),
  );
  assert.ok(
    assessment.warnings.every((warning) => !warning.includes("non in cinese")),
    "un titolo cinese non deve produrre l'avviso di lingua",
  );
  assert.ok(assessment.matchedTokens.length > 0);
});

test("una misura assente da un titolo in altra lingua non affossa il risultato", () => {
  const query = "货架 珍珠白4层主架 加厚中型长200*宽40*高140 300KG/层";
  const assessment = assessProductRelevance(
    query,
    product("The blue three-layer main shelf has a stable load-bearing capacity"),
  );
  assert.ok(
    assessment.score > 40,
    `una specifica non verificabile non deve escludere il risultato: ${assessment.score}`,
  );
});

test("una misura in contrasto penalizza anche fra lingue diverse", () => {
  const query = "电源 24V";
  const conflicting = assessProductRelevance(query, product("Power supply 400V industrial"));
  const silent = assessProductRelevance(query, product("Industrial power supply unit"));
  assert.ok(
    conflicting.score < silent.score,
    `un valore incompatibile deve pesare: ${conflicting.score} vs ${silent.score}`,
  );
});
