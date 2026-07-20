"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { BulkSearch } from "./bulk-search";
import { InquirySearch } from "./inquiry-search";
import {
  AggregateSearchResult,
  ProductCard,
  ProductSort,
  SEARCH_ENGINE_CONFIG,
  SEARCH_ENGINES,
  SEARCH_QUALITY_OPTIONS,
  SearchEngine,
  SearchEmptyState,
  SearchDiagnosticsSummary,
  SearchQuality,
  SearchResult,
  searchAllProducts,
  searchProducts,
  SORT_OPTIONS,
} from "./search-shared";

const FRAME_SIZE = 10;

type Mode = "single" | "bulk" | "inquiry";
type EngineChoice = SearchEngine | "all";

const ENGINE_OPTIONS: { value: EngineChoice; label: string }[] = [
  { value: "all", label: "Tutti gli attivi" },
  ...SEARCH_ENGINES.map((engine) => ({
    value: engine,
    label: SEARCH_ENGINE_CONFIG[engine].shortLabel,
  })),
];

interface EngineState {
  status: "loading" | "done" | "error";
  result?: SearchResult;
  error?: string;
}

interface AggregateState {
  status: "loading" | "done" | "error";
  result?: AggregateSearchResult;
  error?: string;
}

interface Props {
  title: string;
  subtitle: ReactNode;
  placeholder: string;
  /** Se impostato, la pagina usa solo quel motore e nasconde il selettore. */
  fixedEngine?: SearchEngine;
  /**
   * Abilita l'importazione delle richieste da foglio Excel, che cerca il
   * testo cinese originale sui soli marketplace interrogati via browser.
   */
  enableInquiry?: boolean;
}

export function SearchExperience({
  title,
  subtitle,
  placeholder,
  fixedEngine,
  enableInquiry = false,
}: Props) {
  const [mode, setMode] = useState<Mode>("single");
  const [choice, setChoice] = useState<EngineChoice>(fixedEngine ?? "all");
  const [input, setInput] = useState("");
  const [sort, setSort] = useState<ProductSort>("default");
  const [quality, setQuality] = useState<SearchQuality>("strict");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [perEngine, setPerEngine] = useState<
    Partial<Record<SearchEngine, EngineState>>
  >({});
  const [aggregate, setAggregate] = useState<AggregateState | null>(null);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const requestVersions = useRef<Partial<Record<SearchEngine, number>>>({});
  const requestControllers = useRef<
    Partial<Record<SearchEngine, AbortController>>
  >({});
  const aggregateController = useRef<AbortController | null>(null);
  const aggregateVersion = useRef(0);

  useEffect(
    () => () => {
      Object.values(requestControllers.current).forEach((controller) =>
        controller?.abort()
      );
      aggregateController.current?.abort();
    },
    []
  );

  const engineList: SearchEngine[] =
    choice === "all" ? [...SEARCH_ENGINES] : [choice];
  const sortableEngines = engineList.filter(
    (engine) => SEARCH_ENGINE_CONFIG[engine].supportsSort
  );
  const paginatedEngine =
    engineList.length === 1 &&
    SEARCH_ENGINE_CONFIG[engineList[0]].supportsPagination
      ? engineList[0]
      : null;
  const singleLoading = Object.values(perEngine).some(
    (s) => s?.status === "loading"
  ) || aggregate?.status === "loading";
  const loading = singleLoading || bulkRunning;
  const showSort = sortableEngines.length > 0;
  const showPagination = paginatedEngine != null;

  async function run(
    query: string,
    framePosition: number,
    s: ProductSort,
    engines: SearchEngine[] = engineList,
    preserveOtherResults = false,
    selectedQuality: SearchQuality = quality
  ) {
    const q = query.trim();
    if (!q) return;
    const aggregateRun =
      choice === "all" &&
      !preserveOtherResults &&
      engines.length === SEARCH_ENGINES.length &&
      SEARCH_ENGINES.every((engine) => engines.includes(engine));
    if (aggregateRun) {
      Object.values(requestControllers.current).forEach((controller) =>
        controller?.abort()
      );
      aggregateController.current?.abort();
      const controller = new AbortController();
      const version = aggregateVersion.current + 1;
      aggregateVersion.current = version;
      aggregateController.current = controller;
      setActiveQuery(q);
      setPerEngine({});
      setAggregate({ status: "loading" });
      try {
        const result = await searchAllProducts(
          q,
          engines,
          FRAME_SIZE,
          s,
          selectedQuality,
          controller.signal
        );
        if (
          controller.signal.aborted ||
          aggregateVersion.current !== version
        ) {
          return;
        }
        setAggregate({ status: "done", result });
      } catch (error) {
        if (
          controller.signal.aborted ||
          aggregateVersion.current !== version
        ) {
          return;
        }
        setAggregate({
          status: "error",
          error: error instanceof Error ? error.message : "Errore imprevisto",
        });
      } finally {
        if (aggregateController.current === controller) {
          aggregateController.current = null;
        }
      }
      return;
    }

    setAggregate(null);
    const requests = engines.map((engine) => {
      requestControllers.current[engine]?.abort();
      const controller = new AbortController();
      const version = (requestVersions.current[engine] ?? 0) + 1;
      requestVersions.current[engine] = version;
      requestControllers.current[engine] = controller;
      return { engine, controller, version };
    });
    setActiveQuery(q);
    const loadingStates = Object.fromEntries(
      engines.map((e) => [e, { status: "loading" as const }])
    );
    setPerEngine((prev) =>
      preserveOtherResults ? { ...prev, ...loadingStates } : loadingStates
    );
    await Promise.allSettled(
      requests.map(async ({ engine, controller, version }) => {
        try {
          const result = await searchProducts(
            q,
            SEARCH_ENGINE_CONFIG[engine].supportsPagination
              ? framePosition
              : 0,
            FRAME_SIZE,
            s,
            engine,
            selectedQuality,
            controller.signal
          );
          if (
            controller.signal.aborted ||
            requestVersions.current[engine] !== version
          ) {
            return;
          }
          setPerEngine((prev) => ({
            ...prev,
            [engine]: { status: "done", result },
          }));
        } catch (err) {
          if (
            controller.signal.aborted ||
            requestVersions.current[engine] !== version
          ) {
            return;
          }
          setPerEngine((prev) => ({
            ...prev,
            [engine]: {
              status: "error",
              error: err instanceof Error ? err.message : "Errore imprevisto",
            },
          }));
        } finally {
          if (requestControllers.current[engine] === controller) {
            delete requestControllers.current[engine];
          }
        }
      })
    );
  }

  function changeSort(s: ProductSort) {
    if (loading) return;
    setSort(s);
    if (mode === "single" && activeQuery && sortableEngines.length > 0) {
      if (choice === "all") {
        void run(activeQuery, 0, s, [...SEARCH_ENGINES], false);
        return;
      }
      // Rilancia soltanto le fonti che supportano davvero l'ordinamento,
      // preservando i risultati degli scraper.
      void run(
        activeQuery,
        0,
        s,
        sortableEngines,
        sortableEngines.length < engineList.length
      );
    }
  }

  function changeChoice(c: EngineChoice) {
    if (loading) return;
    setChoice(c);
    // I risultati mostrati appartengono alla scelta precedente: pulizia.
    setPerEngine({});
    setAggregate(null);
    setActiveQuery(null);
  }

  function changeQuality(selectedQuality: SearchQuality) {
    if (loading || selectedQuality === quality) return;
    setQuality(selectedQuality);
    if (mode === "single" && activeQuery) {
      void run(activeQuery, 0, sort, engineList, false, selectedQuality);
    }
  }

  const paginatedResult = paginatedEngine
    ? perEngine[paginatedEngine]?.result
    : undefined;
  const page = paginatedResult
    ? Math.floor(paginatedResult.framePosition / FRAME_SIZE)
    : 0;
  const totalPages =
    paginatedResult?.totalCount != null
      ? Math.max(1, Math.ceil(paginatedResult.totalCount / FRAME_SIZE))
      : null;

  return (
    <>
      <div className="search-hero">
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>

        <div className="mode-row" role="group" aria-label="Modalità di ricerca">
          <button
            type="button"
            className="chip"
            aria-pressed={mode === "single"}
            disabled={loading}
            onClick={() => setMode("single")}
          >
            Ricerca singola
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={mode === "bulk"}
            disabled={loading}
            onClick={() => setMode("bulk")}
          >
            Lista prodotti
          </button>
          {enableInquiry && (
            <button
              type="button"
              className="chip"
              aria-pressed={mode === "inquiry"}
              disabled={loading}
              onClick={() => {
                setMode("inquiry");
                // Le vetrine internazionali rispondono a una query cinese con
                // titoli in inglese: con il profilo Massima la corrispondenza
                // delle parole non è verificabile e non resterebbe nulla.
                setQuality("broad");
              }}
            >
              Richieste da Excel
            </button>
          )}
        </div>

        {!fixedEngine && mode !== "inquiry" && (
          <div className="sort-row" role="group" aria-label="Motore di ricerca">
            <span className="sort-label">Motore</span>
            {ENGINE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className="chip"
                aria-pressed={choice === o.value}
                disabled={loading}
                onClick={() => changeChoice(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        <div
          className="quality-control"
          role="group"
          aria-label="Livello di precisione"
        >
          <div className="quality-control-row">
            <span className="sort-label">Precisione</span>
            {SEARCH_QUALITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="chip"
                aria-pressed={quality === option.value}
                disabled={loading}
                onClick={() => changeQuality(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="quality-description">
            {
              SEARCH_QUALITY_OPTIONS.find(
                (option) => option.value === quality
              )?.description
            }
          </p>
        </div>

        {mode === "single" && (
          <form
            className="search-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void run(input, 0, sort);
            }}
          >
            <input
              type="text"
              placeholder={placeholder}
              aria-label="Cerca un prodotto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={loading || input.trim().length === 0}
            >
              {loading ? "Ricerca…" : "Cerca"}
            </button>
          </form>
        )}

        {showSort && mode !== "inquiry" && (
          <div className="sort-row" role="group" aria-label="Ordina risultati">
            <span className="sort-label">Ordina per</span>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className="chip"
                aria-pressed={sort === o.value}
                disabled={loading}
                onClick={() => changeSort(o.value)}
              >
                {o.label}
              </button>
            ))}
            {sortableEngines.length < engineList.length && (
              <span className="sort-label">
                (vale per{" "}
                {sortableEngines
                  .map(
                    (engine) => SEARCH_ENGINE_CONFIG[engine].shortLabel
                  )
                  .join(", ")}
                )
              </span>
            )}
          </div>
        )}
      </div>

      <div hidden={mode !== "bulk"}>
        <BulkSearch
          key={engineList.join("|")}
          sort={sort}
          quality={quality}
          engines={engineList}
          onRunningChange={setBulkRunning}
        />
      </div>

      {enableInquiry && mode === "inquiry" && (
        <InquirySearch quality={quality} onRunningChange={setBulkRunning} />
      )}

      {mode === "single" && choice === "all" && aggregate && (
        <section>
          <div className="engine-head">
            <h2>Risultati unificati</h2>
            {aggregate.status === "loading" && (
              <span className="badge warn">Ricerca su 7 fonti…</span>
            )}
            {aggregate.status === "error" && (
              <span className="badge err">Errore</span>
            )}
            {aggregate.status === "done" && aggregate.result && (
              <span className="badge ok">
                {aggregate.result.diagnostics.succeededCount}/
                {aggregate.result.diagnostics.engineCount} fonti completate
              </span>
            )}
          </div>

          {aggregate.status === "loading" && (
            <>
              <p className="status-note" role="status">
                Le fonti lavorano in parallelo; i risultati saranno filtrati e
                deduplicati prima di essere mostrati.
              </p>
              <div className="results-grid" aria-hidden>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div className="product-card" key={i}>
                    <div className="skeleton-img" />
                    <div className="card-body">
                      <div className="skeleton-line" style={{ width: "45%" }} />
                      <div className="skeleton-line" />
                      <div className="skeleton-line" style={{ width: "70%" }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {aggregate.status === "error" && (
            <div className="error-panel">{aggregate.error}</div>
          )}

          {aggregate.status === "done" && aggregate.result && (
            <>
              <div className="aggregate-sources" aria-label="Stato fonti">
                {aggregate.result.sources.map((source) => (
                  <span
                    className={`badge ${source.status === "done" ? "ok" : "err"}`}
                    key={source.engine}
                    title={source.error?.message}
                  >
                    {SEARCH_ENGINE_CONFIG[source.engine].shortLabel}: {source.status === "done"
                      ? `${source.acceptedCount} pertinenti`
                      : "non disponibile"}
                  </span>
                ))}
              </div>
              <div className="search-diagnostics" aria-label="Diagnostica multi-motore">
                <span>
                  Qualità <strong>{SEARCH_QUALITY_OPTIONS.find((option) => option.value === aggregate.result!.quality)?.label}</strong>
                </span>
                <span>
                  Analizzati <strong>{aggregate.result.diagnostics.fetchedCount.toLocaleString("it-IT")}</strong>
                </span>
                <span>
                  Pertinenti <strong>{aggregate.result.diagnostics.acceptedBeforeMerge.toLocaleString("it-IT")}</strong>
                </span>
                <span>
                  Unici <strong>{aggregate.result.diagnostics.uniqueCount.toLocaleString("it-IT")}</strong>
                </span>
                <span>
                  Duplicati raggruppati <strong>{aggregate.result.diagnostics.duplicatesMerged.toLocaleString("it-IT")}</strong>
                </span>
                <span>
                  Tempo <strong>{(aggregate.result.durationMs / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })}s</strong>
                </span>
              </div>

              {aggregate.result.sources.some((source) => source.error) && (
                <details className="source-errors">
                  <summary>Dettagli delle fonti non disponibili</summary>
                  {aggregate.result.sources
                    .filter((source) => source.error)
                    .map((source) => (
                      <p key={source.engine}>
                        <strong>{SEARCH_ENGINE_CONFIG[source.engine].shortLabel}:</strong>{" "}
                        {source.error!.message}
                      </p>
                    ))}
                </details>
              )}

              {aggregate.result.items.length === 0 ? (
                <div className="panel search-empty filtered">
                  <p>
                    Nessun articolo supera i controlli di qualità sulle fonti
                    disponibili.
                  </p>
                  <p className="muted">
                    Sono stati analizzati {aggregate.result.diagnostics.fetchedCount.toLocaleString("it-IT")} candidati. Puoi provare il profilo Bilanciata o Esplorativa.
                  </p>
                </div>
              ) : (
                <>
                  <p className="results-meta">
                    {aggregate.result.diagnostics.uniqueCount.toLocaleString("it-IT")} risultati unici · mostrati i migliori {aggregate.result.items.length}
                  </p>
                  <div className="results-grid">
                    {aggregate.result.items.map((product, index) => (
                      <ProductCard
                        p={product}
                        key={product.canonicalKey ?? `${product.provider}-${product.id}-${index}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {mode === "single" &&
        choice !== "all" &&
        engineList.map((e) => {
          const st = perEngine[e];
          if (!st) return null;
          const caps = SEARCH_ENGINE_CONFIG[e];
          return (
            <section key={e}>
              <div className="engine-head">
                <h2>{caps.label}</h2>
                {caps.maturity === "beta" && (
                  <span className="badge warn">Beta</span>
                )}
                {st.status === "loading" && (
                  <span className="badge warn">Ricerca…</span>
                )}
                {st.status === "error" && (
                  <span className="badge err">Errore</span>
                )}
              </div>

              {st.status === "loading" && (
                <>
                  <p className="status-note" role="status">
                    {caps.loadingNote}
                  </p>
                  <div className="results-grid" aria-hidden>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div className="product-card" key={i}>
                        <div className="skeleton-img" />
                        <div className="card-body">
                          <div
                            className="skeleton-line"
                            style={{ width: "45%" }}
                          />
                          <div className="skeleton-line" />
                          <div
                            className="skeleton-line"
                            style={{ width: "70%" }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {st.status === "error" && (
                <div className="error-panel">{st.error}</div>
              )}

              {st.status === "done" && st.result && (
                <>
                  <SearchDiagnosticsSummary
                    diagnostics={st.result.diagnostics}
                  />
                  {st.result.items.length === 0 ? (
                    <SearchEmptyState result={st.result} />
                  ) : (
                    <>
                      <p className="results-meta">
                        {st.result.totalCount != null &&
                          `${st.result.totalCount.toLocaleString(
                            "it-IT"
                          )} risultati — `}
                        {e === paginatedEngine && showPagination ? (
                          <>
                            pagina {page + 1}
                            {totalPages != null &&
                              ` di ${totalPages.toLocaleString("it-IT")}`}
                          </>
                        ) : (
                          `primi ${st.result.items.length}`
                        )}
                        {caps.supportsSort && (
                          <>
                            {" · "}
                            {
                              SORT_OPTIONS.find(
                                (o) => o.value === st.result!.sort
                              )?.label
                            }
                          </>
                        )}
                      </p>
                      <div className="results-grid">
                        {st.result.items.map((p, i) => (
                          <ProductCard p={p} key={`${p.id}-${i}`} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          );
        })}

      {mode === "single" &&
        showPagination &&
        paginatedResult &&
        !loading &&
        paginatedResult.items.length > 0 && (
          <div className="pagination">
            <button
              disabled={page === 0}
              onClick={() =>
                void run(
                  paginatedResult.query,
                  (page - 1) * FRAME_SIZE,
                  sort
                )
              }
            >
              ← Precedente
            </button>
            <span className="muted">pagina {page + 1}</span>
            <button
              disabled={
                paginatedResult.hasMore != null
                  ? !paginatedResult.hasMore
                  : totalPages != null
                  ? page + 1 >= totalPages
                  : paginatedResult.items.length < FRAME_SIZE
              }
              onClick={() =>
                void run(
                  paginatedResult.query,
                  (page + 1) * FRAME_SIZE,
                  sort
                )
              }
            >
              Successiva →
            </button>
          </div>
        )}
    </>
  );
}
