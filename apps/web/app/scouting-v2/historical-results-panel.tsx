"use client";

import { useState } from "react";
import type {
  TaobaoJobResults,
  TaobaoPipelineGap,
  TaobaoPipelineReviewIssue,
  V2RetryMode,
} from "@china/shared";
import { apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/messages-en";
import { ResultsWorkspace } from "./results-workspace";
import { estimateRetryRows, retryRowsRequest } from "./retry-actions";

interface HistoricalResultsPanelProps {
  results: TaobaoJobResults;
  gaps?: readonly TaobaoPipelineGap[];
  reviewIssues?: readonly TaobaoPipelineReviewIssue[];
  /**
   * La corsa da cui vengono questi risultati, se si sa quale.
   *
   * Serve alla riprova mirata: riprovare una riga scoperta ha senso anche —
   * e soprattutto — qualche giorno dopo, quando qualcuno riapre il file e
   * guarda cosa è rimasto indietro. Senza pipeline il pannello resta di sola
   * lettura, come i risultati dei job più vecchi.
   */
  pipelineId?: string | null;
  onBack: () => void;
}

export function HistoricalResultsPanel({
  results,
  gaps = [],
  reviewIssues = [],
  pipelineId = null,
  onBack,
}: HistoricalResultsPanelProps) {
  const { t } = useI18n();
  const [markup, setMarkup] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const clientId = results.job.clientId;
  const jobPath = `/taobao/clients/${results.job.clientId}/jobs/${results.job.jobId}`;
  const rowsWithCandidates = results.rows.filter(
    (row) => row.candidates.length > 0
  ).length;
  const coherentRows = results.rows.filter((row) =>
    row.candidates.some((candidate) => candidate.coherence?.verdict === "coherent")
  ).length;
  const usage = results.job.usage;
  const totalCalls =
    usage.hwhCalls + usage.apiCalls + usage.elimCalls + usage.browserCalls;

  return (
    <section className="panel scouting-step">
      <div className="scouting-row scouting-controls">
        <button type="button" className="chip" onClick={onBack}>
          {t("v2.history.back")}
        </button>
      </div>

      <header className="v2-done-head">
        <h2>{t("v2.results.title", { file: results.job.fileName })}</h2>
        <p className="v2-done-lead">
          {t("v2.results.subtitle", {
            processed: results.job.processedRows,
            total: results.job.totalRows,
          })}
        </p>
      </header>

      <div className="v2-tiles">
        <Tile
          value={results.job.processedRows}
          label={t("v2.results.processed")}
          tone=""
        />
        <Tile
          value={rowsWithCandidates}
          label={t("v2.results.withCandidates")}
          tone="ok"
        />
        <Tile
          value={coherentRows}
          label={t("v2.results.coherent")}
          tone="ok"
        />
        <Tile
          value={results.job.failedRows}
          label={t("v2.results.failed")}
          tone={results.job.failedRows > 0 ? "err" : ""}
        />
      </div>

      <p className="muted">
        {t(
          `v2.history.status.${results.job.status}` as MessageKey
        )}{" "}
        · {t("v2.results.usage", { calls: totalCalls, cached: usage.apiCacheHits })}
      </p>
      {results.job.error ? (
        <div className="scouting-engine-error">{results.job.error}</div>
      ) : null}

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
      </div>

      <h3>{t("v2.results.rows")}</h3>
      <ResultsWorkspace
        key={reloadKey}
        markupPct={markup}
        rows={results.rows}
        gaps={gaps}
        reviewIssues={reviewIssues}
        onRetryRows={
          pipelineId
            ? async (rowNumbers: readonly number[], mode: V2RetryMode) => {
                const result = await retryRowsRequest(
                  clientId,
                  pipelineId,
                  rowNumbers,
                  mode
                );
                // I risultati di questa vista sono una fotografia: dopo una
                // riprova va ripresa, e chi guarda deve vedere che è cambiata.
                setReloadKey((current) => current + 1);
                return result;
              }
            : undefined
        }
        onEstimateRetry={
          pipelineId
            ? (rowNumbers: readonly number[], mode: V2RetryMode) =>
                estimateRetryRows(clientId, pipelineId, rowNumbers, mode)
            : undefined
        }
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
