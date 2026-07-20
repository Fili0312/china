import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedProduct } from "@china/shared";
import {
  aggregateProducts,
  canonicalizeProductUrl,
  selectDiverseProducts,
} from "./aggregate";

function product(
  overrides: Partial<NormalizedProduct> & Pick<NormalizedProduct, "id" | "provider" | "title">
): NormalizedProduct {
  return {
    originalTitle: null,
    imageUrl: null,
    originalPrice: null,
    currency: "USD",
    vendorName: null,
    totalSales: null,
    moq: null,
    productUrl: null,
    warnings: [],
    ...overrides,
  };
}

test("unisce Taobao e Tmall con lo stesso ID e conserva entrambe le offerte", () => {
  const aggregated = aggregateProducts([
    product({
      provider: "taobao",
      id: "12345",
      title: "Power bank 10000 mAh",
      originalPrice: 80,
      currency: "CNY",
      relevanceScore: 82,
    }),
    product({
      provider: "tmall",
      id: "12345",
      title: "Official power bank 10000 mAh",
      originalPrice: 95,
      currency: "CNY",
      vendorName: "Official store",
      relevanceScore: 94,
    }),
  ]);

  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].canonicalKey, "otapi:12345");
  assert.equal(aggregated[0].representative.provider, "tmall");
  assert.equal(aggregated[0].representative.canonicalKey, "otapi:12345");
  assert.equal(aggregated[0].relevanceScore, 94);
  assert.deepEqual(
    aggregated[0].offers.map(({ provider, price, vendor, score }) => ({
      provider,
      price,
      vendor,
      score,
    })),
    [
      { provider: "tmall", price: 95, vendor: "Official store", score: 94 },
      { provider: "taobao", price: 80, vendor: null, score: 82 },
    ]
  );
});

test("unisce URL equivalenti ma conserva i parametri che identificano il prodotto", () => {
  assert.equal(
    canonicalizeProductUrl(
      "http://www.example.com/item/42/?b=2&utm_source=mail&a=1#reviews"
    ),
    "example.com/item/42?a=1&b=2"
  );

  const aggregated = aggregateProducts([
    product({
      provider: "alibaba",
      id: "offer-a",
      title: "Ceramic mug",
      productUrl: "https://www.example.com/item/42/?utm_source=ads&sku=white",
      relevanceScore: 70,
    }),
    product({
      provider: "made-in-china",
      id: "offer-b",
      title: "White ceramic mug",
      productUrl: "http://example.com/item/42?sku=white&spm=tracking",
      relevanceScore: 75,
    }),
    product({
      provider: "made-in-china",
      id: "offer-c",
      title: "Black ceramic mug",
      productUrl: "https://example.com/item/42?sku=black",
      relevanceScore: 99,
    }),
  ]);

  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0].representative.id, "offer-c");
  const white = aggregated.find((entry) => entry.offers.length === 2);
  assert.equal(white?.canonicalKey, "url:example.com/item/42?sku=white");
});

test("unisce titolo e immagine ragionevolmente uguali anche con URL prodotto diversi", () => {
  const aggregated = aggregateProducts([
    product({
      provider: "aliexpress",
      id: "ae-1",
      title: "Magnetic Power Bank 10000mAh Fast Charge Black",
      imageUrl: "https://cdn.example.com/products/power.jpg_300x300q90.jpg?cache=1",
      productUrl: "https://aliexpress.example/item/1",
      relevanceScore: 88,
    }),
    product({
      provider: "chinagoods",
      id: "cg-9",
      title: "Magnetic power-bank 10000 mAh fast charging black edition",
      imageUrl: "http://www.cdn.example.com/products/power.jpg?width=900",
      productUrl: "https://chinagoods.example/product/9",
      relevanceScore: 91,
    }),
  ]);

  assert.equal(aggregated.length, 1);
  assert.match(aggregated[0].canonicalKey, /^fingerprint:[0-9a-f]{16}$/);
  assert.equal(aggregated[0].representative.provider, "chinagoods");
  assert.equal(aggregated[0].offers.length, 2);
});

test("non unisce prodotti diversi che riusano la stessa immagine", () => {
  const imageUrl = "https://cdn.example.com/catalog/shared.jpg";
  const aggregated = aggregateProducts([
    product({
      provider: "alibaba",
      id: "one",
      title: "USB C power bank 10000 mAh",
      imageUrl,
      relevanceScore: 90,
    }),
    product({
      provider: "alibaba",
      id: "two",
      title: "Leather travel backpack waterproof 40 litre",
      imageUrl,
      relevanceScore: 89,
    }),
  ]);

  assert.equal(aggregated.length, 2);
});

test("deduplica offerte identiche, sceglie la versione migliore e ordina per score", () => {
  const duplicateLow = product({
    provider: "aliexpress",
    id: "777",
    title: "USB charger 65W",
    productUrl: "https://www.aliexpress.com/item/777.html?utm_campaign=x",
    relevanceScore: 40,
  });
  const duplicateHigh = product({
    ...duplicateLow,
    title: "USB charger 65W GaN",
    relevanceScore: 87,
  });
  const best = product({
    provider: "yiwugo",
    id: "best",
    title: "USB charger 65W",
    relevanceScore: 98,
  });

  const aggregated = aggregateProducts([duplicateLow, best, duplicateHigh]);

  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0].representative.id, "best");
  const aliExpress = aggregated.find(
    (entry) => entry.representative.provider === "aliexpress"
  );
  assert.equal(aliExpress?.offers.length, 1);
  assert.equal(aliExpress?.offers[0].score, 87);
  assert.equal(aliExpress?.representative.title, "USB charger 65W GaN");
});

test("canonicalKey, rappresentante e offerte non dipendono dall'ordine di input", () => {
  const values = [
    product({
      provider: "tmall",
      id: "900",
      title: "Official item",
      relevanceScore: 90,
    }),
    product({
      provider: "taobao",
      id: "900",
      title: "Marketplace item",
      relevanceScore: 90,
    }),
  ];

  const forward = aggregateProducts(values);
  const reverse = aggregateProducts([...values].reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].representative.provider, "taobao");
});

test("diversifica i pareggi senza promuovere risultati molto meno pertinenti", () => {
  const candidates = aggregateProducts([
    ...Array.from({ length: 5 }, (_, index) =>
      product({
        provider: "aliexpress",
        id: `ae-${index}`,
        title: `Exact power bank model ${index}`,
        relevanceScore: 100,
      })
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      product({
        provider: "chinagoods",
        id: `cg-${index}`,
        title: `Exact power bank wholesale ${index}`,
        relevanceScore: 100,
      })
    ),
    product({
      provider: "yiwugo",
      id: "low",
      title: "Weak candidate",
      relevanceScore: 70,
    }),
  ]);

  const selected = selectDiverseProducts(candidates, 6);
  assert.deepEqual(
    new Set(selected.map((entry) => entry.representative.provider)),
    new Set(["aliexpress", "chinagoods"])
  );
  assert.equal(selected.some((entry) => entry.representative.id === "low"), false);
  const counts = selected.reduce<Record<string, number>>((byProvider, entry) => {
    const provider = entry.representative.provider;
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    return byProvider;
  }, {});
  assert.deepEqual(counts, { aliexpress: 3, chinagoods: 3 });
});
