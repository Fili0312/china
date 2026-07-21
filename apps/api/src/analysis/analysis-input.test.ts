import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisInputHash,
  renderRowForAnalysis,
  type AnalysisInputRow,
} from "@china/ai";

/**
 * Il testo inviato a Claude è due cose insieme: ciò che il modello legge e la
 * chiave della cache. Da qui due obblighi che questi test tengono fermi.
 *
 * 1. **Deve contenere solo la merce.** Richiedente, reparto, centro di costo e
 *    firme non escono mai da questo server. Non è una preferenza: è il motivo
 *    per cui la fase può girare su fogli aziendali reali.
 * 2. **Deve essere stabile.** Se lo stesso prodotto producesse due testi
 *    diversi, la cache non colpirebbe mai e ogni analisi verrebbe ripagata.
 */

function row(overrides: Partial<AnalysisInputRow> = {}): AnalysisInputRow {
  return {
    rowIndex: 6,
    name: "平板灯",
    spec: "Specifiche: 60*60",
    usage: "办公室平板灯更换",
    quantity: "10",
    unit: "个",
    declaredTitle: null,
    referenceUrl: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Cosa viene inviato                                                          */
/* -------------------------------------------------------------------------- */

test("il testo inviato contiene i campi prodotto, etichettati", () => {
  const text = renderRowForAnalysis(row());

  assert.match(text, /^Nome: 平板灯$/m);
  assert.match(text, /^Specifiche: Specifiche: 60\*60$/m);
  assert.match(text, /^Utilizzo: 办公室平板灯更换$/m);
  assert.match(text, /^Quantità: 10$/m);
  assert.match(text, /^Unità: 个$/m);
});

test("i campi vuoti spariscono invece di diventare righe vuote", () => {
  const text = renderRowForAnalysis(
    row({ spec: null, usage: null, quantity: null, unit: null })
  );

  assert.equal(text, "Nome: 平板灯");
});

test("titolo indicato e link compaiono solo quando ci sono", () => {
  const withExtras = renderRowForAnalysis(
    row({
      declaredTitle: "防静电PU发泡升降凳子 防静电椅子",
      referenceUrl: "https://example.tmall.com/item/1",
    })
  );

  assert.match(withExtras, /^Titolo indicato: 防静电PU发泡升降凳子 防静电椅子$/m);
  assert.match(withExtras, /^Link: https:\/\/example\.tmall\.com\/item\/1$/m);
  assert.doesNotMatch(renderRowForAnalysis(row()), /Titolo indicato|Link/);
});

test("il numero di riga non entra nel testo", () => {
  // Se ci entrasse, la stessa richiesta in due file diversi avrebbe due
  // impronte diverse e la cache non servirebbe a niente.
  const sixth = renderRowForAnalysis(row({ rowIndex: 6 }));
  const ninetieth = renderRowForAnalysis(row({ rowIndex: 90 }));

  assert.equal(sixth, ninetieth);
});

/* -------------------------------------------------------------------------- */
/* Stabilità della chiave di cache                                             */
/* -------------------------------------------------------------------------- */

test("la stessa riga produce sempre la stessa impronta", () => {
  assert.equal(
    analysisInputHash(renderRowForAnalysis(row())),
    analysisInputHash(renderRowForAnalysis(row()))
  );
});

test("gli spazi di contorno non cambiano l'impronta", () => {
  const clean = analysisInputHash(renderRowForAnalysis(row({ name: "平板灯" })));
  const padded = analysisInputHash(renderRowForAnalysis(row({ name: "  平板灯  " })));

  assert.equal(clean, padded);
});

test("un prodotto diverso produce un'impronta diversa", () => {
  const sixty = analysisInputHash(renderRowForAnalysis(row({ spec: "60*60" })));
  const thirty = analysisInputHash(renderRowForAnalysis(row({ spec: "30*30" })));

  assert.notEqual(sixty, thirty);
});

test("l'impronta è esadecimale e di lunghezza fissa", () => {
  assert.match(analysisInputHash(renderRowForAnalysis(row())), /^[0-9a-f]{32}$/);
});

/* -------------------------------------------------------------------------- */
/* Riservatezza                                                                */
/* -------------------------------------------------------------------------- */

test("i dati amministrativi del foglio non hanno un campo in cui entrare", () => {
  // `AnalysisInputRow` è deliberatamente chiuso: richiedente, reparto, centro
  // di costo, firma del responsabile e prezzo interno non hanno un posto dove
  // stare, quindi non possono finire nella chiamata per distrazione.
  const text = renderRowForAnalysis(
    row({
      name: "防静电椅子",
      spec: "铝合金脚 高度43-64CM 脚垫",
      usage: "部分工位需要使用",
    })
  );

  for (const forbidden of ["吴东洋", "生产部", "0350产线", "含税单价", "部门经理签字"]) {
    assert.doesNotMatch(text, new RegExp(forbidden));
  }
});

/* -------------------------------------------------------------------------- */
/* Righe gemelle                                                               */
/* -------------------------------------------------------------------------- */

test("due righe identiche in fogli diversi hanno la stessa impronta", () => {
  // È il caso che dimezza il costo sui fogli reali: un foglio di riepilogo che
  // ripete i reparti. Se le impronte non coincidessero, ogni riga verrebbe
  // pagata due volte.
  const reparto = analysisInputHash(
    renderRowForAnalysis(row({ rowIndex: 12, name: "陶瓷针规", spec: "10mm" }))
  );
  const riepilogo = analysisInputHash(
    renderRowForAnalysis(row({ rowIndex: 340, name: "陶瓷针规", spec: "10mm" }))
  );

  assert.equal(reparto, riepilogo);
});

test("righe che differiscono solo per la quantità NON sono gemelle", () => {
  // La quantità viaggia nel testo inviato: due richieste dello stesso prodotto
  // con quantità diverse restano due analisi. È corretto — `requestedQuantity`
  // fa parte del risultato — ed è il prezzo da pagare per non sbagliarla.
  const dieci = analysisInputHash(renderRowForAnalysis(row({ quantity: "10" })));
  const cento = analysisInputHash(renderRowForAnalysis(row({ quantity: "100" })));

  assert.notEqual(dieci, cento);
});

test("l'utilizzo diverso separa due righe altrimenti uguali", () => {
  const ufficio = analysisInputHash(
    renderRowForAnalysis(row({ usage: "办公室平板灯更换" }))
  );
  const bagno = analysisInputHash(
    renderRowForAnalysis(row({ usage: "卫生间平板灯更换" }))
  );

  assert.notEqual(ufficio, bagno);
});
