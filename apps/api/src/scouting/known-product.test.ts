import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REUSE_SETTINGS,
  decideReuse,
  evaluateKnownProducts,
  priceChangePct,
  type KnownProductState,
  type ReuseSettings,
} from "./known-product";
import { variantNoLongerAvailable } from "./known-product.service";

/**
 * Ogni motivo di invalidazione della specifica ha il suo caso: sono le
 * situazioni in cui il sistema deve accorgersi che un dato salvato non vale
 * più, ed è esattamente ciò che nessuno prova finché non consegna il prodotto
 * sbagliato a un cliente.
 */

const NOW = new Date("2026-07-21T12:00:00Z");

function settings(overrides: Partial<ReuseSettings> = {}): ReuseSettings {
  return { ...DEFAULT_REUSE_SETTINGS, ...overrides };
}

function product(overrides: Partial<KnownProductState> = {}): KnownProductState {
  return {
    candidateId: "c1",
    unavailable: false,
    refreshFailed: false,
    variantMissing: false,
    requirementsFailed: false,
    price: 12.5,
    previousPrice: 12.5,
    vendorName: "Shenzhen Tools Co.",
    hadVendor: true,
    lastCheckedAt: new Date("2026-07-21T09:00:00Z"),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* I motivi che invalidano un prodotto                                         */
/* -------------------------------------------------------------------------- */

test("un prodotto sano resta valido", () => {
  const evaluation = evaluateKnownProducts([product()], settings(), NOW);

  assert.deepEqual(evaluation.valid, ["c1"]);
  assert.equal(evaluation.invalid.length, 0);
});

test("la pagina non più raggiungibile invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ unavailable: true })],
    settings(),
    NOW
  );

  assert.equal(evaluation.valid.length, 0);
  assert.equal(evaluation.invalid[0]!.code, "UNREACHABLE");
});

test("la variante non più disponibile invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ variantMissing: true })],
    settings(),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "VARIANT_MISSING");
});

test("un requisito obbligatorio non più rispettato invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ requirementsFailed: true })],
    settings(),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "REQUIREMENTS_FAILED");
});

test("un prezzo non recuperabile invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ price: null })],
    settings(),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "NO_PRICE");
});

test("una verifica troppo vecchia invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ lastCheckedAt: new Date("2026-07-01T09:00:00Z") })],
    settings({ maxCacheAgeHours: 24 }),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "STALE");
});

test("il prezzo entro la soglia non invalida, oltre la soglia sì", () => {
  const within = evaluateKnownProducts(
    [product({ previousPrice: 10, price: 12 })],
    settings({ maxPriceChangePct: 25 }),
    NOW
  );
  const beyond = evaluateKnownProducts(
    [product({ previousPrice: 10, price: 14 })],
    settings({ maxPriceChangePct: 25 }),
    NOW
  );

  assert.deepEqual(within.valid, ["c1"]);
  assert.equal(beyond.invalid[0]!.code, "PRICE_JUMP");
});

test("anche un crollo di prezzo supera la soglia", () => {
  // Un prezzo dimezzato è sospetto quanto uno raddoppiato: spesso significa
  // che la scheda ora mostra un accessorio invece del prodotto.
  const evaluation = evaluateKnownProducts(
    [product({ previousPrice: 100, price: 40 })],
    settings({ maxPriceChangePct: 25 }),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "PRICE_JUMP");
});

test("il venditore sparito invalida il prodotto", () => {
  const evaluation = evaluateKnownProducts(
    [product({ vendorName: null, hadVendor: true })],
    settings(),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "VENDOR_GONE");
});

test("un prodotto che non ha mai avuto un venditore non viene invalidato", () => {
  // Alcune fonti non espongono il negozio: l'assenza non è una perdita.
  const evaluation = evaluateKnownProducts(
    [product({ vendorName: null, hadVendor: false })],
    settings(),
    NOW
  );

  assert.deepEqual(evaluation.valid, ["c1"]);
});

/* -------------------------------------------------------------------------- */
/* L'errore di aggiornamento è configurabile                                   */
/* -------------------------------------------------------------------------- */

test("con fullSearchOnError attivo un aggiornamento fallito invalida", () => {
  const evaluation = evaluateKnownProducts(
    [product({ refreshFailed: true })],
    settings({ fullSearchOnError: true }),
    NOW
  );

  assert.equal(evaluation.invalid[0]!.code, "REFRESH_FAILED");
});

test("con fullSearchOnError spento un aggiornamento fallito non invalida", () => {
  const evaluation = evaluateKnownProducts(
    [product({ refreshFailed: true })],
    settings({ fullSearchOnError: false }),
    NOW
  );

  assert.deepEqual(evaluation.valid, ["c1"]);
});

/* -------------------------------------------------------------------------- */
/* La decisione finale                                                         */
/* -------------------------------------------------------------------------- */

test("abbastanza prodotti validi: si riusa", () => {
  const evaluation = evaluateKnownProducts(
    [product({ candidateId: "a" }), product({ candidateId: "b" })],
    settings({ minValidCandidates: 2 }),
    NOW
  );
  const decision = decideReuse(evaluation, settings({ minValidCandidates: 2 }));

  assert.equal(decision.reuse, true);
  assert.deepEqual(decision.validCandidates, ["a", "b"]);
});

test("troppo pochi prodotti validi: ricerca completa", () => {
  const evaluation = evaluateKnownProducts(
    [product({ candidateId: "a" }), product({ candidateId: "b", unavailable: true })],
    settings({ minValidCandidates: 2 }),
    NOW
  );
  const decision = decideReuse(evaluation, settings({ minValidCandidates: 2 }));

  assert.equal(decision.reuse, false);
  assert.match(decision.reason, /minimo di 2/);
});

test("nessun prodotto valido: la motivazione cita il primo problema", () => {
  const evaluation = evaluateKnownProducts(
    [product({ unavailable: true })],
    settings(),
    NOW
  );
  const decision = decideReuse(evaluation, settings());

  assert.equal(decision.reuse, false);
  assert.match(decision.reason, /non è più raggiungibile/);
});

test("variante mai cercata: nessun prodotto, nessun riuso", () => {
  const decision = decideReuse({ valid: [], invalid: [] }, settings());

  assert.equal(decision.reuse, false);
  assert.match(decision.reason, /Nessun prodotto salvato/);
});

/* -------------------------------------------------------------------------- */
/* Dettagli di calcolo                                                         */
/* -------------------------------------------------------------------------- */

test("la variazione di prezzo è simmetrica e regge lo zero", () => {
  assert.equal(priceChangePct(10, 12), 20);
  assert.equal(priceChangePct(10, 8), 20);
  assert.equal(priceChangePct(0, 5), 0);
});

test("il primo motivo vince: un prodotto irraggiungibile non viene giudicato sul prezzo", () => {
  const evaluation = evaluateKnownProducts(
    [product({ unavailable: true, previousPrice: 10, price: 100 })],
    settings(),
    NOW
  );

  assert.equal(evaluation.invalid.length, 1);
  assert.equal(evaluation.invalid[0]!.code, "UNREACHABLE");
});

/* -------------------------------------------------------------------------- */
/* Variante non più disponibile                                                */
/* -------------------------------------------------------------------------- */

test("nessuna variante richiesta: non si invalida nulla", () => {
  assert.equal(
    variantNoLongerAvailable([{ name: "colore", options: ["nero"] }], {}),
    false
  );
});

test("scheda senza opzioni: dato assente, non dato negativo", () => {
  // La maggior parte dei risultati di ricerca non espone le varianti. Trattare
  // l'assenza come «non disponibile» butterebbe via prodotti buoni a ogni giro.
  assert.equal(variantNoLongerAvailable([], { colore: "nero" }), false);
  assert.equal(variantNoLongerAvailable(null, { colore: "nero" }), false);
});

test("la variante richiesta c'è ancora fra le opzioni", () => {
  assert.equal(
    variantNoLongerAvailable(
      [{ name: "颜色", options: ["黑色", "白色"] }],
      { colore: "白色" }
    ),
    false
  );
});

test("la variante richiesta non c'è più: il prodotto non serve", () => {
  assert.equal(
    variantNoLongerAvailable(
      [{ name: "颜色", options: ["黑色", "灰色"] }],
      { colore: "白色" }
    ),
    true
  );
});

test("basta che manchi una sola caratteristica richiesta", () => {
  assert.equal(
    variantNoLongerAvailable(
      [
        { name: "颜色", options: ["白色"] },
        { name: "尺寸", options: ["600"] },
      ],
      { colore: "白色", misura: "800" }
    ),
    true
  );
});

test("il confronto ignora maiuscole e forme di larghezza diversa", () => {
  assert.equal(
    variantNoLongerAvailable([{ name: "size", options: ["XL"] }], { taglia: "xl" }),
    false
  );
});
