"use client";

import { apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/messages-en";
import {
  historyHasResults,
  historyJobId,
  type ScoutingV2HistoryEntry,
} from "./history";

interface HistoryPanelProps {
  entries: readonly ScoutingV2HistoryEntry[];
  loading: boolean;
  busy: boolean;
  onReopen: (entry: ScoutingV2HistoryEntry) => void;
  onOpenResults: (entry: ScoutingV2HistoryEntry) => void;
}

export function HistoryPanel({
  entries,
  loading,
  busy,
  onReopen,
  onOpenResults,
}: HistoryPanelProps) {
  const { t, intlLocale } = useI18n();

  return (
    <section className="panel scouting-step">
      <h2>{t("v2.history.title")}</h2>
      {loading && entries.length === 0 ? (
        <p className="scouting-hint">{t("common.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="scouting-hint">{t("v2.history.empty")}</p>
      ) : (
        <>
          {loading ? <p className="scouting-hint">{t("v2.history.refreshing")}</p> : null}
          <div className="scouting-table-wrap">
            <table className="scouting-table">
              <thead>
                <tr>
                  <th>{t("v2.history.file")}</th>
                  <th>{t("v2.history.uploaded")}</th>
                  <th>{t("v2.history.processed")}</th>
                  <th>{t("v2.history.work")}</th>
                  <th>{t("v2.history.rows")}</th>
                  <th>{t("v2.history.status")}</th>
                  <th>{t("v2.history.coverage")}</th>
                  <th>{t("v2.history.usage")}</th>
                  <th>{t("v2.history.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <HistoryRow
                    key={entry.key}
                    entry={entry}
                    busy={busy}
                    intlLocale={intlLocale}
                    onReopen={onReopen}
                    onOpenResults={onOpenResults}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function HistoryRow({
  entry,
  busy,
  intlLocale,
  onReopen,
  onOpenResults,
}: {
  entry: ScoutingV2HistoryEntry;
  busy: boolean;
  intlLocale: string;
  onReopen: (entry: ScoutingV2HistoryEntry) => void;
  onOpenResults: (entry: ScoutingV2HistoryEntry) => void;
}) {
  const { t } = useI18n();
  const outcome = entry.pipeline?.outcome ?? null;
  const job = entry.job;
  const jobId = historyJobId(entry);
  const resultReady = historyHasResults(entry);

  const coverage = outcome
    ? t("v2.history.coveragePipeline", {
        covered: outcome.confirmedRows,
        total: outcome.totalRows,
        review: outcome.uncertainRows + outcome.uncoveredRows,
      })
    : job
      ? t("v2.history.coverageJob", {
          processed: job.processedRows,
          total: job.totalRows,
          failed: job.failedRows,
        })
      : "—";

  const calls = job
    ? job.usage.hwhCalls +
      job.usage.apiCalls +
      job.usage.elimCalls +
      job.usage.browserCalls
    : (outcome?.searchCalls ?? null);
  const cacheHits = job?.usage.apiCacheHits ?? outcome?.cacheHits ?? null;

  return (
    <tr>
      <td className="scouting-samples">{entry.fileName}</td>
      <td className="muted">{formatDateTime(entry.uploadedAt, intlLocale)}</td>
      <td className="muted">
        {formatDateTime(entry.processedAt, intlLocale)}
        {entry.finishedAt ? (
          <div>{t("v2.history.finished", { date: formatDateTime(entry.finishedAt, intlLocale) })}</div>
        ) : null}
      </td>
      <td>
        <span className="chip">{t(`v2.history.kind.${entry.kind}` as MessageKey)}</span>
        <div className="muted">
          {t("v2.history.available", {
            analyses: entry.analysisRunCount,
            jobs: entry.jobCount,
          })}
        </div>
      </td>
      <td>{entry.totalRows}</td>
      <td>
        <span className={`badge ${statusTone(entry.status)}`}>
          {t(`v2.history.status.${entry.status}` as MessageKey)}
        </span>
      </td>
      <td>{coverage}</td>
      <td>
        {calls == null || cacheHits == null ? (
          "—"
        ) : (
          <>
            <div>{t("v2.history.usageLine", { calls, cached: cacheHits })}</div>
            {outcome ? <div className="muted">${outcome.totalCostUsd.toFixed(4)}</div> : null}
          </>
        )}
      </td>
      <td>
        {entry.pipeline ? (
          <>
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => onReopen(entry)}
            >
              {t("v2.run.reopen")}
            </button>{" "}
          </>
        ) : null}
        {resultReady && jobId ? (
          <>
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => onOpenResults(entry)}
            >
              {t("v2.history.openResults")}
            </button>{" "}
            <a
              className="chip"
              href={apiDownloadUrl(`/taobao/clients/${entry.clientId}/jobs/${jobId}/export`)}
            >
              {t("v2.done.export")}
            </a>{" "}
            <a
              className="chip"
              href={apiDownloadUrl(`/taobao/clients/${entry.clientId}/jobs/${jobId}/report`, {
                markupPct: entry.pipeline?.markupPct ?? 15,
              })}
            >
              {t("v2.done.report")}
            </a>
          </>
        ) : null}
        {!entry.pipeline && !resultReady ? "—" : null}
      </td>
    </tr>
  );
}

function formatDateTime(value: string | null, intlLocale: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(intlLocale) : "—";
}

function statusTone(status: ScoutingV2HistoryEntry["status"]): string {
  if (status === "COMPLETED") return "ok";
  if (status === "FAILED") return "err";
  if (status === "CANCELLED" || status === "COMPLETED_WITH_ERRORS") return "warn";
  return "";
}
