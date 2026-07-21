"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ANALYSIS_ROW_STATE_LABELS,
  CRITICAL_WARNING_CODES,
  type AnalysisRow,
  type AnalysisRun,
  type AnalysisWarningCode,
  type AnalyzedDimension,
  type AnalyzedSpec,
  type ProductAnalysis,
} from "@china/shared";
import { api } from "../../lib/api";

/**
 * La fase «Analisi richieste con IA».
 *
 * Sta fra il caricamento del file e la ricerca, e serve a una cosa sola: far
 * vedere a un umano **che cosa il sistema ha capito** prima di spendere tempo
 * e crediti a cercarlo. Per questo ogni riga mostra il testo originale accanto
 * all'interpretazione, e ogni campo interpretato è modificabile.
 *
 * Le righe con confidenza bassa o warning critici non partono da sole: la
 * casella «pronta» va spuntata a mano. È deliberatamente un attrito — è il
 * momento in cui costa poco accorgersi che `60*60` erano centimetri.
 */

const STATE_TONE: Record<string, string> = {
  READY: "ok",
  KNOWN_PRODUCT: "ok",
  NEW_PRODUCT: "",
  NEW_VARIANT: "warn",
  NEEDS_REVIEW: "warn",
  ANALYSIS_FAILED: "err",
};

const WARNING_LABELS: Record<AnalysisWarningCode, string> = {
  AMBIGUOUS_MEASURE: "misura ambigua",
  AMBIGUOUS_MODEL: "modello ambiguo",
  AMBIGUOUS_UNIT: "unità ambigua",
  AMBIGUOUS_QUANTITY: "quantità ambigua",
  MULTIPLE_PRODUCTS: "più prodotti nella riga",
  MISSING_INFO: "informazioni mancanti",
  UNCLEAR_TEXT: "testo poco chiaro",
  OTHER: "altro",
};

/** Righe da cui la ricerca può partire senza conferma esplicita. */
const READY_STATES = new Set(["READY", "KNOWN_PRODUCT", "NEW_PRODUCT", "NEW_VARIANT"]);

function formatDimensions(dimensions: readonly AnalyzedDimension[]): string {
  if (dimensions.length === 0) return "—";
  return dimensions
    .map((dimension) => {
      const axis = dimension.axis === "other" ? (dimension.label ?? "misura") : dimension.axis;
      return `${axis} ${dimension.value}${dimension.unit ? ` ${dimension.unit}` : ""}`;
    })
    .join(" · ");
}

function formatSpecs(specs: readonly AnalyzedSpec[]): string {
  if (specs.length === 0) return "—";
  return specs
    .map((spec) => `${spec.key} ${spec.value}${spec.unit ? ` ${spec.unit}` : ""}`)
    .join(" · ");
}

function formatDate(value: string | null): string {
  if (!value) return "mai";
  return new Date(value).toLocaleDateString("it-IT");
}

interface AnalysisReviewProps {
  run: AnalysisRun;
  busy: boolean;
  onRunChange: (run: AnalysisRun) => void;
  onError: (message: string) => void;
}

export function AnalysisReview({ run, busy, onRunChange, onError }: AnalysisReviewProps) {
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const row of run.rows) {
      tally.set(row.state, (tally.get(row.state) ?? 0) + 1);
    }
    return tally;
  }, [run.rows]);

  /** Applica una correzione e rimpiazza la riga con quella tornata dall'API. */
  const patchRow = useCallback(
    async (row: AnalysisRow, patch: Record<string, unknown>) => {
      setSavingRowId(row.analysisRowId);
      try {
        const updated = await api<AnalysisRow>(
          `/scouting/analysis/rows/${row.analysisRowId}`,
          { method: "PATCH", body: JSON.stringify(patch) }
        );
        onRunChange({
          ...run,
          rows: run.rows.map((entry) =>
            entry.analysisRowId === updated.analysisRowId ? updated : entry
          ),
          readyRows: run.rows.filter((entry) =>
            entry.analysisRowId === updated.analysisRowId
              ? READY_STATES.has(updated.state)
              : READY_STATES.has(entry.state)
          ).length,
        });
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingRowId(null);
      }
    },
    [onError, onRunChange, run]
  );

  return (
    <section className="panel scouting-step">
      <h2>3. Analisi richieste con IA</h2>

      <div className="scouting-row scouting-job-head">
        <strong>
          {run.analyzedRows} / {run.totalRows} righe analizzate
        </strong>
        <span className="muted">
          {run.readyRows} pronte · {run.failedRows} non analizzabili
        </span>
        <span className="muted">
          {run.usage.apiCalls} chiamate · {run.usage.cachedRows} da cache ·{" "}
          {run.usage.inputTokens + run.usage.outputTokens} token · ≈ $
          {run.usage.estimatedCostUsd.toFixed(4)}
        </span>
        <span className="chip" title={`Prompt ${run.usage.promptVersion}`}>
          {run.usage.model}
        </span>
      </div>

      <div className="scouting-engine-chips">
        {[...counts.entries()].map(([state, count]) => (
          <span key={state} className={`chip ${STATE_TONE[state] ?? ""}`}>
            {ANALYSIS_ROW_STATE_LABELS[state as keyof typeof ANALYSIS_ROW_STATE_LABELS] ??
              state}{" "}
            {count}
          </span>
        ))}
      </div>

      <p className="scouting-hint">
        Le righe con confidenza sotto la soglia o con avvertimenti critici non
        partono automaticamente: aprile, correggi ciò che serve e confermale.
      </p>

      <div className="scouting-table-wrap">
        <table className="scouting-table">
          <thead>
            <tr>
              <th>Riga</th>
              <th>Testo originale</th>
              <th>Famiglia / variante</th>
              <th>Nomi e query</th>
              <th>Specifiche obbligatorie</th>
              <th>Confidenza</th>
              <th>Stato</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row) => (
              <AnalysisRowView
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

interface AnalysisRowViewProps {
  row: AnalysisRow;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
}

function AnalysisRowView({ row, open, busy, onToggle, onPatch }: AnalysisRowViewProps) {
  const analysis = row.analysis;
  const criticalWarnings = (analysis?.warnings ?? []).filter((warning) =>
    (CRITICAL_WARNING_CODES as readonly string[]).includes(warning.code)
  );

  return (
    <>
      <tr>
        <td className="muted">{row.rowNumber}</td>
        <td className="scouting-samples">
          {/* La riga originale resta sempre visibile: è la fonte di verità
              contro cui l'utente giudica l'interpretazione. */}
          {row.originalCells.filter(Boolean).slice(0, 6).join(" · ") || "—"}
        </td>
        <td>
          {analysis ? (
            <>
              <div>{analysis.productFamily}</div>
              <div className="scouting-hint">{analysis.variantKey}</div>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          {analysis ? (
            <>
              <div>{analysis.productNameChinese ?? <span className="muted">nessun nome cinese</span>}</div>
              <div className="muted">{analysis.productNameEnglish ?? "—"}</div>
              <div className="scouting-hint">
                ZH: {analysis.searchQueryChinese ?? "—"} · EN:{" "}
                {analysis.searchQueryEnglish ?? "—"}
              </div>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="scouting-samples">
          {analysis ? (
            <>
              {analysis.model ? <div>modello {analysis.model}</div> : null}
              <div className="scouting-hint">{formatDimensions(analysis.dimensions)}</div>
              <div className="scouting-hint">{formatSpecs(analysis.technicalSpecifications)}</div>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          {analysis ? (
            <span className={`badge ${analysis.confidence >= 0.8 ? "ok" : "warn"}`}>
              {Math.round(analysis.confidence * 100)}%
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          <span className={`badge ${STATE_TONE[row.state] ?? ""}`}>
            {ANALYSIS_ROW_STATE_LABELS[row.state]}
          </span>
          {row.edited ? <span className="chip">corretta</span> : null}
          {row.fromCache ? (
            <span className="chip" title="Analisi riusata: nessuna chiamata spesa">
              da cache
            </span>
          ) : null}
          {row.dbMatch?.requestId ? (
            <div className="scouting-hint">
              {row.dbMatch.validCandidateCount}/{row.dbMatch.candidateCount} prodotti
              validi · ultima ricerca {formatDate(row.dbMatch.lastSearchedAt)}
            </div>
          ) : null}
          {!row.dbMatch?.requestId && (row.dbMatch?.familyRequestCount ?? 0) > 0 ? (
            <div className="scouting-hint">
              {row.dbMatch!.familyRequestCount} varianti note della stessa famiglia
            </div>
          ) : null}
        </td>
        <td>
          <button type="button" className="chip" onClick={onToggle} disabled={busy}>
            {open ? "chiudi" : "correggi"}
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
                {WARNING_LABELS[warning.code]}
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
            <AnalysisRowEditor row={row} busy={busy} onPatch={onPatch} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Campi correggibili di una riga. */
const EDITABLE_FIELDS: Array<{ key: keyof ProductAnalysis; label: string }> = [
  { key: "productFamily", label: "Famiglia (leggibile)" },
  { key: "familyKey", label: "Chiave famiglia" },
  { key: "variantKey", label: "Etichetta variante" },
  { key: "productNameChinese", label: "Nome cinese" },
  { key: "productNameEnglish", label: "Nome inglese" },
  { key: "model", label: "Modello / codice" },
  { key: "material", label: "Materiale" },
  { key: "color", label: "Colore" },
  { key: "searchQueryChinese", label: "Query cinese" },
  { key: "searchQueryEnglish", label: "Query inglese" },
  { key: "unit", label: "Unità" },
];

function AnalysisRowEditor({
  row,
  busy,
  onPatch,
}: {
  row: AnalysisRow;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
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
        {row.error ?? "Questa riga non ha un'analisi."} Rilancia l&apos;analisi IA
        dopo aver corretto la mappatura delle colonne.
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
      // I campi facoltativi tornano a `null` quando vengono svuotati; famiglia
      // e chiavi non possono essere vuote e restano stringhe.
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
        Testo inviato all&apos;analisi:
        <pre className="scouting-submitted">{row.submittedText || "—"}</pre>
      </div>

      {analysis.warnings.map((warning) => (
        <div key={`${warning.code}-${warning.message}`} className="scouting-warning">
          {WARNING_LABELS[warning.code]}
          {warning.field ? ` (${warning.field})` : ""}: {warning.message}
        </div>
      ))}

      <div className="scouting-row scouting-options">
        {EDITABLE_FIELDS.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              type="text"
              value={draft[field.key] ?? ""}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, [field.key]: event.target.value })
              }
            />
          </label>
        ))}
        <label>
          Quantità richiesta
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
        Misure: {formatDimensions(analysis.dimensions)} — Specifiche:{" "}
        {formatSpecs(analysis.technicalSpecifications)}
        {analysis.hardRequirements.length > 0
          ? ` — Obbligatori: ${analysis.hardRequirements.join("; ")}`
          : ""}
      </div>
      {row.identity ? (
        <div className="scouting-hint">variante: {row.identity.variantKey}</div>
      ) : null}

      <div className="scouting-row scouting-controls">
        <button type="button" disabled={busy} onClick={() => save()}>
          Salva correzioni
        </button>
        <button type="button" disabled={busy} onClick={() => save(true)}>
          Salva e conferma per la ricerca
        </button>
      </div>
    </div>
  );
}
