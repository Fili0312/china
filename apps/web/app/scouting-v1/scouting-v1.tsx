"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATASET_FIELDS,
  type ClientSummary,
  type DatasetField,
  type DatasetMapping,
  type TaobaoAnalysisRun,
  type TaobaoApiStatus,
  type TaobaoDatasetPreview,
  type TaobaoDatasetSummary,
  type TaobaoJobResults,
  type TaobaoJobSummary,
  type TaobaoRerunScope,
} from "@china/shared";
import { API_URL, api, apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { formatDate, formatShortDateTime } from "../i18n/format";
import type { MessageKey } from "../i18n/messages-en";
import { AnalysisReviewV1 } from "./analysis-review-v1";
import { ClarificationsPanel } from "./clarifications-panel";
import { MemoryHistory } from "./memory-history";
import { TaobaoResults } from "./taobao-results";

/**
 * Scouting v1: un cliente, un file, solo Taobao.
 *
 * Le fasi sono in ordine e restano tutte visibili: chi guarda deve poter
 * risalire dal risultato alla riga che l'ha prodotto senza cambiare pagina.
 *
 * È l'unica pagina della piattaforma. Le altre — ricerca diretta OTAPI,
 * scouting multi-marketplace, preventivi Playwright — sono state rimosse: non
 * erano usate e ognuna teneva in vita un pezzo di API che nessuno chiamava.
 */

/** Chiave del dizionario per ogni campo mappabile del foglio. */
const FIELD_KEYS: Record<DatasetField, MessageKey> = {
  name: "field.name",
  spec: "field.spec",
  title: "field.title",
  category: "field.category",
  brand: "field.brand",
  model: "field.model",
  quantity: "field.quantity",
  unit: "field.unit",
  material: "field.material",
  certifications: "field.certifications",
  targetPrice: "field.targetPrice",
  notes: "field.notes",
  referenceUrl: "field.referenceUrl",
  ignore: "field.ignore",
};

/** Ogni quanto si rilegge un job in corso. */
const POLL_MS = 4000;

/** Stato del motore di analisi: provider, modello e (per DeepSeek) budget. */
interface AnalysisEngineStatus {
  configured: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  minConfidence: number;
  budget: { limitUsd: number; spentUsd: number; remainingUsd: number } | null;
}

/** Riepilogo di una revisione già fatta, come la restituisce l'API. */
interface AnalysisRunSummary {
  runId: string;
  totalRows: number;
  analyzedRows: number;
  failedRows: number;
  apiCalls: number;
  cachedRows: number;
  estimatedCostUsd: number;
  createdAt: string;
  finishedAt: string | null;
}

export function ScoutingV1() {
  const { t, tr, intlLocale } = useI18n();

  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [newClientName, setNewClientName] = useState("");

  const [datasets, setDatasets] = useState<TaobaoDatasetSummary[]>([]);
  const [dataset, setDataset] = useState<TaobaoDatasetPreview | null>(null);
  const [mapping, setMapping] = useState<Map<number, DatasetField>>(new Map());

  const [analysis, setAnalysis] = useState<TaobaoAnalysisRun | null>(null);
  const [apiStatus, setApiStatus] = useState<TaobaoApiStatus | null>(null);
  const [engine, setEngine] = useState<AnalysisEngineStatus | null>(null);

  const [job, setJob] = useState<TaobaoJobSummary | null>(null);
  const [results, setResults] = useState<TaobaoJobResults | null>(null);

  const [forceFullSearch, setForceFullSearch] = useState(false);
  // Provider secondari in standby per la demo: solo Taobao API cerca, così
  // durante il primo test non compaiono errori di fonti non pronte.
  const useBrowser = false;
  const [maxCandidates, setMaxCandidates] = useState(10);
  const [detailTopN, setDetailTopN] = useState(3);
  const [reviewTopN, setReviewTopN] = useState(0);
  // ElimAPI e 1688 sono in standby per la demo: la ricerca usa solo Taobao API.
  const useElim = false;
  const use1688 = false;

  const [jobHistory, setJobHistory] = useState<TaobaoJobSummary[]>([]);
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisRunSummary[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Incrementa dopo ogni analisi: fa ricaricare le domande dell'IA. */
  const [clarificationsToken, setClarificationsToken] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const client = useMemo(
    () => clients.find((entry) => entry.clientId === clientId) ?? null,
    [clientId, clients]
  );

  const mappingList: DatasetMapping[] = useMemo(
    () =>
      [...mapping.entries()]
        .filter(([, field]) => field !== "ignore")
        .map(([columnIndex, field]) => ({ columnIndex, field })),
    [mapping]
  );
  const hasName = mappingList.some((entry) => entry.field === "name");

  /* ------------------------------------------------------------------ */
  /* Caricamenti iniziali                                                */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      try {
        const [clientList, apiState, engineState] = await Promise.all([
          api<ClientSummary[]>("/taobao/clients"),
          api<TaobaoApiStatus>("/taobao/api/status"),
          api<AnalysisEngineStatus>("/taobao/analysis/status"),
        ]);
        setClients(clientList);
        setApiStatus(apiState);
        setEngine(engineState);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  useEffect(() => {
    if (!clientId) return;
    void (async () => {
      try {
        const [files, jobs] = await Promise.all([
          api<TaobaoDatasetSummary[]>(`/taobao/clients/${clientId}/datasets`),
          api<TaobaoJobSummary[]>(`/taobao/clients/${clientId}/jobs`),
        ]);
        setDatasets(files);
        setJobHistory(jobs);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [clientId]);

  /** Le revisioni già fatte sul file aperto: riaprirle non costa niente. */
  useEffect(() => {
    if (!clientId || !dataset) {
      setAnalysisHistory([]);
      return;
    }
    void (async () => {
      try {
        setAnalysisHistory(
          await api<AnalysisRunSummary[]>(
            `/taobao/clients/${clientId}/datasets/${dataset.datasetId}/analysis`
          )
        );
      } catch {
        // Lo storico è un di più: se non arriva, la pagina resta usabile.
      }
    })();
  }, [clientId, dataset]);

  /** Un job in corso si rilegge da solo finché non finisce. */
  useEffect(() => {
    if (!clientId || !job) return;
    if (job.status !== "RUNNING" && job.status !== "QUEUED") return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await api<TaobaoJobResults>(
            `/taobao/clients/${clientId}/jobs/${job.jobId}/results`
          );
          setJob(fresh.job);
          setResults(fresh);
        } catch {
          // Un errore di rete non deve spegnere il polling: al giro dopo
          // riprova, e nel frattempo resta a schermo l'ultimo stato buono.
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [clientId, job]);

  /* ------------------------------------------------------------------ */
  /* Azioni                                                              */
  /* ------------------------------------------------------------------ */

  const createClient = useCallback(async () => {
    const name = newClientName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<ClientSummary>("/taobao/clients", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setClients((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setClientId(created.clientId);
      setNewClientName("");
      resetWork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [newClientName]);

  function resetWork() {
    setDataset(null);
    setAnalysis(null);
    setJob(null);
    setResults(null);
  }

  const upload = useCallback(
    async (file: File) => {
      if (!clientId) return;
      setBusy(true);
      setError(null);
      resetWork();
      try {
        const body = await file.arrayBuffer();
        const response = await fetch(
          `${API_URL}/api/taobao/clients/${clientId}/datasets?fileName=${encodeURIComponent(file.name)}&previewLimit=8`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
          }
        );
        const payload = (await response.json()) as TaobaoDatasetPreview & {
          message?: string;
        };
        if (!response.ok) throw new Error(payload.message || `API ${response.status}`);

        setDataset(payload);
        setMapping(
          new Map(
            payload.columns.map((column) => [column.index, column.suggestedField ?? "ignore"])
          )
        );
        setDatasets(await api<TaobaoDatasetSummary[]>(`/taobao/clients/${clientId}/datasets`));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clientId]
  );

  const openDataset = useCallback(
    async (datasetId: string) => {
      if (!clientId) return;
      setBusy(true);
      setError(null);
      resetWork();
      try {
        const preview = await api<TaobaoDatasetPreview>(
          `/taobao/clients/${clientId}/datasets/${datasetId}?previewLimit=8`
        );
        setDataset(preview);
        setMapping(
          new Map(
            preview.columns.map((column) => [
              column.index,
              (preview.suggestedMapping.find((entry) => entry.columnIndex === column.index)
                ?.field as DatasetField | undefined) ??
                column.suggestedField ??
                "ignore",
            ])
          )
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clientId]
  );

  const runAnalysis = useCallback(async () => {
    if (!clientId || !dataset) return;
    setBusy(true);
    setError(null);
    try {
      setAnalysis(
        await api<TaobaoAnalysisRun>(
          `/taobao/clients/${clientId}/datasets/${dataset.datasetId}/analysis`,
          { method: "POST", body: JSON.stringify({ mapping: mappingList }) }
        )
      );
      // L'analisi può aver aperto domande nuove: si ricaricano subito.
      setClarificationsToken((token) => token + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [clientId, dataset, mappingList]);

  const startJob = useCallback(async () => {
    if (!clientId || !dataset || !analysis) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<TaobaoJobSummary>(
        `/taobao/clients/${clientId}/datasets/${dataset.datasetId}/jobs`,
        {
          method: "POST",
          body: JSON.stringify({
            mapping: mappingList,
            analysisRunId: analysis.runId,
            forceFullSearch,
            useBrowser,
            // 1688 passa da ElimAPI: sceglierlo implica attivare quel canale.
            useElim: useElim || use1688,
            use1688,
            maxCandidates,
            detailTopN,
            reviewTopN,
          }),
        }
      );
      setJob(created);
      setResults(
        await api<TaobaoJobResults>(
          `/taobao/clients/${clientId}/jobs/${created.jobId}/results`
        )
      );
      setJobHistory(await api<TaobaoJobSummary[]>(`/taobao/clients/${clientId}/jobs`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    analysis,
    clientId,
    dataset,
    detailTopN,
    forceFullSearch,
    mappingList,
    maxCandidates,
    reviewTopN,
    use1688,
    useBrowser,
    useElim,
  ]);

  /** Riapre una ricerca già fatta: nessun credito, nessuna nuova chiamata. */
  const openJob = useCallback(
    async (jobId: string) => {
      if (!clientId) return;
      setBusy(true);
      setError(null);
      try {
        const fresh = await api<TaobaoJobResults>(
          `/taobao/clients/${clientId}/jobs/${jobId}/results`
        );
        setJob(fresh.job);
        setResults(fresh);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clientId]
  );

  /** Riapre una revisione già fatta: l'analisi è salvata, non si ripaga. */
  const openAnalysisRun = useCallback(
    async (runId: string) => {
      if (!clientId) return;
      setBusy(true);
      setError(null);
      try {
        setAnalysis(
          await api<TaobaoAnalysisRun>(`/taobao/clients/${clientId}/analysis/${runId}`)
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clientId]
  );

  /** Rilancia la ricerca aperta: nuovo job, stessa configurazione. */
  const rerunJob = useCallback(
    async (scope: TaobaoRerunScope) => {
      if (!clientId || !job) return;
      setBusy(true);
      setError(null);
      try {
        const created = await api<TaobaoJobSummary>(
          `/taobao/clients/${clientId}/jobs/${job.jobId}/rerun`,
          { method: "POST", body: JSON.stringify({ scope, forceFullSearch: true }) }
        );
        setJob(created);
        setResults(
          await api<TaobaoJobResults>(
            `/taobao/clients/${clientId}/jobs/${created.jobId}/results`
          )
        );
        setJobHistory(await api<TaobaoJobSummary[]>(`/taobao/clients/${clientId}/jobs`));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clientId, job]
  );

  const refreshResults = useCallback(async () => {
    if (!clientId || !job) return;
    setBusy(true);
    try {
      const fresh = await api<TaobaoJobResults>(
        `/taobao/clients/${clientId}/jobs/${job.jobId}/results`
      );
      setJob(fresh.job);
      setResults(fresh);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [clientId, job]);

  /* ------------------------------------------------------------------ */
  /* Interfaccia                                                         */
  /* ------------------------------------------------------------------ */

  return (
    <div className="scouting">
      <header className="search-hero">
        <h1>{t("scouting.heading")}</h1>
        <p className="subtitle">
          {t("scouting.subtitle")}
          {apiStatus && !apiStatus.configured ? (
            <>
              {" "}
              <strong>{t("scouting.apiMissing")}</strong>
            </>
          ) : null}
        </p>
      </header>

      {error ? <div className="error-panel">{error}</div> : null}

      {/* 1. Cliente ---------------------------------------------------- */}
      <section className="panel scouting-step">
        <h2>{t("client.step")}</h2>
        <div className="scouting-row scouting-options">
          <label>
            {t("client.select")}
            <select
              value={clientId ?? ""}
              disabled={busy}
              onChange={(event) => {
                setClientId(event.target.value || null);
                resetWork();
              }}
            >
              <option value="">{t("common.choose")}</option>
              {clients.map((entry) => (
                <option key={entry.clientId} value={entry.clientId}>
                  {t("client.option", {
                    name: entry.name,
                    datasets: entry.datasetCount,
                    jobs: entry.jobCount,
                  })}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t("client.new")}
            <input
              type="text"
              value={newClientName}
              disabled={busy}
              placeholder={t("client.newPlaceholder")}
              onChange={(event) => setNewClientName(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || newClientName.trim().length === 0}
            onClick={() => void createClient()}
          >
            {t("client.create")}
          </button>
        </div>
        <p className="scouting-hint">{t("client.hint")}</p>
      </section>

      {/* Storico ------------------------------------------------------- */}
      {client && (jobHistory.length > 0 || analysisHistory.length > 0) ? (
        <section className="panel scouting-step">
          <h2>{t("history.heading", { name: client.name })}</h2>
          <p className="scouting-hint">{tr("history.hint")}</p>

          {jobHistory.length > 0 ? (
            <div className="scouting-table-wrap">
              <table className="scouting-table">
                <thead>
                  <tr>
                    <th>{t("history.col.search")}</th>
                    <th>{t("history.col.file")}</th>
                    <th>{t("history.col.rows")}</th>
                    <th>{t("history.col.usage")}</th>
                    <th>{t("history.col.status")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobHistory.map((entry) => (
                    <tr key={entry.jobId}>
                      <td className="muted">
                        {formatShortDateTime(entry.createdAt, intlLocale)}
                      </td>
                      <td className="scouting-samples">{entry.fileName}</td>
                      <td>
                        {entry.processedRows}/{entry.totalRows}
                        {entry.failedRows > 0 ? (
                          <span className="muted">
                            {" "}
                            - {t("history.errors", { count: entry.failedRows })}
                          </span>
                        ) : null}
                      </td>
                      <td className="scouting-hint">
                        {t("history.usage", {
                          calls: entry.usage.apiCalls,
                          cached: entry.usage.apiCacheHits,
                          products: entry.usage.newProducts,
                        })}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            entry.status === "COMPLETED"
                              ? "ok"
                              : entry.status === "FAILED"
                                ? "err"
                                : "warn"
                          }`}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => void openJob(entry.jobId)}
                        >
                          {t("history.reopen")}
                        </button>
                        <a
                          className="chip"
                          href={apiDownloadUrl(
                            `/taobao/clients/${client.clientId}/jobs/${entry.jobId}/export`
                          )}
                        >
                          {t("history.excel")}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {analysisHistory.length > 0 ? (
            <>
              <h3>{t("history.reviews")}</h3>
              <div className="scouting-engine-chips">
                {analysisHistory.map((entry) => (
                  <button
                    key={entry.runId}
                    type="button"
                    className="chip"
                    disabled={busy}
                    title={t("history.reviewTitle", {
                      calls: entry.apiCalls,
                      cached: entry.cachedRows,
                      cost: entry.estimatedCostUsd.toFixed(4),
                    })}
                    onClick={() => void openAnalysisRun(entry.runId)}
                  >
                    {t("history.reviewChip", {
                      date: formatShortDateTime(entry.createdAt, intlLocale),
                      analyzed: entry.analyzedRows,
                      total: entry.totalRows,
                    })}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* 2. File ------------------------------------------------------- */}
      {client ? (
        <section className="panel scouting-step">
          <h2>{t("file.step")}</h2>

          <div className="scouting-row scouting-controls">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.xlsm,.csv"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            {datasets.length > 0 ? (
              <label>
                {t("file.existing")}
                <select
                  value={dataset?.datasetId ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value) void openDataset(event.target.value);
                  }}
                >
                  <option value="">{t("common.choose")}</option>
                  {datasets.map((entry) => (
                    <option key={entry.datasetId} value={entry.datasetId}>
                      {t("file.option", {
                        name: entry.fileName,
                        rows: entry.totalRows,
                        date: formatDate(entry.createdAt, intlLocale, t("common.none")),
                      })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {dataset ? (
            <>
              <div className="scouting-row">
                <strong>{dataset.fileName}</strong>
                <span className="muted">
                  {t("file.summary", { rows: dataset.totalRows, sheet: dataset.sheet })}
                </span>
              </div>
              {dataset.warnings.map((warning) => (
                <div key={warning} className="scouting-warning">
                  {warning}
                </div>
              ))}

              <h3>{t("file.columns")}</h3>
              <div className="scouting-table-wrap">
                <table className="scouting-table">
                  <thead>
                    <tr>
                      <th>{t("file.col.column")}</th>
                      <th>{t("file.col.header")}</th>
                      <th>{t("file.col.samples")}</th>
                      <th>{t("file.col.field")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataset.columns.map((column) => (
                      <tr key={column.index}>
                        <td className="muted">{column.letter}</td>
                        <td>
                          {column.header || <span className="muted">{t("common.none")}</span>}
                        </td>
                        <td className="scouting-samples">
                          {column.sampleValues.slice(0, 3).join(" · ") || t("common.none")}
                        </td>
                        <td>
                          <select
                            value={mapping.get(column.index) ?? "ignore"}
                            disabled={busy}
                            onChange={(event) => {
                              const next = new Map(mapping);
                              next.set(column.index, event.target.value as DatasetField);
                              setMapping(next);
                            }}
                          >
                            {DATASET_FIELDS.map((field) => (
                              <option key={field} value={field}>
                                {t(FIELD_KEYS[field])}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* 3. Analisi ---------------------------------------------------- */}
      {dataset ? (
        <section className="panel scouting-step">
          <h2>{t("analysis.step")}</h2>
          <p className="scouting-hint">{t("analysis.hint")}</p>
          {engine ? (
            <div className="scouting-row">
              <span
                className="chip"
                title={t("analysis.engineTitle", { version: engine.promptVersion })}
              >
                {t("analysis.engine", { provider: engine.provider, model: engine.model })}
              </span>
              {!engine.configured ? (
                <span className="scouting-warning">{t("analysis.engineMissing")}</span>
              ) : null}
              {engine.budget ? (
                <span
                  className={`chip ${engine.budget.remainingUsd <= 0 ? "err" : ""}`}
                  title={t("analysis.budgetTitle")}
                >
                  {t("analysis.budget", {
                    remaining: engine.budget.remainingUsd.toFixed(2),
                    limit: engine.budget.limitUsd.toFixed(2),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="scouting-row scouting-controls">
            <button type="button" disabled={busy || !hasName} onClick={() => void runAnalysis()}>
              {busy ? t("analysis.running") : t("analysis.run")}
            </button>
            {!hasName ? (
              <span className="scouting-warning">{t("analysis.needName")}</span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Domande dell'IA ------------------------------------------------ */}
      {client ? (
        <ClarificationsPanel reloadToken={clarificationsToken} onError={setError} />
      ) : null}

      {/* 4. Revisione -------------------------------------------------- */}
      {analysis && clientId ? (
        <AnalysisReviewV1
          clientId={clientId}
          run={analysis}
          busy={busy}
          onRunChange={setAnalysis}
          onError={setError}
        />
      ) : null}

      {/* 5. Account Taobao (Playwright) — in standby per la demo -------- */}

      {/* 6. Ricerca ----------------------------------------------------- */}
      {analysis ? (
        <section className="panel scouting-step">
          <h2>{t("search.step")}</h2>

          <div className="scouting-row">
            <span className="chip" title={t("search.sourceTitle")}>
              {t("search.source", {
                source: apiStatus?.primarySearch === "datahub" ? "DataHub" : "Taobao API",
              })}
            </span>
          </div>

          <div className="scouting-row scouting-options">
            <label>
              <input
                type="checkbox"
                checked={forceFullSearch}
                disabled={busy}
                onChange={(event) => setForceFullSearch(event.target.checked)}
              />
              {t("search.forceFull")}
            </label>
            <label>
              {t("search.maxCandidates")}
              <input
                type="number"
                min={1}
                max={40}
                value={maxCandidates}
                disabled={busy}
                onChange={(event) => setMaxCandidates(Number(event.target.value))}
              />
            </label>
            <label>
              {t("search.detailTopN")}
              <input
                type="number"
                min={0}
                max={10}
                value={detailTopN}
                disabled={busy}
                onChange={(event) => setDetailTopN(Number(event.target.value))}
              />
            </label>
            <label>
              {t("search.reviewTopN")}
              <input
                type="number"
                min={0}
                max={10}
                value={reviewTopN}
                disabled={busy}
                onChange={(event) => setReviewTopN(Number(event.target.value))}
              />
            </label>
          </div>

          <p className="scouting-hint">{tr("search.hint")}</p>

          <div className="scouting-row scouting-controls">
            <button
              type="button"
              disabled={busy || analysis.readyRows === 0}
              onClick={() => void startJob()}
            >
              {t("search.start", { count: analysis.readyRows })}
            </button>
          </div>
        </section>
      ) : null}

      {/* 7 e 8. Risultati ed export ------------------------------------- */}
      {results && clientId ? (
        <TaobaoResults
          clientId={clientId}
          results={results}
          busy={busy}
          onRefresh={() => void refreshResults()}
          onRerun={(scope) => void rerunJob(scope)}
          onQuestionsOpened={() => setClarificationsToken((token) => token + 1)}
        />
      ) : null}

      {/* Storico della memoria interna ---------------------------------- */}
      <MemoryHistory />
    </div>
  );
}
