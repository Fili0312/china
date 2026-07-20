import assert from "node:assert/strict";
import test from "node:test";
import { extractRequirements } from "@china/shared";
import {
  checkRequirements,
  evaluateCandidate,
  selectFinalists,
  type CandidateForSelection,
  type StoredEvaluation,
} from "./selection";

function candidate(
  overrides: Partial<CandidateForSelection> = {}
): CandidateForSelection {
  return {
    candidateId: "c1",
    engine: "yiwugo",
    title: "防静电台垫 长200*宽40 绿色",
    price: 30,
    currency: "CNY",
    moq: 1,
    rating: 4.5,
    reviewCount: 40,
    totalSales: 300,
    relevanceScore: 70,
    unavailable: false,
    ...overrides,
  };
}

const requirements = extractRequirements("防静电台垫 长200*宽40").requirements;

const context = {
  request: {
    requirements,
    targetPrice: 40,
    requestedQuantity: 10,
  },
  threshold: 40,
};

test("una misura dichiarata diversa viola il requisito", () => {
  const checks = checkRequirements(
    requirements,
    candidate({ title: "防静电台垫 长400*宽40" })
  );
  const length = checks.find((check) => check.key === "dimension.length");
  assert.equal(length?.outcome, "violated");
});

test("una misura non dichiarata non è una violazione", () => {
  const checks = checkRequirements(
    requirements,
    candidate({ title: "防静电台垫 工业用" })
  );
  assert.deepEqual(
    checks.map((check) => check.outcome),
    ["unverifiable", "unverifiable"]
  );
});

test("un prodotto che viola un requisito obbligatorio viene scartato", () => {
  const evaluation = evaluateCandidate(
    candidate({ title: "防静电台垫 长400*宽40" }),
    context
  );
  assert.equal(evaluation.rejectionCode, "HARD_CONSTRAINT");
  assert.match(evaluation.rejectionReason ?? "", /Dimensione length/);
  assert.equal(evaluation.score, 0);
});

test("un minimo d'ordine superiore alla quantità richiesta scarta il prodotto", () => {
  const evaluation = evaluateCandidate(candidate({ moq: 500 }), context);
  assert.equal(evaluation.rejectionCode, "MOQ_TOO_HIGH");
  assert.match(evaluation.rejectionReason ?? "", /500/);
});

test("un prezzo molto oltre il riferimento scarta il prodotto", () => {
  const evaluation = evaluateCandidate(candidate({ price: 500 }), context);
  assert.equal(evaluation.rejectionCode, "PRICE_OVER_TARGET");
});

test("un prezzo un po' sopra il riferimento resta accettabile", () => {
  // I prezzi arrivano in valute diverse e all'ingrosso: la soglia è larga
  // apposta, altrimenti un semplice cambio valuta scarterebbe prodotti buoni.
  const evaluation = evaluateCandidate(candidate({ price: 60 }), context);
  assert.equal(evaluation.rejectionCode, null);
});

test("un prodotto non più disponibile viene scartato con la sua motivazione", () => {
  const evaluation = evaluateCandidate(candidate({ unavailable: true }), context);
  assert.equal(evaluation.rejectionCode, "UNAVAILABLE");
});

test("i requisiti verificati alzano il punteggio rispetto a quelli ignoti", () => {
  const verified = evaluateCandidate(candidate(), context);
  const unknown = evaluateCandidate(
    candidate({ title: "防静电台垫 工业用" }),
    context
  );
  assert.ok(
    verified.score > unknown.score,
    `verificato ${verified.score} deve battere ignoto ${unknown.score}`
  );
  // Ma l'ignoto non viene azzerato: l'assenza di prova non è prova contraria.
  assert.ok(unknown.score > 40, `punteggio troppo basso: ${unknown.score}`);
});

test("il punteggio è ripartito fra i criteri e resta entro 100", () => {
  const evaluation = evaluateCandidate(candidate(), context);
  assert.deepEqual(Object.keys(evaluation.breakdown).sort(), [
    "moq",
    "price",
    "relevance",
    "reputation",
    "requirements",
  ]);
  const total = Object.values(evaluation.breakdown).reduce((a, b) => a + b, 0);
  assert.ok(total <= 100.001, `somma ${total}`);
  assert.equal(evaluation.score, Math.round(total * 10) / 10);
});

test("il punteggio è deterministico", () => {
  assert.equal(
    evaluateCandidate(candidate(), context).score,
    evaluateCandidate(candidate(), context).score
  );
});

test("i finalisti sono i migliori entro il numero richiesto", () => {
  const outcomes = selectFinalists(
    [
      candidate({ candidateId: "a", relevanceScore: 90 }),
      candidate({ candidateId: "b", relevanceScore: 80, title: "防静电台垫 长200*宽40 蓝色" }),
      candidate({ candidateId: "c", relevanceScore: 70, title: "防静电台垫 长200*宽40 灰色" }),
      // Violazione: non deve entrare in classifica nemmeno con pertinenza alta.
      candidate({ candidateId: "d", relevanceScore: 99, title: "防静电台垫 长900*宽40" }),
    ],
    context,
    2
  );

  const finalists = outcomes.filter((o) => o.outcome === "FINALIST");
  assert.deepEqual(
    finalists.map((o) => o.candidateId),
    ["a", "b"]
  );
  assert.deepEqual(
    finalists.map((o) => o.rank),
    [1, 2]
  );
  assert.equal(
    outcomes.find((o) => o.candidateId === "c")?.outcome,
    "SHORTLISTED"
  );
  const rejected = outcomes.find((o) => o.candidateId === "d");
  assert.equal(rejected?.outcome, "REJECTED");
  assert.equal(rejected?.evaluation.rejectionCode, "HARD_CONSTRAINT");
});

test("lo stesso prodotto su due marketplace viene deduplicato con motivazione", () => {
  const outcomes = selectFinalists(
    [
      candidate({ candidateId: "primo", engine: "yiwugo", relevanceScore: 80 }),
      // Stesso titolo a parole invertite e stesso prezzo: è lo stesso prodotto.
      candidate({
        candidateId: "secondo",
        engine: "chinagoods",
        title: "绿色 长200*宽40 防静电台垫",
        relevanceScore: 60,
      }),
    ],
    context,
    3
  );

  assert.equal(outcomes.find((o) => o.candidateId === "primo")?.outcome, "FINALIST");
  const duplicate = outcomes.find((o) => o.candidateId === "secondo");
  assert.equal(duplicate?.outcome, "REJECTED");
  assert.equal(duplicate?.evaluation.rejectionCode, "DUPLICATE");
});

test("ogni prodotto scartato porta sempre una motivazione leggibile", () => {
  const outcomes = selectFinalists(
    [
      candidate({ candidateId: "a", moq: 9999 }),
      candidate({ candidateId: "b", title: "防静电台垫 长900*宽40" }),
      candidate({ candidateId: "c", unavailable: true }),
      candidate({ candidateId: "d", relevanceScore: 0, price: 39 }),
    ],
    context,
    3
  );

  for (const outcome of outcomes.filter((o) => o.outcome === "REJECTED")) {
    assert.ok(
      outcome.evaluation.rejectionCode,
      `${outcome.candidateId} senza codice di scarto`
    );
    assert.ok(
      (outcome.evaluation.rejectionReason ?? "").length > 10,
      `${outcome.candidateId} senza motivazione leggibile`
    );
  }
});

test("senza prezzo obiettivo e senza quantità i criteri restano neutri", () => {
  const evaluation = evaluateCandidate(candidate({ moq: null, price: null }), {
    request: { requirements, targetPrice: null, requestedQuantity: null },
    threshold: 40,
  });
  assert.equal(evaluation.rejectionCode, null);
  assert.equal(evaluation.breakdown.price, 6);
  assert.equal(evaluation.breakdown.moq, 4);
});

test("un punteggio già calcolato viene riusato invece di essere rifatto", () => {
  const stored = new Map<string, StoredEvaluation>([
    [
      "a",
      {
        // Sopra la soglia, ma sotto ciò che "a" otterrebbe se ricalcolato.
        score: 45,
        breakdown: { relevance: 45 },
        rejectionCode: null,
        rejectionReason: null,
        checks: [],
      },
    ],
  ]);

  const outcomes = selectFinalists(
    [
      candidate({ candidateId: "a", relevanceScore: 95 }),
      candidate({ candidateId: "b", relevanceScore: 50, title: "防静电台垫 长200*宽40 蓝色" }),
    ],
    context,
    2,
    stored
  );

  const reused = outcomes.find((o) => o.candidateId === "a")!;
  // Nonostante la pertinenza altissima, "a" conserva il punteggio salvato…
  assert.equal(reused.evaluation.score, 45);
  assert.equal(reused.scoreReused, true);
  // …e proprio per questo finisce dietro a "b", che è stato ricalcolato.
  assert.equal(reused.rank, 2);

  const fresh = outcomes.find((o) => o.candidateId === "b")!;
  assert.equal(fresh.scoreReused, false);
  assert.equal(fresh.rank, 1);
});

test("senza segnali verificabili nessun prodotto viene proposto come finalista", () => {
  // Caso reale: query cinese su un catalogo con titoli inglesi. La pertinenza
  // è neutra per tutti e nessuna misura è dichiarata: proporre un finalista
  // significherebbe indicare a caso.
  const outcomes = selectFinalists(
    [
      candidate({ candidateId: "a", title: "Air cushion comb", relevanceScore: 52.5 }),
      candidate({ candidateId: "b", title: "Plastic hair comb", relevanceScore: 52.5 }),
    ],
    context,
    2
  );

  assert.equal(outcomes.filter((o) => o.outcome === "FINALIST").length, 0);
  for (const outcome of outcomes) {
    assert.equal(outcome.outcome, "SHORTLISTED");
    assert.match(outcome.evaluation.rejectionReason ?? "", /non viene proposto/);
  }
});

test("un solo requisito verificato basta a rendere il prodotto proponibile", () => {
  const outcomes = selectFinalists(
    [candidate({ candidateId: "a", relevanceScore: 30 })],
    context,
    2
  );
  assert.equal(outcomes[0]?.outcome, "FINALIST");
});
