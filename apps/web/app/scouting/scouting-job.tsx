"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATASET_FIELDS,
  SEARCH_ENGINES,
  type DatasetField,
  type DatasetMapping,
  type DatasetPreview,
  type ImportJobProgress,
  type ImportJobResults,
  type SearchEngine,
  type SearchQuality,
} from "@china/shared";
import { API_URL, api } from "../../lib/api";

/**
 * Scouting da file: caricamento, mappatura delle colonne, scelta dei
 * marketplace, avvio e sorveglianza del job.
 *
 * L'avanzamento arriva per interrogazioni periodiche invece che via SSE: la
 * pagina mostra un'istantanea completa (file, righe, marketplace) e ricomporla
 * da eventi incrementali costerebbe complessità senza aggiungere nulla.
 * Il polling si ferma da solo quando il job non è più in corso.
 */

const FIELD_LABELS: Record<DatasetField, string> = {
  name: "Nome prodotto",
  spec: "Specifiche",
  category: "Categoria",
  brand: "Marca",
  model: "Modello / codice",
  quantity: "Quantità",
  unit: "Unità",
  material: "Materiale",
  certifications: "Certificazioni",
  targetPrice: "Prezzo obiettivo",
  notes: "Note",
  referenceUrl: "Link di riferimento",
  ignore: "— ignora —",
};

const ENGINE_LABELS: Record<SearchEngine, string> = {
  taobao: "Taobao",
  tmall: "Tmall",
  alibaba: "Alibaba",
  aliexpress: "AliExpress",
  "made-in-china": "Made-in-China",
  chinagoods: "Chinagoods",
  yiwugo: "Yiwugo",
};

/** Fonti proposte di default: le due che rispondono bene a query cinesi. */
const DEFAULT_ENGINES: SearchEngine[] = ["chinagoods", "yiwugo"];

const RUNNING_STATUSES = new Set(["QUEUED", "RUNNING"]);

function statusTone(status: string): string {
  if (status === "DONE" || status === "COMPLETED") return "ok";
  if (status === "FAILED" || status === "ERROR") return "err";
  if (status === "COMPLETED_WITH_ERRORS" || status === "PAUSED") return "warn";
  return "";
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function ScoutingJob() {
  const [dataset, setDataset] = useState<DatasetPreview | null>(null);
  const [mapping, setMapping] = useState<Map<number, DatasetField>>(new Map());
  const [engines, setEngines] = useState<SearchEngine[]>(DEFAULT_ENGINES);
  const [quality, setQuality] = useState<SearchQuality>("broad");
  const [candidatesPerEngine, setCandidatesPerEngine] = useState(6);
  const [forceFullSearch, setForceFullSearch] = useState(false);
  const [maxRows, setMaxRows] = useState<string>("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportJobProgress | null>(null);
  const [results, setResults] = useState<ImportJobResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const mappingList = useMemo<DatasetMapping[]>(
    () =>
      [...mapping.entries()]
        .filter(([, field]) => field !== "ignore")
        .map(([columnIndex, field]) => ({ columnIndex, field }))
        .sort((left, right) => left.columnIndex - right.columnIndex),
    [mapping]
  );

  const hasName = mappingList.some((entry) => entry.field === "name");

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setProgress(null);
    setResults(null);
    setJobId(null);
    try {
      const body = await file.arrayBuffer();
      const response = await fetch(
        `${API_URL}/api/scouting/datasets?fileName=${encodeURIComponent(file.name)}&previewLimit=8`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body,
        }
      );
      const payload = (await response.json()) as DatasetPreview & {
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message || "Caricamento non riuscito.");
      }
      setDataset(payload);
      setMapping(
        new Map(
          payload.columns.map((column) => [
            column.index,
            column.suggestedField ?? "ignore",
          ])
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startJob() {
    if (!dataset) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await api<{ jobId: string }>(
        `/scouting/datasets/${dataset.datasetId}/jobs`,
        {
          method: "POST",
          body: JSON.stringify({
            mapping: mappingList,
            engines,
            quality,
            candidatesPerEngine,
            forceFullSearch,
            ...(maxRows ? { maxRows: Number(maxRows) } : {}),
          }),
        }
      );
      setJobId(summary.jobId);
      setResults(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function command(action: string, body?: unknown) {
    if (!jobId) return;
    setError(null);
    try {
      await api(`/scouting/jobs/${jobId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      setProgress(await api<ImportJobProgress>(`/scouting/jobs/${jobId}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [jobId]);

  // Sorveglianza: si interroga l'API finché il job è in corso, poi ci si ferma.
  useEffect(() => {
    if (!jobId) return;
    void refresh();
    const timer = setInterval(() => {
      setProgress((current) => {
        if (current && !RUNNING_STATUSES.has(current.job.status)) return current;
        void refresh();
        return current;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [jobId, refresh]);

  async function loadResults() {
    if (!jobId) return;
    setBusy(true);
    try {
      setResults(
        await api<ImportJobResults>(`/scouting/jobs/${jobId}/results?limit=50`)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const job = progress?.job;
  const percent = job?.totalRows
    ? Math.round((job.processedRows / job.totalRows) * 100)
    : 0;

  return (
    <div className="scouting">
      <header className="search-hero">
        <h1>Scouting prodotti da file</h1>
        <p className="muted">
          Carica un Excel, XLS o CSV, controlla le colonne riconosciute, scegli
          i marketplace e segui l&apos;analisi riga per riga.
        </p>
      </header>

      {error ? <div className="error-panel">{error}</div> : null}

      <section className="panel scouting-step">
        <h2>1. File</h2>
        <div className="scouting-row">
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
          {dataset ? (
            <span className="muted">
              {dataset.fileName} · foglio {dataset.sheet} · {dataset.totalRows}{" "}
              righe
              {dataset.headerRowNumber
                ? ` · intestazione alla riga ${dataset.headerRowNumber}`
                : " · nessuna intestazione riconosciuta"}
            </span>
          ) : null}
        </div>
        {dataset?.warnings.map((warning) => (
          <p key={warning} className="scouting-warning">
            {warning}
          </p>
        ))}
      </section>

      {dataset ? (
        <section className="panel scouting-step">
          <h2>2. Colonne</h2>
          <div className="scouting-table-wrap">
            <table className="scouting-table">
              <thead>
                <tr>
                  <th>Col.</th>
                  <th>Intestazione</th>
                  <th>Campo</th>
                  <th>Valori di esempio</th>
                </tr>
              </thead>
              <tbody>
                {dataset.columns.map((column) => (
                  <tr key={column.index}>
                    <td className="muted">{column.letter}</td>
                    <td>
                      {column.header || <span className="muted">senza titolo</span>}
                      {column.suggestionReason ? (
                        <div className="scouting-hint">
                          {column.suggestionReason}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <select
                        value={mapping.get(column.index) ?? "ignore"}
                        onChange={(event) => {
                          const next = new Map(mapping);
                          next.set(
                            column.index,
                            event.target.value as DatasetField
                          );
                          setMapping(next);
                        }}
                      >
                        {DATASET_FIELDS.map((field) => (
                          <option key={field} value={field}>
                            {FIELD_LABELS[field]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted scouting-samples">
                      {column.sampleValues.join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!hasName ? (
            <p className="scouting-warning">
              Serve almeno una colonna associata a «Nome prodotto».
            </p>
          ) : null}
        </section>
      ) : null}

      {dataset ? (
        <section className="panel scouting-step">
          <h2>3. Marketplace</h2>
          <div className="scouting-engines">
            {SEARCH_ENGINES.map((engine) => (
              <label key={engine} className="scouting-engine">
                <input
                  type="checkbox"
                  checked={engines.includes(engine)}
                  onChange={(event) => {
                    setEngines((current) =>
                      event.target.checked
                        ? [...current, engine]
                        : current.filter((name) => name !== engine)
                    );
                  }}
                />
                {ENGINE_LABELS[engine]}
              </label>
            ))}
          </div>
          <div className="scouting-row scouting-options">
            <label>
              Precisione
              <select
                value={quality}
                onChange={(event) =>
                  setQuality(event.target.value as SearchQuality)
                }
              >
                <option value="strict">Alta</option>
                <option value="balanced">Media</option>
                <option value="broad">Esplorativa</option>
              </select>
            </label>
            <label>
              Prodotti per fonte
              <input
                type="number"
                min={1}
                max={50}
                value={candidatesPerEngine}
                onChange={(event) =>
                  setCandidatesPerEngine(Number(event.target.value) || 1)
                }
              />
            </label>
            <label>
              Solo le prime N righe
              <input
                type="number"
                min={1}
                placeholder="tutte"
                value={maxRows}
                onChange={(event) => setMaxRows(event.target.value)}
              />
            </label>
            <label className="scouting-check">
              <input
                type="checkbox"
                checked={forceFullSearch}
                onChange={(event) => setForceFullSearch(event.target.checked)}
              />
              Ignora i prodotti già trovati e ricerca tutto
            </label>
          </div>
          <button
            type="button"
            disabled={busy || engines.length === 0 || !hasName}
            onClick={() => void startJob()}
          >
            Avvia scouting
          </button>
        </section>
      ) : null}

      {job ? (
        <section className="panel scouting-step">
          <h2>4. Avanzamento</h2>
          <div className="scouting-row scouting-job-head">
            <span className={`badge ${statusTone(job.status)}`}>
              {job.status}
            </span>
            <strong>
              {job.processedRows} / {job.totalRows} righe
            </strong>
            <span className="muted">
              {job.reusedRows} riusate · {job.failedRows} fallite
              {job.creditsSpent > 0
                ? ` · ${job.creditsSpent} crediti Piloterr`
                : ""}
            </span>
          </div>
          <div className="scouting-bar">
            <div className="scouting-bar-fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="scouting-row scouting-controls">
            <button type="button" onClick={() => void command("pause")}>
              Pausa
            </button>
            <button type="button" onClick={() => void command("resume")}>
              Riprendi
            </button>
            <button type="button" onClick={() => void command("cancel")}>
              Annulla
            </button>
            <button
              type="button"
              onClick={() => void command("retry", { scope: "failed" })}
            >
              Ritenta i falliti
            </button>
            <button type="button" onClick={() => void loadResults()}>
              Mostra i prodotti trovati
            </button>
            <a
              className="scouting-download"
              href={`${API_URL}/api/scouting/jobs/${jobId}/export`}
            >
              Esporta in Excel
            </a>
          </div>

          <div className="scouting-engine-summary">
            {progress?.engineSummary.map((summary) => (
              <div key={summary.engine} className="scouting-engine-card">
                <strong>
                  {ENGINE_LABELS[summary.engine as SearchEngine] ??
                    summary.engine}
                </strong>
                <span className="muted">
                  {summary.done} ok · {summary.error} errori ·{" "}
                  {summary.pending} in attesa · {summary.acceptedCount} prodotti
                </span>
                {summary.lastError ? (
                  <span className="scouting-engine-error">
                    {summary.lastError}
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          <div className="scouting-table-wrap">
            <table className="scouting-table">
              <thead>
                <tr>
                  <th>Riga</th>
                  <th>Richiesta</th>
                  <th>Stato</th>
                  <th>Marketplace</th>
                  <th>Prodotti</th>
                </tr>
              </thead>
              <tbody>
                {progress?.rows.map((row) => (
                  <tr key={row.jobRowId}>
                    <td className="muted">{row.rowNumber}</td>
                    <td>
                      {row.displayName}
                      <div className="scouting-hint">{row.searchQuery}</div>
                      {row.error ? (
                        <div className="scouting-engine-error">{row.error}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge ${statusTone(row.status)}`}>
                        {row.status}
                      </span>
                      {row.reused ? (
                        <span className="chip" title="Richiesta già elaborata">
                          riusata
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <div className="scouting-engine-chips">
                        {row.engines.map((entry) => (
                          <span
                            key={entry.engine}
                            className={`chip ${statusTone(entry.status)}`}
                            title={
                              entry.error ??
                              `${entry.acceptedCount} prodotti · ${formatDuration(entry.durationMs)}${
                                entry.servedFromCache ? " · da cache" : ""
                              }`
                            }
                          >
                            {ENGINE_LABELS[entry.engine as SearchEngine] ??
                              entry.engine}
                            {entry.status === "DONE"
                              ? ` ${entry.acceptedCount}`
                              : ""}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{row.candidateCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {results ? (
        <section className="panel scouting-step">
          <h2>5. Prodotti trovati</h2>
          {results.rows.map((row) => (
            <div key={row.jobRowId} className="scouting-result-row">
              <h3>
                Riga {row.rowNumber} · {row.displayName}
                {row.reused ? <span className="chip">riusata</span> : null}
              </h3>
              {row.requirements.length ? (
                <div className="scouting-engine-chips">
                  {row.requirements.map((requirement) => (
                    <span
                      key={requirement.key}
                      className={`chip ${requirement.kind === "hard" ? "warn" : ""}`}
                    >
                      {requirement.label}
                    </span>
                  ))}
                </div>
              ) : null}
              {row.candidates.length === 0 ? (
                <p className="muted">Nessun prodotto trovato per questa riga.</p>
              ) : (
                <>
                <h4 className="scouting-subhead">
                  Finalisti ({row.finalists.length})
                </h4>
                <div className="scouting-candidates">
                  {row.finalists.map((selection) => (
                    <article
                      key={selection.product.candidateId}
                      className="product-card"
                    >
                      {selection.product.imageUrl ? (
                        <img
                          src={selection.product.imageUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                          loading="lazy"
                        />
                      ) : null}
                      <div className="card-body">
                        <a
                          className="card-title"
                          href={selection.product.url ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {selection.product.title}
                        </a>
                        <div className="card-meta">
                          <span className="badge ok">
                            #{selection.rank} · {selection.score}
                          </span>
                          <span className="chip">{selection.product.engine}</span>
                          {selection.product.price != null ? (
                            <strong>
                              {selection.product.price} {selection.product.currency}
                            </strong>
                          ) : null}
                          {selection.product.moq ? (
                            <span className="muted">
                              MOQ {selection.product.moq}
                            </span>
                          ) : null}
                          {selection.scoreReused ? (
                            <span className="chip" title="Dati invariati: punteggio non ricalcolato">
                              punteggio invariato
                            </span>
                          ) : null}
                        </div>
                        <div className="scouting-hint">
                          {Object.entries(selection.scoreBreakdown)
                            .map(([name, value]) => `${name} ${value.toFixed(1)}`)
                            .join(" · ")}
                        </div>
                        {selection.product.vendorName ? (
                          <div className="muted">
                            {selection.product.vendorName}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                {row.rejected.length ? (
                  <details className="scouting-rejected">
                    <summary>
                      Scartati ({row.rejected.length}) e perché
                    </summary>
                    <ul>
                      {row.rejected.map((selection) => (
                        <li key={selection.product.candidateId}>
                          <span className="chip err">
                            {selection.rejectionCode}
                          </span>{" "}
                          <strong>{selection.product.title.slice(0, 60)}</strong>
                          <div className="scouting-hint">
                            {selection.rejectionReason}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <details className="scouting-rejected">
                  <summary>Tutti i prodotti trovati ({row.candidates.length})</summary>
                <div className="scouting-candidates">
                  {row.candidates.map((candidate) => (
                    <article key={candidate.candidateId} className="product-card">
                      {candidate.imageUrl ? (
                        // I CDN cinesi rifiutano il hotlink con referer esterno.
                        <img
                          src={candidate.imageUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                          loading="lazy"
                        />
                      ) : null}
                      <div className="card-body">
                        <a
                          className="card-title"
                          href={candidate.url ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {candidate.title}
                        </a>
                        <div className="card-meta">
                          <span className="chip">{candidate.engine}</span>
                          {candidate.price != null ? (
                            <strong>
                              {candidate.price} {candidate.currency}
                            </strong>
                          ) : (
                            <span className="muted">prezzo non esposto</span>
                          )}
                          {candidate.moq ? (
                            <span className="muted">MOQ {candidate.moq}</span>
                          ) : null}
                          {candidate.relevanceScore != null ? (
                            <span className="muted">
                              pertinenza {Math.round(candidate.relevanceScore)}
                            </span>
                          ) : null}
                        </div>
                        {candidate.vendorName ? (
                          <div className="muted">{candidate.vendorName}</div>
                        ) : null}
                        {candidate.changedFields.length ? (
                          <div className="scouting-changed">
                            aggiornato: {candidate.changedFields.join(", ")}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                </details>
                </>
              )}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
