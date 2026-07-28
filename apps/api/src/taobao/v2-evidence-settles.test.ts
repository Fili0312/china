import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROCUREMENT,
  type AnalysisWarning,
  type ProductAnalysis,
} from "@china/shared";
import { buildPipelineReviewIssues } from "./pipeline.service";

/**
 * Un dubbio a cui il prodotto trovato risponde non è più un dubbio.
 *
 * Sulla corsa da 498 righe erano 25 richieste d'intervento su 23 righe: di
 * quelle, 16 righe avevano già in mano un candidato che il giudice accettava
 * senza riserve. Chiedere «60*60 in millimetri o centimetri?» dopo aver
 * trovato il pannello giusto non cambia che cosa si compra — cambia solo chi
 * deve stare sveglio a rispondere.
 *
 * Il limite che rende onesta la regola è qui sotto in forma di test: la nota
 * **resta**, cambia solo chi deve occuparsene. Niente sparisce.
 */

function analysis(warnings: AnalysisWarning[]): ProductAnalysis {
  return {
    productFamily: "pannello led",
    familyKey: "led-panel-light",
    variantKey: "60x60",
    productNameChinese: "平板灯",
    productNameEnglish: "led panel light",
    model: null,
    material: null,
    color: null,
    dimensions: [
      { axis: "length", label: null, value: 60, unit: null },
      { axis: "width", label: null, value: 60, unit: null },
    ],
    technicalSpecifications: [],
    includedAccessories: [],
    hardRequirements: [],
    softRequirements: [],
    requestedQuantity: null,
    unit: null,
    searchQueryChinese: "平板灯 60*60",
    searchQueryEnglish: "led panel light 60*60",
    confidence: 0.8,
    procurement: DEFAULT_PROCUREMENT,
    warnings,
  };
}

const ambiguousUnit: AnalysisWarning = {
  code: "AMBIGUOUS_UNIT",
  field: "dimensions",
  message: "Unità di misura non specificata per le dimensioni 60*60",
};

function issuesFor(confirmed: readonly number[]) {
  return buildPipelineReviewIssues(
    [
      {
        rowNumber: 1,
        submittedText: "平板灯 60*60",
        analysis: analysis([ambiguousUnit]),
        error: null,
      },
    ],
    new Set(confirmed),
    0.4
  );
}

test("senza un prodotto che risponda, il dubbio resta una domanda", () => {
  const [issue, ...rest] = issuesFor([]);
  assert.equal(rest.length, 0);
  assert.equal(issue?.code, "AMBIGUOUS_UNIT");
  assert.equal(issue?.resolvedAutomatically, false);
  assert.equal(issue?.humanAction, "CLARIFY_REQUIREMENT");
});

test("col prodotto trovato il dubbio resta scritto, ma non chiama più nessuno", () => {
  const [issue, ...rest] = issuesFor([1]);
  assert.equal(rest.length, 0);
  // La nota non sparisce: chi vuole controllare la trova dov'era.
  assert.equal(issue?.code, "AMBIGUOUS_UNIT");
  assert.equal(issue?.detail, ambiguousUnit.message);
  assert.equal(issue?.resolvedAutomatically, true);
  assert.equal(issue?.humanAction, null);
});
