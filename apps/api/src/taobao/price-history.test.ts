import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHashOf, readReuseSettings } from "./taobao-memory.service";

/**
 * Quando si scrive nello storico.
 *
 * Lo storico non registra i controlli, registra i **cambiamenti**: un prodotto
 * riletto dieci volte senza variazioni non deve produrre dieci righe identiche,
 * altrimenti l'unica domanda che conta — «quando è cambiato il prezzo?» —
 * diventa illeggibile. L'impronta dei dati commerciali è ciò che distingue i
 * due casi.
 */

const base = {
  price: 13.8,
  currency: "CNY",
  variantPrice: null,
  availability: null,
  totalSales: 120,
  reviewCount: 8,
  rating: 4.8,
};

test("gli stessi dati danno la stessa impronta", () => {
  assert.equal(contentHashOf(base), contentHashOf({ ...base }));
});

test("un prezzo diverso cambia l'impronta", () => {
  assert.notEqual(contentHashOf(base), contentHashOf({ ...base, price: 15.9 }));
});

test("cambiano l'impronta anche disponibilità, vendite e recensioni", () => {
  assert.notEqual(contentHashOf(base), contentHashOf({ ...base, availability: "sold out" }));
  assert.notEqual(contentHashOf(base), contentHashOf({ ...base, totalSales: 121 }));
  assert.notEqual(contentHashOf(base), contentHashOf({ ...base, reviewCount: 9 }));
});

test("un prezzo che sparisce non è uguale a un prezzo invariato", () => {
  // `null` e `13.8` devono restare distinguibili: «non recuperabile» è
  // un'informazione, e confonderla con «uguale a prima» nasconderebbe un
  // prodotto da riverificare.
  assert.notEqual(contentHashOf(base), contentHashOf({ ...base, price: null }));
});

test("le soglie di riuso hanno valori predefiniti sensati", () => {
  const settings = readReuseSettings();
  assert.ok(settings.maxCacheAgeHours > 0);
  assert.ok(settings.minValidProducts >= 1);
  assert.ok(settings.maxPriceChangePct > 0 && settings.maxPriceChangePct < 100);
});
