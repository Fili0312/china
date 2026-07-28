import assert from "node:assert/strict";
import test from "node:test";
import { settleVerdict } from "@china/ai";

/**
 * Il giudice non deve respingere per silenzio dell'inserzione.
 *
 * Su una corsa reale da 498 righe, 183 candidati su 1693 erano stati respinti
 * con motivazioni del tipo «il titolo non menziona l'acciaio 420»: assenza di
 * menzione, non contraddizione. Bastavano a lasciare 23 righe senza risultato.
 */

test("un rifiuto motivato solo da ciò che l'inserzione non dichiara diventa «incerto»", () => {
  assert.equal(settleVerdict("incoherent", "unstated"), "unsure");
});

test("una contraddizione esplicita resta un rifiuto", () => {
  assert.equal(settleVerdict("incoherent", "explicit"), "incoherent");
});

test("il verdetto positivo non viene mai toccato", () => {
  assert.equal(settleVerdict("coherent", "none"), "coherent");
  // Una misura elencata fra le varianti è una contraddizione apparente: se il
  // modello la giudica comunque coerente, la si rispetta.
  assert.equal(settleVerdict("coherent", "explicit"), "coherent");
});

test("«incerto» resta «incerto» qualunque sia il tipo di conflitto", () => {
  for (const conflict of ["explicit", "unstated", "none"] as const) {
    assert.equal(settleVerdict("unsure", conflict), "unsure");
  }
});

/**
 * Il modello descriveva la contraddizione a parole e poi votava «silenzio»:
 * un nastro da 50 metri dove ne servivano 10 tornava valutabile. Se riesce a
 * citare il valore letto nell'inserzione, quel dato è dichiarato — e
 * «non dichiarato» diventa una contraddizione in termini.
 */
test("se cita un valore letto nell'inserzione, il rifiuto non viene ammorbidito", () => {
  assert.equal(settleVerdict("incoherent", "unstated", "长50米"), "incoherent");
});

test("una citazione vuota o assente non impedisce l'ammorbidimento", () => {
  assert.equal(settleVerdict("incoherent", "unstated", null), "unsure");
  assert.equal(settleVerdict("incoherent", "unstated", "   "), "unsure");
});
