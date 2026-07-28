import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import { DEFAULT_PROCUREMENT, type ProductAnalysis } from "@china/shared";
import {
  aggregateV2DoubtCategories,
  classifyV2Doubt,
  ClarificationService,
  localizedQuestion,
  orderV2QuestionCandidates,
  selectV2QuestionCandidates,
  v2FamilyLabel,
  v2SemanticQuestionKey,
  V2_MAX_NEW_PER_PIPELINE,
} from "./clarification.service";

test("v2: a value already present in the spreadsheet is resolved internally", () => {
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_UNIT", "Steel pin diameter 12 mm", "unit uncertain"),
    "INTERNAL"
  );
});

test("v2: facts belonging to a Taobao listing never become user questions", () => {
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_MEASURE", "bearing", "check available SKU variant on Taobao"),
    "TAOBAO_CHECK"
  );
});

test("v2: row-specific and low-confidence doubts go to review", () => {
  assert.equal(classifyV2Doubt("MULTIPLE_PRODUCTS", "two items", "uncertain"), "ROW_REVIEW");
  assert.equal(classifyV2Doubt("LOW_CONFIDENCE", "bearing", "low confidence"), "ROW_REVIEW");
});

test("v2: only a genuinely missing user decision is askable", () => {
  assert.equal(
    classifyV2Doubt(
      "AMBIGUOUS_MODEL",
      "industrial pump",
      "Are equivalent models acceptable?"
    ),
    "USER_INPUT"
  );
});

test("v2: the hard visible-question limit is two", () => {
  assert.equal(V2_MAX_NEW_PER_PIPELINE, 2);
});

test("v2: questions are localized without changing their semantic identity", () => {
  const it = localizedQuestion("it", "AMBIGUOUS_MODEL", "pompe");
  const en = localizedQuestion("en", "AMBIGUOUS_MODEL", "pumps");
  const zh = localizedQuestion("zh", "AMBIGUOUS_MODEL", "泵");
  assert.match(it, /modelli equivalenti/);
  assert.match(en, /equivalent models/);
  assert.match(zh, /同等型号/);
  assert.equal(new Set([it, en, zh]).size, 3);
});

test("v2: listing price units and availability are Taobao checks", () => {
  for (const message of [
    "is this price per piece or per roll in the listing?",
    "check availability of the selected variant",
  ]) {
    assert.equal(
      classifyV2Doubt("AMBIGUOUS_UNIT", "industrial cable", message),
      "TAOBAO_CHECK"
    );
  }
});

test("v2: invalid or unknown warning codes conservatively become row review", () => {
  assert.equal(classifyV2Doubt("UNKNOWN_WARNING", "bearing", "uncertain"), "ROW_REVIEW");
});

test("v2: listing facts are recognized in Italian and Chinese", () => {
  assert.equal(
    classifyV2Doubt(
      "AMBIGUOUS_UNIT",
      "Cavo industriale",
      "Verificare nell'inserzione se il prezzo è per pezzo o per rotolo"
    ),
    "TAOBAO_CHECK"
  );
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_MODEL", "工业泵", "请检查商品详情中的 SKU 库存"),
    "TAOBAO_CHECK"
  );
});

test("v2: a Taobao URL alone does not turn a user decision into a listing check", () => {
  assert.equal(
    classifyV2Doubt(
      "AMBIGUOUS_MODEL",
      "Nome: industrial pump\nLink: https://item.taobao.com/item.htm?id=123",
      "Are equivalent models acceptable?",
      "model"
    ),
    "USER_INPUT"
  );
});

test("v2: explicit policy decisions win over generic marketplace words", () => {
  assert.equal(
    classifyV2Doubt(
      "AMBIGUOUS_MODEL",
      "industrial pump",
      "Are equivalent variants acceptable on Taobao?"
    ),
    "USER_INPUT"
  );
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_MEASURE", "工业轴承", "客户是否接受这个公差？"),
    "USER_INPUT"
  );
});

test("v2: low confidence and row-specific problems fall back to review in every locale", () => {
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_MODEL", "pompa", "Bassa confidenza del modello"),
    "ROW_REVIEW"
  );
  assert.equal(
    classifyV2Doubt("AMBIGUOUS_UNIT", "轴承", "本行链接无效，需要人工检查"),
    "ROW_REVIEW"
  );
});

test("v2: conflicting classifications aggregate conservatively and independently of order", () => {
  const one = aggregateV2DoubtCategories(["USER_INPUT", "TAOBAO_CHECK"]);
  const two = aggregateV2DoubtCategories(["TAOBAO_CHECK", "USER_INPUT"]);
  assert.equal(one, "ROW_REVIEW");
  assert.equal(two, "ROW_REVIEW");
  assert.equal(aggregateV2DoubtCategories(["USER_INPUT", "USER_INPUT"]), "USER_INPUT");
});

test("v2: semantic identity is stable across localized attribute names and question text", () => {
  const en = v2SemanticQuestionKey("AMBIGUOUS_MODEL", "industrial-pump", "model");
  const it = v2SemanticQuestionKey("AMBIGUOUS_MODEL", "industrial-pump", "modello");
  const zh = v2SemanticQuestionKey("AMBIGUOUS_MODEL", "industrial-pump", "型号");
  assert.equal(en, it);
  assert.equal(it, zh);

  // Le frasi cambiano, la chiave no.
  assert.notEqual(
    localizedQuestion("en", "AMBIGUOUS_MODEL", "industrial pump"),
    localizedQuestion("zh", "AMBIGUOUS_MODEL", "工业泵")
  );
});

test("v2: old attributeKey=code remains compatible with the canonical identity", () => {
  assert.equal(
    v2SemanticQuestionKey("AMBIGUOUS_UNIT", "cable", "AMBIGUOUS_UNIT"),
    v2SemanticQuestionKey("AMBIGUOUS_UNIT", "cable", "unità")
  );
});

test("v2: semantic importance wins over frequency and ties are deterministic", () => {
  const ordered = orderV2QuestionCandidates([
    { canonical: "z", code: "AMBIGUOUS_UNIT", hits: 100 },
    { canonical: "b", code: "AMBIGUOUS_MODEL", hits: 1 },
    { canonical: "a", code: "AMBIGUOUS_MODEL", hits: 1 },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.canonical),
    ["a", "b", "z"]
  );
});

test("v2: the cap is total for the pipeline and answered/dismissed slots are not reused", () => {
  const candidates = [
    { canonical: "a", code: "AMBIGUOUS_MODEL", hits: 1 },
    { canonical: "b", code: "AMBIGUOUS_MEASURE", hits: 1 },
    { canonical: "c", code: "AMBIGUOUS_UNIT", hits: 1 },
  ];
  assert.equal(selectV2QuestionCandidates(candidates, new Set(), 0).length, 2);
  assert.equal(selectV2QuestionCandidates(candidates, new Set(), 1).length, 1);
  assert.equal(selectV2QuestionCandidates(candidates, new Set(), 2).length, 0);
});

test("v2: an equivalent question in another pipeline suppresses a duplicate", () => {
  const canonical = v2SemanticQuestionKey("AMBIGUOUS_MODEL", "industrial-pump", "model");
  const selected = selectV2QuestionCandidates(
    [{ canonical, code: "AMBIGUOUS_MODEL", hits: 10 }],
    new Set([canonical]),
    0
  );
  assert.deepEqual(selected, []);
});

test("v2: answered and dismissed semantic questions never return", () => {
  const answered = v2SemanticQuestionKey(
    "AMBIGUOUS_MODEL",
    "industrial-pump",
    "model"
  );
  const dismissed = v2SemanticQuestionKey(
    "AMBIGUOUS_UNIT",
    "industrial-cable",
    "unit"
  );
  const selected = selectV2QuestionCandidates(
    [
      { canonical: answered, code: "AMBIGUOUS_MODEL", hits: 8 },
      { canonical: dismissed, code: "AMBIGUOUS_UNIT", hits: 5 },
    ],
    new Set([answered, dismissed]),
    0
  );
  assert.deepEqual(selected, []);
});

test("v2: question family follows the pipeline locale with safe fallbacks", () => {
  const analysis = {
    productFamily: "pompa industriale",
    familyKey: "industrial-pump",
    productNameEnglish: "industrial pump",
    productNameChinese: "工业泵",
  };
  assert.equal(v2FamilyLabel(analysis, "it"), "pompa industriale");
  assert.equal(v2FamilyLabel(analysis, "en"), "industrial pump");
  assert.equal(v2FamilyLabel(analysis, "zh"), "工业泵");
  assert.equal(
    v2FamilyLabel({ ...analysis, productNameChinese: null }, "zh"),
    "pompa industriale"
  );
});

test("legacy list and knowledge queries explicitly exclude every v2 scope", async () => {
  const delegate = prisma.taobaoClarification as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const original = delegate.findMany;
  const calls: Array<Record<string, unknown>> = [];
  delegate.findMany = async (args) => {
    calls.push(args as Record<string, unknown>);
    return [];
  };

  try {
    const service = new ClarificationService();
    await service.list("OPEN");
    await service.knowledge();
    await service.knowledgeForClient("client-a");
  } finally {
    delegate.findMany = original;
  }

  assert.deepEqual(calls[0]?.where, {
    status: "OPEN",
    clientId: null,
    pipelineId: null,
  });
  assert.deepEqual(calls[1]?.where, {
    status: "ANSWERED",
    clientId: null,
    pipelineId: null,
  });
  assert.deepEqual(calls[2]?.where, {
    clientId: "client-a",
    pipelineId: { not: null },
    status: "ANSWERED",
  });
});

test("v2 question reads are restricted to the exact client and pipeline", async () => {
  const delegate = prisma.taobaoClarification as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const original = delegate.findMany;
  let query: Record<string, unknown> | undefined;
  delegate.findMany = async (args) => {
    query = args as Record<string, unknown>;
    return [];
  };

  try {
    await new ClarificationService().listForPipeline(
      "client-a",
      "pipeline-a",
      "OPEN"
    );
  } finally {
    delegate.findMany = original;
  }

  assert.deepEqual(query?.where, {
    clientId: "client-a",
    pipelineId: "pipeline-a",
    status: "OPEN",
  });
  assert.equal(query?.take, 2);
});

test("the global answer path refuses a v2-scoped clarification", async () => {
  const delegate = prisma.taobaoClarification as unknown as {
    findUnique: (args: unknown) => Promise<unknown>;
  };
  const original = delegate.findUnique;
  delegate.findUnique = async () => ({
    id: "question-a",
    clientId: "client-a",
    pipelineId: "pipeline-a",
  });

  try {
    await assert.rejects(
      () => new ClarificationService().answer("question-a", { answer: "yes" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status: number }).status === 404
    );
  } finally {
    delegate.findUnique = original;
  }
});

test("the legacy open-question cap counts only legacy questions", async () => {
  const delegate = prisma.taobaoClarification as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    count: (args: unknown) => Promise<number>;
    create: (args: unknown) => Promise<unknown>;
  };
  const originalFindMany = delegate.findMany;
  const originalCount = delegate.count;
  const originalCreate = delegate.create;
  let countWhere: unknown;
  delegate.findMany = async () => [];
  delegate.count = async (args) => {
    countWhere = (args as { where: unknown }).where;
    return 0;
  };
  delegate.create = async () => ({ id: "legacy-question" });

  const analysis: ProductAnalysis = {
    productFamily: "pompa industriale",
    familyKey: "industrial-pump",
    variantKey: "standard",
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
    confidence: 0.6,
    procurement: DEFAULT_PROCUREMENT,
    warnings: [{ code: "AMBIGUOUS_MODEL", field: "model", message: "modello ambiguo" }],
  };

  try {
    await new ClarificationService().harvestFromAnalysis([
      { analysis, submittedText: "industrial pump" },
    ]);
  } finally {
    delegate.findMany = originalFindMany;
    delegate.count = originalCount;
    delegate.create = originalCreate;
  }

  assert.deepEqual(countWhere, {
    status: "OPEN",
    clientId: null,
    pipelineId: null,
  });
});
