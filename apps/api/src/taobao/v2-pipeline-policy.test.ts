import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import type { ProductAnalysis } from "@china/shared";
import {
  DEFAULT_PROCUREMENT,
  TaobaoPipelineOutcomeSchema,
} from "@china/shared";
import {
  buildPipelineReviewIssues,
  canOpenPipelineQuestions,
  PipelineService,
} from "./pipeline.service";
import {
  canRunCoherence,
  describeCoherenceCandidate,
  shouldCreateCoherenceQuestion,
} from "./coherence.service";
import { isTaobaoJobRowReady } from "./taobao-job.service";
import { clarificationHarvestMode } from "./taobao-analysis.service";

function analysis(
  patch: Partial<ProductAnalysis> = {}
): ProductAnalysis {
  return {
    productFamily: "pompa industriale",
    familyKey: "industrial-pump",
    variantKey: "base",
    productNameChinese: "工业泵",
    productNameEnglish: "industrial pump",
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
    searchQueryChinese: "工业泵",
    searchQueryEnglish: "industrial pump",
    confidence: 0.9,
    procurement: DEFAULT_PROCUREMENT,
    warnings: [],
    ...patch,
  };
}

test("v2 review rows continue, while the v1 readiness rule is unchanged", () => {
  assert.equal(isTaobaoJobRowReady("NEEDS_REVIEW", true), false);
  assert.equal(
    isTaobaoJobRowReady("NEEDS_REVIEW", true, { allowReviewRows: true }),
    true
  );
  assert.equal(
    isTaobaoJobRowReady("ANALYSIS_FAILED", false, { allowReviewRows: true }),
    false
  );
  assert.equal(
    isTaobaoJobRowReady("ANALYSIS_FAILED", true, { allowReviewRows: true }),
    false
  );
});

test("v2 coherence doubts stay in review and never open global questions", () => {
  assert.equal(
    shouldCreateCoherenceQuestion("legacy", "unsure", "Are equivalents allowed?"),
    true
  );
  assert.equal(
    shouldCreateCoherenceQuestion("v2-review", "unsure", "Are equivalents allowed?"),
    false
  );
});

test("v2 coherence accepts DeepSeek while the legacy gate remains Claude-only", () => {
  assert.equal(
    canRunCoherence("legacy", { claude: false, deepseek: true }),
    false
  );
  assert.equal(
    canRunCoherence("v2-review", { claude: false, deepseek: true }),
    true
  );
  assert.equal(
    canRunCoherence("v2-review", { claude: false, deepseek: false }),
    false
  );
});

test("only v2 sends SKU, variants, availability and product link to coherence", () => {
  const product = {
    platform: "taobao",
    title: "Industrial controller",
    titleEn: null,
    price: null,
    promotionPrice: null,
    currency: "CNY",
    moq: 1,
    shopName: "Supplier",
    specs: { voltage: "24 V" },
    sku: "AX-40-24V",
    variants: [{ name: "Voltage", options: ["12 V", "24 V"] }],
    availability: "in stock",
    url: "https://item.taobao.com/item.htm?id=40",
    sources: [],
  };

  const legacy = describeCoherenceCandidate(product);
  const v2 = describeCoherenceCandidate(product, "v2-review");

  assert.doesNotMatch(legacy, /SKU:|Varianti:|Disponibilità:|Link prodotto:/u);
  assert.match(v2, /SKU: AX-40-24V/u);
  assert.match(v2, /Varianti: Voltage: 12 V \/ 24 V/u);
  assert.match(v2, /Disponibilità: in stock/u);
  assert.match(v2, /Link prodotto: https:\/\/item\.taobao\.com/u);
});

test("v2 permits one visible question round and no hidden follow-up round", () => {
  assert.equal(canOpenPipelineQuestions(0), true);
  assert.equal(canOpenPipelineQuestions(1), false);
  assert.equal(canOpenPipelineQuestions(2), false);
  assert.equal(clarificationHarvestMode({ allowQuestions: true }), "v2");
  assert.equal(clarificationHarvestMode({ allowQuestions: false }), "none");
  assert.equal(clarificationHarvestMode(), "legacy");
});

test("starting an already-active dataset reattaches to its pipeline without creating one", async () => {
  const delegate = prisma.taobaoPipeline as unknown as {
    findFirst: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  const originalFindFirst = delegate.findFirst;
  const originalCreate = delegate.create;
  let activeQuery: unknown;
  let createCalled = false;
  delegate.findFirst = async (args) => {
    activeQuery = args;
    return { id: "pipeline-live", status: "WAITING_ANSWERS" };
  };
  delegate.create = async () => {
    createCalled = true;
    throw new Error("must not create a duplicate pipeline");
  };

  const service = new PipelineService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  service.estimate = async () =>
    ({
      datasetId: "dataset-a",
      fileName: "request.xlsx",
      sheet: "Sheet1",
      totalRows: 1,
      usableRows: 1,
      estimatedVariants: 1,
      maxCostUsd: 0,
      maxSearchCalls: 0,
      estimatedSeconds: 0,
      mapping: [{ columnIndex: 0, field: "name" }],
      blockers: [],
      warnings: [],
    }) as never;
  service.state = async (clientId, pipelineId) => {
    assert.equal(clientId, "client-a");
    assert.equal(pipelineId, "pipeline-live");
    return { pipelineId, clientId, status: "WAITING_ANSWERS" } as never;
  };

  try {
    const result = await service.start("client-a", "dataset-a", {
      mode: "v2",
      mapping: [{ columnIndex: 0, field: "name" }],
      markupPct: 15,
      maxRefineRounds: 2,
      forceFullSearch: false,
      locale: "it",
    });
    assert.equal(result.pipelineId, "pipeline-live");
  } finally {
    delegate.findFirst = originalFindFirst;
    delegate.create = originalCreate;
  }

  assert.equal(createCalled, false);
  assert.deepEqual(
    (activeQuery as { where: unknown }).where,
    {
      clientId: "client-a",
      datasetId: "dataset-a",
      status: { in: ["RUNNING", "WAITING_ANSWERS"] },
    }
  );
});

test("internal, Taobao and low-confidence doubts become structured review items", () => {
  const issues = buildPipelineReviewIssues(
    [
      {
        rowNumber: 1,
        submittedText: "Steel pin diameter 12 mm",
        analysis: analysis({
          warnings: [
            {
              code: "AMBIGUOUS_UNIT",
              field: "dimensions",
              message: "unit uncertain",
            },
          ],
        }),
        error: null,
      },
      {
        rowNumber: 2,
        submittedText: "Industrial cable",
        analysis: analysis({
          warnings: [
            {
              code: "AMBIGUOUS_MEASURE",
              field: "variants",
              message: "Verificare disponibilità della variante SKU su Taobao",
            },
          ],
        }),
        error: null,
      },
      {
        rowNumber: 3,
        submittedText: "Industrial pump",
        analysis: analysis({ confidence: 0.2 }),
        error: null,
      },
    ],
    new Set([1]),
    0.4
  );

  assert.deepEqual(
    issues.map((issue) => [issue.rowNumber, issue.category, issue.code]),
    [
      [1, "INTERNAL", "AMBIGUOUS_UNIT"],
      [2, "TAOBAO_CHECK", "AMBIGUOUS_MEASURE"],
      [3, "ROW_REVIEW", "LOW_CONFIDENCE"],
    ]
  );
  assert.equal(issues[0]?.resolvedAutomatically, true);
  assert.equal(issues[1]?.resolvedAutomatically, true);
  assert.equal(issues[2]?.resolvedAutomatically, true);
});

test("a warning for an optional model never requested is omitted", () => {
  const issues = buildPipelineReviewIssues(
    [
      {
        rowNumber: 7,
        submittedText: "Industrial pump",
        analysis: analysis({
          warnings: [
            {
              code: "AMBIGUOUS_MODEL",
              field: "model",
              message: "model is missing",
            },
          ],
        }),
        error: null,
      },
    ],
    new Set(),
    0.4
  );
  assert.deepEqual(issues, []);
});

test("only a real commercial decision remains unresolved", () => {
  const [issue] = buildPipelineReviewIssues(
    [
      {
        rowNumber: 8,
        submittedText:
          "Nome: Industrial controller AX-40\nSpecifiche: Modello/codice: AX-40",
        analysis: analysis({
          model: "AX-40",
          warnings: [
            {
              code: "AMBIGUOUS_MODEL",
              field: "model",
              message: "Are equivalent models acceptable?",
            },
          ],
        }),
        error: null,
      },
    ],
    new Set(),
    0.4
  );
  assert.equal(issue?.category, "ROW_REVIEW");
  assert.equal(issue?.code, "AMBIGUOUS_MODEL");
  assert.equal(issue?.resolvedAutomatically, false);
  assert.equal(issue?.humanAction, "APPROVE_EQUIVALENT");
});

test("historic outcomes remain readable with an empty structured review", () => {
  const parsed = TaobaoPipelineOutcomeSchema.parse({
    totalRows: 1,
    confirmedRows: 1,
    uncertainRows: 0,
    uncoveredRows: 0,
    reusedRows: 0,
    totalCostUsd: 0,
    searchCalls: 0,
    cacheHits: 0,
    refineRounds: 0,
    recoveredRows: 0,
    gaps: [],
  });
  assert.deepEqual(parsed.reviewIssues, []);
});
