"use client";

import { useEffect, useRef, useState } from "react";
import {
  ProductCard,
  ProductSort,
  qualityLabel,
  SEARCH_ENGINE_CONFIG,
  SearchEngine,
  SearchDiagnostics,
  SearchDiagnosticsSummary,
  SearchProduct,
  SearchQuality,
  searchProducts,
} from "./search-shared";

const MAX_SEARCH_TASKS = 500;
const VISIBLE_STEP = 25;

/**
 * Ogni fonte ha un pool separato: le API possono lavorare in parallelo,
 * mentre i marketplace interrogati via browser restano serializzati.
 */
function concurrencyFor(engine: SearchEngine): number {
  return SEARCH_ENGINE_CONFIG[engine].bulkConcurrency;
}

type ItemStatus = "pending" | "loading" | "done" | "error";

interface BulkSource {
  status: ItemStatus;
  results: SearchProduct[];
  diagnostics: SearchDiagnostics | null;
  error: string | null;
}

interface BulkItem {
  query: string;
  sources: Partial<Record<SearchEngine, BulkSource>>;
}

interface BatchConfig {
  sort: ProductSort;
  perItem: number;
  quality: SearchQuality;
}

type IndexesByEngine = Partial<Record<SearchEngine, number[]>>;

function emptySource(): BulkSource {
  return { status: "pending", results: [], diagnostics: null, error: null };
}

function parseLines(text: string, maxLines: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const q = line.trim().slice(0, 200);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= maxLines) break;
  }
  return out;
}

function toCsv(items: BulkItem[], engines: SearchEngine[]): string {
  const esc = (value: string | number | null) => {
    let raw = String(value ?? "");
    // Evita che testo esterno venga interpretato come formula da Excel.
    if (typeof value === "string" && /^\s*[=+\-@]/.test(raw)) raw = `'${raw}`;
    return `"${raw.replace(/"/g, '""')}"`;
  };
  const rows = [
    [
      "prodotto richiesto",
      "fonte",
      "stato",
      "qualità",
      "analizzati",
      "pertinenti",
      "scartati",
      "deduplicati",
      "oltre il top mostrato",
      "errore",
      "id",
      "titolo",
      "titolo originale",
      "prezzo originale",
      "valuta",
      "venditore",
      "ordini",
      "MOQ",
      "link",
      "punteggio pertinenza",
      "affidabilità fonte",
      "motivi pertinenza",
      "avvisi pertinenza",
      "warning fonte",
    ].join(";"),
  ];

  for (const item of items) {
    for (const engine of engines) {
      const source = item.sources[engine];
      if (!source) continue;
      if (source.status === "error") {
        rows.push(
          [
            esc(item.query),
            esc(SEARCH_ENGINE_CONFIG[engine].label),
            esc("errore"),
            "",
            "",
            "",
            "",
            "",
            "",
            esc(source.error),
            ...Array.from({ length: 14 }, () => ""),
          ].join(";")
        );
        continue;
      }
      if (source.status !== "done") continue;
      if (source.results.length === 0) {
        rows.push(
          [
            esc(item.query),
            esc(SEARCH_ENGINE_CONFIG[engine].label),
            esc("nessun risultato"),
            esc(source.diagnostics?.quality ?? ""),
            esc(source.diagnostics?.fetchedCount ?? ""),
            esc(source.diagnostics?.qualifiedCount ?? ""),
            esc(source.diagnostics?.discardedCount ?? ""),
            esc(source.diagnostics?.duplicatesRemoved ?? ""),
            esc(source.diagnostics?.truncatedCount ?? ""),
            "",
            ...Array.from({ length: 14 }, () => ""),
          ].join(";")
        );
        continue;
      }
      for (const product of source.results) {
        rows.push(
          [
            esc(item.query),
            esc(SEARCH_ENGINE_CONFIG[engine].label),
            esc("ok"),
            esc(source.diagnostics?.quality ?? ""),
            esc(source.diagnostics?.fetchedCount ?? ""),
            esc(source.diagnostics?.qualifiedCount ?? ""),
            esc(source.diagnostics?.discardedCount ?? ""),
            esc(source.diagnostics?.duplicatesRemoved ?? ""),
            esc(source.diagnostics?.truncatedCount ?? ""),
            "",
            esc(product.id),
            esc(product.title),
            esc(product.originalTitle),
            esc(product.originalPrice),
            esc(product.currency),
            esc(product.vendorName),
            esc(product.totalSales),
            esc(product.moq),
            esc(product.productUrl),
            esc(product.relevanceScore ?? ""),
            esc(product.sourceConfidenceScore ?? ""),
            esc(product.matchReasons?.join(" | ") ?? ""),
            esc(product.matchWarnings?.join(" | ") ?? ""),
            esc(product.warnings.join(", ")),
          ].join(";")
        );
      }
    }
  }
  return rows.join("\n");
}

const STATUS_BADGE: Record<ItemStatus, { label: string; cls: string }> = {
  pending: { label: "In coda", cls: "" },
  loading: { label: "Ricerca…", cls: "warn" },
  done: { label: "Fatto", cls: "ok" },
  error: { label: "Errore", cls: "err" },
};

function overallBadge(sources: BulkSource[]): { label: string; cls: string } {
  if (sources.some((source) => source.status === "loading")) {
    return STATUS_BADGE.loading;
  }
  if (sources.some((source) => source.status === "pending")) {
    return STATUS_BADGE.pending;
  }
  const errors = sources.filter((source) => source.status === "error").length;
  if (errors === sources.length) return STATUS_BADGE.error;
  if (errors > 0) return { label: "Parziale", cls: "warn" };
  return STATUS_BADGE.done;
}

export function BulkSearch({
  sort,
  quality,
  engines,
  onRunningChange,
}: {
  sort: ProductSort;
  quality: SearchQuality;
  engines: SearchEngine[];
  onRunningChange?: (running: boolean) => void;
}) {
  // Mantiene il batch entro 500 chiamate sorgente complessive: con un solo
  // motore restano 500 righe, con “Tutti” il limite viene diviso per fonte.
  const maxLines = Math.max(1, Math.floor(MAX_SEARCH_TASKS / engines.length));
  const [text, setText] = useState("");
  const [perItem, setPerItem] = useState(3);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  const [batchConfig, setBatchConfig] = useState<BatchConfig | null>(null);
  const cancelRef = useRef(false);
  const operationIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      operationIdRef.current += 1;
      cancelRef.current = true;
      activeControllerRef.current?.abort();
    },
    []
  );

  const lineCount = parseLines(text, maxLines).length;
  const sourceStates = items.flatMap((item) =>
    engines
      .map((engine) => item.sources[engine])
      .filter((source): source is BulkSource => source != null)
  );
  const doneCount = sourceStates.filter(
    (source) => source.status === "done"
  ).length;
  const errorCount = sourceStates.filter(
    (source) => source.status === "error"
  ).length;
  const finished = items.length > 0 && !running;

  function setIsRunning(value: boolean) {
    setRunning(value);
    onRunningChange?.(value);
  }

  function updateSource(
    index: number,
    engine: SearchEngine,
    patch: Partial<BulkSource>,
    operationId: number
  ) {
    setItems((prev) => {
      if (operationIdRef.current !== operationId) return prev;
      const item = prev[index];
      if (!item) return prev;
      const next = [...prev];
      next[index] = {
        ...item,
        sources: {
          ...item.sources,
          [engine]: {
            ...(item.sources[engine] ?? emptySource()),
            ...patch,
          },
        },
      };
      return next;
    });
  }

  async function searchOne(
    index: number,
    query: string,
    selectedSort: ProductSort,
    engine: SearchEngine,
    resultCount: number,
    selectedQuality: SearchQuality,
    operationId: number,
    signal: AbortSignal
  ) {
    updateSource(
      index,
      engine,
      { status: "loading", error: null },
      operationId
    );
    try {
      const response = await searchProducts(
        query,
        0,
        resultCount,
        selectedSort,
        engine,
        selectedQuality,
        signal
      );
      updateSource(
        index,
        engine,
        {
          status: "done",
          results: response.items,
          diagnostics: response.diagnostics ?? null,
          error: null,
        },
        operationId
      );
    } catch (error) {
      updateSource(
        index,
        engine,
        {
          status: "error",
          error: signal.aborted
            ? "Interrotto"
            : error instanceof Error
              ? error.message
              : "Errore imprevisto",
        },
        operationId
      );
    }
  }

  async function runPools(
    indexesByEngine: IndexesByEngine,
    queries: string[],
    selectedSort: ProductSort,
    resultCount: number,
    selectedQuality: SearchQuality
  ) {
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setStopping(false);
    setIsRunning(true);
    cancelRef.current = false;
    try {
      await Promise.all(
        engines.map(async (engine) => {
          const indexes = indexesByEngine[engine] ?? [];
          let cursor = 0;
          await Promise.all(
            Array.from({ length: concurrencyFor(engine) }, async () => {
              while (
                cursor < indexes.length &&
                !cancelRef.current &&
                !controller.signal.aborted
              ) {
                const index = indexes[cursor++];
                await searchOne(
                  index,
                  queries[index],
                  selectedSort,
                  engine,
                  resultCount,
                  selectedQuality,
                  operationId,
                  controller.signal
                );
              }
            })
          );
        })
      );
    } finally {
      if (operationIdRef.current !== operationId) return;
      // Ciò che è rimasto in coda dopo un'interruzione torna riprovabile.
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          sources: Object.fromEntries(
            Object.entries(item.sources).map(([engine, source]) => [
              engine,
              source?.status === "pending" || source?.status === "loading"
                ? { ...source, status: "error", error: "Interrotto" }
                : source,
            ])
          ) as Partial<Record<SearchEngine, BulkSource>>,
        }))
      );
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
      setStopping(false);
      setIsRunning(false);
    }
  }

  function start() {
    const queries = parseLines(text, maxLines);
    if (queries.length === 0) return;
    const config = { sort, perItem, quality };
    setBatchConfig(config);
    setVisibleCount(VISIBLE_STEP);

    setItems(
      queries.map((query) => ({
        query,
        sources: Object.fromEntries(
          engines.map((engine) => [engine, emptySource()])
        ) as Partial<Record<SearchEngine, BulkSource>>,
      }))
    );

    const indexes = queries.map((_, index) => index);
    const indexesByEngine = Object.fromEntries(
      engines.map((engine) => [engine, indexes])
    ) as IndexesByEngine;
    void runPools(
      indexesByEngine,
      queries,
      config.sort,
      config.perItem,
      config.quality
    );
  }

  function retryFailed() {
    if (!batchConfig) return;
    const indexesByEngine: IndexesByEngine = {};
    for (const engine of engines) {
      indexesByEngine[engine] = items
        .map((item, index) =>
          item.sources[engine]?.status === "error" ? index : -1
        )
        .filter((index) => index >= 0);
    }
    if (!engines.some((engine) => (indexesByEngine[engine]?.length ?? 0) > 0)) {
      return;
    }

    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        sources: Object.fromEntries(
          Object.entries(item.sources).map(([engine, source]) => [
            engine,
            source?.status === "error"
              ? { ...source, status: "pending", error: null }
              : source,
          ])
        ) as Partial<Record<SearchEngine, BulkSource>>,
      }))
    );
    void runPools(
      indexesByEngine,
      items.map((item) => item.query),
      batchConfig.sort,
      batchConfig.perItem,
      batchConfig.quality
    );
  }

  function retrySource(index: number, engine: SearchEngine) {
    if (!batchConfig) return;
    void runPools(
      { [engine]: [index] },
      items.map((item) => item.query),
      batchConfig.sort,
      batchConfig.perItem,
      batchConfig.quality
    );
  }

  function exportCsv() {
    // BOM per Excel: i titoli originali possono essere in cinese (UTF-8).
    const blob = new Blob(["﻿" + toCsv(items, engines)], {
      type: "text/csv;charset=utf-8",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download =
      engines.length > 1
        ? "ricerca-tutti-i-motori.csv"
        : `ricerca-${engines[0]}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  return (
    <>
      <div className="panel">
        <label className="bulk-label" htmlFor="bulk-input">
          Un prodotto per riga (max {maxLines} con i motori selezionati) — ogni
          riga viene cercata su{" "}
          {engines
            .map((engine) => SEARCH_ENGINE_CONFIG[engine].shortLabel)
            .join(", ")}
        </label>
        {engines.some(
          (engine) => SEARCH_ENGINE_CONFIG[engine].transport === "browser"
        ) && (
          <p className="status-note bulk-engine-note">
            Le fonti via browser procedono una richiesta alla volta e possono
            attivare verifiche anti-bot; l&apos;errore di una fonte non ferma
            le altre.
          </p>
        )}
        <textarea
          id="bulk-input"
          className="bulk-input"
          placeholder={
            "powerbank 20000mah\ntazza ceramica bianca\nzaino impermeabile 30L\npenna a sfera blu\n…"
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={running}
        />
        <div className="bulk-toolbar">
          <label className="muted">
            Risultati per prodotto e fonte{" "}
            <select
              value={perItem}
              onChange={(event) => setPerItem(Number(event.target.value))}
              disabled={running}
            >
              {[1, 3, 5, 10].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {!running ? (
            <button onClick={start} disabled={lineCount === 0}>
              {lineCount === 1
                ? "Cerca 1 prodotto"
                : `Cerca${lineCount > 0 ? ` ${lineCount} prodotti` : ""}`}
            </button>
          ) : (
            <button
              className="secondary"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                cancelRef.current = true;
                activeControllerRef.current?.abort();
              }}
            >
              {stopping ? "Interruzione…" : "Interrompi"}
            </button>
          )}
          {finished && errorCount > 0 && (
            <button className="secondary" onClick={retryFailed}>
              Riprova falliti ({errorCount})
            </button>
          )}
          {finished && sourceStates.length > 0 && (
            <button className="secondary" onClick={exportCsv}>
              Esporta CSV
            </button>
          )}
        </div>

        {batchConfig &&
          !running &&
          (batchConfig.sort !== sort ||
            batchConfig.perItem !== perItem ||
            batchConfig.quality !== quality) && (
            <p className="status-note bulk-config-note">
              Le nuove impostazioni, inclusa la precisione, valgono dal
              prossimo avvio; “Riprova” mantiene quelle del batch visualizzato.
            </p>
          )}

        {sourceStates.length > 0 && (
          <div className="bulk-progress" role="status">
            <div className="progress" aria-hidden>
              <div
                style={{
                  width: `${
                    ((doneCount + errorCount) / sourceStates.length) * 100
                  }%`,
                }}
              />
            </div>
            <span className="muted">
              {doneCount + errorCount} di {sourceStates.length} ricerche
              completate
              {errorCount > 0 && ` · ${errorCount} errori`}
            </span>
          </div>
        )}
      </div>

      {items.slice(0, visibleCount).map((item, itemIndex) => {
        const sources = engines
          .map((engine) => item.sources[engine])
          .filter((source): source is BulkSource => source != null);
        const itemBadge = overallBadge(sources);
        return (
          <section className="panel bulk-item" key={`${item.query}-${itemIndex}`}>
            <div className="bulk-item-head">
              <h2 className="bulk-item-title">{item.query}</h2>
              <span className={`badge ${itemBadge.cls}`}>{itemBadge.label}</span>
            </div>

            {engines.map((engine) => {
              const source = item.sources[engine];
              if (!source) return null;
              const sourceBadge = STATUS_BADGE[source.status];
              return (
                <div className="bulk-source" key={engine}>
                  {engines.length > 1 && (
                    <div className="bulk-source-head">
                      <h3>{SEARCH_ENGINE_CONFIG[engine].label}</h3>
                      <span className={`badge ${sourceBadge.cls}`}>
                        {sourceBadge.label}
                      </span>
                    </div>
                  )}
                  {source.status === "error" && (
                    <p className="bulk-item-error">
                      {source.error}{" "}
                      {!running && (
                        <button
                          className="link-btn"
                          onClick={() => retrySource(itemIndex, engine)}
                        >
                          Riprova
                        </button>
                      )}
                    </p>
                  )}
                  {source.status === "done" && (
                    <SearchDiagnosticsSummary
                      diagnostics={source.diagnostics ?? undefined}
                    />
                  )}
                  {source.status === "done" && source.results.length === 0 && (
                    <div
                      className={`bulk-empty${
                        source.diagnostics &&
                        source.diagnostics.fetchedCount > 0 &&
                        source.diagnostics.discardedCount +
                          source.diagnostics.duplicatesRemoved >
                          0
                          ? " filtered"
                          : ""
                      }`}
                    >
                      {source.diagnostics &&
                      source.diagnostics.fetchedCount > 0 &&
                      source.diagnostics.discardedCount +
                        source.diagnostics.duplicatesRemoved >
                        0 ? (
                        <>
                          <strong>
                            Tutti i {source.diagnostics.fetchedCount} articoli
                            analizzati sono stati esclusi.
                          </strong>
                          <span className="muted">
                            Il profilo{" "}
                            {qualityLabel(source.diagnostics.quality)} non ha
                            trovato corrispondenze abbastanza affidabili.
                          </span>
                        </>
                      ) : (
                        <span className="muted">Nessun risultato.</span>
                      )}
                    </div>
                  )}
                  {source.results.length > 0 && (
                    <div className="bulk-strip">
                      {source.results.map((product, productIndex) => (
                        <ProductCard
                          p={product}
                          key={`${product.id}-${productIndex}`}
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

      {visibleCount < items.length && (
        <div className="bulk-more">
          <button
            className="secondary"
            onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
          >
            Mostra altri {Math.min(VISIBLE_STEP, items.length - visibleCount)}
          </button>
          <span className="muted">
            {visibleCount} di {items.length} prodotti visualizzati
          </span>
        </div>
      )}
    </>
  );
}
