"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  ClientSummary,
  TaobaoDatasetPreview,
  TaobaoDatasetSummary,
  TaobaoJobResults,
  TaobaoJobSummary,
  TaobaoPipelineEstimate,
  TaobaoPipelineGap,
  TaobaoPipelineReviewIssue,
  TaobaoPipelineMode,
  TaobaoPipelineState,
} from "@china/shared";
import { API_URL, api } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { HistoryPanel } from "./history-panel";
import { HistoricalResultsPanel } from "./historical-results-panel";
import {
  buildScoutingV2History,
  historyHasResults,
  historyJobId,
  mergePipelineIntoHistory,
  type ScoutingV2HistoryEntry,
} from "./history";
import { OutcomePanel } from "./outcome-panel";
import { ProgressPanel } from "./progress-panel";
import { QuestionsPanel } from "./questions-panel";

/**
 * Scouting v2: il foglio entra, la quotazione esce.
 *
 * La v1 resta e non va toccata: è la vista di chi deve capire *perché* il
 * sistema ha deciso una certa cosa, e ha bisogno di ogni pulsante separato.
 * Questa è la vista di chi deve consegnare una quotazione, e ha bisogno che
 * quelle sette decisioni le prenda il sistema.
 *
 * Tutto lo stato dell'elaborazione vive nel server: qui c'è solo il polling e
 * il disegno. È la ragione per cui chiudere la scheda non fa danni e riaprirla
 * mostra il punto esatto in cui il lavoro è arrivato — la pagina non possiede
 * nulla che non possa richiedere di nuovo.
 */

/** Ogni quanto si richiede lo stato mentre l'elaborazione gira. */
const POLL_MS = 2000;

type Stage = "upload" | "estimate" | "running" | "results";
type OpenedResultsContext = {
  gaps: readonly TaobaoPipelineGap[];
  reviewIssues: readonly TaobaoPipelineReviewIssue[];
  /** La corsa da cui vengono: senza, la riprova non saprebbe cosa rifare. */
  pipelineId: string | null;
  /** L'esito calcolato dal backend: è l'unica fonte dei contatori. */
  outcome: TaobaoPipelineState["outcome"] | null;
};

/**
 * La stessa pagina serve due modalità.
 *
 * `v3` cambia il motore, non l'interfaccia: i prodotti che nel foglio hanno un
 * link vengono risolti aprendo il link — variante compresa — invece di essere
 * cercati, e per gli altri la ricerca guarda più candidati. Duplicare mille
 * righe di pagina per cambiare una stringa avrebbe creato due interfacce
 * destinate a divergere alla prima correzione.
 */
export function ScoutingV2({ mode = "v2" }: { mode?: TaobaoPipelineMode } = {}) {
  const { t, locale } = useI18n();

  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [newClientName, setNewClientName] = useState("");

  const [stage, setStage] = useState<Stage>("upload");
  const [estimate, setEstimate] = useState<TaobaoPipelineEstimate | null>(null);
  const [state, setState] = useState<TaobaoPipelineState | null>(null);
  const [history, setHistory] = useState<ScoutingV2HistoryEntry[]>([]);
  const [historyClientId, setHistoryClientId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openedResults, setOpenedResults] = useState<TaobaoJobResults | null>(null);
  const [openedResultsContext, setOpenedResultsContext] =
    useState<OpenedResultsContext | null>(null);

  const [markupPct, setMarkupPct] = useState(15);
  const [maxRefineRounds, setMaxRefineRounds] = useState(2);

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeClientRef = useRef<string | null>(null);
  const activePipelineRef = useRef<string | null>(null);
  const historyRequestRef = useRef(0);
  const resultsRequestRef = useRef(0);

  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  /* ------------------------------------------------------------------ */
  /* Clienti                                                             */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void api<ClientSummary[]>("/taobao/clients").then(setClients).catch(fail);
  }, [fail]);

  /**
   * Cambia cliente in una singola transazione di UI.
   *
   * Cancellare subito la proiezione precedente è un controllo di isolamento,
   * non solo uno stato di caricamento: una risposta lenta del cliente A non deve
   * restare cliccabile mentre la select mostra già il cliente B.
   */
  const selectClient = useCallback((nextClientId: string | null) => {
    activeClientRef.current = nextClientId;
    activePipelineRef.current = null;
    historyRequestRef.current += 1;
    resultsRequestRef.current += 1;
    setClientId(nextClientId);
    setHistoryClientId(nextClientId);
    setHistory([]);
    setHistoryLoading(Boolean(nextClientId));
    setState(null);
    setEstimate(null);
    setOpenedResults(null);
    setOpenedResultsContext(null);
    setStage("upload");
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  const loadClientHistory = useCallback(
    async (selectedClientId: string, reattachLive: boolean) => {
      const requestId = ++historyRequestRef.current;
      if (activeClientRef.current === selectedClientId) setHistoryLoading(true);
      try {
        const [datasets, jobs, pipelines] = await Promise.all([
          api<TaobaoDatasetSummary[]>(`/taobao/clients/${selectedClientId}/datasets`),
          api<TaobaoJobSummary[]>(`/taobao/clients/${selectedClientId}/jobs`),
          api<TaobaoPipelineState[]>(
            `/taobao/clients/${selectedClientId}/pipelines?limit=50`
          ),
        ]);
        if (
          requestId !== historyRequestRef.current ||
          activeClientRef.current !== selectedClientId
        ) {
          return;
        }

        // Difesa in profondità: anche se gli endpoint filtrano già per
        // ownership, la pagina non rende mai una riga che dichiara un cliente
        // diverso da quello attualmente selezionato.
        const ownedDatasets = datasets.filter(
          (entry) => entry.clientId === selectedClientId
        );
        const ownedJobs = jobs.filter((entry) => entry.clientId === selectedClientId);
        const ownedPipelines = pipelines.filter(
          (entry) => entry.clientId === selectedClientId
        );
        const merged = buildScoutingV2History(
          selectedClientId,
          ownedDatasets,
          ownedJobs,
          ownedPipelines
        );
        setHistoryClientId(selectedClientId);
        setHistory(merged);

        if (reattachLive) {
          const live = ownedPipelines.find(
            (entry) => entry.status === "RUNNING" || entry.status === "WAITING_ANSWERS"
          );
          if (live && live.clientId === selectedClientId) {
            activePipelineRef.current = live.pipelineId;
            setState(live);
            setStage("running");
          }
        }
      } catch (cause) {
        if (
          requestId === historyRequestRef.current &&
          activeClientRef.current === selectedClientId
        ) {
          fail(cause);
        }
      } finally {
        if (
          requestId === historyRequestRef.current &&
          activeClientRef.current === selectedClientId
        ) {
          setHistoryLoading(false);
        }
      }
    },
    [fail]
  );

  /**
   * Riprende l'ultima elaborazione ancora viva del cliente scelto.
   *
   * È la contropartita dello stato sul server: senza questo, chi ricarica la
   * pagina durante una ricerca vedrebbe una schermata di caricamento vuota e
   * ne lancerebbe una seconda, pagando due volte lo stesso foglio.
   */
  useEffect(() => {
    activeClientRef.current = clientId;
    if (!clientId) {
      setHistoryLoading(false);
      return;
    }
    void loadClientHistory(clientId, true);
    return () => {
      historyRequestRef.current += 1;
    };
  }, [clientId, loadClientHistory]);

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
      selectClient(created.clientId);
      setNewClientName("");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }, [fail, newClientName, selectClient]);

  /* ------------------------------------------------------------------ */
  /* Caricamento e preventivo                                            */
  /* ------------------------------------------------------------------ */

  const upload = useCallback(
    async (file: File) => {
      if (!clientId) {
        setError(t("v2.drop.needClient"));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const body = await file.arrayBuffer();
        const response = await fetch(
          `${API_URL}/api/taobao/clients/${clientId}/datasets?fileName=${encodeURIComponent(file.name)}&previewLimit=5`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
          }
        );
        const payload = (await response.json()) as TaobaoDatasetPreview & { message?: string };
        if (!response.ok) throw new Error(payload.message || `API ${response.status}`);

        setEstimate(
          await api<TaobaoPipelineEstimate>(
            `/taobao/clients/${clientId}/datasets/${payload.datasetId}/estimate`
          )
        );
        setStage("estimate");
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [clientId, fail, t]
  );

  const acceptPipelineState = useCallback((fresh: TaobaoPipelineState) => {
    if (activeClientRef.current !== fresh.clientId) return false;
    setHistoryClientId(fresh.clientId);
    setHistory((current) => mergePipelineIntoHistory(current, fresh));
    if (activePipelineRef.current === fresh.pipelineId) setState(fresh);
    return true;
  }, []);

  const startRun = useCallback(async () => {
    if (!clientId || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api<TaobaoPipelineState>(
        `/taobao/clients/${clientId}/datasets/${estimate.datasetId}/pipeline`,
        {
          method: "POST",
          body: JSON.stringify({
            mode,
            markupPct,
            maxRefineRounds,
            mapping: estimate.mapping,
            locale,
          }),
        }
      );
      if (activeClientRef.current !== clientId || started.clientId !== clientId) return;
      activePipelineRef.current = started.pipelineId;
      acceptPipelineState(started);
      setStage("running");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }, [
    acceptPipelineState,
    clientId,
    estimate,
    fail,
    locale,
    markupPct,
    maxRefineRounds,
    mode,
  ]);

  /* ------------------------------------------------------------------ */
  /* Avanzamento                                                         */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!clientId || !state) return;
    if (state.clientId !== clientId || activePipelineRef.current !== state.pipelineId) return;
    // Ferma solo quando non c'è più niente da aspettare: in pausa per domande
    // si continua a chiedere, perché un'altra scheda può aver risposto.
    if (state.status === "COMPLETED" || state.status === "FAILED" || state.status === "CANCELLED") {
      return;
    }

    const polledClientId = clientId;
    const polledPipelineId = state.pipelineId;
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      controller = new AbortController();
      try {
        const fresh = await api<TaobaoPipelineState>(
          `/taobao/clients/${polledClientId}/pipelines/${polledPipelineId}`,
          { signal: controller.signal }
        );
        if (
          disposed ||
          activeClientRef.current !== polledClientId ||
          activePipelineRef.current !== polledPipelineId ||
          fresh.clientId !== polledClientId ||
          fresh.pipelineId !== polledPipelineId
        ) {
          return;
        }
        acceptPipelineState(fresh);
        if (
          fresh.status === "COMPLETED" ||
          fresh.status === "FAILED" ||
          fresh.status === "CANCELLED"
        ) {
          void loadClientHistory(polledClientId, false);
          return;
        }
      } catch {
        // Un errore di rete non spegne il polling: resta l'ultimo stato buono.
      }
      if (!disposed) timer = setTimeout(() => void poll(), POLL_MS);
    };

    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    acceptPipelineState,
    clientId,
    loadClientHistory,
    state?.clientId,
    state?.pipelineId,
    state?.status,
  ]);

  const answer = useCallback(
    async (answers: Array<{ clarificationId: string; answer: string; skip: boolean }>) => {
      if (!clientId || !state || state.clientId !== clientId) return;
      setBusy(true);
      setError(null);
      try {
        const fresh = await api<TaobaoPipelineState>(
          `/taobao/clients/${clientId}/pipelines/${state.pipelineId}/answers`,
          { method: "POST", body: JSON.stringify({ answers }) }
        );
        if (
          activeClientRef.current === clientId &&
          activePipelineRef.current === state.pipelineId
        ) {
          acceptPipelineState(fresh);
        }
      } catch (cause) {
        if (activeClientRef.current === clientId) fail(cause);
      } finally {
        if (activeClientRef.current === clientId) setBusy(false);
      }
    },
    [acceptPipelineState, clientId, fail, state]
  );

  const cancelRun = useCallback(async () => {
    if (!clientId || !state || state.clientId !== clientId) return;
    setBusy(true);
    try {
      const fresh = await api<TaobaoPipelineState>(
        `/taobao/clients/${clientId}/pipelines/${state.pipelineId}/cancel`,
        { method: "POST" }
      );
      if (
        activeClientRef.current === clientId &&
        activePipelineRef.current === state.pipelineId
      ) {
        acceptPipelineState(fresh);
        void loadClientHistory(clientId, false);
      }
    } catch (cause) {
      if (activeClientRef.current === clientId) fail(cause);
    } finally {
      if (activeClientRef.current === clientId) setBusy(false);
    }
  }, [acceptPipelineState, clientId, fail, loadClientHistory, state]);

  function restart() {
    activePipelineRef.current = null;
    resultsRequestRef.current += 1;
    setState(null);
    setEstimate(null);
    setOpenedResults(null);
    setOpenedResultsContext(null);
    setStage("upload");
    if (fileInput.current) fileInput.current.value = "";
    if (clientId) void loadClientHistory(clientId, false);
  }

  const reopen = useCallback(
    async (entry: ScoutingV2HistoryEntry) => {
      const pipeline = entry.pipeline;
      const selectedClientId = activeClientRef.current;
      if (!pipeline || !selectedClientId || entry.clientId !== selectedClientId) return;

      activePipelineRef.current = pipeline.pipelineId;
      setBusy(true);
      setError(null);
      try {
        const fresh = await api<TaobaoPipelineState>(
          `/taobao/clients/${selectedClientId}/pipelines/${pipeline.pipelineId}`
        );
        if (
          activeClientRef.current !== selectedClientId ||
          activePipelineRef.current !== pipeline.pipelineId ||
          fresh.clientId !== selectedClientId
        ) {
          return;
        }
        acceptPipelineState(fresh);
        setEstimate(null);
        setStage("running");
      } catch (cause) {
        if (
          activeClientRef.current === selectedClientId &&
          activePipelineRef.current === pipeline.pipelineId
        ) {
          activePipelineRef.current = null;
          fail(cause);
        }
      } finally {
        if (activeClientRef.current === selectedClientId) setBusy(false);
      }
    },
    [acceptPipelineState, fail]
  );

  const openHistoricalResults = useCallback(
    async (entry: ScoutingV2HistoryEntry) => {
      const selectedClientId = activeClientRef.current;
      const jobId = historyJobId(entry);
      if (
        !selectedClientId ||
        entry.clientId !== selectedClientId ||
        !jobId ||
        !historyHasResults(entry)
      ) {
        return;
      }

      const requestId = ++resultsRequestRef.current;
      setBusy(true);
      setError(null);
      try {
        const fresh = await api<TaobaoJobResults>(
          `/taobao/clients/${selectedClientId}/jobs/${jobId}/results?limit=1000`
        );
        if (
          requestId !== resultsRequestRef.current ||
          activeClientRef.current !== selectedClientId
        ) {
          return;
        }
        if (fresh.job.clientId !== selectedClientId || fresh.job.jobId !== jobId) {
          throw new Error(t("v2.results.wrongClient"));
        }

        activePipelineRef.current = null;
        setState(null);
        setEstimate(null);
        setOpenedResults(fresh);
        setOpenedResultsContext({
          gaps: entry.pipeline?.outcome?.gaps ?? [],
          reviewIssues: entry.pipeline?.outcome?.reviewIssues ?? [],
          pipelineId: entry.pipeline?.pipelineId ?? null,
          outcome: entry.pipeline?.outcome ?? null,
        });
        setStage("results");
      } catch (cause) {
        if (
          requestId === resultsRequestRef.current &&
          activeClientRef.current === selectedClientId
        ) {
          fail(cause);
        }
      } finally {
        if (
          requestId === resultsRequestRef.current &&
          activeClientRef.current === selectedClientId
        ) {
          setBusy(false);
        }
      }
    },
    [fail, t]
  );

  /* ------------------------------------------------------------------ */
  /* Interfaccia                                                         */
  /* ------------------------------------------------------------------ */

  return (
    <div className="scouting v2">
      <header className="search-hero">
        <h1>{t("v2.heading")}</h1>
        <p className="subtitle">
          {t("v2.subtitle")}{" "}
          <Link href="/scouting-v1" className="v2-link">
            {t("v2.openV1")}
          </Link>
        </p>
      </header>

      {error ? <div className="error-panel">{error}</div> : null}

      {/* Cliente: un passo solo, e solo finché serve ------------------- */}
      {stage === "upload" ? (
        <section className="panel scouting-step">
          <h2>{t("v2.client.step")}</h2>
          <div className="scouting-row scouting-options">
            <label>
              {t("v2.client.existing")}
              <select
                value={clientId ?? ""}
                disabled={busy}
                onChange={(event) => selectClient(event.target.value || null)}
              >
                <option value="">{t("common.choose")}</option>
                {clients.map((entry) => (
                  <option key={entry.clientId} value={entry.clientId}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("v2.client.new")}
              <input
                type="text"
                value={newClientName}
                disabled={busy}
                placeholder={t("client.newPlaceholder")}
                onChange={(event) => setNewClientName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createClient();
                }}
              />
            </label>
            <button
              type="button"
              className="chip"
              disabled={busy || newClientName.trim().length === 0}
              onClick={() => void createClient()}
            >
              {t("client.create")}
            </button>
          </div>
          <p className="scouting-hint">{t("v2.client.hint")}</p>
        </section>
      ) : null}

      {stage === "upload" && clientId && historyClientId === clientId ? (
        <HistoryPanel
          entries={history}
          loading={historyLoading}
          busy={busy}
          onReopen={(entry) => void reopen(entry)}
          onOpenResults={(entry) => void openHistoricalResults(entry)}
        />
      ) : null}

      {/* Il foglio ------------------------------------------------------ */}
      {stage === "upload" ? (
        <section
          className={`v2-drop${dragging ? " dragging" : ""}${clientId ? "" : " disabled"}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (clientId) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <div className="v2-drop-title">
            {busy ? t("v2.drop.reading") : t("v2.drop.title")}
          </div>
          <div className="v2-drop-hint">{t("v2.drop.hint")}</div>
          <button
            type="button"
            disabled={busy || !clientId}
            onClick={() => fileInput.current?.click()}
          >
            {t("v2.drop.browse")}
          </button>
          {!clientId ? <div className="v2-drop-block">{t("v2.drop.needClient")}</div> : null}
        </section>
      ) : null}

      {/* Preventivo ----------------------------------------------------- */}
      {stage === "estimate" && estimate ? (
        <section className="panel scouting-step v2-estimate">
          <h2>{t("v2.estimate.title")}</h2>
          <div className="v2-estimate-file">
            <strong>{estimate.fileName}</strong>
            <span className="muted">{t("v2.estimate.sheet", { sheet: estimate.sheet })}</span>
          </div>

          <ul className="v2-estimate-list">
            <li>
              {t("v2.estimate.rows", {
                usable: estimate.usableRows,
                total: estimate.totalRows,
              })}
            </li>
            <li>{t("v2.estimate.variants", { count: estimate.estimatedVariants })}</li>
            <li>
              {t("v2.estimate.cost", { cost: estimate.maxCostUsd.toFixed(3) })} ·{" "}
              {t("v2.estimate.calls", { count: estimate.maxSearchCalls })} ·{" "}
              {t("v2.estimate.time", {
                minutes: Math.max(1, Math.round(estimate.estimatedSeconds / 60)),
              })}
            </li>
          </ul>
          <p className="scouting-hint">{t("v2.estimate.ceilingHint")}</p>

          {estimate.warnings.map((warning) => (
            <div key={warning} className="scouting-warning">
              {warning}
            </div>
          ))}
          {estimate.blockers.length > 0 ? (
            <div className="scouting-engine-error">
              {t("v2.estimate.blocked")} {estimate.blockers.join(" · ")}
            </div>
          ) : null}

          <div className="scouting-row scouting-options">
            <label>
              {t("v2.estimate.markup")}
              <input
                type="number"
                min={0}
                max={500}
                value={markupPct}
                disabled={busy}
                onChange={(event) => setMarkupPct(Number(event.target.value))}
              />
            </label>
            <label title={t("v2.estimate.roundsHint")}>
              {t("v2.estimate.rounds")}
              <input
                type="number"
                min={0}
                max={5}
                value={maxRefineRounds}
                disabled={busy}
                onChange={(event) => setMaxRefineRounds(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="scouting-row scouting-controls">
            <button
              type="button"
              disabled={busy || estimate.blockers.length > 0}
              onClick={() => void startRun()}
            >
              {busy ? t("v2.estimate.starting") : t("v2.estimate.start")}
            </button>
            <button type="button" className="chip" disabled={busy} onClick={restart}>
              {t("v2.estimate.cancel")}
            </button>
          </div>
        </section>
      ) : null}

      {/* Elaborazione --------------------------------------------------- */}
      {stage === "running" && state && clientId && state.clientId === clientId ? (
        <>
          <div className="scouting-row scouting-controls">
            <button type="button" className="chip" disabled={busy} onClick={restart}>
              {t("v2.history.back")}
            </button>
          </div>

          {state.status !== "COMPLETED" ? (
            <ProgressPanel state={state} busy={busy} onCancel={() => void cancelRun()} />
          ) : null}

          {state.status === "WAITING_ANSWERS" && state.questions.length > 0 ? (
            <QuestionsPanel
              questions={state.questions}
              round={state.questionRound}
              busy={busy}
              onSubmit={(answers) => void answer(answers)}
            />
          ) : null}

          {state.status === "COMPLETED" ? (
            <OutcomePanel
              state={state}
              onRestart={restart}
              onRefreshOutcome={() => {
                // La riprova mirata cambia i conteggi in alto: si rilegge lo
                // stato invece di lasciare a schermo numeri appena smentiti.
                void api<TaobaoPipelineState>(
                  `/taobao/clients/${state.clientId}/pipelines/${state.pipelineId}`
                ).then(acceptPipelineState);
              }}
            />
          ) : null}

          {state.status === "FAILED" ? (
            <section className="panel scouting-step">
              <h2>{t("v2.error.title")}</h2>
              <div className="scouting-engine-error">{state.error}</div>
              <button type="button" onClick={restart}>
                {t("v2.error.retry")}
              </button>
            </section>
          ) : null}

          {state.status === "CANCELLED" ? (
            <section className="panel scouting-step">
              <p className="muted">{t("v2.run.cancelled")}</p>
              <button type="button" onClick={restart}>
                {t("v2.done.again")}
              </button>
            </section>
          ) : null}
        </>
      ) : null}

      {stage === "results" &&
      openedResults &&
      clientId &&
      openedResults.job.clientId === clientId ? (
        <HistoricalResultsPanel
          results={openedResults}
          gaps={openedResultsContext?.gaps}
          reviewIssues={openedResultsContext?.reviewIssues}
          pipelineId={openedResultsContext?.pipelineId}
          outcome={openedResultsContext?.outcome}
          onBack={restart}
        />
      ) : null}
    </div>
  );
}
