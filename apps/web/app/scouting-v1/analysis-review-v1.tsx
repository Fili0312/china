"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ANALYSIS_ROW_STATE_LABELS,
  CRITICAL_WARNING_CODES,
  type AnalysisWarningCode,
  type AnalyzedDimension,
  type AnalyzedSpec,
  type ProductAnalysis,
  type TaobaoAnalysisRow,
  type TaobaoAnalysisRun,
} from "@china/shared";
import { api } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { formatDate } from "../i18n/format";
import type { MessageKey } from "../i18n/messages-en";

/**
 * La revisione delle richieste interpretate.
 *
 * Il testo originale accanto all'interpretazione, ogni campo correggibile, e
 * due cose che riguardano solo Taobao:
 *
 * - si mostra la **query cinese**, che è quella che verrà davvero inviata;
 * - si mostra il **residuo dell'identità**: i pezzi del testo (misure, codici)
 *   entrati nella chiave di variante perché l'analisi non li aveva estratti.
 *   È la risposta visibile alla domanda «perché queste due righe simili non
 *   sono considerate la stessa richiesta?».
 */

const STATE_TONE: Record<string, string> = {
  READY: "ok",
  KNOWN_PRODUCT: "ok",
  NEW_PRODUCT: "",
  NEW_VARIANT: "warn",
  NEEDS_REVIEW: "warn",
  ANALYSIS_FAILED: "err",
};

/** Chiave del dizionario per ogni codice di avviso dell'analisi. */
const WARNING_KEYS: Record<AnalysisWarningCode, MessageKey> = {
  AMBIGUOUS_MEASURE: "warning.AMBIGUOUS_MEASURE",
  AMBIGUOUS_MODEL: "warning.AMBIGUOUS_MODEL",
  AMBIGUOUS_UNIT: "warning.AMBIGUOUS_UNIT",
  AMBIGUOUS_QUANTITY: "warning.AMBIGUOUS_QUANTITY",
  MULTIPLE_PRODUCTS: "warning.MULTIPLE_PRODUCTS",
  MISSING_INFO: "warning.MISSING_INFO",
  UNCLEAR_TEXT: "warning.UNCLEAR_TEXT",
  OTHER: "warning.OTHER",
};

const READY_STATES = new Set(["READY", "KNOWN_PRODUCT", "NEW_PRODUCT", "NEW_VARIANT"]);

/** Etichette dei campi modificabili, nell'ordine in cui compaiono nel modulo. */
const EDITABLE_FIELDS: Array<{ key: keyof ProductAnalysis; label: MessageKey }> = [
  { key: "productFamily", label: "editable.productFamily" },
  { key: "familyKey", label: "editable.familyKey" },
  { key: "variantKey", label: "editable.variantKey" },
  { key: "productNameChinese", label: "editable.productNameChinese" },
  { key: "productNameEnglish", label: "editable.productNameEnglish" },
  { key: "model", label: "editable.model" },
  { key: "material", label: "editable.material" },
  { key: "color", label: "editable.color" },
  { key: "searchQueryChinese", label: "editable.searchQueryChinese" },
  { key: "unit", label: "editable.unit" },
];

interface ReviewProps {
  clientId: string;
  run: TaobaoAnalysisRun;
  busy: boolean;
  onRunChange: (run: TaobaoAnalysisRun) => void;
  onError: (message: string) => void;
}

export function AnalysisReviewV1({
  clientId,
  run,
  busy,
  onRunChange,
  onError,
}: ReviewProps) {
  const { t, tr, locale } = useI18n();
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDone, setBulkDone] = useState(0);

  const toConfirm = useMemo(
    () => run.rows.filter((row) => row.state === "NEEDS_REVIEW" && row.analysis),
    [run.rows]
  );

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const row of run.rows) tally.set(row.state, (tally.get(row.state) ?? 0) + 1);
    return tally;
  }, [run.rows]);

  const patchRow = useCallback(
    async (row: TaobaoAnalysisRow, patch: Record<string, unknown>) => {
      setSavingRowId(row.analysisRowId);
      try {
        const updated = await api<TaobaoAnalysisRow>(
          `/taobao/clients/${clientId}/analysis/rows/${row.analysisRowId}`,
          { method: "PATCH", body: JSON.stringify(patch) }
        );
        const rows = run.rows.map((entry) =>
          entry.analysisRowId === updated.analysisRowId ? updated : entry
        );
        onRunChange({
          ...run,
          rows,
          readyRows: rows.filter((entry) => READY_STATES.has(entry.state)).length,
        });
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingRowId(null);
      }
    },
    [clientId, onError, onRunChange, run]
  );

  /** Conferma in blocco: in sequenza, perché ogni PATCH ricalcola le chiavi. */
  const confirmAll = useCallback(async () => {
    setBulkRunning(true);
    setBulkDone(0);
    const updated = new Map<string, TaobaoAnalysisRow>();
    try {
      for (const row of toConfirm) {
        try {
          const result = await api<TaobaoAnalysisRow>(
            `/taobao/clients/${clientId}/analysis/rows/${row.analysisRowId}`,
            { method: "PATCH", body: JSON.stringify({ approve: true }) }
          );
          updated.set(result.analysisRowId, result);
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : String(cause));
        }
        setBulkDone((done) => done + 1);
      }
    } finally {
      const rows = run.rows.map((row) => updated.get(row.analysisRowId) ?? row);
      onRunChange({
        ...run,
        rows,
        readyRows: rows.filter((row) => READY_STATES.has(row.state)).length,
      });
      setBulkRunning(false);
    }
  }, [clientId, onError, onRunChange, run, toConfirm]);

  return (
    <section className="panel scouting-step">
      <h2>{t("review.step")}</h2>

      <div className="scouting-row">
        <strong>
          {t("review.analysed", { analysed: run.analyzedRows, total: run.totalRows })}
        </strong>
        <span className="muted">
          {t("review.counts", {
            ready: run.readyRows,
            warnings: run.warningRows,
            failed: run.failedRows,
          })}
        </span>
        <span className="muted">
          {t("review.usage", {
            calls: run.usage.apiCalls,
            cached: run.usage.cachedRows,
            tokens: run.usage.inputTokens + run.usage.outputTokens,
            cost: run.usage.estimatedCostUsd.toFixed(4),
          })}
        </span>
        <span
          className="chip"
          title={t("review.engineTitle", { version: run.usage.promptVersion })}
        >
          {run.usage.provider ? `${run.usage.provider} · ` : ""}
          {run.usage.model}
        </span>
      </div>

      <div className="scouting-engine-chips">
        {[...counts.entries()].map(([state, count]) => (
          <span key={state} className={`chip ${STATE_TONE[state] ?? ""}`}>
            {ANALYSIS_ROW_STATE_LABELS[locale][
              state as keyof (typeof ANALYSIS_ROW_STATE_LABELS)["en"]
            ] ?? state}{" "}
            {count}
          </span>
        ))}
      </div>

      <p className="scouting-hint">{tr("review.hint")}</p>

      {toConfirm.length > 0 ? (
        <div className="scouting-row scouting-bulk">
          <span>{tr("review.pending", { count: toConfirm.length })}</span>
          <button type="button" disabled={busy || bulkRunning} onClick={() => void confirmAll()}>
            {bulkRunning
              ? t("review.confirming", { done: bulkDone, total: toConfirm.length })
              : t("review.confirmAll", { count: toConfirm.length })}
          </button>
        </div>
      ) : null}

      <div className="scouting-table-wrap">
        <table className="scouting-table">
          <thead>
            <tr>
              <th>{t("review.col.row")}</th>
              <th>{t("review.col.original")}</th>
              <th>{t("review.col.family")}</th>
              <th>{t("review.col.query")}</th>
              <th>{t("review.col.specs")}</th>
              <th>{t("review.col.confidence")}</th>
              <th>{t("review.col.state")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row) => (
              <ReviewRow
                key={row.analysisRowId}
                row={row}
                open={openRowId === row.analysisRowId}
                busy={busy || savingRowId === row.analysisRowId}
                onToggle={() =>
                  setOpenRowId(openRowId === row.analysisRowId ? null : row.analysisRowId)
                }
                onPatch={(patch) => void patchRow(row, patch)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReviewRow({
  row,
  open,
  busy,
  onToggle,
  onPatch,
}: {
  row: TaobaoAnalysisRow;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const { t, locale, intlLocale } = useI18n();
  const dash = t("common.none");
  const analysis = row.analysis;
  const criticalWarnings = (analysis?.warnings ?? []).filter((warning) =>
    (CRITICAL_WARNING_CODES as readonly string[]).includes(warning.code)
  );

  return (
    <>
      <tr>
        <td className="muted">{row.rowNumber}</td>
        <td className="scouting-samples">
          {row.originalCells.filter(Boolean).slice(0, 6).join(" · ") || dash}
        </td>
        <td>
          {analysis ? (
            <>
              <div>{analysis.productFamily}</div>
              <div className="scouting-hint">{analysis.variantKey}</div>
              {row.identity && row.identity.residual.length > 0 ? (
                <div className="scouting-hint" title={t("review.residualTitle")}>
                  {t("review.residual", { values: row.identity.residual.join(" ") })}
                </div>
              ) : null}
            </>
          ) : (
            <span className="muted">{dash}</span>
          )}
        </td>
        <td>
          {analysis ? (
            <>
              <div>
                {analysis.searchQueryChinese ?? (
                  <span className="muted">{t("review.noQuery")}</span>
                )}
              </div>
              <div className="muted">{analysis.productNameChinese ?? dash}</div>
            </>
          ) : (
            <span className="muted">{dash}</span>
          )}
        </td>
        <td className="scouting-samples">
          {analysis ? (
            <>
              {analysis.model ? <div>{t("review.model", { model: analysis.model })}</div> : null}
              <div className="scouting-hint">
                {formatDimensions(analysis.dimensions, dash, t("common.measure"))}
              </div>
              <div className="scouting-hint">
                {formatSpecs(analysis.technicalSpecifications, dash)}
              </div>
            </>
          ) : (
            <span className="muted">{dash}</span>
          )}
        </td>
        <td>
          {analysis ? (
            <span className={`badge ${analysis.confidence >= 0.8 ? "ok" : "warn"}`}>
              {Math.round(analysis.confidence * 100)}%
            </span>
          ) : (
            <span className="muted">{dash}</span>
          )}
        </td>
        <td>
          <span className={`badge ${STATE_TONE[row.state] ?? ""}`}>
            {ANALYSIS_ROW_STATE_LABELS[locale][row.state]}
          </span>
          {row.edited ? <span className="chip">{t("review.edited")}</span> : null}
          {row.fromCache ? (
            <span className="chip" title={t("review.cachedTitle")}>
              {t("review.cached")}
            </span>
          ) : null}
          {row.state !== "NEEDS_REVIEW" && criticalWarnings.length > 0 ? (
            <span
              className="chip warn"
              title={criticalWarnings
                .map((warning) => `${t(WARNING_KEYS[warning.code])}: ${warning.message}`)
                .join(" · ")}
            >
              {t("review.toCheck")}
            </span>
          ) : null}
          {row.memory?.requestId ? (
            <div className="scouting-hint">
              {t("review.memory", {
                valid: row.memory.validProductCount,
                total: row.memory.productCount,
                date: formatDate(row.memory.lastSearchedAt, intlLocale, t("common.never")),
              })}
            </div>
          ) : null}
          {!row.memory?.requestId && (row.memory?.familyRequestCount ?? 0) > 0 ? (
            <div className="scouting-hint">
              {t("review.memoryFamily", { count: row.memory!.familyRequestCount })}
            </div>
          ) : null}
        </td>
        <td>
          <button type="button" className="chip" onClick={onToggle} disabled={busy}>
            {open ? t("common.close") : t("review.edit")}
          </button>
        </td>
      </tr>

      {(criticalWarnings.length > 0 || row.error) && !open ? (
        <tr>
          <td />
          <td colSpan={7}>
            {row.error ? <div className="scouting-engine-error">{row.error}</div> : null}
            {criticalWarnings.map((warning) => (
              <div key={`${warning.code}-${warning.message}`} className="scouting-warning">
                {t(WARNING_KEYS[warning.code])}
                {warning.field ? ` (${warning.field})` : ""}: {warning.message}
              </div>
            ))}
          </td>
        </tr>
      ) : null}

      {open ? (
        <tr>
          <td />
          <td colSpan={7}>
            <RowEditor row={row} busy={busy} onPatch={onPatch} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RowEditor({
  row,
  busy,
  onPatch,
}: {
  row: TaobaoAnalysisRow;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const dash = t("common.none");
  const analysis = row.analysis;
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (!analysis) return initial;
    for (const field of EDITABLE_FIELDS) {
      const value = analysis[field.key];
      initial[field.key] = value == null ? "" : String(value);
    }
    initial.requestedQuantity =
      analysis.requestedQuantity == null ? "" : String(analysis.requestedQuantity);
    return initial;
  });

  if (!analysis) {
    return (
      <div className="scouting-warning">
        {row.error ?? t("review.noAnalysis")} {t("review.noAnalysisHint")}
      </div>
    );
  }

  const save = (approve?: boolean) => {
    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      const next = draft[field.key] ?? "";
      const current = analysis[field.key];
      const currentText = current == null ? "" : String(current);
      if (next === currentText) continue;
      const nullable = !["productFamily", "familyKey", "variantKey"].includes(field.key);
      patch[field.key] = next === "" && nullable ? null : next;
    }
    const quantity = draft.requestedQuantity ?? "";
    const currentQuantity =
      analysis.requestedQuantity == null ? "" : String(analysis.requestedQuantity);
    if (quantity !== currentQuantity) {
      patch.requestedQuantity = quantity === "" ? null : Number(quantity);
    }
    if (approve !== undefined) patch.approve = approve;
    onPatch(patch);
  };

  return (
    <div className="scouting-analysis-editor">
      <div className="scouting-hint">
        {t("review.submitted")}
        <pre className="scouting-submitted">{row.submittedText || dash}</pre>
      </div>

      {analysis.warnings.map((warning) => (
        <div key={`${warning.code}-${warning.message}`} className="scouting-warning">
          {t(WARNING_KEYS[warning.code])}
          {warning.field ? ` (${warning.field})` : ""}: {warning.message}
        </div>
      ))}

      <div className="scouting-row scouting-options">
        {EDITABLE_FIELDS.map((field) => (
          <label key={field.key}>
            {t(field.label)}
            <input
              type="text"
              value={draft[field.key] ?? ""}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
            />
          </label>
        ))}
        <label>
          {t("editable.requestedQuantity")}
          <input
            type="number"
            value={draft.requestedQuantity ?? ""}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, requestedQuantity: event.target.value })
            }
          />
        </label>
      </div>

      <div className="scouting-hint">
        {t("review.dimensions", {
          dimensions: formatDimensions(analysis.dimensions, dash, t("common.measure")),
          specs: formatSpecs(analysis.technicalSpecifications, dash),
        })}
        {analysis.hardRequirements.length > 0
          ? t("review.hardRequirements", {
              requirements: analysis.hardRequirements.join("; "),
            })
          : ""}
      </div>
      {row.identity ? (
        <div className="scouting-hint">
          {t("review.variant", { variant: row.identity.variantKey })}
        </div>
      ) : null}
      {row.referenceUrl ? (
        <div className="scouting-hint">
          {t("review.referenceUrl")}{" "}
          <a href={row.referenceUrl} target="_blank" rel="noreferrer">
            {row.referenceUrl}
          </a>
        </div>
      ) : null}

      <div className="scouting-row scouting-controls">
        <button type="button" disabled={busy} onClick={() => save()}>
          {t("review.save")}
        </button>
        <button type="button" disabled={busy} onClick={() => save(true)}>
          {t("review.saveConfirm")}
        </button>
      </div>
    </div>
  );
}

/**
 * Le misure in una riga sola.
 *
 * `axis` è già una chiave canonica in inglese (`length`, `width`…): resta com'è
 * anche nelle altre lingue perché è la stessa parola che compare nella query
 * inviata e nel foglio esportato, e tradurla qui creerebbe due nomi per la
 * stessa cosa. Solo l'asse `other` senza etichetta ha bisogno di una parola.
 */
function formatDimensions(
  dimensions: readonly AnalyzedDimension[],
  dash: string,
  measureLabel: string
): string {
  if (dimensions.length === 0) return dash;
  return dimensions
    .map((dimension) => {
      const axis = dimension.axis === "other" ? (dimension.label ?? measureLabel) : dimension.axis;
      return `${axis} ${dimension.value}${dimension.unit ? ` ${dimension.unit}` : ""}`;
    })
    .join(" · ");
}

function formatSpecs(specs: readonly AnalyzedSpec[], dash: string): string {
  if (specs.length === 0) return dash;
  return specs
    .map((spec) => `${spec.key} ${spec.value}${spec.unit ? ` ${spec.unit}` : ""}`)
    .join(" · ");
}
