import assert from "node:assert/strict";
import test from "node:test";
import type { ProductAnalysis } from "@china/shared";
import {
  buildV2RetryQueries,
  deriveV2RequirementContext,
  evaluateV2Candidate,
  isV2CandidateCompatible,
  repairV2SearchQuery,
} from "./v2-requirement-policy";

/**
 * I casi di questo file vengono dal foglio reale del 26/07/2026, dove il gate
 * deterministico aveva scartato 221 candidati su 238 prima che l'IA li vedesse.
 * La regola che si verifica qui è una sola: si scarta una contraddizione, non
 * un silenzio.
 */

function analysis(overrides: Partial<ProductAnalysis> = {}): ProductAnalysis {
  return {
    productFamily: "prodotto",
    familyKey: "prodotto",
    variantKey: "base",
    productNameChinese: "产品",
    productNameEnglish: "product",
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
    searchQueryChinese: "产品",
    searchQueryEnglish: "product",
    confidence: 0.9,
    warnings: [],
    ...overrides,
  };
}

function candidate(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    titleEn: null,
    sku: null,
    shopName: null,
    specs: null,
    variants: null,
    moq: null,
    ...extra,
  };
}

test("una misura assente dal titolo è UNKNOWN, non un'incompatibilità", () => {
  const context = deriveV2RequirementContext(
    analysis({
      productFamily: "sedia antistatica",
      familyKey: "esd-chair",
      productNameChinese: "防静电椅子",
      searchQueryChinese: "防静电椅子 铝合金脚 高度43-64CM",
    }),
    "Nome: Sedia antistatica\nSpecifiche: gambe in alluminio, altezza 43-64 cm"
  );

  // Il titolo reale di Taobao: prodotto giusto, nessuna misura dichiarata.
  const evaluation = evaluateV2Candidate(
    candidate("厂家防静电椅子靠背升降软垫防静电椅子铝合金脚轮pu车间工作椅"),
    context
  );

  assert.equal(evaluation.status, "unknown");
  assert.equal(evaluation.conflicts.length, 0);
  assert.ok(evaluation.unresolved.length > 0);
  // Deve restare in gioco: è il candidato che prima veniva buttato via.
  assert.equal(isV2CandidateCompatible(candidate("厂家防静电椅子铝合金脚轮"), context), true);
});

test("un gruppo dimensionale diverso nel titolo è un conflitto esplicito", () => {
  const context = deriveV2RequirementContext(
    analysis({
      productFamily: "pannello led",
      familyKey: "led-panel",
      productNameChinese: "平板灯",
      searchQueryChinese: "平板灯 60*60",
    }),
    "Nome: Pannello LED\nSpecifiche: 60*60"
  );

  const evaluation = evaluateV2Candidate(
    candidate("集成吊顶led灯嵌入式30x60平板灯厨房卫生间浴室铝扣板吸顶灯阳台"),
    context
  );

  assert.equal(evaluation.status, "conflict");
  assert.ok(evaluation.conflicts.length > 0);
});

test("una misura di arietà diversa non è confrontabile e non genera conflitto", () => {
  const context = deriveV2RequirementContext(
    analysis({ productNameChinese: "平板灯", searchQueryChinese: "平板灯 60x60" }),
    "Nome: Pannello\nSpecifiche: 60x60"
  );

  // 30x30x60 è una grandezza a tre assi: non dice nulla su un 60x60.
  const evaluation = evaluateV2Candidate(candidate("集成吊顶led灯30x30x60厨房"), context);

  assert.notEqual(evaluation.status, "conflict");
});

test("uno scalare con unità confligge solo se il titolo ne espone uno solo", () => {
  const context = deriveV2RequirementContext(
    analysis({
      productFamily: "calibro a spillo",
      familyKey: "pin-gauge",
      productNameChinese: "针规",
      searchQueryChinese: "针规 2.48mm",
    }),
    "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm"
  );

  // Una sola misura confrontabile e diversa: l'inserzione è di un'altra taglia.
  assert.equal(
    evaluateV2Candidate(candidate("高精度针规 2.84mm"), context).status,
    "conflict"
  );
  // Più misure diverse: non si sa quale identifichi il prodotto.
  assert.notEqual(
    evaluateV2Candidate(candidate("针规套装 2.84mm 3.10mm 4.00mm 收纳盒"), context).status,
    "conflict"
  );
});

test("un numero senza unità non genera mai conflitto", () => {
  const context = deriveV2RequirementContext(
    analysis({ productNameChinese: "货架", searchQueryChinese: "货架 300kg 4层" }),
    "Nome: Scaffale\nSpecifiche: 4 ripiani"
  );

  const evaluation = evaluateV2Candidate(
    candidate("货架 珍珠白 5层 主架 加厚 中型 2026"),
    context
  );

  assert.equal(evaluation.conflicts.length, 0);
});

test("un intervallo dichiarato dal venditore copre la misura richiesta", () => {
  const context = deriveV2RequirementContext(
    analysis({ productNameChinese: "升降椅", searchQueryChinese: "升降椅 50cm" }),
    "Nome: Sedia regolabile\nSpecifiche: altezza 50 cm"
  );

  const evaluation = evaluateV2Candidate(
    candidate("人体工学升降椅 高度43-64cm 可调节"),
    context
  );

  assert.equal(evaluation.status, "match");
  assert.equal(evaluation.unresolved.length, 0);
});

test("il MOQ oltre il fabbisogno resta un conflitto", () => {
  const context = deriveV2RequirementContext(
    analysis({ requestedQuantity: 10, unit: "pcs", productNameChinese: "螺丝" }),
    "Nome: Vite\nQuantità: 10\nUnità: pcs"
  );

  const evaluation = evaluateV2Candidate(candidate("螺丝", { moq: 500 }), context);

  assert.equal(evaluation.status, "conflict");
  assert.ok(evaluation.conflicts.some((entry) => entry.startsWith("moq:")));
});

test("le specifiche lette dalla scheda risolvono un UNKNOWN senza IA", () => {
  const context = deriveV2RequirementContext(
    analysis({
      productFamily: "sedia antistatica",
      productNameChinese: "防静电椅子",
      searchQueryChinese: "防静电椅子 高度64cm",
    }),
    "Nome: Sedia antistatica\nSpecifiche: altezza 64 cm"
  );

  const titleOnly = candidate("厂家防静电椅子靠背升降软垫铝合金脚轮");
  assert.equal(evaluateV2Candidate(titleOnly, context).status, "unknown");

  // Stesso prodotto, ma con la scheda letta: la misura ora è verificabile.
  const withDetail = candidate("厂家防静电椅子靠背升降软垫铝合金脚轮", {
    specs: { 高度: "64cm", 材质: "铝合金" },
  });
  assert.equal(evaluateV2Candidate(withDetail, context).status, "match");
});

test("la scheda può anche rivelare un conflitto che il titolo nascondeva", () => {
  const context = deriveV2RequirementContext(
    analysis({ productNameChinese: "平板灯", searchQueryChinese: "平板灯 60x60cm" }),
    "Nome: Pannello\nSpecifiche: 60x60 cm"
  );

  const withDetail = candidate("集成吊顶led平板灯", {
    specs: { 尺寸: "30x60cm" },
  });

  assert.equal(evaluateV2Candidate(withDetail, context).status, "conflict");
});

/**
 * La ricerca della v2 deve comportarsi come quella della v1: la query
 * dell'analisi si usa così com'è. Gli esempi sono le query realmente prodotte
 * dal foglio del 26/07/2026, quando ogni vincolo veniva appeso alla query.
 */

test("una query valida dell'analisi non viene alterata", () => {
  const a = analysis({
    productFamily: "scaffale",
    familyKey: "shelf",
    productNameChinese: "货架",
    searchQueryChinese: "货架 珍珠白 4层 中型",
  });
  const context = deriveV2RequirementContext(
    a,
    [
      "Nome: Scaffale",
      "Specifiche: 4 ripiani, 200x40x140, 300KG/ripiano",
      "Quantità: 4",
    ].join("\n")
  );

  const query = repairV2SearchQuery("货架 珍珠白 4层 中型", a, context);

  assert.equal(query, "货架 珍珠白 4层 中型");
  // La query che il marketplace non trovava mai: un elenco di numeri in AND.
  assert.doesNotMatch(query, /200\s*40\s*140/u);
});

test("la ricostruzione scarta codici e quantità, tiene le misure", () => {
  const a = analysis({
    productFamily: "peso campione",
    familyKey: "weight",
    productNameChinese: "砝码",
    searchQueryChinese: "砝码 400g",
    requestedQuantity: 2,
    unit: "pcs",
  });
  const context = deriveV2RequirementContext(
    a,
    [
      "Nome: Peso campione M1",
      "Specifiche: 400g cromato, codici 0350 0360",
      "Quantità: 2",
      "Unità: pcs",
    ].join("\n")
  );

  // Proposta con un numero che contraddice la riga: va ricostruita.
  const query = repairV2SearchQuery("砝码 900g", a, context);

  assert.match(query, /砝码/u);
  assert.match(query, /400g/u);
  // I codici articolo non sono termini di ricerca.
  assert.doesNotMatch(query, /0350|0360/u);
  // Nemmeno la quantità ordinata.
  assert.doesNotMatch(query, /\b2\b/u);
});

test("la scala di retry resta corta e leggibile", () => {
  const a = analysis({
    productFamily: "calibro a spillo",
    familyKey: "pin-gauge",
    productNameChinese: "针规",
    productNameEnglish: "pin gauge",
    searchQueryChinese: "针规 2.48mm",
  });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm"
  );

  const queries = buildV2RetryQueries({
    analysis: a,
    context,
    previousQuery: "针规 2.48mm",
  });

  assert.ok(queries.length <= 3);
  assert.equal(queries[0], "针规 2.48mm");
  // Nessun tentativo trasformato in elenco di token.
  for (const query of queries) {
    assert.ok(query.split(/\s+/u).length <= 4, `query troppo lunga: ${query}`);
  }
});
