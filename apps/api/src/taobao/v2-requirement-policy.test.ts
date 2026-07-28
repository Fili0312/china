import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROCUREMENT, type ProductAnalysis } from "@china/shared";
import {
  buildV2RetryQueries,
  deriveV2RequirementContext,
  executeV2RetryPlan,
  isV2CandidateCompatible,
  isV2NoCompatibleReason,
  normalizeV2Analysis,
  repairV2SearchQuery,
  v2NoCompatibleReason,
} from "./v2-requirement-policy";

function analysis(patch: Partial<ProductAnalysis> = {}): ProductAnalysis {
  return {
    productFamily: "calibro a spillo",
    familyKey: "pin-gauge",
    variantKey: "base",
    productNameChinese: "针规",
    productNameEnglish: "pin gauge",
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
    searchQueryChinese: "针规",
    searchQueryEnglish: "pin gauge",
    confidence: 0.9,
    procurement: DEFAULT_PROCUREMENT,
    warnings: [],
    ...patch,
  };
}

function candidate(patch: Record<string, unknown> = {}) {
  return {
    title: "高精度针规 2.48mm",
    titleEn: "precision pin gauge 2.48 mm",
    sku: null,
    shopName: "工业量具店",
    specs: null,
    variants: null,
    moq: 1,
    ...patch,
  };
}

test("una query numerica corrotta viene ricostruita dal valore e dall'unità originali", () => {
  const source = [
    "Nome: Pin gauge",
    "Specifiche: diametro 2,48 mm",
  ].join("\n");
  const raw = analysis({
    searchQueryChinese: "针规 2.84mm",
    dimensions: [
      { axis: "diameter", label: null, value: 2.84, unit: "mm" },
    ],
  });

  const normalized = normalizeV2Analysis(raw, source);
  assert.match(normalized.analysis.searchQueryChinese ?? "", /2\.48mm/u);
  assert.doesNotMatch(normalized.analysis.searchQueryChinese ?? "", /2\.84/u);
  assert.deepEqual(normalized.analysis.dimensions, []);
  assert.ok(
    normalized.context.inferred.some((entry) => entry.includes("dimension:2.84mm"))
  );
});

test("modello, quantità e unità espliciti prevalgono sui valori dedotti dal modello", () => {
  const source = [
    "Nome: Industrial controller AX-40",
    "Specifiche: Modello/codice: AX-40",
    "Quantità: 25",
    "Unità: pezzi",
  ].join("\n");
  const normalized = normalizeV2Analysis(
    analysis({
      productFamily: "controller industriale",
      productNameChinese: "工业控制器",
      model: "AX-04",
      requestedQuantity: 250,
      unit: "scatole",
      searchQueryChinese: "工业控制器 AX-04",
    }),
    source
  );

  assert.equal(normalized.analysis.model, "AX-40");
  assert.equal(normalized.analysis.requestedQuantity, 25);
  assert.equal(normalized.analysis.unit, "pezzi");
  assert.match(normalized.analysis.searchQueryChinese ?? "", /AX-40/u);
  assert.doesNotMatch(normalized.analysis.searchQueryChinese ?? "", /AX-04/u);
  assert.deepEqual(normalized.context.quantity, { value: 25, unit: "pezzi" });
});

test("attributi opzionali non richiesti non generano vincoli o falsi warning", () => {
  const source = "Nome: Pannello LED 60x60";
  const normalized = normalizeV2Analysis(
    analysis({
      productFamily: "pannello led",
      productNameChinese: "平板灯",
      material: "alluminio",
      color: "bianco",
      model: "PL-6060",
      warnings: [
        { code: "AMBIGUOUS_MODEL", field: "model", message: "modello mancante" },
        { code: "MISSING_INFO", field: "color", message: "colore mancante" },
        { code: "AMBIGUOUS_UNIT", field: "dimensions", message: "unità assente" },
      ],
    }),
    source
  );

  assert.equal(normalized.analysis.model, null);
  assert.equal(normalized.analysis.material, null);
  assert.equal(normalized.analysis.color, null);
  assert.deepEqual(
    normalized.analysis.warnings.map((warning) => warning.code),
    ["AMBIGUOUS_UNIT"]
  );
  assert.ok(normalized.context.inferred.includes("model:PL-6060"));
  assert.ok(normalized.context.inferred.includes("material:alluminio"));
  assert.ok(normalized.context.inferred.includes("color:bianco"));
});

test("il contesto separa vincoli espliciti senza includere quantità nella query prodotto", () => {
  const context = deriveV2RequirementContext(
    analysis({ model: "ZX-7" }),
    [
      "Nome: Sensore ZX-7 24 V",
      "Specifiche: Modello/codice: ZX-7",
      "Quantità: 100",
      "Unità: pezzi",
      "Link: https://item.taobao.com/item.htm?id=99887766",
    ].join("\n")
  );

  assert.ok(context.explicit.includes("model:ZX-7"));
  assert.ok(context.explicit.includes("constraint:24v"));
  assert.ok(context.explicit.includes("quantity:100 pezzi"));
  assert.ok(!context.immutableSearchTokens.includes("100"));
  assert.ok(!context.immutableSearchTokens.includes("99887766"));
});

test("il full-row senza note resta nel contesto ma i numeri amministrativi non diventano vincoli", () => {
  const context = deriveV2RequirementContext(
    analysis(),
    [
      "Nome: Pin gauge 2.48 mm",
      "Utilizzo: Contesto completo della riga:",
      "Cella 1: Pin gauge 2.48 mm",
      "Cella 8: prezzo target 999",
      "Cella 9: centro costo 7788",
    ].join("\n")
  );

  assert.match(context.sourceText, /prezzo target 999/u);
  assert.ok(context.immutableSearchTokens.includes("2.48mm"));
  assert.ok(!context.immutableSearchTokens.includes("999"));
  assert.ok(!context.immutableSearchTokens.includes("7788"));
});

test("caratteristiche testuali esplicite restano vincoli senza falsi scarti cross-lingua", () => {
  const context = deriveV2RequirementContext(
    analysis({
      material: "stainless steel",
      hardRequirements: ["must be waterproof"],
    }),
    [
      "Nome: Industrial enclosure",
      "Specifiche: Materiale: stainless steel",
      "Utilizzo: must be waterproof",
    ].join("\n")
  );

  assert.ok(context.explicit.includes("feature:stainless steel"));
  assert.ok(context.explicit.includes("feature:must be waterproof"));
  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "stainless steel waterproof industrial enclosure",
        titleEn: null,
      }),
      context
    ),
    true
  );
  assert.equal(
    isV2CandidateCompatible(
      candidate({ title: "不锈钢防水工业外壳", titleEn: null }),
      context
    ),
    true
  );
});

test("le query di retry si semplificano progressivamente e non contengono parole-metadato", () => {
  const a = analysis({
    productNameChinese: "工业传感器",
    productNameEnglish: "industrial sensor",
    productFamily: "sensore industriale",
    model: "ZX-7",
    searchQueryChinese: "工业传感器 ZX-7 24V",
  });
  const context = deriveV2RequirementContext(
    a,
    [
      "Nome: Industrial sensor ZX-7 24 V",
      "Specifiche: Modello/codice: ZX-7",
    ].join("\n")
  );
  const queries = buildV2RetryQueries({
    analysis: a,
    context,
    previousQuery: "工业传感器 ZX-7 24V",
    proposedQuery: "工业传感器 ZX-9 12V",
  });

  assert.equal(queries.length, 3);
  // Il modello resta in tutti i tentativi: è l'identificativo del prodotto.
  // I valori proposti in conflitto con la riga non entrano mai.
  for (const query of queries) {
    assert.match(query, /ZX-7/u);
    assert.doesNotMatch(query, /ZX-9|12V/u);
  }
  // I tentativi precisi portano anche l'unità; l'ultimo è volutamente largo.
  assert.match(queries[0]!.toLowerCase(), /24v/u);
  assert.doesNotMatch(queries.at(-1)!.toLowerCase(), /24v/u);
  // Nessuna parola-metadato: chiederebbe al marketplace i titoli che
  // contengono "SKU/specifiche/produttore", che per costruzione non esistono.
  for (const query of queries) {
    assert.doesNotMatch(query, /SKU|规格|厂家|型号/u);
  }
});

test("il retry continua su risultati incompatibili e usa un provider simulato", async () => {
  const a = analysis();
  const context = deriveV2RequirementContext(
    a,
    "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm"
  );
  const queries = buildV2RetryQueries({
    analysis: a,
    context,
    previousQuery: "针规 2.48mm",
  });
  const seen: string[] = [];

  const outcome = await executeV2RetryPlan(
    queries,
    async (query) => {
      seen.push(query);
      // Il primo tentativo porta solo una misura sbagliata: il gate la scarta
      // e la scala prosegue fino all'ultimo gradino, che trova il pezzo giusto.
      if (seen.length === 1) {
        return {
          products: [candidate({ title: "高精度针规 2.84mm", titleEn: null })],
          calls: 1,
        };
      }
      if (seen.length < queries.length) return { products: [], calls: 1 };
      return { products: [candidate()], calls: 1 };
    },
    (product) => isV2CandidateCompatible(product, context)
  );

  assert.equal(outcome.products.length, 1);
  assert.equal(outcome.calls, queries.length);
  assert.deepEqual(outcome.attemptedQueries, seen);
});

test("il retry si ferma appena un tentativo porta candidati validi", async () => {
  const queries = ["query-base", "query-sinonimo", "query-larga"];
  const outcome = await executeV2RetryPlan(
    queries,
    async (query) => ({
      products: [{ query, title: query === queries[0] ? "plastic" : "steel" }],
      calls: 1,
    }),
    () => true
  );

  // L'ampiezza la dà la scala del provider dentro la singola query: insistere
  // con i sinonimi qui costerebbe chiamate senza aggiungere copertura.
  assert.equal(outcome.calls, 1);
  assert.deepEqual(outcome.attemptedQueries, [queries[0]]);
  assert.equal(outcome.products.length, 1);
});

test("un errore su una query non impedisce il recupero dai tentativi successivi", async () => {
  const queries = ["query-guasta", "query-valida", "query-venditore"];
  const outcome = await executeV2RetryPlan(
    queries,
    async (query) => {
      if (query === "query-guasta") throw new Error("provider unavailable");
      return {
        products: query === "query-valida" ? [{ id: "recovered" }] : [],
        calls: 1,
      };
    },
    () => true
  );

  // Il guasto non conta come tentativo riuscito: si prosegue e ci si ferma
  // sul primo che porta davvero qualcosa.
  assert.deepEqual(outcome.attemptedQueries, ["query-guasta", "query-valida"]);
  assert.deepEqual(outcome.products, [{ id: "recovered" }]);
  assert.equal(outcome.calls, 1);
});

test("SKU, varianti e MOQ vengono usati per la compatibilità esplicita", () => {
  const a = analysis({ model: "ZX-7" });
  const context = deriveV2RequirementContext(
    a,
    [
      "Nome: Sensore ZX-7 24 V",
      "Specifiche: Modello/codice: ZX-7",
      "Quantità: 10",
      "Unità: pezzi",
    ].join("\n")
  );

  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "工业传感器",
        titleEn: null,
        sku: "ZX-7",
        variants: [{ name: "电压", options: ["24V"] }],
        moq: 5,
      }),
      context
    ),
    true
  );
  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "工业传感器",
        titleEn: null,
        sku: "ZX-7",
        variants: [{ name: "电压", options: ["24V"] }],
        moq: 20,
      }),
      context
    ),
    false
  );
});

test("la compatibilità accetta unità equivalenti senza alterare la query originale", () => {
  const a = analysis();
  const context = deriveV2RequirementContext(
    a,
    "Nome: Asta telescopica\nSpecifiche: lunghezza 1.5 m"
  );
  assert.ok(context.immutableSearchTokens.includes("1.5m"));
  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "伸缩杆 1500mm",
        titleEn: "telescopic rod 1500 mm",
      }),
      context
    ),
    true
  );
  // Una query valida resta **identica**, come nella v1: i vincoli non le
  // vengono appesi, perché il marketplace cerca i termini in AND e una query
  // fatta di numeri non trova niente. Verificarli è compito del gate.
  assert.equal(repairV2SearchQuery("针规", a, context), "针规");
});

test("dimensioni composte e grandezze fisiche equivalenti sono risolte automaticamente", () => {
  const a = analysis();
  const context = deriveV2RequirementContext(
    a,
    [
      "Nome: Pannello industriale",
      "Specifiche: dimensioni 60x60 cm, pressione 1 bar, frequenza 50 Hz, corrente 2 A",
    ].join("\n")
  );

  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "工业面板 600x600mm 100kPa 0.05kHz 2000mA",
        titleEn: null,
      }),
      context
    ),
    true
  );
  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "工业面板 600x500mm 100kPa 0.05kHz 2000mA",
        titleEn: null,
      }),
      context
    ),
    false
  );
});

test("unità cinesi equivalenti non vengono scartate dal gate deterministico", () => {
  const context = deriveV2RequirementContext(
    analysis(),
    [
      "Nome: Alimentatore industriale",
      "Specifiche: 24 V, 2 A, 50 Hz, 100 kPa",
    ].join("\n")
  );

  assert.equal(
    isV2CandidateCompatible(
      candidate({
        title: "工业电源 24伏 2000毫安 50赫兹 1巴",
        titleEn: null,
      }),
      context
    ),
    true
  );
});

test("l'assenza di candidati compatibili ha una classificazione stabile", () => {
  const reason = v2NoCompatibleReason(3);
  assert.equal(isV2NoCompatibleReason(reason), true);
  assert.equal(isV2NoCompatibleReason("nessun prodotto"), false);
  assert.match(reason, /3 tentativi/u);
});

test("una query già corretta resta stabile", () => {
  const a = analysis({ searchQueryChinese: "针规 2.48mm" });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm"
  );
  assert.equal(repairV2SearchQuery("针规 2.48mm", a, context), "针规 2.48mm");
});
