import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import {
  DEFAULT_PROCUREMENT,
  ProductAnalysisModelSchema,
  ProductAnalysisSchema,
  isSearchableProcurement,
  procurementOf,
  type ProcurementKind,
  type ProductAnalysis,
} from "@china/shared";
import { buildPipelineReviewIssues, PipelineService } from "./pipeline.service";
import { isTaobaoJobRowProcurable } from "./taobao-job.service";

/**
 * Che cosa fa il sistema con una riga che non è merce da marketplace.
 *
 * Il rischio di questa funzione è uno solo, ed è il motivo per cui metà dei
 * casi qui sotto sono un gruppo di controllo: una classificazione sbagliata
 * **toglie** una riga dalla ricerca. I test verificano quindi in entrambe le
 * direzioni — che le righe non acquistabili escano dagli scoperti, e che
 * nessun prodotto vero venga spostato o nascosto per colpa dell'etichetta.
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

function notProcurable(kind: ProcurementKind, reason: string): ProductAnalysis {
  return analysis({ procurement: { kind, reason } });
}

/* -------------------------------------------------------------------------- */
/* Lo schema                                                                   */
/* -------------------------------------------------------------------------- */

test("un'analisi salvata prima del campo resta leggibile come prodotto normale", () => {
  const { procurement: _omitted, ...legacy } = analysis();
  const parsed = ProductAnalysisSchema.parse(legacy);
  assert.deepEqual(parsed.procurement, {
    kind: "MARKETPLACE_ITEM",
    reason: null,
  });
  assert.equal(procurementOf(parsed), "MARKETPLACE_ITEM");
});

test("al modello il campo si chiede obbligatorio, senza ripieghi silenziosi", () => {
  const { procurement: _omitted, ...withoutField } = analysis();
  assert.equal(ProductAnalysisModelSchema.safeParse(withoutField).success, false);
  assert.equal(ProductAnalysisModelSchema.safeParse(analysis()).success, true);
});

/* -------------------------------------------------------------------------- */
/* La politica: che cosa si cerca e che cosa no                                */
/* -------------------------------------------------------------------------- */

test("si rinuncia a cercare solo ciò che nessuno può mettere a catalogo", () => {
  assert.equal(isSearchableProcurement("MARKETPLACE_ITEM"), true);
  // Codici di costruttore, pezzi su disegno e prestazioni si cercano lo
  // stesso. Non è prudenza teorica: sul gruppo di controllo della corsa da
  // 498 righe, escludere i servizi avrebbe tolto dalla ricerca un certificato
  // di taratura che quella corsa aveva trovato e confermato.
  assert.equal(isSearchableProcurement("PROPRIETARY_PART"), true);
  assert.equal(isSearchableProcurement("CUSTOM_MADE"), true);
  assert.equal(isSearchableProcurement("SERVICE"), true);
  assert.equal(isSearchableProcurement("PRINTED_DOCUMENT"), false);
  assert.equal(isSearchableProcurement("NOT_A_PRODUCT"), false);
});

test("il cancello della ricerca segue la politica, e senza analisi non blocca", () => {
  assert.equal(isTaobaoJobRowProcurable(analysis()), true);
  assert.equal(isTaobaoJobRowProcurable(null), true);
  assert.equal(
    isTaobaoJobRowProcurable(
      notProcurable("PRINTED_DOCUMENT", "modulo di collaudo da stampare")
    ),
    false
  );
  assert.equal(
    isTaobaoJobRowProcurable(
      notProcurable("PROPRIETARY_PART", "solo un codice del costruttore")
    ),
    true
  );
  assert.equal(
    isTaobaoJobRowProcurable(notProcurable("SERVICE", "taratura con certificato")),
    true
  );
});

/* -------------------------------------------------------------------------- */
/* L'esito finale                                                              */
/* -------------------------------------------------------------------------- */

interface OutcomeRow {
  rowNumber: number;
  analysis: ProductAnalysis;
  /** Verdetto del candidato trovato; `null` quando la riga è rimasta vuota. */
  verdict?: "coherent" | "incoherent" | "unsure" | null;
  /** Obiezioni del giudice sul candidato: un coerente con riserve non chiude. */
  issues?: readonly string[];
  /**
   * Testo originale della riga. Conta: un dubbio sulle misure viene ritenuto
   * pertinente solo se le misure sono davvero scritte nella riga.
   */
  submittedText?: string;
  /** Prezzo del candidato: `null` è il caso dei link presi dal foglio. */
  price?: number | null;
}

/**
 * Esegue `buildOutcome` con prisma e job finti: quello che si vuole misurare
 * è la classificazione, non l'accesso ai dati.
 */
async function outcomeFor(rows: readonly OutcomeRow[]) {
  const runs = prisma.taobaoAnalysisRun as unknown as {
    findUnique: (args: unknown) => Promise<unknown>;
  };
  const originalFindUnique = runs.findUnique;
  runs.findUnique = async () => ({
    totalRows: rows.length,
    costUsd: 0,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      signatureText: row.analysis.productNameChinese,
      effectiveAnalysis: row.analysis,
      error: null,
      analysis: {
        submittedText: row.submittedText ?? row.analysis.productNameChinese,
      },
    })),
  });

  const jobs = {
    getResults: async () => ({
      job: {
        reusedRows: 0,
        usage: {
          apiCalls: 0,
          hwhCalls: 0,
          elimCalls: 0,
          browserCalls: 0,
          apiCacheHits: 0,
        },
      },
      rows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        displayName: row.analysis.productNameChinese,
        searchQuery: row.analysis.searchQueryChinese,
        status: "DONE",
        reuseReason: null,
        error: null,
        apiError: null,
        hwhError: null,
        candidates: row.verdict
          ? [
              {
                rank: 1,
                score: 1,
                coherence: { verdict: row.verdict, issues: row.issues ?? [] },
                product: {
                  unavailable: false,
                  price: row.price === undefined ? 12.5 : row.price,
                  url: "https://item.taobao.com/item.htm?id=1",
                },
              },
            ]
          : [],
      })),
    }),
  };

  const service = new PipelineService(
    {} as never,
    {} as never,
    { minConfidence: 0.4 } as never,
    jobs as never,
    {} as never,
    {} as never,
    {} as never
  );

  try {
    return await (
      service as unknown as {
        buildOutcome: (
          clientId: string,
          analysisRunId: string | null,
          jobId: string | null,
          refineRounds: number,
          recoveredRows: number
        ) => Promise<import("@china/shared").TaobaoPipelineOutcome>;
      }
    ).buildOutcome("client-a", "run-a", "job-a", 0, 0);
  } finally {
    runs.findUnique = originalFindUnique;
  }
}

test("una riga che non è merce esce dagli scoperti e va nella sua sezione", async () => {
  const outcome = await outcomeFor([
    {
      rowNumber: 1,
      analysis: notProcurable("PRINTED_DOCUMENT", "modulo da stampare in A4"),
    },
  ]);

  assert.equal(outcome.notProcurableRows, 1);
  // Non è «non trovata»: nessuna ri-ricerca la salverebbe, e prometterlo
  // manderebbe l'operatore a riprovare qualcosa che non riuscirà mai.
  assert.equal(outcome.uncoveredRows, 0);
  assert.equal(outcome.gaps.length, 1);
  assert.equal(outcome.gaps[0]?.reason, "not_procurable");
  assert.match(outcome.gaps[0]?.detail ?? "", /modulo da stampare in A4/u);
});

test("l'etichetta non toglie un prodotto trovato: il confermato resta confermato", async () => {
  const outcome = await outcomeFor([
    {
      rowNumber: 1,
      analysis: notProcurable("PROPRIETARY_PART", "codice del costruttore"),
      verdict: "coherent",
    },
  ]);

  assert.equal(outcome.confirmedRows, 1);
  assert.equal(outcome.notProcurableRows, 0);
  assert.equal(outcome.gaps.length, 0);
});

test("gruppo di controllo: le righe normali restano classificate come prima", async () => {
  const outcome = await outcomeFor([
    { rowNumber: 1, analysis: analysis() },
    { rowNumber: 2, analysis: analysis(), verdict: "coherent" },
    { rowNumber: 3, analysis: analysis(), verdict: "incoherent" },
  ]);

  assert.equal(outcome.notProcurableRows, 0);
  assert.equal(outcome.confirmedRows, 1);
  assert.equal(outcome.uncoveredRows, 2);
  assert.deepEqual(
    outcome.gaps.map((gap) => gap.reason).sort(),
    ["no_coherent", "no_results"]
  );
});

test("una riga che non verrà cercata non chiede più niente a nessuno", () => {
  const warnings = [
    { code: "AMBIGUOUS_UNIT" as const, field: "unit", message: "mm o cm?" },
  ];
  const asked = buildPipelineReviewIssues(
    [
      {
        rowNumber: 1,
        submittedText: "modulo A4",
        analysis: analysis({ warnings }),
        error: null,
      },
    ],
    new Set(),
    0.4
  );
  assert.equal(asked.length, 1);

  const silent = buildPipelineReviewIssues(
    [
      {
        rowNumber: 1,
        submittedText: "modulo A4",
        analysis: {
          ...notProcurable("PRINTED_DOCUMENT", "modulo da stampare"),
          warnings,
        },
        error: null,
      },
    ],
    new Set(),
    0.4
  );
  assert.deepEqual(silent, []);
});

test("il verdetto senza riserve chiude il dubbio; l'incerto no", async () => {
  // Un dubbio che davvero chiama una persona: la stessa forma che la corsa
  // da 498 righe produceva sui pannelli «60*60» senza unità.
  const doubtful = analysis({
    dimensions: [
      { axis: "length", label: null, value: 60, unit: null },
      { axis: "width", label: null, value: 60, unit: null },
    ],
    warnings: [
      {
        code: "AMBIGUOUS_UNIT",
        field: "dimensions",
        message: "Unità di misura non specificata per le dimensioni 60*60",
      },
    ],
  });

  const line = "Nome: 平板灯\nSpecifiche: 60*60";

  const settled = await outcomeFor([
    { rowNumber: 1, analysis: doubtful, verdict: "coherent", submittedText: line },
  ]);
  assert.equal(settled.confirmedRows, 1);
  assert.equal(settled.uncertainRows, 0);

  // Gruppo di controllo, due volte. Un «incerto» significa che il giudice non
  // ha potuto verificare proprio quell'attributo: la domanda resta.
  const unsure = await outcomeFor([
    { rowNumber: 1, analysis: doubtful, verdict: "unsure", submittedText: line },
  ]);
  assert.equal(unsure.uncertainRows, 1);
  assert.equal(unsure.confirmedRows, 0);

  // E un coerente **con obiezioni** è una deviazione da accettare, non una
  // risposta: decide una persona.
  const withReservations = await outcomeFor([
    {
      rowNumber: 1,
      analysis: doubtful,
      verdict: "coherent",
      issues: ["Il titolo indica 30x60, non 60x60."],
      submittedText: line,
    },
  ]);
  assert.equal(withReservations.uncertainRows, 1);
  assert.equal(withReservations.confirmedRows, 0);
});

test("un prodotto senza prezzo non è una riga di quotazione", async () => {
  const withPrice = await outcomeFor([
    { rowNumber: 1, analysis: analysis(), verdict: "coherent", price: 42 },
  ]);
  assert.equal(withPrice.confirmedRows, 1);

  // Stesso prodotto, stesso verdetto, prezzo assente: la riga non può essere
  // esportata come confermata, perché la cella del prezzo sarebbe vuota.
  const withoutPrice = await outcomeFor([
    { rowNumber: 1, analysis: analysis(), verdict: "coherent", price: null },
  ]);
  assert.equal(withoutPrice.confirmedRows, 0);
  assert.equal(withoutPrice.uncertainRows, 1);
  const issue = withoutPrice.reviewIssues.find(
    (entry) => entry.code === "MISSING_PRICE"
  );
  assert.equal(issue?.resolvedAutomatically, false);
  // Il link resta accanto alla riga: è dove il prezzo si legge.
  assert.match(issue?.detail ?? "", /item\.taobao\.com/u);
});

test("i quattro conteggi continuano a sommare al totale delle righe", async () => {
  const outcome = await outcomeFor([
    { rowNumber: 1, analysis: analysis(), verdict: "coherent" },
    { rowNumber: 2, analysis: analysis() },
    { rowNumber: 3, analysis: notProcurable("SERVICE", "taratura in loco") },
    { rowNumber: 4, analysis: notProcurable("NOT_A_PRODUCT", "riga di totale") },
  ]);

  assert.equal(
    outcome.confirmedRows +
      outcome.uncertainRows +
      outcome.uncoveredRows +
      outcome.notProcurableRows,
    outcome.totalRows
  );
  assert.equal(outcome.notProcurableRows, 2);
});
