import assert from "node:assert/strict";
import test from "node:test";
import { maxSearchCallsCeiling } from "./pipeline.service";

/**
 * Il tetto delle chiamate di ricerca.
 *
 * È il numero su cui una persona decide se avviare o no, e sbagliarlo al
 * ribasso è il difetto peggiore che questa schermata possa avere: annuncia una
 * spesa e ne produce un'altra. Due corse reali del 2026-07-26 su un foglio da
 * 6 righe e 5 varianti hanno consumato 64 e 45 chiamate; la prima versione del
 * calcolo ne prometteva rispettivamente 0 e 20. Questi test fissano quei due
 * casi perché non si ripetano.
 */

test("il tetto copre le corse reali che avevano smentito il calcolo precedente", () => {
  // 5 varianti, 2 giri di ri-ricerca: la configurazione delle due prove.
  const ceiling = maxSearchCallsCeiling(5, 2);
  assert.ok(ceiling >= 64, `tetto ${ceiling} sotto le 64 chiamate osservate`);
  assert.ok(ceiling >= 45, `tetto ${ceiling} sotto le 45 chiamate osservate`);
});

test("il tetto cresce con le varianti e con i giri di ri-ricerca", () => {
  assert.ok(maxSearchCallsCeiling(10, 2) > maxSearchCallsCeiling(5, 2));
  assert.ok(maxSearchCallsCeiling(5, 3) > maxSearchCallsCeiling(5, 2));
  // Zero giri è la configurazione più economica possibile, non un caso limite.
  assert.ok(maxSearchCallsCeiling(5, 0) < maxSearchCallsCeiling(5, 1));
});

test("un foglio senza varianti non promette chiamate", () => {
  assert.equal(maxSearchCallsCeiling(0, 2), 0);
});

test("il tetto include la rilettura dei prodotti già in memoria", () => {
  // È l'addendo che la prima versione ignorava: dava «già conosciuta = gratis»
  // per una strada che invece rilegge fino a 12 schede per variante.
  const perVariant = maxSearchCallsCeiling(1, 0);
  assert.ok(
    perVariant >= 12,
    `una variante costa al massimo ${perVariant}: la rilettura non è contata`
  );
});
