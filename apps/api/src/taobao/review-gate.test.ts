import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisWarningCode, ProductAnalysis } from "@china/shared";
import { gateReason, hasReviewableWarning, resolveAnalysisState } from "./review-gate";

/**
 * Quanto lavoro manuale scarica il cancello sull'operatore.
 *
 * Questi test nascono da un file reale: 498 righe, 135 fermate dalla prima
 * versione della regola, e nessuna di quelle 135 era una riga che non si
 * poteva cercare. Le due proprietà da tenere insieme sono opposte, ed è per
 * questo che vanno scritte: ciò che impedisce di cercare **deve** fermare la
 * riga, ciò che è solo incerto **non deve**.
 */

function analysis(overrides: Partial<ProductAnalysis> = {}): ProductAnalysis {
  return {
    productFamily: "pannello led",
    familyKey: "led-panel-light",
    variantKey: "60x60",
    productNameChinese: "平板灯",
    productNameEnglish: "led panel light",
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
    searchQueryChinese: "平板灯 60*60",
    searchQueryEnglish: "led panel light 60x60",
    confidence: 0.7,
    warnings: [],
    ...overrides,
  };
}

function warning(code: AnalysisWarningCode) {
  return { code, field: null, message: `avviso ${code}` };
}

function gate(overrides: Partial<Parameters<typeof resolveAnalysisState>[0]> = {}) {
  return {
    analysis: analysis(),
    hasIdentity: true,
    approvedByUser: false,
    memory: null,
    minConfidence: 0.45,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Ciò che NON deve fermare la riga                                            */
/* -------------------------------------------------------------------------- */

test("una misura senza unità non ferma la riga", () => {
  // `平板灯 60*60`: la query cinese parte così com'è, quindi l'ambiguità non
  // cambia cosa si cerca. È il caso che da solo bloccava 45 righe su 498.
  const input = gate({
    analysis: analysis({ warnings: [warning("AMBIGUOUS_UNIT")], confidence: 0.7 }),
  });
  assert.equal(gateReason(input), null);
  assert.equal(resolveAnalysisState(input), "NEW_PRODUCT");
});

test("una misura ambigua non ferma la riga", () => {
  const input = gate({
    analysis: analysis({ warnings: [warning("AMBIGUOUS_MEASURE")], confidence: 0.6 }),
  });
  assert.equal(resolveAnalysisState(input), "NEW_PRODUCT");
});

test("un modello incerto non ferma la riga", () => {
  const input = gate({
    analysis: analysis({ warnings: [warning("AMBIGUOUS_MODEL")], confidence: 0.55 }),
  });
  assert.equal(resolveAnalysisState(input), "NEW_PRODUCT");
});

test("la confidenza intermedia del prompt non ferma la riga", () => {
  // La scala del prompt: 0.4-0.7 «un elemento importante è ambiguo». Ambiguo
  // non è sconosciuto — il prodotto si sa qual è.
  for (const confidence of [0.5, 0.55, 0.6, 0.65]) {
    const input = gate({ analysis: analysis({ confidence }) });
    assert.equal(resolveAnalysisState(input), "NEW_PRODUCT", `confidenza ${confidence}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Ciò che DEVE fermare la riga                                                */
/* -------------------------------------------------------------------------- */

test("senza query cinese la riga si ferma", () => {
  const input = gate({
    analysis: analysis({ searchQueryChinese: null, productNameChinese: null }),
  });
  assert.equal(gateReason(input), "NO_QUERY");
  assert.equal(resolveAnalysisState(input), "NEEDS_REVIEW");
});

test("una query fatta di soli spazi conta come assente", () => {
  const input = gate({
    analysis: analysis({ searchQueryChinese: "   ", productNameChinese: null }),
  });
  assert.equal(gateReason(input), "NO_QUERY");
});

test("più prodotti nella stessa riga fermano la riga", () => {
  // Cercarne uno solo sarebbe una risposta sbagliata data con sicurezza.
  const input = gate({
    analysis: analysis({ warnings: [warning("MULTIPLE_PRODUCTS")], confidence: 0.9 }),
  });
  assert.equal(gateReason(input), "MULTIPLE_PRODUCTS");
  assert.equal(resolveAnalysisState(input), "NEEDS_REVIEW");
});

test("sotto la soglia di confidenza la riga si ferma", () => {
  const input = gate({ analysis: analysis({ confidence: 0.3 }) });
  assert.equal(gateReason(input), "LOW_CONFIDENCE");
  assert.equal(resolveAnalysisState(input), "NEEDS_REVIEW");
});

test("la soglia è configurabile e rispettata", () => {
  const strict = gate({ analysis: analysis({ confidence: 0.6 }), minConfidence: 0.65 });
  assert.equal(gateReason(strict), "LOW_CONFIDENCE");
});

test("senza analisi la riga è «analisi IA fallita», non «da verificare»", () => {
  assert.equal(resolveAnalysisState(gate({ analysis: null })), "ANALYSIS_FAILED");
  assert.equal(resolveAnalysisState(gate({ hasIdentity: false })), "ANALYSIS_FAILED");
});

/* -------------------------------------------------------------------------- */
/* Conferma umana e memoria                                                    */
/* -------------------------------------------------------------------------- */

test("la conferma dell'operatore supera il cancello", () => {
  const input = gate({
    analysis: analysis({ warnings: [warning("MULTIPLE_PRODUCTS")], confidence: 0.1 }),
    approvedByUser: true,
  });
  assert.equal(gateReason(input), null);
  assert.equal(resolveAnalysisState(input), "NEW_PRODUCT");
});

test("la memoria decide lo stato solo dopo il cancello", () => {
  const known = { requestId: "req_1", familyRequestCount: 3 };

  // Riga cercabile: la memoria può dire «già conosciuto».
  assert.equal(resolveAnalysisState(gate({ memory: known })), "KNOWN_PRODUCT");

  // Riga ferma: resta ferma, anche se la variante esiste già. Una richiesta
  // ambigua non diventa «conosciuta» perché una chiave calcolata su dati
  // dubbi ha trovato una corrispondenza.
  const blocked = gate({
    analysis: analysis({ warnings: [warning("MULTIPLE_PRODUCTS")] }),
    memory: known,
  });
  assert.equal(resolveAnalysisState(blocked), "NEEDS_REVIEW");
});

test("famiglia conosciuta senza variante esatta è «variante nuova»", () => {
  const input = gate({ memory: { requestId: null, familyRequestCount: 2 } });
  assert.equal(resolveAnalysisState(input), "NEW_VARIANT");
});

/* -------------------------------------------------------------------------- */
/* Avvisi: segnalati, non bloccanti                                            */
/* -------------------------------------------------------------------------- */

test("gli avvisi restano contabilizzati anche quando non fermano nulla", () => {
  const withWarning = analysis({ warnings: [warning("AMBIGUOUS_UNIT")] });
  assert.equal(hasReviewableWarning(withWarning), true);
  assert.equal(resolveAnalysisState(gate({ analysis: withWarning })), "NEW_PRODUCT");

  assert.equal(hasReviewableWarning(analysis()), false);
  assert.equal(hasReviewableWarning(null), false);
});

test("un avviso non critico non viene nemmeno segnalato", () => {
  // `MISSING_INFO` e `UNCLEAR_TEXT` descrivono una riga povera, non una riga
  // sbagliata: non c'è niente da controllare a mano.
  assert.equal(hasReviewableWarning(analysis({ warnings: [warning("MISSING_INFO")] })), false);
  assert.equal(hasReviewableWarning(analysis({ warnings: [warning("UNCLEAR_TEXT")] })), false);
});
