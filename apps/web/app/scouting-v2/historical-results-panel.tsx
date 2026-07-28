"use client";

import { useState } from "react";
import type {
  TaobaoJobResults,
  TaobaoPipelineGap,
  TaobaoPipelineReviewIssue,
} from "@china/shared";
import { apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/messages-en";
import { ResultsWorkspace } from "./results-workspace";

interface HistoricalResultsPanelProps {
  results: TaobaoJobResults;
  gaps?: readonly TaobaoPipelineGap[];
  reviewIssues?: readonly TaobaoPipelineReviewIssue[];
  onBack: () => void;
}

export function HistoricalResultsPanel({
  results,
  gaps = [],
  reviewIssues = [],
  onBack,
}: HistoricalResultsPanelProps) {
  const { t } = useI18n();
  const [markup, setMarkup] = useState(0);
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
          markupPct={markup}
        rows={results.rows}
        gaps={gaps}
        reviewIssues={reviewIssues}
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
