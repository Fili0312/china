import assert from "node:assert/strict";
import test from "node:test";
import type {
  TaobaoCandidate,
  TaobaoDatasetSummary,
  TaobaoJobSummary,
  TaobaoPipelineGap,
  TaobaoPipelineState,
  TaobaoRowResults,
} from "@china/shared";
import {
  buildScoutingV2History,
  historyHasResults,
  historyJobId,
  mergePipelineIntoHistory,
} from "./history";
import {
  buildV2ResultRows,
  calculateVirtualWindow,
  filterAndSortV2ResultRows,
  groupV2ResultRows,
  normalizeImageUrl,
  salesUnitFromCandidate,
  type V2CandidateCoherence,
  type V2ReviewIssue,
  V2_HUMAN_ACTION_TYPES,
} from "./results-model";

function dataset(
  clientId: string,
  id: string,
  patch: Partial<TaobaoDatasetSummary> = {}
): TaobaoDatasetSummary {
  return {
    datasetId: id,
    clientId,
    fileName: `${id}.xlsx`,
    format: "xlsx",
    sheet: "Sheet1",
    totalRows: 10,
    createdAt: "2026-07-20T10:00:00.000Z",
    analysisRunCount: 0,
    jobCount: 0,
    ...patch,
  };
}

function job(
  clientId: string,
  id: string,
  datasetId: string,
  patch: Partial<TaobaoJobSummary> = {}
): TaobaoJobSummary {
  return {
    jobId: id,
    clientId,
    clientName: clientId,
    datasetId,
    fileName: `${datasetId}.xlsx`,
    status: "COMPLETED",
    totalRows: 10,
    processedRows: 10,
    reusedRows: 0,
    searchedRows: 10,
    failedRows: 0,
    usage: {
      hwhCalls: 4,
      apiCalls: 2,
      apiCacheHits: 1,
      browserCalls: 0,
      elimCalls: 0,
      reusedProducts: 0,
      newProducts: 3,
    },
    browserUsed: false,
    createdAt: "2026-07-20T10:05:00.000Z",
    startedAt: "2026-07-20T10:06:00.000Z",
    finishedAt: "2026-07-20T10:10:00.000Z",
    error: null,
    ...patch,
  };
}

function pipeline(
  clientId: string,
  id: string,
  datasetId: string,
  patch: Partial<TaobaoPipelineState> = {}
): TaobaoPipelineState {
  return {
    pipelineId: id,
    clientId,
    clientName: clientId,
    datasetId,
    fileName: `${datasetId}.xlsx`,
    totalRows: 10,
    status: "RUNNING",
    phase: "SEARCH",
    progress: 50,
    step: "step.searchRows",
    stepParams: {},
    completedPhases: ["ANALYSIS", "REVIEW"],
    questions: [],
    questionRound: 0,
    analysisRunId: "analysis-a",
    jobId: null,
    markupPct: 15,
    outcome: null,
    error: null,
    uploadedAt: "2026-07-20T10:00:00.000Z",
    startedAt: "2026-07-20T10:01:00.000Z",
    finishedAt: null,
    ...patch,
  };
}

test("v2 history renders only the selected client's files, jobs and pipelines", () => {
  const entries = buildScoutingV2History(
    "client-a",
    [dataset("client-a", "file-a"), dataset("client-b", "file-b")],
    [
      job("client-a", "job-a", "file-a"),
      job("client-b", "job-b", "file-b"),
    ],
    [
      pipeline("client-a", "pipeline-a", "file-a", { jobId: "job-a" }),
      pipeline("client-b", "pipeline-b", "file-b", { jobId: "job-b" }),
    ]
  );

  assert.deepEqual(entries.map((entry) => entry.key), ["pipeline:pipeline-a"]);
  assert.ok(entries.every((entry) => entry.clientId === "client-a"));
  assert.equal(entries[0]?.pipeline?.clientId, "client-a");
  assert.equal(entries[0]?.job?.clientId, "client-a");
});

test("v2 history keeps upload-only files and their real upload date", () => {
  const entries = buildScoutingV2History(
    "client-a",
    [
      dataset("client-a", "file-only", {
        createdAt: "2026-07-18T09:30:00.000Z",
        analysisRunCount: 1,
      }),
    ],
    [],
    []
  );

  assert.equal(entries[0]?.kind, "upload");
  assert.equal(entries[0]?.uploadedAt, "2026-07-18T09:30:00.000Z");
  assert.equal(entries[0]?.analysisRunCount, 1);
});

test("an active pipeline is reopenable and polling updates it without duplication", () => {
  const active = pipeline("client-a", "pipeline-live", "file-a");
  const initial = buildScoutingV2History(
    "client-a",
    [dataset("client-a", "file-a")],
    [],
    [active]
  );
  assert.equal(initial[0]?.pipeline?.status, "RUNNING");

  const updated = mergePipelineIntoHistory(initial, {
    ...active,
    status: "WAITING_ANSWERS",
    phase: "QUESTIONS",
    step: "step.questions",
    progress: 30,
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.pipeline?.pipelineId, "pipeline-live");
  assert.equal(updated[0]?.status, "WAITING_ANSWERS");
});

test("a completed pipeline and an orphan historical job both reopen saved results", () => {
  const linkedJob = job("client-a", "job-linked", "file-linked");
  const orphanJob = job("client-a", "job-orphan", "file-orphan", {
    status: "COMPLETED_WITH_ERRORS",
  });
  const completed = pipeline("client-a", "pipeline-done", "file-linked", {
    status: "COMPLETED",
    phase: "REPORT",
    progress: 100,
    step: "step.done",
    completedPhases: [
      "ANALYSIS",
      "REVIEW",
      "SEARCH",
      "VERIFY",
      "REFINE",
      "REPORT",
    ],
    jobId: linkedJob.jobId,
    finishedAt: "2026-07-20T10:10:00.000Z",
  });

  const entries = buildScoutingV2History(
    "client-a",
    [
      dataset("client-a", "file-linked"),
      dataset("client-a", "file-orphan"),
    ],
    [linkedJob, orphanJob],
    [completed]
  );
  const pipelineEntry = entries.find((entry) => entry.kind === "pipeline");
  const orphanEntry = entries.find((entry) => entry.kind === "job");

  assert.equal(entries.length, 2);
  assert.equal(historyHasResults(pipelineEntry!), true);
  assert.equal(historyJobId(pipelineEntry!), "job-linked");
  assert.equal(historyHasResults(orphanEntry!), true);
  assert.equal(historyJobId(orphanEntry!), "job-orphan");
});

function candidate(
  id: string,
  patch: {
    imageUrl?: string | null;
    unavailable?: boolean;
    verdict?: "coherent" | "incoherent" | "unsure" | null;
    missingRequirements?: string[];
    specs?: Record<string, string> | null;
    price?: number | null;
  } = {}
): TaobaoCandidate {
  const verdict = patch.verdict === undefined ? "coherent" : patch.verdict;
  return {
    rank: 1,
    score: 0.9,
    scoreBreakdown: null,
    matchedRequirements: ["material"],
    missingRequirements: patch.missingRequirements ?? [],
    warnings: [],
    sourceConflicts: [],
    coherence:
      verdict === null
        ? null
        : { verdict, confidence: verdict === "coherent" ? 0.95 : 0.55, issues: [] },
    product: {
      productId: id,
      platform: "taobao",
      itemId: id,
      title: `Product ${id}`,
      titleEn: null,
      url: `https://item.taobao.com/item.htm?id=${id}`,
      imageUrl:
        "imageUrl" in patch
          ? (patch.imageUrl ?? null)
          : `https://img.example.test/${id}.jpg`,
      price: patch.price ?? 10,
      currency: "CNY",
      variantPrice: null,
      promotionPrice: null,
      moq: 1,
      sku: `SKU-${id}`,
      shopName: null,
      shopUrl: null,
      totalSales: null,
      reviewCount: null,
      rating: null,
      specs: patch.specs ?? { salesUnit: "piece" },
      variants: null,
      availability: patch.unavailable ? "sold out" : "in stock",
      shipping: null,
      foundQuery: id,
      sources: [],
      lastCheckedAt: "2026-07-20T10:00:00.000Z",
      changedFields: [],
      unavailable: patch.unavailable ?? false,
    },
  };
}

function resultRow(
  rowNumber: number,
  candidates: TaobaoCandidate[] = [candidate(String(rowNumber))]
): TaobaoRowResults {
  return {
    jobRowId: `row-${rowNumber}`,
    rowNumber,
    displayName: `Requested product ${rowNumber}`,
    searchQuery: `query ${rowNumber}`,
    status: "DONE",
    reused: false,
    reuseReason: null,
    attemptedQueries: [],
    variantKey: null,
    originalCells: [`Product ${rowNumber}`],
    requestedQuantity: 1,
    requestedUnit: "requested-only-unit",
    hwhStatus: null,
    hwhError: null,
    hwhCount: 0,
    apiStatus: "DONE",
    apiError: null,
    apiCount: candidates.length,
    elimStatus: null,
    elimError: null,
    elimCount: 0,
    browserStatus: null,
    browserError: null,
    browserCount: 0,
    error: null,
    candidates,
  };
}

function reviewIssue(
  rowNumber: number,
  patch: Partial<V2ReviewIssue> = {}
): V2ReviewIssue {
  return {
    rowNumber,
    displayName: `Requested product ${rowNumber}`,
    category: "ROW_REVIEW",
    code: "VARIANT_SELECTION_REQUIRED",
    attributeKey: "variant",
    detail: "Choose the correct variant",
    resolvedAutomatically: false,
    humanAction: "CHOOSE_VARIANT",
    ...patch,
  };
}

test("v2 results model handles 1000 rows while the virtual window stays bounded", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => resultRow(index + 1));
  const modeled = buildV2ResultRows(rows);
  const grouped = groupV2ResultRows(modeled);
  const virtual = calculateVirtualWindow(1000, 67_000, 430, 68);

  assert.equal(modeled.length, 1000);
  assert.equal(grouped.corrected.length, 1000);
  assert.ok(virtual.start > 900);
  assert.equal(virtual.end <= 1000, true);
  assert.equal(virtual.end - virtual.start < 30, true);
  assert.equal(
    virtual.paddingTop + virtual.paddingBottom + (virtual.end - virtual.start) * 68,
    1000 * 68
  );
});

test("missing or unsafe product images use the fallback path", () => {
  const withoutImage = buildV2ResultRows([
    resultRow(1, [candidate("missing", { imageUrl: null })]),
  ])[0]!;

  assert.equal(withoutImage.imageUrl, null);
  assert.equal(normalizeImageUrl(""), null);
  assert.equal(normalizeImageUrl("javascript:alert(1)"), null);
  assert.equal(
    normalizeImageUrl("//img.example.test/product.jpg"),
    "https://img.example.test/product.jpg"
  );
});

test("sales unit comes only from marketplace specs and never requestedUnit", () => {
  const withUnit = candidate("unit", { specs: { 包装单位: "carton" } });
  const withoutUnit = candidate("no-unit", { specs: { color: "red" } });
  const modeled = buildV2ResultRows([resultRow(1, [withoutUnit])])[0]!;

  assert.equal(salesUnitFromCandidate(withUnit), "carton");
  assert.equal(salesUnitFromCandidate(withoutUnit), null);
  assert.equal(modeled.salesUnit, null);
  assert.equal(modeled.source?.requestedUnit, "requested-only-unit");
});

test("the human counter excludes no-results, inferred warnings and auto-resolved checks", () => {
  const noResultGap: TaobaoPipelineGap = {
    rowNumber: 1,
    displayName: "Missing",
    searchQuery: "missing",
    reason: "no_results",
    detail: null,
  };
  const rows = [
    resultRow(1, []),
    resultRow(2, [
      candidate("missing-requirement", { missingRequirements: ["color"] }),
    ]),
    resultRow(3),
  ];
  const modeled = buildV2ResultRows(rows, {
    gaps: [noResultGap],
    reviewIssues: [
      reviewIssue(1),
      reviewIssue(3, {
        resolvedAutomatically: true,
        code: "VARIANT_NORMALIZED",
        humanAction: null,
      }),
    ],
  });

  assert.equal(modeled.find((row) => row.rowNumber === 1)?.section, "no_result");
  assert.equal(modeled.find((row) => row.rowNumber === 1)?.candidate, null);
  assert.deepEqual(modeled.find((row) => row.rowNumber === 1)?.candidates, []);
  assert.equal(modeled.find((row) => row.rowNumber === 1)?.actions.length, 0);
  assert.equal(modeled.find((row) => row.rowNumber === 2)?.section, "corrected");
  assert.equal(modeled.find((row) => row.rowNumber === 2)?.actions.length, 0);
  assert.equal(
    modeled.find((row) => row.rowNumber === 3)?.section,
    "auto_resolved"
  );
  assert.equal(modeled.flatMap((row) => row.actions).length, 0);
});

test("only explicit unresolved review signals create typed human actions", () => {
  const rows = [resultRow(1), resultRow(2), resultRow(3)];
  const modeled = buildV2ResultRows(rows, {
    reviewIssues: [
      reviewIssue(1),
      reviewIssue(2, {
        code: "LOW_CONFIDENCE",
        attributeKey: "confidence",
        detail: null,
        humanAction: null,
      }),
      reviewIssue(3, {
        code: "PRODUCT_UNAVAILABLE",
        attributeKey: "availability",
        detail: "Marketplace reports sold out",
        humanAction: "MARK_UNAVAILABLE",
      }),
    ],
  });

  assert.deepEqual(modeled[0]?.actions.map((action) => action.type), [
    "CHOOSE_VARIANT",
  ]);
  assert.deepEqual(modeled[1]?.actions, []);
  assert.deepEqual(modeled[2]?.actions.map((action) => action.type), [
    "MARK_UNAVAILABLE",
  ]);
});

test("a structured unresolved marketplace variant creates the only required action", () => {
  const pendingVariant = candidate("variant-choice");
  pendingVariant.product.sku = null;
  pendingVariant.coherence = {
    verdict: "coherent",
    confidence: 0.95,
    issues: [],
    selectedVariant: null,
    variantSelectionRequired: true,
    variantChoices: ["24 V", "48 V"],
  } as V2CandidateCoherence;

  const [modeled] = buildV2ResultRows([resultRow(1, [pendingVariant])]);

  assert.equal(modeled?.section, "review");
  assert.deepEqual(modeled?.actions.map((action) => action.type), [
    "CHOOSE_VARIANT",
  ]);
  assert.equal(modeled?.actions[0]?.detail, "24 V · 48 V");
});

test("a coherent candidate stays selected ahead of an unsure resolved variant", () => {
  const unsure = candidate("unsure", { verdict: "unsure" });
  const pendingCoherent = candidate("coherent-pending");
  pendingCoherent.product.sku = null;
  pendingCoherent.coherence = {
    verdict: "coherent",
    confidence: 0.95,
    issues: [],
    selectedVariant: null,
    variantSelectionRequired: true,
    variantChoices: ["M", "L"],
  } as V2CandidateCoherence;

  const [modeled] = buildV2ResultRows([
    resultRow(1, [unsure, pendingCoherent]),
  ]);

  assert.equal(modeled?.candidate?.product.productId, "coherent-pending");
  assert.deepEqual(modeled?.actions.map((action) => action.type), [
    "CHOOSE_VARIANT",
  ]);
});

// Il vocabolario resta chiuso: ogni voce in più è una casella che qualcuno
// dovrà svuotare a mano. `CONFIRM_PRICE` è entrata perché senza prezzo la
// riga non è esportabile, e nessuna delle altre cinque lo dice.
test("the v2 action vocabulary stays closed to the supported decisions", () => {
  assert.deepEqual(V2_HUMAN_ACTION_TYPES, [
    "APPROVE_EQUIVALENT",
    "CHOOSE_VARIANT",
    "CLARIFY_REQUIREMENT",
    "CHANGE_TOLERANCE",
    "MARK_UNAVAILABLE",
    "CONFIRM_PRICE",
  ]);
});

// Un prodotto non acquistabile sparisce; un prodotto bocciato dalla verifica
// resta visibile fra quelli da controllare. Nasconderlo faceva dichiarare
// «nessun risultato» a righe in cui la ricerca aveva invece trovato qualcosa,
// e il totale finale non tornava con quello della ricerca.
test("unavailable candidates disappear, incoherent ones stay visible", () => {
  const modeled = buildV2ResultRows([
    resultRow(1, [candidate("unavailable", { unavailable: true })]),
    resultRow(2, [candidate("incoherent", { verdict: "incoherent" })]),
  ]);

  // Entrambe sono buchi, per ragioni diverse: la prima non ha nulla di
  // acquistabile, la seconda ha un prodotto che il giudice ha respinto. In
  // nessuna delle due c'è una decisione che una persona possa prendere al
  // posto dell'IA, quindi nessuna delle due va in "Da confermare".
  // Il prodotto respinto resta comunque visibile, come traccia di cosa è
  // stato trovato e scartato.
  assert.deepEqual(
    modeled.map((row) => row.section),
    ["no_result", "no_result"]
  );
  assert.equal(modeled[0]!.candidate, null);
  assert.deepEqual(modeled[0]!.candidates, []);
  assert.equal(modeled[1]!.candidates.length, 1);
  assert.equal(modeled[1]!.candidate?.product.title, "Product incoherent");
});

test("search, marketplace filters and price sorting operate on the local projection", () => {
  const rows = buildV2ResultRows([
    resultRow(1, [candidate("expensive", { price: 30 })]),
    resultRow(2, [candidate("cheap", { price: 5 })]),
  ]);
  const filtered = filterAndSortV2ResultRows(rows, {
    query: "requested product",
    section: "corrected",
    platform: "taobao",
    sort: "price_asc",
  });

  assert.deepEqual(filtered.map((row) => row.rowNumber), [2, 1]);
});

test("la quantità del foglio arriva sulla riga", () => {
  const rows = buildV2ResultRows([
    { ...resultRow(1, [candidate("a")]), requestedQuantity: 12, requestedUnit: "个" },
  ]);

  assert.equal(rows[0]!.requestedQuantity, 12);
  assert.equal(rows[0]!.requestedUnit, "个");
});

test("a pari verdetto rappresenta la riga la scheda con prezzo e immagine", () => {
  // Il caso reale: il link del foglio arriva primo ma è un riquadro vuoto.
  const empty = {
    ...candidate("dal-foglio", { imageUrl: null, price: null, verdict: null }),
    rank: 1,
  };
  const complete = { ...candidate("trovato", { verdict: null }), rank: 2 };

  const rows = buildV2ResultRows([resultRow(1, [empty, complete])]);

  assert.equal(rows[0]!.candidate?.product.title, "Product trovato");
  // Il vuoto resta consultabile, solo non rappresenta più la riga.
  assert.equal(rows[0]!.candidates.length, 2);
});

test("il prezzo maggiorato si calcola sul costo", () => {
  // Il report mostra due cifre: quanto costa e quanto si rivende.
  const rows = buildV2ResultRows([resultRow(1, [candidate("a", { price: 20 })])]);
  const cost = rows[0]!.price!;

  assert.equal(cost, 20);
  assert.equal(cost * (1 + 15 / 100), 23);
  assert.equal(cost * (1 + 0 / 100), 20);
});

test("un prodotto respinto dall'IA non risulta confermato nel report", () => {
  // Il difetto: le caselle in alto (calcolate dal server) dicevano 18/11 e i
  // gruppi del report 25/4 sulla stessa ricerca, perché qui il verdetto non
  // veniva guardato affatto.
  const modeled = buildV2ResultRows([
    resultRow(1, [candidate("ok", { verdict: "coherent" })]),
    resultRow(2, [candidate("dubbio", { verdict: "unsure" })]),
    resultRow(3, [candidate("no", { verdict: "incoherent" })]),
    resultRow(4, [candidate("mai giudicato", { verdict: null })]),
  ]);

  assert.deepEqual(
    modeled.map((row) => row.section),
    // Promosso e incerto sono accettati. Il respinto è un buco: il giudice ha
    // già deciso. Il mai giudicato invece aspetta davvero una persona, perché
    // la verifica su quella riga non è stata fatta.
    ["corrected", "corrected", "no_result", "review"]
  );
});
