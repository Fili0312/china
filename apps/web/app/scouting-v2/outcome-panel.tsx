"use client";

import { useEffect, useState } from "react";
import type {
  TaobaoJobResults,
  TaobaoPipelineState,
  V2RetryEstimate,
  V2RetryMode,
  V2RetryResult,
} from "@china/shared";
import { api, apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { ResultsWorkspace } from "./results-workspace";

/**
 * Il risultato: cosa è pronto e cosa aspetta una persona.
 *
 * L'ordine è deliberato. Prima il numero che serve — quante righe hanno un
 * prodotto di cui fidarsi — poi il pulsante per scaricare, e solo dopo
 * l'elenco delle righe rimaste indietro. Mettere prima i problemi farebbe
 * sembrare fallita un'elaborazione riuscita al 90%; nasconderli renderebbe la
 * quotazione pericolosa da inoltrare.
 *
 * Le righe scoperte sono elencate con il motivo e con la query usata, che è
 * l'informazione da cui si riparte a mano: quasi sempre il problema è lì.
 */

interface OutcomePanelProps {
  state: TaobaoPipelineState;
  onRestart: () => void;
  /** Rilegge lo stato dopo una riprova: i conteggi in alto devono seguirla. */
  onRefreshOutcome: () => void;
}

export function OutcomePanel({
  state,
  onRestart,
  onRefreshOutcome,
}: OutcomePanelProps) {
  const { t } = useI18n();
  const [markup, setMarkup] = useState(state.markupPct);
  const [results, setResults] = useState<TaobaoJobResults | null>(null);
  const [resultsLoading, setResultsLoading] = useState(Boolean(state.jobId));
  const [resultsError, setResultsError] = useState<string | null>(null);
  const outcome = state.outcome;
  const jobPath = `/taobao/clients/${state.clientId}/jobs/${state.jobId}`;
  const pipelinePath = `/taobao/clients/${state.clientId}/pipelines/${state.pipelineId}`;

  /**
   * Riprova le righe scelte al gradino scelto.
   *
   * I due gradini non sono equivalenti e non costano lo stesso: `rejudge`
   * rilegge i candidati già in archivio con i criteri di oggi senza spendere
   * una chiamata di ricerca, `research` torna a cercare. Chi guarda sceglie —
   * dopo aver visto la stima.
   */
  async function retryRows(rowNumbers: readonly number[], mode: V2RetryMode) {
    const result = await api<V2RetryResult>(`${pipelinePath}/retry`, {
      method: "POST",
      body: JSON.stringify({ rowNumbers, mode }),
    });
    // La riprova cambia verdetti e prodotti: si rilegge tutto invece di
    // indovinare che cosa è cambiato.
    const refreshed = await api<TaobaoJobResults>(`${jobPath}/results?limit=1000`);
    setResults(refreshed);
    onRefreshOutcome();
    return result;
  }

  function estimateRetry(rowNumbers: readonly number[], mode: V2RetryMode) {
    return api<V2RetryEstimate>(`${pipelinePath}/retry-estimate`, {
      method: "POST",
      body: JSON.stringify({ rowNumbers, mode }),
    });
  }

  useEffect(() => {
    if (!state.jobId) {
      setResults(null);
      setResultsLoading(false);
      return;
    }
    const controller = new AbortController();
    setResults(null);
    setResultsError(null);
    setResultsLoading(true);
    void api<TaobaoJobResults>(
      `/taobao/clients/${state.clientId}/jobs/${state.jobId}/results?limit=1000`,
      { signal: controller.signal }
    )
      .then((fresh) => {
        if (
          fresh.job.clientId !== state.clientId ||
          fresh.job.jobId !== state.jobId
        ) {
          throw new Error(t("v2.results.wrongClient"));
        }
        setResults(fresh);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setResultsError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setResultsLoading(false);
      });
    return () => controller.abort();
  }, [state.clientId, state.jobId, t]);

  if (!outcome) return null;

  return (
    <section className="v2-done">
      <header className="v2-done-head">
        <h2>{t("v2.done.title")}</h2>
        <p className="v2-done-lead">
          {t("v2.done.subtitle", {
            confirmed: outcome.confirmedRows,
            total: outcome.totalRows,
          })}
        </p>
      </header>

      <div className="v2-tiles">
        <Tile value={outcome.confirmedRows} label={t("v2.done.confirmed")} tone="ok" />
        <Tile value={outcome.uncertainRows} label={t("v2.done.uncertain")} tone="warn" />
        <Tile value={outcome.uncoveredRows} label={t("v2.done.uncovered")} tone="err" />
        {/* Compare solo quando c'è: un riquadro a zero fisso su ogni corsa
            insegnerebbe a non leggerlo. */}
        {outcome.notProcurableRows > 0 ? (
          <Tile
            value={outcome.notProcurableRows}
            label={t("v2.done.notProcurable")}
            tone=""
          />
        ) : null}
        <Tile value={outcome.reusedRows} label={t("v2.done.reused")} tone="" />
      </div>

      <p className="muted">
        {t("v2.done.spent", {
          cost: outcome.totalCostUsd.toFixed(4),
          calls: outcome.searchCalls,
          cached: outcome.cacheHits,
        })}
        {outcome.recoveredRows > 0
          ? ` · ${t("v2.done.recovered", {
              count: outcome.recoveredRows,
              rounds: outcome.refineRounds,
            })}`
          : ""}
      </p>

      {state.jobId ? (
        <div className="v2-done-actions">
          <label>
            {t("v2.done.markup")}
            <input
              type="number"
              min={0}
              max={500}
              value={markup}
              onChange={(event) => setMarkup(Number(event.target.value))}
            />
            %
          </label>
          <a
            className="link-btn primary"
            href={apiDownloadUrl(`${jobPath}/v2-report`, { markupPct: markup })}
          >
            {t("v2.done.report")}
          </a>
          <a className="link-btn" href={apiDownloadUrl(`${jobPath}/v2-export`)}>
            {t("v2.done.export")}
          </a>
          <button type="button" className="chip" onClick={onRestart}>
            {t("v2.done.again")}
          </button>
        </div>
      ) : null}

      <h3>{t("v2.results.rows")}</h3>
      <ResultsWorkspace
        rows={results?.rows ?? []}
        gaps={outcome.gaps}
        reviewIssues={outcome.reviewIssues ?? []}
        loading={resultsLoading}
        loadError={resultsError}
        onRetryRows={state.jobId ? retryRows : undefined}
        onEstimateRetry={state.jobId ? estimateRetry : undefined}
        markupPct={markup}
      />
    </section>
  );
}

function Tile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className={`v2-tile ${tone}`}>
      <span className="v2-tile-value">{value}</span>
      <span className="v2-tile-label">{label}</span>
    </div>
  );
}
