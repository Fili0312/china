"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InquiryImportResult, InquiryRow } from "@china/shared";
import { API_URL, api, withApiQuery } from "@/lib/api";
import {
  ProductCard,
  ProductSort,
  SEARCH_ENGINE_CONFIG,
  SEARCH_ENGINES,
  SearchDiagnostics,
  SearchEngine,
  SearchProduct,
  SearchQuality,
  searchProducts,
} from "./search-shared";

/** Foglio usato dai fogli di richiesta 博工. */
const DEFAULT_SHEET = "询价";

/**
 * L'importazione lavora solo sui marketplace interrogati via browser: la
 * modalità OTAPI resta quella della ricerca normale e non viene toccata.
 */
const PLAYWRIGHT_ENGINES = SEARCH_ENGINES.filter(
  (engine) => SEARCH_ENGINE_CONFIG[engine].transport === "browser"
);

const VISIBLE_STEP = 25;

/**
 * Come si comporta ogni fonte con una query cinese. Verificato dal server il
 * 2026-07-20: conta la vetrina che il marketplace serve a questo IP, non la
 * lingua della query.
 */
const ENGINE_FITNESS: Partial<
  Record<SearchEngine, { level: "ok" | "warn" | "err"; hint: string }>
> = {
  yiwugo: {
    level: "ok",
    hint: "vetrina cinese, titoli in cinese: la più precisa",
  },
  chinagoods: {
    level: "warn",
    hint: "capisce il cinese ma titola in inglese: da controllare a mano",
  },
  aliexpress: {
    level: "warn",
    hint: "catalogo export al dettaglio (vetrina tedesca da questo server): prezzi molto più alti, poco preciso sui ricambi industriali",
  },
  alibaba: { level: "err", hint: "captcha: bloccato da questo server" },
  "made-in-china": {
    level: "err",
    hint: "captcha: bloccato da questo server",
  },
};

interface InquirySource {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

type SourceStatus = "pending" | "loading" | "done" | "error";

interface RowSource {
  status: SourceStatus;
  results: SearchProduct[];
  diagnostics: SearchDiagnostics | null;
  error: string | null;
  /** Query cinese realmente inviata al marketplace. */
  queryUsed: string | null;
}

interface RowState {
  /** Query cinese corrente: quella generata oppure la correzione manuale. */
  query: string;
  /** Query generata dal foglio, per poter tornare indietro. */
  generatedQuery: string;
  selected: boolean;
  sources: Partial<Record<SearchEngine, RowSource>>;
}

function emptySource(): RowSource {
  return {
    status: "pending",
    results: [],
    diagnostics: null,
    error: null,
    queryUsed: null,
  };
}

function storageKey(source: string, sheet: string): string {
  return `china:inquiry:${source}:${sheet}`;
}

/** Le correzioni manuali alle query restano disponibili dopo un reload. */
function loadSavedQueries(
  source: string,
  sheet: string
): Record<number, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(source, sheet));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const saved: Record<number, string> = {};
    for (const [key, value] of Object.entries(parsed as object)) {
      const rowNumber = Number(key);
      if (Number.isInteger(rowNumber) && typeof value === "string") {
        saved[rowNumber] = value;
      }
    }
    return saved;
  } catch {
    return {};
  }
}

function saveQueries(
  source: string,
  sheet: string,
  rows: InquiryRow[],
  states: Record<number, RowState>
): void {
  if (typeof window === "undefined") return;
  const edited: Record<number, string> = {};
  for (const row of rows) {
    const state = states[row.rowNumber];
    if (state && state.query !== row.query) {
      edited[row.rowNumber] = state.query;
    }
  }
  try {
    const key = storageKey(source, sheet);
    if (Object.keys(edited).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(edited));
  } catch {
    // Spazio esaurito o storage disabilitato: le correzioni restano in pagina.
  }
}

function listSources(): Promise<InquirySource[]> {
  return api<InquirySource[]>("/inquiry/sources");
}

function loadSource(
  source: string,
  sheet: string
): Promise<InquiryImportResult> {
  return api<InquiryImportResult>(
    withApiQuery("/inquiry/rows", { source, sheet })
  );
}

/** Il file viaggia come corpo binario: nessun parser multipart necessario. */
async function uploadSource(
  file: File,
  sheet: string
): Promise<InquiryImportResult> {
  const path = withApiQuery("/inquiry/import", {
    fileName: file.name,
    sheet,
  });
  const response = await fetch(`${API_URL}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    cache: "no-store",
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let detail = raw;
    try {
      const body = JSON.parse(raw) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      // Risposta non JSON: resta il testo originale.
    }
    throw new Error(detail || `Importazione fallita (${response.status})`);
  }
  return (await response.json()) as InquiryImportResult;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function csvEscape(value: string | number | null): string {
  let raw = String(value ?? "");
  if (typeof value === "string" && /^\s*[=+\-@]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replace(/"/g, '""')}"`;
}

function toCsv(
  rows: InquiryRow[],
  states: Record<number, RowState>,
  engines: SearchEngine[]
): string {
  const lines = [
    [
      "riga",
      "品名",
      "规格型号",
      "quantità",
      "unità",
      "reparto",
      "query cinese usata",
      "link di riferimento",
      "fonte",
      "stato",
      "titolo",
      "prezzo",
      "valuta",
      "ordini",
      "MOQ",
      "pertinenza",
      "link risultato",
      "avvisi",
    ].join(";"),
  ];

  for (const row of rows) {
    const state = states[row.rowNumber];
    if (!state) continue;
    const base = [
      csvEscape(row.rowNumber),
      csvEscape(row.name),
      csvEscape(row.spec),
      csvEscape(row.quantity),
      csvEscape(row.unit),
      csvEscape(row.department),
    ];
    for (const engine of engines) {
      const source = state.sources[engine];
      if (!source || source.status === "pending") continue;
      const context = [
        ...base,
        csvEscape(source.queryUsed ?? state.query),
        csvEscape(row.referenceUrl),
        csvEscape(SEARCH_ENGINE_CONFIG[engine].label),
      ];
      if (source.status !== "done") {
        // L'errore va nell'ultima colonna, non in quella del titolo.
        lines.push(
          [
            ...context,
            csvEscape("errore"),
            ...Array(7).fill('""'),
            csvEscape(source.error),
          ].join(";")
        );
        continue;
      }
      if (source.results.length === 0) {
        lines.push(
          [...context, csvEscape("nessun risultato"), ...Array(8).fill('""')].join(";")
        );
        continue;
      }
      for (const product of source.results) {
        lines.push(
          [
            ...context,
            csvEscape("ok"),
            csvEscape(product.title),
            csvEscape(product.originalPrice),
            csvEscape(product.currency),
            csvEscape(product.totalSales),
            csvEscape(product.moq),
            csvEscape(product.relevanceScore ?? ""),
            csvEscape(product.productUrl),
            csvEscape(product.matchWarnings?.join(" | ") ?? ""),
          ].join(";")
        );
      }
    }
  }
  return lines.join("\n");
}

const STATUS_BADGE: Record<SourceStatus, { label: string; cls: string }> = {
  pending: { label: "In coda", cls: "" },
  loading: { label: "Ricerca…", cls: "warn" },
  done: { label: "Fatto", cls: "ok" },
  error: { label: "Errore", cls: "err" },
};

export function InquirySearch({
  quality,
  onRunningChange,
}: {
  quality: SearchQuality;
  onRunningChange?: (running: boolean) => void;
}) {
  const [sources, setSources] = useState<InquirySource[]>([]);
  const [source, setSource] = useState("");
  const [sheet, setSheet] = useState(DEFAULT_SHEET);
  const [imported, setImported] = useState<InquiryImportResult | null>(null);
  const [states, setStates] = useState<Record<number, RowState>>({});
  // Preselezionate le due fonti che rispondono davvero a una query cinese.
  const [engines, setEngines] = useState<SearchEngine[]>([
    "chinagoods",
    "yiwugo",
  ]);
  const [perItem, setPerItem] = useState(5);
  const [sort, setSort] = useState<ProductSort>("best-match");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  const cancelRef = useRef(false);
  const operationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listSources()
      .then((available) => {
        setSources(available);
        setSource((current) => current || available[0]?.name || "");
      })
      .catch(() => setSources([]));
  }, []);

  useEffect(
    () => () => {
      operationRef.current += 1;
      cancelRef.current = true;
      controllerRef.current?.abort();
    },
    []
  );

  const setIsRunning = useCallback(
    (value: boolean) => {
      setRunning(value);
      onRunningChange?.(value);
    },
    [onRunningChange]
  );

  function applyImport(result: InquiryImportResult) {
    const saved = loadSavedQueries(result.source, result.sheet);
    const next: Record<number, RowState> = {};
    for (const row of result.rows) {
      next[row.rowNumber] = {
        query: saved[row.rowNumber] ?? row.query,
        generatedQuery: row.query,
        selected: false,
        sources: {},
      };
    }
    setImported(result);
    setStates(next);
    setVisibleCount(VISIBLE_STEP);
  }

  async function importFromServer() {
    if (!source) return;
    setImporting(true);
    setImportError(null);
    try {
      applyImport(await loadSource(source, sheet.trim() || DEFAULT_SHEET));
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Importazione fallita"
      );
    } finally {
      setImporting(false);
    }
  }

  async function importFromFile(file: File) {
    setImporting(true);
    setImportError(null);
    try {
      applyImport(await uploadSource(file, sheet.trim() || DEFAULT_SHEET));
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Importazione fallita"
      );
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function updateRow(rowNumber: number, patch: Partial<RowState>) {
    setStates((prev) => {
      const current = prev[rowNumber];
      if (!current) return prev;
      return { ...prev, [rowNumber]: { ...current, ...patch } };
    });
  }

  function updateSource(
    rowNumber: number,
    engine: SearchEngine,
    patch: Partial<RowSource>,
    operation: number
  ) {
    setStates((prev) => {
      if (operationRef.current !== operation) return prev;
      const current = prev[rowNumber];
      if (!current) return prev;
      return {
        ...prev,
        [rowNumber]: {
          ...current,
          sources: {
            ...current.sources,
            [engine]: { ...(current.sources[engine] ?? emptySource()), ...patch },
          },
        },
      };
    });
  }

  function editQuery(rowNumber: number, query: string) {
    updateRow(rowNumber, { query });
    if (!imported) return;
    // Salvataggio differito: la scrittura avviene sullo stato appena calcolato.
    setStates((prev) => {
      saveQueries(imported.source, imported.sheet, imported.rows, prev);
      return prev;
    });
  }

  async function searchRow(
    rowNumber: number,
    query: string,
    engine: SearchEngine,
    operation: number,
    signal: AbortSignal
  ) {
    updateSource(rowNumber, engine, { status: "loading", error: null }, operation);
    try {
      const result = await searchProducts(
        query,
        0,
        perItem,
        sort,
        engine,
        quality,
        signal
      );
      updateSource(
        rowNumber,
        engine,
        {
          status: "done",
          results: result.items,
          diagnostics: result.diagnostics ?? null,
          queryUsed: result.diagnostics?.queryUsed ?? query,
          error: null,
        },
        operation
      );
    } catch (error) {
      updateSource(
        rowNumber,
        engine,
        {
          status: "error",
          queryUsed: query,
          error: signal.aborted
            ? "Interrotto"
            : error instanceof Error
              ? error.message
              : "Errore imprevisto",
        },
        operation
      );
    }
  }

  /** Un pool per fonte: i browser restano serializzati, le fonti no. */
  async function runSearches(targets: { rowNumber: number; query: string }[]) {
    if (targets.length === 0 || engines.length === 0) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelRef.current = false;
    setStopping(false);
    setIsRunning(true);

    setStates((prev) => {
      const next = { ...prev };
      for (const target of targets) {
        const current = next[target.rowNumber];
        if (!current) continue;
        next[target.rowNumber] = {
          ...current,
          sources: Object.fromEntries(
            engines.map((engine) => [engine, emptySource()])
          ) as Partial<Record<SearchEngine, RowSource>>,
        };
      }
      return next;
    });

    try {
      await Promise.all(
        engines.map(async (engine) => {
          let cursor = 0;
          const lanes = SEARCH_ENGINE_CONFIG[engine].bulkConcurrency;
          await Promise.all(
            Array.from({ length: lanes }, async () => {
              while (
                cursor < targets.length &&
                !cancelRef.current &&
                !controller.signal.aborted
              ) {
                const target = targets[cursor++];
                await searchRow(
                  target.rowNumber,
                  target.query,
                  engine,
                  operation,
                  controller.signal
                );
              }
            })
          );
        })
      );
    } finally {
      if (operationRef.current === operation) {
        setStates((prev) => {
          const next = { ...prev };
          for (const target of targets) {
            const current = next[target.rowNumber];
            if (!current) continue;
            const sources = { ...current.sources };
            let changed = false;
            for (const engine of engines) {
              const entry = sources[engine];
              if (entry && (entry.status === "pending" || entry.status === "loading")) {
                sources[engine] = { ...entry, status: "error", error: "Interrotto" };
                changed = true;
              }
            }
            if (changed) next[target.rowNumber] = { ...current, sources };
          }
          return next;
        });
        if (controllerRef.current === controller) controllerRef.current = null;
        setStopping(false);
        setIsRunning(false);
      }
    }
  }

  const rows = imported?.rows ?? [];
  const selectedRows = rows.filter((row) => states[row.rowNumber]?.selected);
  const withReference = rows.filter((row) => row.referenceUrl).length;

  function toggleEngine(engine: SearchEngine) {
    if (running) return;
    setEngines((prev) =>
      prev.includes(engine)
        ? prev.filter((value) => value !== engine)
        : [...prev, engine]
    );
  }

  function selectVisible(count: number | "none") {
    setStates((prev) => {
      const next = { ...prev };
      rows.forEach((row, index) => {
        const current = next[row.rowNumber];
        if (!current) return;
        next[row.rowNumber] = {
          ...current,
          selected: count === "none" ? false : index < count,
        };
      });
      return next;
    });
  }

  function exportCsv() {
    if (!imported) return;
    const blob = new Blob(["﻿" + toCsv(rows, states, engines)], {
      type: "text/csv;charset=utf-8",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `richieste-${imported.sheet}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const searchedCount = rows.filter((row) =>
    engines.some((engine) => {
      const status = states[row.rowNumber]?.sources[engine]?.status;
      return status === "done" || status === "error";
    })
  ).length;

  return (
    <>
      <div className="panel inquiry-setup">
        <h2 className="inquiry-heading">Richieste dal foglio Excel</h2>
        <p className="status-note">
          Le query vengono costruite con il testo cinese originale della
          richiesta — 品名 più 规格型号 — senza passare da una traduzione
          italiana e da una riconversione, che perderebbero codici, modelli,
          misure e materiali. Quantità richiesta, fornitore, data, reparto,
          richiedente e centro di costo non entrano mai nella query.
        </p>

        <div className="inquiry-source-row">
          <label className="muted">
            File sul server{" "}
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={importing || running || sources.length === 0}
            >
              {sources.length === 0 && <option value="">nessun file</option>}
              {sources.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name} ({formatBytes(entry.sizeBytes)})
                </option>
              ))}
            </select>
          </label>
          <label className="muted">
            Foglio{" "}
            <input
              type="text"
              className="inquiry-sheet-input"
              value={sheet}
              onChange={(event) => setSheet(event.target.value)}
              disabled={importing || running}
            />
          </label>
          <button onClick={importFromServer} disabled={importing || running || !source}>
            {importing ? "Importazione…" : "Importa"}
          </button>
          <label className="inquiry-upload muted">
            oppure carica un file
            <input
              ref={fileInputRef}
              type="file"
              accept=".xls,.xlsx,.xlsm"
              disabled={importing || running}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFromFile(file);
              }}
            />
          </label>
        </div>

        {importError && <div className="error-panel">{importError}</div>}

        {imported && (
          <>
            <div className="search-diagnostics" aria-label="Riepilogo importazione">
              <span>
                File <strong>{imported.source}</strong>
              </span>
              <span>
                Foglio <strong>{imported.sheet}</strong>
              </span>
              <span>
                Richieste <strong>{imported.totalRows.toLocaleString("it-IT")}</strong>
              </span>
              <span>
                Con link prodotto <strong>{withReference.toLocaleString("it-IT")}</strong>
              </span>
              {imported.skippedRows > 0 && (
                <span>
                  Righe ignorate <strong>{imported.skippedRows}</strong>
                </span>
              )}
            </div>

            <div className="sort-row" role="group" aria-label="Marketplace">
              <span className="sort-label">Marketplace (Playwright)</span>
              {PLAYWRIGHT_ENGINES.map((engine) => {
                const fitness = ENGINE_FITNESS[engine];
                return (
                  <button
                    key={engine}
                    type="button"
                    className="chip"
                    aria-pressed={engines.includes(engine)}
                    disabled={running}
                    onClick={() => toggleEngine(engine)}
                    title={fitness?.hint}
                  >
                    {fitness && (
                      <span
                        className={`engine-dot ${fitness.level}`}
                        aria-hidden
                      />
                    )}
                    {SEARCH_ENGINE_CONFIG[engine].shortLabel}
                  </button>
                );
              })}
            </div>
            <p className="status-note">
              Taobao e Tmall restano fuori da questa modalità: usano OTAPI e non
              lo scraping. Ogni fonte via browser lavora una richiesta alla
              volta, quindi conviene selezionare poche righe per volta.
            </p>
            <ul className="engine-legend">
              <li>
                <span className="engine-dot ok" aria-hidden />
                <strong>Yiwugo</strong> — cerca sulla vetrina cinese e
                restituisce titoli in cinese: la corrispondenza delle parole è
                misurata davvero. È la fonte più precisa su queste richieste.
              </li>
              <li>
                <span className="engine-dot warn" aria-hidden />
                <strong>Chinagoods</strong> — capisce il cinese ma pubblica i
                titoli in inglese: la corrispondenza non è verificabile e i
                risultati vanno controllati a mano.
              </li>
              <li>
                <span className="engine-dot warn" aria-hidden />
                <strong>AliExpress</strong> — non ha una vetrina cinese: da
                questo server serve il catalogo export al dettaglio, con prezzi
                molto più alti (una sedia antistatica a 496 € contro 110 ¥ su
                Yiwugo). Trova prodotti simili, non il ricambio industriale
                richiesto, e dopo poche ricerche di fila chiede una verifica
                anti-bot.
              </li>
              <li>
                <span className="engine-dot err" aria-hidden />
                <strong>Alibaba</strong> e <strong>Made-in-China</strong> —
                bloccano lo scraping da questo server con un captcha, anche in
                inglese: correggere la query non cambia nulla, servono API
                ufficiali o un proxy autorizzato.
              </li>
            </ul>

            <div className="bulk-toolbar">
              <label className="muted">
                Risultati per richiesta{" "}
                <select
                  value={perItem}
                  onChange={(event) => setPerItem(Number(event.target.value))}
                  disabled={running}
                >
                  {[3, 5, 10].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="muted">
                Ordina per{" "}
                <select
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as ProductSort)
                  }
                  disabled={running}
                >
                  <option value="best-match">
                    Parole + prezzo + vendite
                  </option>
                  <option value="default">Solo pertinenza</option>
                  <option value="price-asc">Prezzo più basso</option>
                  <option value="orders-desc">Più ordini</option>
                </select>
              </label>
              <button
                className="secondary"
                disabled={running}
                onClick={() => selectVisible(10)}
              >
                Seleziona prime 10
              </button>
              <button
                className="secondary"
                disabled={running}
                onClick={() => selectVisible("none")}
              >
                Deseleziona tutto
              </button>
              {!running ? (
                <button
                  disabled={selectedRows.length === 0 || engines.length === 0}
                  onClick={() =>
                    void runSearches(
                      selectedRows.map((row) => ({
                        rowNumber: row.rowNumber,
                        query: states[row.rowNumber]!.query,
                      }))
                    )
                  }
                >
                  Cerca {selectedRows.length} richieste selezionate
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    cancelRef.current = true;
                    controllerRef.current?.abort();
                  }}
                >
                  {stopping ? "Interruzione…" : "Interrompi"}
                </button>
              )}
              {searchedCount > 0 && !running && (
                <button className="secondary" onClick={exportCsv}>
                  Esporta CSV
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {rows.slice(0, visibleCount).map((row) => {
        const state = states[row.rowNumber];
        if (!state) return null;
        const edited = state.query !== state.generatedQuery;
        return (
          <section className="panel inquiry-card" key={row.rowNumber}>
            <div className="inquiry-card-head">
              <label className="inquiry-select">
                <input
                  type="checkbox"
                  checked={state.selected}
                  disabled={running}
                  onChange={(event) =>
                    updateRow(row.rowNumber, { selected: event.target.checked })
                  }
                />
                <span className="inquiry-row-number">riga {row.rowNumber}</span>
              </label>
              <h3 className="inquiry-name">{row.name}</h3>
              {row.spec && <span className="inquiry-spec">{row.spec}</span>}
            </div>

            <div className="inquiry-meta muted">
              {[
                row.quantity != null
                  ? `richiesti ${row.quantity.toLocaleString("it-IT")}${row.unit ? ` ${row.unit}` : ""}`
                  : null,
                row.unitPrice != null ? `prezzo indicato ${row.unitPrice} CNY` : null,
                row.purpose ? `uso: ${row.purpose}` : null,
                row.department ? `reparto: ${row.department}` : null,
                row.requester ? `richiedente: ${row.requester}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              <span className="inquiry-meta-note">
                (questi campi non entrano nella query)
              </span>
            </div>

            {row.referenceUrl && (
              <div className="inquiry-reference">
                <strong>Prodotto già indicato nel file</strong>
                {row.referenceTitle && (
                  <span className="inquiry-reference-title">
                    {row.referenceTitle}
                  </span>
                )}
                <a
                  href={row.referenceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  1. Apri il prodotto originale ↗
                </a>
                <span className="muted">
                  2. poi cerca alternative con il nome e le specifiche cinesi
                </span>
              </div>
            )}

            <div className="inquiry-query">
              <label htmlFor={`query-${row.rowNumber}`}>
                Query cinese usata sui marketplace
              </label>
              <div className="inquiry-query-row">
                <input
                  id={`query-${row.rowNumber}`}
                  type="text"
                  lang="zh"
                  value={state.query}
                  disabled={running}
                  onChange={(event) =>
                    editQuery(row.rowNumber, event.target.value)
                  }
                />
                <button
                  disabled={running || !state.query.trim() || engines.length === 0}
                  onClick={() =>
                    void runSearches([
                      { rowNumber: row.rowNumber, query: state.query },
                    ])
                  }
                >
                  Cerca
                </button>
                {edited && (
                  <button
                    className="secondary"
                    disabled={running}
                    onClick={() =>
                      editQuery(row.rowNumber, state.generatedQuery)
                    }
                  >
                    Ripristina
                  </button>
                )}
              </div>
              <div className="inquiry-query-parts muted">
                {edited && <span className="badge warn">query corretta a mano</span>}
                {row.droppedTerms.length > 0 && (
                  <span>Rimossi come quantità: {row.droppedTerms.join(", ")}</span>
                )}
              </div>
            </div>

            {engines.map((engine) => {
              const entry = state.sources[engine];
              if (!entry) return null;
              const badge = STATUS_BADGE[entry.status];
              return (
                <div className="bulk-source" key={engine}>
                  <div className="bulk-source-head">
                    <h4>{SEARCH_ENGINE_CONFIG[engine].label}</h4>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  </div>
                  {entry.queryUsed && (
                    <p className="inquiry-query-used muted">
                      Query inviata: <code>{entry.queryUsed}</code>
                    </p>
                  )}
                  {entry.status === "error" && (
                    <p className="bulk-item-error">{entry.error}</p>
                  )}
                  {entry.status === "done" && entry.results.length === 0 && (
                    <div className="bulk-empty">
                      <span className="muted">
                        Nessun risultato per questa query.
                      </span>
                    </div>
                  )}
                  {entry.results.length > 0 && (
                    <div className="bulk-strip">
                      {entry.results.map((product, index) => (
                        <ProductCard
                          p={product}
                          key={`${product.id}-${index}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      {visibleCount < rows.length && (
        <div className="bulk-more">
          <button
            className="secondary"
            onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
          >
            Mostra altre {Math.min(VISIBLE_STEP, rows.length - visibleCount)}
          </button>
          <span className="muted">
            {visibleCount} di {rows.length} richieste visualizzate
          </span>
        </div>
      )}
    </>
  );
}
