import assert from "node:assert/strict";
import test from "node:test";
import {
  pipelineProgress,
  pipelineProgressFloor,
  TAOBAO_PIPELINE_PHASES,
  TAOBAO_PIPELINE_PHASE_WEIGHTS,
} from "./pipeline";

/**
 * La barra di avanzamento.
 *
 * Sembra cosmetica, e invece è l'unica cosa che una persona guarda per capire
 * se il sistema sta lavorando o si è piantato. Un salto all'indietro o una
 * barra che si ferma al 98% costano una segnalazione di guasto per un'
 * elaborazione perfettamente sana.
 */

test("i pesi delle fasi coprono esattamente il 100%", () => {
  const total = TAOBAO_PIPELINE_PHASES.reduce(
    (sum, phase) => sum + TAOBAO_PIPELINE_PHASE_WEIGHTS[phase],
    0
  );
  assert.equal(total, 100, "una barra che non arriva a 100 non finisce mai");
});

test("ogni fase parte da dove finisce la precedente", () => {
  let expected = 0;
  for (const phase of TAOBAO_PIPELINE_PHASES) {
    assert.equal(pipelineProgressFloor(phase), expected, `base sbagliata su ${phase}`);
    expected += TAOBAO_PIPELINE_PHASE_WEIGHTS[phase];
  }
});

test("l'avanzamento non arretra passando da una fase alla successiva", () => {
  let previous = -1;
  for (const phase of TAOBAO_PIPELINE_PHASES) {
    const start = pipelineProgress(phase, 0);
    const end = pipelineProgress(phase, 1);
    assert.ok(start >= previous, `${phase} riparte più indietro della fase prima`);
    assert.ok(end >= start, `${phase} finisce prima di dove inizia`);
    previous = end;
  }
  assert.equal(previous, 100, "l'ultima fase deve chiudere a 100");
});

test("un rapporto assurdo dà una barra valida, non un'eccezione", () => {
  // Succede davvero: una fase che rifà righe già contate può superare il
  // totale. Meglio una barra piena che un'elaborazione interrotta a metà.
  assert.equal(pipelineProgress("SEARCH", 5), pipelineProgress("SEARCH", 1));
  assert.equal(pipelineProgress("SEARCH", -3), pipelineProgress("SEARCH", 0));
  assert.equal(pipelineProgress("SEARCH", Number.NaN), pipelineProgress("SEARCH", 0));
  assert.equal(pipelineProgress("SEARCH", Number.POSITIVE_INFINITY), pipelineProgress("SEARCH", 1));
});

test("la ricerca pesa più di ogni altra fase", () => {
  // È la fase che dura minuti: se pesasse come le altre, la barra starebbe
  // ferma per quasi tutta l'elaborazione.
  const search = TAOBAO_PIPELINE_PHASE_WEIGHTS.SEARCH;
  for (const phase of TAOBAO_PIPELINE_PHASES) {
    if (phase === "SEARCH") continue;
    assert.ok(search > TAOBAO_PIPELINE_PHASE_WEIGHTS[phase], `SEARCH non batte ${phase}`);
  }
});
