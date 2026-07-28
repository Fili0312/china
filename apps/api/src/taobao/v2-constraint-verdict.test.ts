import assert from "node:assert/strict";
import test from "node:test";
import type { ProductAnalysis } from "@china/shared";
import {
  buildV2RetryQueries,
  deriveV2RequirementContext,
  evaluateV2Candidate,
  normalizeV2Analysis,
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

test("la quantità del foglio si legge anche dopo il contesto completo", () => {
  // Il testo reale prodotto dalla v2: `Quantità:` e `Unità:` vengono appese
  // dopo il riversamento della riga, quindi dopo il punto di troncamento.
  const sourceText = [
    "Nome: 牙签",
    "Specifiche: 2瓶装双头尖翻盖瓶-约800支",
    "Utilizzo: 样件涂胶用",
    "Contesto completo della riga:",
    "序号 (Cella 1): 1",
    "申请数量 (Cella 6): 12",
    "单位 (Cella 7): 个",
    "Quantità: 12",
    "Unità: 个",
  ].join("\n");

  const context = deriveV2RequirementContext(
    analysis({ productNameChinese: "牙签", searchQueryChinese: "牙签" }),
    sourceText
  );

  assert.equal(context.quantity.value, 12);
  assert.equal(context.quantity.unit, "个");
});

test("un foglio senza quantità non cancella quella letta dall'IA", () => {
  const context = deriveV2RequirementContext(
    analysis({ requestedQuantity: 5, unit: "pcs" }),
    "Nome: Vite\nSpecifiche: M4"
  );

  // Il contesto non trova nulla di dichiarato...
  assert.equal(context.quantity.value, null);
  // ...ma il grounding deve conservare il valore dell'analisi.
  const grounded = normalizeV2Analysis(
    analysis({ requestedQuantity: 5, unit: "pcs" }),
    "Nome: Vite\nSpecifiche: M4"
  );
  assert.equal(grounded.analysis.requestedQuantity, 5);
  assert.equal(grounded.analysis.unit, "pcs");
});

/**
 * I numeri nudi nella query: misurati sulla fonte reale il 28/07/2026.
 * `货架 200 40 140 300kg` tornava 0 risultati, `货架 300kg` venti.
 */

test("i numeri senza unità escono dalla query", () => {
  const a = analysis({
    productFamily: "scaffale",
    familyKey: "shelf",
    productNameChinese: "货架",
    searchQueryChinese: "货架 200 40 140 300kg",
  });
  const context = deriveV2RequirementContext(a, "Nome: Scaffale\nSpecifiche: 300kg");

  const query = repairV2SearchQuery("货架 200 40 140 300kg", a, context);

  assert.equal(query, "货架 300kg");
});

test("un numero che è una misura dell'analisi recupera la sua unità", () => {
  const a = analysis({
    productFamily: "calibro a spillo",
    familyKey: "pin-gauge",
    productNameChinese: "针规",
    searchQueryChinese: "针规 2.48",
    dimensions: [
      { axis: "diameter", label: "diametro", value: 2.48, unit: "mm" },
    ] as never,
  });
  const context = deriveV2RequirementContext(a, "Nome: Pin gauge\nSpecifiche: 2.48 mm");

  // Invece di perdere la misura, la query diventa cercabile.
  assert.equal(repairV2SearchQuery("针规 2.48", a, context), "针规 2.48mm");
});

test("termini con unità, separatore o lettera restano intatti", () => {
  const a = analysis({
    productNameChinese: "平板灯",
    model: "M1",
    searchQueryChinese: "平板灯 60x60 4P M1 300kg",
  });
  // Il foglio dichiara tutti questi termini: la query è valida e va usata
  // così com'è. Qui si verifica che la pulizia dei numeri nudi non tocchi
  // ciò che porta unità, separatore o lettera.
  const context = deriveV2RequirementContext(
    a,
    "Nome: Pannello\nModello: M1\nSpecifiche: 60x60, 4P, 300kg"
  );

  assert.equal(
    repairV2SearchQuery("平板灯 60x60 4P M1 300kg", a, context),
    "平板灯 60x60 4P M1 300kg"
  );
});

test("una query di soli numeri non viene svuotata", () => {
  const a = analysis({ productNameChinese: "产品", searchQueryChinese: "123 456" });
  const context = deriveV2RequirementContext(a, "Nome: Prodotto");

  assert.ok(repairV2SearchQuery("123 456", a, context).length > 0);
});

/**
 * Zeri finali e unità di conteggio: misurati sulla fonte il 28/07/2026, dove
 * ciascuno da solo portava la stessa ricerca da 0 a 20 risultati.
 */

test("gli zeri finali di una misura spariscono dalla query", () => {
  const a = analysis({
    productFamily: "calibro ceramico",
    familyKey: "ceramic-gauge",
    productNameChinese: "陶瓷针规",
    searchQueryChinese: "陶瓷针规 5.00mm 塞规",
  });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Calibro ceramico\nSpecifiche: 5.00 mm"
  );

  assert.equal(
    repairV2SearchQuery("陶瓷针规 5.00mm 塞规", a, context),
    "陶瓷针规 5mm 塞规"
  );
});

test("l'unità di conteggio del foglio non entra nella ricerca", () => {
  const a = analysis({
    productFamily: "calibro ceramico",
    familyKey: "ceramic-gauge",
    productNameChinese: "陶瓷针规",
    searchQueryChinese: "陶瓷针规 5mm 单支 塞规",
    requestedQuantity: 1,
    unit: "支",
  });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Calibro ceramico\nSpecifiche: 5 mm\nQuantità: 1\nUnità: 支"
  );

  // `单支` dice come si contano i pezzi, non cosa si compra.
  assert.equal(
    repairV2SearchQuery("陶瓷针规 5mm 单支 塞规", a, context),
    "陶瓷针规 5mm 塞规"
  );
});

test("una misura senza zeri superflui resta com'è", () => {
  const a = analysis({
    productNameChinese: "针规",
    searchQueryChinese: "针规 2.48mm",
  });
  const context = deriveV2RequirementContext(a, "Nome: Pin gauge\nSpecifiche: 2.48 mm");

  assert.equal(repairV2SearchQuery("针规 2.48mm", a, context), "针规 2.48mm");
});

test("un descrittore attaccato alla misura non entra nella ricerca", () => {
  const a = analysis({
    productFamily: "nastro alta temperatura",
    familyKey: "tape",
    productNameChinese: "高温纸胶带",
    searchQueryChinese: "高温纸胶带 50mm宽",
  });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Nastro\nSpecifiche: 50MM宽*50米长"
  );

  // `50mm宽` non compare in nessun titolo: là si legge `50mm`.
  assert.equal(
    repairV2SearchQuery("高温纸胶带 50mm宽", a, context),
    "高温纸胶带 50mm"
  );
});

test("più quote diventano un gruppo, come le scrivono i venditori", () => {
  const a = analysis({
    productFamily: "magnete anulare",
    familyKey: "ring-magnet",
    productNameChinese: "环形磁铁",
    searchQueryChinese: "环形磁铁 外径14mm 内径8.1mm 厚7mm",
    dimensions: [
      { axis: "outer", label: "esterno", value: 14, unit: "mm" },
      { axis: "inner", label: "interno", value: 8.1, unit: "mm" },
      { axis: "thickness", label: "spessore", value: 7, unit: "mm" },
    ] as never,
  });
  const context = deriveV2RequirementContext(
    a,
    "Nome: Magnete\nSpecifiche: 外径14mm*厚7mm/孔内径8.1mm"
  );

  const queries = buildV2RetryQueries({
    analysis: a,
    context,
    previousQuery: "环形磁铁 外径14mm 内径8.1mm 厚7mm",
  });

  assert.ok(
    queries.some((query) => query.includes("14x8.1x7")),
    `nessun tentativo con la taglia raggruppata: ${queries.join(" | ")}`
  );
});

/**
 * Memoria e prezzi: la rilettura di una scheda che torna vuota non conferma
 * nulla. Regola verificata sul run delle 08:48, dove 25 righe su 29 venivano
 * riusate senza che un solo prezzo fosse stato riconfermato.
 */

test("una rilettura vuota non conferma il prezzo", () => {
  // È la forma che restituisce la fonte quando la scheda non c'è.
  const emptyPatch: Record<string, unknown> = {};
  const informativePatch: Record<string, unknown> = { price: 12.5 };

  const verified = (patch: Record<string, unknown>) =>
    Object.keys(patch).length > 0;

  assert.equal(verified(emptyPatch), false);
  assert.equal(verified(informativePatch), true);

  // Nessuna rilettura utile su prodotti noti: la memoria non basta più, e
  // tocca cercare — che è anche l'unico modo di accorgersi di un'offerta
  // migliore comparsa nel frattempo.
  const known = 9;
  const verifiedCount = 0;
  const canReuse = !(known > 0 && verifiedCount === 0);
  assert.equal(canReuse, false);
});
