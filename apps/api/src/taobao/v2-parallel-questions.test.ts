import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import {
  CRITICAL_WARNING_CODES,
  DEFAULT_PROCUREMENT,
  type AnalysisWarning,
  type ProductAnalysis,
} from "@china/shared";
import { isRowUnaffectedByAnswers } from "./pipeline.service";
import { TaobaoJobService } from "./taobao-job.service";

/**
 * Una domanda ferma le righe che potrebbe cambiare, non il file.
 *
 * Due cose vanno garantite, e sono entrambe questioni di denaro: che le righe
 * cercate durante l'attesa siano solo quelle che la risposta non tocca, e che
 * le righe rimaste indietro entrino poi nello stesso job **una volta sola**.
 * Una riga duplicata è una ricerca pagata due volte.
 */

function analysis(patch: Partial<ProductAnalysis> = {}): ProductAnalysis {
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

function warning(code: AnalysisWarning["code"]): AnalysisWarning {
  return { code, field: null, message: "dubbio" };
}

test("parte solo ciò che nessuna risposta può cambiare", () => {
  assert.equal(isRowUnaffectedByAnswers(analysis()), true);
  // Senza analisi la riga verrà ritentata: cercarla ora sarebbe cercare il
  // nulla e poi doverla rifare.
  assert.equal(isRowUnaffectedByAnswers(null), false);
  // Ogni avviso critico è, per definizione, uno di quelli che una risposta
  // può sciogliere: la regola resta agganciata a quell'elenco invece di
  // ripeterlo, così le due non possono divergere in silenzio.
  for (const code of CRITICAL_WARNING_CODES) {
    assert.equal(
      isRowUnaffectedByAnswers(analysis({ warnings: [warning(code)] })),
      false,
      code
    );
  }
  // Una riga povera non è una riga ambigua: non aspetta niente.
  assert.equal(
    isRowUnaffectedByAnswers(analysis({ warnings: [warning("MISSING_INFO")] })),
    true
  );
});

test("le righe rimaste indietro entrano nello stesso job, una volta sola", async () => {
  const jobDelegate = prisma.taobaoJob as unknown as Record<string, unknown>;
  const rowDelegate = prisma.taobaoJobRow as unknown as Record<string, unknown>;
  const analysisDelegate = prisma.taobaoAnalysisRow as unknown as Record<string, unknown>;
  const original = {
    findUnique: jobDelegate.findUnique,
    update: jobDelegate.update,
    rowFindMany: rowDelegate.findMany,
    rowCreate: rowDelegate.create,
    analysisFindMany: analysisDelegate.findMany,
  };

  const created: number[] = [];
  let jobPatch: Record<string, unknown> | null = null;
  let restarted: string | null = null;

  jobDelegate.findUnique = async () => ({
    id: "job-a",
    totalRows: 2,
  });
  jobDelegate.update = async (args: { data: Record<string, unknown> }) => {
    jobPatch = args.data;
    return {};
  };
  // Righe 1 e 2 sono già state cercate durante l'attesa.
  rowDelegate.findMany = async () => [
    { datasetRowId: "dataset-row-1" },
    { datasetRowId: "dataset-row-2" },
  ];
  rowDelegate.create = async (args: { data: { rowNumber: number } }) => {
    created.push(args.data.rowNumber);
    return {};
  };
  analysisDelegate.findMany = async () => [
    {
      id: "analysis-1",
      datasetRowId: "dataset-row-1",
      rowNumber: 1,
      state: "READY",
      error: null,
      signatureText: "工业泵",
      effectiveAnalysis: analysis(),
      datasetRow: { id: "dataset-row-1", cells: [], hyperlink: null },
    },
    {
      id: "analysis-3",
      datasetRowId: "dataset-row-3",
      rowNumber: 3,
      state: "READY",
      error: null,
      signatureText: "工业泵",
      effectiveAnalysis: analysis(),
      datasetRow: { id: "dataset-row-3", cells: [], hyperlink: null },
    },
  ];

  const service = new TaobaoJobService(
    {} as never,
    { upsertRequest: async () => "request-1" } as never,
    { start: (jobId: string) => { restarted = jobId; } } as never,
    {} as never
  );

  try {
    const added = await service.appendMissingRows("job-a", "run-nuovo", {
      allowReviewRows: true,
    });
    assert.equal(added, 1);
    assert.deepEqual(created, [3]);
  } finally {
    jobDelegate.findUnique = original.findUnique;
    jobDelegate.update = original.update;
    rowDelegate.findMany = original.rowFindMany;
    rowDelegate.create = original.rowCreate;
    analysisDelegate.findMany = original.analysisFindMany;
  }

  assert.equal(restarted, "job-a");
  assert.equal((jobPatch as unknown as { totalRows: number }).totalRows, 3);
  // Il job non deve apparire concluso nell'istante fra l'aggiunta e la
  // ripartenza del runner: chi lo sta seguendo chiuderebbe la ricerca.
  assert.equal((jobPatch as unknown as { status: string }).status, "QUEUED");
  // Le righe aggiunte vanno cercate con l'analisi rifatta dopo la risposta.
  assert.equal(
    (jobPatch as unknown as { analysisRunId: string }).analysisRunId,
    "run-nuovo"
  );
});
