import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import type { ProductAnalysis } from "@china/shared";
import { RefineService } from "./refine.service";
import type { RawTaobaoProduct } from "./providers/taobao-item";

function analysis(): ProductAnalysis {
  return {
    productFamily: "calibro a spillo",
    familyKey: "pin-gauge",
    variantKey: "2.48mm",
    productNameChinese: "针规",
    productNameEnglish: "pin gauge",
    model: null,
    material: null,
    color: null,
    dimensions: [
      { axis: "diameter", label: null, value: 2.48, unit: "mm" },
    ],
    technicalSpecifications: [],
    includedAccessories: [],
    hardRequirements: [],
    softRequirements: [],
    requestedQuantity: 10,
    unit: "pcs",
    searchQueryChinese: "针规 2.48mm",
    searchQueryEnglish: "pin gauge 2.48mm",
    confidence: 0.9,
    warnings: [],
  };
}

function product(itemId: string, title: string): RawTaobaoProduct {
  return {
    platform: "taobao",
    itemId,
    title,
    titleEn: null,
    url: `https://item.taobao.com/item.htm?id=${itemId}`,
    imageUrl: null,
    price: 10,
    currency: "CNY",
    variantPrice: null,
    promotionPrice: null,
    moq: 1,
    sku: null,
    shopName: "量具店",
    shopUrl: null,
    sellerId: "seller-a",
    totalSales: 10,
    reviewCount: 2,
    rating: 4.8,
    specs: null,
    variants: null,
    availability: "available",
    shipping: null,
    source: "hwh",
  };
}

test("v2 refine retries zero-result rows with exact immutable queries and no AI call", async () => {
  const job = prisma.taobaoJob as unknown as {
    findUnique: (args: unknown) => Promise<unknown>;
  };
  const jobRow = prisma.taobaoJobRow as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    update: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<unknown>;
  };
  const jobResult = prisma.taobaoJobResult as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    deleteMany: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  const originals = {
    jobFindUnique: job.findUnique,
    rowFindMany: jobRow.findMany,
    rowUpdate: jobRow.update,
    rowUpdateMany: jobRow.updateMany,
    resultFindMany: jobResult.findMany,
    resultDeleteMany: jobResult.deleteMany,
    resultCreate: jobResult.create,
  };
  const previousKeys = {
    deepSeekApi: process.env.DEEP_SEEK_API,
    deepSeekApiKey: process.env.DEEPSEEK_API_KEY,
    primary: process.env.TAOBAO_PRIMARY_SEARCH,
  };

  const searched: Array<{ query: string; exactQuery?: boolean }> = [];
  let updateData: Record<string, unknown> | null = null;

  job.findUnique = async () => ({
    id: "job-a",
    clientId: "client-a",
    maxCandidates: 5,
  });
  jobRow.findMany = async () => [
    {
      id: "job-row-a",
      rowNumber: 1,
      requestId: "request-a",
      searchQuery: "针规 2.84mm",
      analysisRow: {
        effectiveAnalysis: analysis(),
        signatureText: "Pin gauge 2.48 mm",
        manualEdits: null,
        analysis: {
          submittedText:
            "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm\nQuantità: 10\nUnità: pcs",
        },
      },
      // Il caso che il vecchio refine saltava senza mai ritentare.
      results: [],
    },
  ];
  jobRow.update = async (args) => {
    updateData = (args as { data: Record<string, unknown> }).data;
    return {};
  };
  jobRow.updateMany = async () => ({ count: 0 });
  jobResult.deleteMany = async () => ({ count: 0 });
  jobResult.create = async () => ({});
  jobResult.findMany = async () => [
    {
      jobRowId: "job-row-a",
      coherence: { verdict: "coherent" },
      product: { unavailable: false },
    },
  ];

  delete process.env.DEEP_SEEK_API;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.TAOBAO_PRIMARY_SEARCH = "hwh";

  const hwh = {
    isConfigured: true,
    search: async (
      query: string,
      options: { exactQuery?: boolean }
    ) => {
      searched.push({ query, exactQuery: options.exactQuery });
      return {
        products:
          searched.length === 1
            ? [product("wrong", "高精度针规 2.84mm")]
            : [product("right", "高精度针规 2.48mm")],
        fromCache: false,
        attempts: 1,
      };
    },
  };
  const memory = {
    loadProducts: async () => [],
    recordProducts: async () => ({
      productIds: new Map([["taobao:right", "product-right"]]),
    }),
  };
  const coherence = {
    verifyJob: async () => ({
      checkedCandidates: 1,
      estimatedCostUsd: 0,
    }),
  };
  const service = new RefineService(
    { assertOwnership: () => undefined } as never,
    memory as never,
    {} as never,
    hwh as never,
    coherence as never
  );

  try {
    const result = await service.refineJob(
      "client-a",
      "job-a",
      { topN: 3 },
      { mode: "v2-review" }
    );
    assert.equal(result.rowsProblematic, 1);
    assert.equal(result.rowsRefined, 1);
    assert.equal(result.rowsRecovered, 1);
  } finally {
    job.findUnique = originals.jobFindUnique;
    jobRow.findMany = originals.rowFindMany;
    jobRow.update = originals.rowUpdate;
    jobRow.updateMany = originals.rowUpdateMany;
    jobResult.findMany = originals.resultFindMany;
    jobResult.deleteMany = originals.resultDeleteMany;
    jobResult.create = originals.resultCreate;
    if (previousKeys.deepSeekApi === undefined) delete process.env.DEEP_SEEK_API;
    else process.env.DEEP_SEEK_API = previousKeys.deepSeekApi;
    if (previousKeys.deepSeekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKeys.deepSeekApiKey;
    if (previousKeys.primary === undefined) delete process.env.TAOBAO_PRIMARY_SEARCH;
    else process.env.TAOBAO_PRIMARY_SEARCH = previousKeys.primary;
  }

  // Il primo tentativo trova solo un 2.84mm, scartato dal gate; il secondo
  // porta il 2.48mm e la scala si ferma lì.
  assert.equal(searched.length, 2);
  // Nessun `exactQuery`: la scala del provider deve restare attiva, è quella
  // che accorcia la query quando il marketplace non trova nulla in AND.
  assert.ok(searched.every((entry) => entry.exactQuery !== true));
  // Il primo tentativo è quello preciso e conserva la misura richiesta; i
  // gradini successivi allargano, come fa la scala della v1.
  assert.ok(searched[0]!.query.includes("2.48mm"));
  // La misura sbagliata della query precedente non rientra mai.
  assert.ok(searched.every((entry) => !entry.query.includes("2.84mm")));
  const capturedUpdate = updateData as unknown as Record<string, unknown> | null;
  assert.match(String(capturedUpdate?.searchQuery ?? ""), /2\.48mm/u);
});
