import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import type { ProductAnalysis } from "@china/shared";
import { CoherenceService } from "./coherence.service";
import { deriveV2RequirementContext } from "./v2-requirement-policy";

function analysis(): ProductAnalysis {
  return {
    productFamily: "calibro a spillo",
    familyKey: "pin-gauge",
    variantKey: "2.48-mm",
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
    searchQueryChinese: "针规 2.48mm",
    searchQueryEnglish: "pin gauge 2.48mm",
    confidence: 0.95,
    warnings: [],
  };
}

// I test del gate deterministico v2 sono stati disattivati perché il gate
// stesso è stato disattivato: ora la v2 funziona come la v1 — manda tutto a
// DeepSeek. Resta solo il test per l'interruttore di dettaglio inerte.

test("una fonte che non serve schede viene abbandonata dopo pochi tentativi", async () => {
  const job = prisma.taobaoJob as unknown as {
    findUnique: (args: unknown) => Promise<unknown>;
  };
  const jobRow = prisma.taobaoJobRow as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const jobResult = prisma.taobaoJobResult as unknown as {
    update: (args: unknown) => Promise<unknown>;
  };
  const originals = {
    job: job.findUnique,
    rows: jobRow.findMany,
    result: jobResult.update,
  };
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const detailCalls: string[] = [];

  const parsed = analysis();
  const sourceText = "Nome: Pin gauge\nSpecifiche: diametro 2.48 mm";
  const requirementContext = deriveV2RequirementContext(parsed, sourceText);

  process.env.DEEPSEEK_API_KEY = "test-key-never-used";
  job.findUnique = async () => ({ id: "job-a", clientId: "client-a" });
  // Dieci righe con un candidato incerto ciascuna: il titolo non nomina mai
  // la misura, quindi ognuna chiederebbe la scheda.
  jobRow.findMany = async () =>
    Array.from({ length: 10 }, (_, index) => ({
      rowNumber: index + 1,
      searchQuery: "针规 2.48mm",
      analysisRow: {
        effectiveAnalysis: parsed,
        signatureText: sourceText,
        manualEdits: { _v2RequirementContext: requirementContext },
        analysis: { submittedText: sourceText },
        datasetRow: { cells: ["Pin gauge", "2.48 mm"] },
      },
      results: [
        {
          id: `result-${index}`,
          rank: 1,
          coherenceCheckedAt: null,
          product: {
            id: `product-${index}`,
            itemId: `item-${index}`,
            platform: "taobao",
            title: "高精度针规 量具",
            titleEn: null,
            sku: null,
            shopName: null,
            specs: null,
            variants: null,
            moq: 1,
            price: null,
            promotionPrice: null,
            currency: "CNY",
            availability: null,
            url: null,
            sources: [],
            unavailable: false,
          },
        },
      ],
    }));
  jobResult.update = async () => ({});

  const api = {
    isConfigured: true,
    // Endpoint presente ma inerte: risponde senza specifiche né varianti.
    detail: async (itemId: string) => {
      detailCalls.push(itemId);
      return { patch: {}, credits: 1, fromCache: false };
    },
  };
  const service = new CoherenceService(
    { assertOwnership: () => undefined } as never,
    {} as never,
    api as never
  );

  try {
    await service.verifyJob(
      "client-a",
      "job-a",
      { topN: 3, force: false },
      { mode: "v2-review" }
    );
  } catch {
    // Senza IA raggiungibile la verifica può fallire: qui conta solo quante
    // schede sono state chieste prima di rinunciare.
  } finally {
    job.findUnique = originals.job;
    jobRow.findMany = originals.rows;
    jobResult.update = originals.result;
    if (originalKey == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }

  // Tre risposte vuote e basta: le altre sette righe non pagano nulla.
  assert.equal(detailCalls.length, 3);
});
