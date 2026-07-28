import assert from "node:assert/strict";
import test from "node:test";
import type { TaobaoPipelineGap, TaobaoRowResults } from "@china/shared";
import { buildV2ResultRows, groupV2ResultRows } from "./results-model";

/**
 * Dove finisce, a schermo, una riga che nessun marketplace vende.
 *
 * La sezione «Nessun risultato» esiste per le righe da riprovare. Metterci
 * dentro un modulo da stampare chiede all'operatore di insistere su qualcosa
 * che non riuscirà mai — e allunga proprio l'elenco che si vuole corto.
 */

function row(patch: Partial<TaobaoRowResults> = {}): TaobaoRowResults {
  return {
    jobRowId: "row-1",
    rowNumber: 1,
    displayName: "工业泵",
    searchQuery: "工业泵",
    attemptedQueries: [],
    requestedQuantity: null,
    requestedUnit: null,
    status: "DONE",
    reused: false,
    error: null,
    candidates: [],
    ...patch,
  } as TaobaoRowResults;
}

function gap(patch: Partial<TaobaoPipelineGap> = {}): TaobaoPipelineGap {
  return {
    rowNumber: 1,
    displayName: "工业泵",
    searchQuery: "工业泵",
    reason: "no_results",
    detail: null,
    ...patch,
  };
}

test("una riga non acquistabile ha una sezione propria, non «nessun risultato»", () => {
  const rows = buildV2ResultRows([row()], {
    gaps: [
      gap({
        reason: "not_procurable",
        detail: "Form to print · modulo di collaudo",
      }),
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.section, "not_procurable");
  // Il motivo resta accanto alla riga: senza, la sezione è un elenco di nomi
  // che non spiega perché siano lì.
  assert.match(rows[0]?.gap?.detail ?? "", /modulo di collaudo/u);

  const grouped = groupV2ResultRows(rows);
  assert.equal(grouped.not_procurable.length, 1);
  assert.equal(grouped.no_result.length, 0);
});

test("gruppo di controllo: gli altri buchi restano dove sono sempre stati", () => {
  const rows = buildV2ResultRows(
    [row(), row({ jobRowId: "row-2", rowNumber: 2 })],
    {
      gaps: [
        gap({ reason: "no_results" }),
        gap({ rowNumber: 2, reason: "no_coherent" }),
      ],
    }
  );

  const grouped = groupV2ResultRows(rows);
  assert.equal(grouped.no_result.length, 2);
  assert.equal(grouped.not_procurable.length, 0);
});
