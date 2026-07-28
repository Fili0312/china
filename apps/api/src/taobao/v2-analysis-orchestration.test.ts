import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import { renderRowForAnalysis, type AnalysisInputRow } from "@china/ai";
import { DEFAULT_PROCUREMENT, type ProductAnalysis } from "@china/shared";
import { TaobaoAnalysisService } from "./taobao-analysis.service";

test("v2 applies client knowledge before analysis and harvests questions afterwards", async () => {
  const events: string[] = [];
  const analysisRun = prisma.taobaoAnalysisRun as unknown as {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  const datasetRow = prisma.taobaoDatasetRow as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const originalCreate = analysisRun.create;
  const originalUpdate = analysisRun.update;
  const originalFindMany = datasetRow.findMany;

  analysisRun.create = async () => ({ id: "analysis-run-a" });
  analysisRun.update = async () => ({});
  datasetRow.findMany = async () => [];

  const clients = {
    assertOwnership: () => events.push("ownership"),
  };
  const datasets = {
    loadRows: async () => ({
      clientId: "client-a",
      fileName: "request.xlsx",
      columnIndexes: [0],
      rows: [
        {
          rowNumber: 1,
          sheetName: "Sheet1",
          sheetRowNumber: 2,
          cells: ["industrial pump"],
          hyperlink: null,
        },
      ],
    }),
  };
  const provider = {
    promptVersion: "mock-v1",
    model: "mock-model",
    analyzeRows: async (
      _rows: unknown,
      options: { knowledge?: { entries: string[]; digest: string } }
    ) => {
      events.push("analysis");
      assert.deepEqual(options.knowledge, {
        entries: ["[industrial-pump] D: equivalents? R: yes"],
        digest: "knowledge-a",
      });
      return {
        outcomes: [],
        usage: {
          apiCalls: 0,
          cachedRows: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
      };
    },
  };
  const clarifications = {
    knowledgeForClient: async (clientId: string) => {
      events.push("knowledge");
      assert.equal(clientId, "client-a");
      return {
        entries: ["[industrial-pump] D: equivalents? R: yes"],
        ids: ["clarification-a"],
        digest: "knowledge-a",
      };
    },
    knowledge: async () => {
      throw new Error("v2 must not read global legacy knowledge");
    },
    harvestForPipeline: async (scope: {
      clientId: string;
      pipelineId: string;
      datasetId: string;
      analysisRunId: string;
      locale: string;
    }) => {
      events.push("questions");
      assert.deepEqual(
        {
          clientId: scope.clientId,
          pipelineId: scope.pipelineId,
          datasetId: scope.datasetId,
          analysisRunId: scope.analysisRunId,
          locale: scope.locale,
        },
        {
          clientId: "client-a",
          pipelineId: "pipeline-a",
          datasetId: "dataset-a",
          analysisRunId: "analysis-run-a",
          locale: "en",
        }
      );
      return 0;
    },
    harvestFromAnalysis: async () => {
      throw new Error("v2 must not harvest legacy questions");
    },
    markApplied: async () => undefined,
  };

  const service = new TaobaoAnalysisService(
    clients as never,
    datasets as never,
    provider as never,
    {} as never,
    clarifications as never
  );
  service.getRun = async () => ({ runId: "analysis-run-a" }) as never;

  try {
    await service.startRun(
      "client-a",
      "dataset-a",
      {
        mapping: [{ columnIndex: 0, field: "name" }],
        ignoreCache: false,
      },
      {
        pipelineId: "pipeline-a",
        locale: "en",
        allowQuestions: true,
      }
    );
  } finally {
    analysisRun.create = originalCreate;
    analysisRun.update = originalUpdate;
    datasetRow.findMany = originalFindMany;
  }

  assert.ok(events.indexOf("knowledge") < events.indexOf("analysis"));
  assert.ok(events.indexOf("analysis") < events.indexOf("questions"));
});

test("v2 sends mapped fields plus every original cell and persists provenance outside the signature", async () => {
  const analysisRun = prisma.taobaoAnalysisRun as unknown as {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  const datasetRow = prisma.taobaoDatasetRow as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const analysisRow = prisma.taobaoAnalysisRow as unknown as {
    create: (args: unknown) => Promise<unknown>;
  };
  const originalRunCreate = analysisRun.create;
  const originalRunUpdate = analysisRun.update;
  const originalDatasetFindMany = datasetRow.findMany;
  const originalAnalysisCreate = analysisRow.create;
  let receivedInput: AnalysisInputRow | null = null;
  let savedRow: Record<string, unknown> | null = null;

  const parsed: ProductAnalysis = {
    productFamily: "industrial sensor",
    familyKey: "industrial-sensor",
    variantKey: "zx-7",
    productNameChinese: "工业传感器",
    productNameEnglish: "industrial sensor",
    model: "ZX-7",
    material: null,
    color: null,
    dimensions: [],
    technicalSpecifications: [
      { key: "voltage", value: "24", unit: "V" },
    ],
    includedAccessories: [],
    hardRequirements: [],
    softRequirements: [],
    requestedQuantity: 10,
    unit: "pcs",
    searchQueryChinese: "工业传感器 ZX-7 24V",
    searchQueryEnglish: "industrial sensor ZX-7 24V",
    confidence: 0.9,
    procurement: DEFAULT_PROCUREMENT,
    warnings: [],
  };

  analysisRun.create = async () => ({ id: "analysis-run-context" });
  analysisRun.update = async () => ({});
  datasetRow.findMany = async () => [{ id: "dataset-row-1", rowNumber: 1 }];
  analysisRow.create = async (args) => {
    savedRow = (args as { data: Record<string, unknown> }).data;
    return {};
  };

  const datasets = {
    loadRows: async () => ({
      clientId: "client-a",
      fileName: "request.xlsx",
      columnIndexes: [0, 1, 2, 3, 4, 5, 6],
      columns: [
        "Prodotto",
        "Specifiche",
        "Quantità",
        "Unità",
        "Utilizzo",
        "Link",
        "Centro costo",
      ].map((header, index) => ({
        index,
        letter: String.fromCharCode(65 + index),
        header,
        suggestedField: null,
        suggestionReason: null,
        filledCount: 1,
        sampleValues: [],
      })),
      rows: [
        {
          rowNumber: 1,
          sheetName: "Sheet1",
          sheetRowNumber: 2,
          cells: [
            "Industrial sensor ZX-7",
            "24 V",
            "10",
            "pcs",
            "Use outdoors",
            "https://item.taobao.com/item.htm?id=123456789",
            "Centro costo 7788 - consegna urgente",
          ],
          hyperlink: "https://item.taobao.com/item.htm?id=123456789",
        },
      ],
    }),
  };
  const provider = {
    promptVersion: "mock-v1",
    model: "mock-model",
    analyzeRows: async (rows: readonly AnalysisInputRow[]) => {
      receivedInput = rows[0] ?? null;
      const submittedText = renderRowForAnalysis(rows[0]!);
      return {
        outcomes: [
          {
            rowIndex: 1,
            analysisId: "request-analysis-1",
            analysis: parsed,
            error: null,
            fromCache: false,
            submittedText,
          },
        ],
        usage: {
          apiCalls: 0,
          cachedRows: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
      };
    },
  };
  const clarifications = {
    knowledgeForClient: async () => ({ entries: [], ids: [], digest: "" }),
    harvestForPipeline: async () => 0,
    markApplied: async () => undefined,
  };
  const service = new TaobaoAnalysisService(
    { assertOwnership: () => undefined } as never,
    datasets as never,
    provider as never,
    {} as never,
    clarifications as never
  );
  service.getRun = async () => ({ runId: "analysis-run-context" }) as never;

  try {
    await service.startRun(
      "client-a",
      "dataset-a",
      {
        mapping: [
          { columnIndex: 0, field: "name" },
          { columnIndex: 1, field: "spec" },
          { columnIndex: 2, field: "quantity" },
          { columnIndex: 3, field: "unit" },
          { columnIndex: 4, field: "notes" },
          { columnIndex: 5, field: "referenceUrl" },
        ],
        ignoreCache: false,
      },
      {
        pipelineId: "pipeline-a",
        locale: "it",
        allowQuestions: true,
      }
    );
  } finally {
    analysisRun.create = originalRunCreate;
    analysisRun.update = originalRunUpdate;
    datasetRow.findMany = originalDatasetFindMany;
    analysisRow.create = originalAnalysisCreate;
  }

  const capturedInput = receivedInput as unknown as AnalysisInputRow | null;
  const capturedRow = savedRow as unknown as Record<string, unknown> | null;
  assert.ok(capturedInput);
  assert.equal(capturedInput.quantity, "10");
  assert.equal(capturedInput.unit, "pcs");
  assert.equal(
    capturedInput.referenceUrl,
    "https://item.taobao.com/item.htm?id=123456789"
  );
  assert.match(capturedInput.usage ?? "", /Use outdoors/u);
  assert.match(
    capturedInput.usage ?? "",
    /Centro costo \(Cella 7\): Centro costo 7788/u
  );

  const manualEdits = capturedRow?.manualEdits as {
    _v2RequirementContext: {
      sourceText: string;
      immutableSearchTokens: string[];
    };
  };
  assert.match(
    manualEdits._v2RequirementContext.sourceText,
    /Centro costo \(Cella 7\): Centro costo 7788/u
  );
  assert.ok(
    !manualEdits._v2RequirementContext.immutableSearchTokens.includes("7788")
  );
  assert.doesNotMatch(
    String(capturedRow?.signatureText ?? ""),
    /7788|123456789|10/u
  );
});
