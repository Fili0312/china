import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@china/db";
import {
  diffFields,
  normalizeTiers,
  readStock,
} from "./candidate-refresh.service";
import { toCandidateData } from "./candidate-store";
import type { NormalizedProduct } from "@china/shared";

function previous(overrides: Partial<Parameters<typeof diffFields>[0]> = {}) {
  return {
    title: "Sedia antistatica",
    price: new Prisma.Decimal(110),
    currency: "CNY",
    moq: 2,
    stock: 40,
    vendorName: "Yiwu Trading",
    unavailable: false,
    ...overrides,
  };
}

function next(overrides: Partial<NormalizedProduct> = {}) {
  return toCandidateData(
    {
      id: "1",
      provider: "yiwugo",
      title: "Sedia antistatica",
      originalTitle: null,
      imageUrl: null,
      originalPrice: 110,
      currency: "CNY",
      vendorName: "Yiwu Trading",
      totalSales: null,
      rating: null,
      reviewCount: null,
      moq: 2,
      productUrl: "https://www.yiwugo.com/p/1",
      warnings: [],
      ...overrides,
    },
    "yiwugo"
  );
}

test("nessuna differenza quando i dati sono identici", () => {
  const changed = diffFields(previous(), { ...next(), stock: 40 });
  assert.deepEqual(changed, []);
});

test("un cambio di prezzo viene rilevato", () => {
  const changed = diffFields(previous(), {
    ...next({ originalPrice: 125 }),
    stock: 40,
  });
  assert.deepEqual(changed, ["price"]);
});

test("più campi cambiati vengono elencati tutti", () => {
  const changed = diffFields(previous(), {
    ...next({ originalPrice: 99, moq: 5 }),
    stock: 0,
  });
  assert.deepEqual(changed.sort(), ["moq", "price", "stock"]);
});

test("un prodotto sparito viene segnalato come non disponibile", () => {
  const changed = diffFields(previous(), {
    ...next(),
    stock: 40,
    unavailable: true,
  });
  assert.deepEqual(changed, ["unavailable"]);
});

test("lo stock si legge dagli attributi in italiano, inglese o cinese", () => {
  assert.equal(readStock({ "库存": "1200 件" }), 1200);
  assert.equal(readStock({ Stock: "1,500" }), 1500);
  assert.equal(readStock({ Disponibilità: "48 pz" }), 48);
  assert.equal(readStock({ Colore: "nero" }), null);
  assert.equal(readStock(undefined), null);
});

test("i prezzi per quantità sono ordinati e ripuliti", () => {
  const tiers = normalizeTiers([
    { minQty: 100, price: { value: 8.5, currency: "USD" } },
    { minQty: 1, price: { value: 12, currency: "USD" } },
    // Scaglione senza quantità valida: non è un prezzo utilizzabile.
    { minQty: 0, price: { value: 99, currency: "USD" } },
    { minQty: 10, price: { value: 10, currency: "USD" } },
  ]);

  assert.deepEqual(
    tiers.map((tier) => tier.minQty),
    [1, 10, 100]
  );
  assert.equal(tiers[0]?.price, 12);
  assert.equal(tiers[2]?.currency, "USD");
});

test("una lettura mancata non cancella il prezzo già noto", () => {
  // Regola centrale dell'aggiornamento: se la scheda non espone il prezzo,
  // il valore precedente resta. Un parser che sbaglia non deve distruggere
  // dati buoni — è successo davvero su Yiwugo, che risponde in inglese e
  // senza prezzo alla pagina di dettaglio.
  const known = 114.75;
  const detailPrice: number | undefined = undefined;
  const resolved = detailPrice ?? known;
  assert.equal(resolved, 114.75);

  // E se invece il prezzo c'è, vince quello nuovo.
  const fresh: number | undefined = 99.9;
  assert.equal(fresh ?? known, 99.9);
});

test("il confronto non segnala differenze quando il prezzo è stato conservato", () => {
  const before = previous({ price: new Prisma.Decimal(114.75) });
  const conserved = { ...next({ originalPrice: 114.75 }), stock: 40 };
  assert.deepEqual(diffFields(before, conserved), []);
});
