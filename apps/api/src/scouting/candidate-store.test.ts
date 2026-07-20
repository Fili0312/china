import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedProduct } from "@china/shared";
import {
  candidateContentHash,
  toCandidateData,
  type CandidateData,
} from "./candidate-store";

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: "1600123",
    provider: "chinagoods",
    title: "Anti-static chair",
    originalTitle: null,
    imageUrl: "https://cdn/x.jpg",
    originalPrice: 36.29,
    currency: "USD",
    vendorName: "Yiwu Trading",
    totalSales: 120,
    rating: 4.6,
    reviewCount: 88,
    moq: 2,
    productUrl: "https://en.chinagoods.com/product/x_1600123",
    warnings: [],
    relevanceScore: 72.5,
    matchReasons: ["nome prodotto compatibile"],
    matchWarnings: [],
    ...overrides,
  };
}

test("un prodotto di ricerca diventa un candidato salvabile", () => {
  const data = toCandidateData(product(), "chinagoods");

  assert.equal(data.engine, "chinagoods");
  assert.equal(data.externalId, "1600123");
  assert.equal(data.price, 36.29);
  assert.equal(data.moq, 2);
  assert.equal(data.vendorName, "Yiwu Trading");
  assert.equal(data.relevanceScore, 72.5);
  // Stock e varianti arrivano dalla scheda prodotto, non dalla ricerca.
  assert.equal(data.stock, null);
});

test("i valori decimali di recensioni e vendite diventano interi", () => {
  const data = toCandidateData(
    product({ reviewCount: 88.4, totalSales: 120.9, moq: 2.0 }),
    "alibaba"
  );
  assert.equal(data.reviewCount, 88);
  assert.equal(data.totalSales, 121);
  assert.equal(data.moq, 2);
});

test("l'impronta cambia quando cambia il prezzo", () => {
  const before = candidateContentHash(toCandidateData(product(), "chinagoods"));
  const after = candidateContentHash(
    toCandidateData(product({ originalPrice: 39.9 }), "chinagoods")
  );
  assert.notEqual(before, after);
});

test("l'impronta non cambia per immagine o punteggio di pertinenza", () => {
  // Sono dati nostri, non del venditore: non devono far risultare
  // "modificato" un prodotto che è rimasto identico.
  const base = candidateContentHash(toCandidateData(product(), "chinagoods"));
  const restyled = candidateContentHash(
    toCandidateData(
      product({
        imageUrl: "https://cdn/altra.jpg",
        relevanceScore: 51,
        matchReasons: ["motivo diverso"],
      }),
      "chinagoods"
    )
  );
  assert.equal(base, restyled);
});

test("l'impronta segue MOQ, stock, disponibilità e venditore", () => {
  const base = toCandidateData(product(), "chinagoods");
  const variations: Array<Partial<CandidateData>> = [
    { moq: 10 },
    { stock: 0 },
    { unavailable: true },
    { vendorName: "Altro fornitore" },
    { currency: "CNY" },
    { rating: 3.1 },
    { reviewCount: 90 },
    { title: "Titolo cambiato" },
  ];
  for (const variation of variations) {
    assert.notEqual(
      candidateContentHash(base),
      candidateContentHash({ ...base, ...variation }),
      `una modifica a ${Object.keys(variation)[0]} deve cambiare l'impronta`
    );
  }
});

test("l'impronta è stabile fra due letture identiche", () => {
  assert.equal(
    candidateContentHash(toCandidateData(product(), "yiwugo")),
    candidateContentHash(toCandidateData(product(), "yiwugo"))
  );
});
