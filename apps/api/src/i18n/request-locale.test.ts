import assert from "node:assert/strict";
import test from "node:test";
import { currentLocale, resolveLocale, runWithLocale } from "./request-locale";
import { t } from "./messages";

/**
 * La lingua della risposta si decide qui, e sbagliarla non rompe niente: il
 * messaggio esce semplicemente in un'altra lingua. Per questo va coperta a
 * test — è un errore che non si manifesta come errore.
 */

test("«?lang» vince su «Accept-Language»: lo mette il link di download", () => {
  assert.equal(resolveLocale("zh", "it,en;q=0.9"), "zh");
  assert.equal(resolveLocale("it", undefined), "it");
});

test("di «Accept-Language» conta la prima preferenza, senza la regione", () => {
  assert.equal(resolveLocale(undefined, "zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(resolveLocale(undefined, "zh-Hans"), "zh");
  assert.equal(resolveLocale(undefined, "it-IT"), "it");
  assert.equal(resolveLocale(undefined, "en-GB,en;q=0.5"), "en");
});

test("una lingua che non parliamo ricade sull'inglese, non sull'ultima vista", () => {
  assert.equal(resolveLocale("de", undefined), "en");
  assert.equal(resolveLocale(undefined, "de-DE,fr;q=0.9"), "en");
  assert.equal(resolveLocale(undefined, ""), "en");
  assert.equal(resolveLocale(undefined, undefined), "en");
  assert.equal(resolveLocale(42, undefined), "en");
});

test("fuori da una richiesta la lingua è l'inglese, non l'ultima usata", () => {
  runWithLocale("zh", () => {
    assert.equal(currentLocale(), "zh");
  });
  // I job di ricerca girano qui: dopo che la risposta HTTP è già partita.
  assert.equal(currentLocale(), "en");
});

test("il contesto sopravvive agli await dentro la richiesta", async () => {
  await runWithLocale("it", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(currentLocale(), "it");
    assert.equal(t("err.noFile"), "Nessun file ricevuto.");
  });
});

test("i segnaposto vengono sostituiti, quelli senza valore restano visibili", () => {
  runWithLocale("en", () => {
    assert.equal(t("err.clientNotFound", { id: "abc" }), "Client not found: abc");
    // Un segnaposto senza valore resta a schermo: è un difetto da vedere.
    assert.equal(t("err.clientNotFound"), "Client not found: {id}");
  });
});
