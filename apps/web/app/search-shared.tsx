"use client";

import { api, withApiQuery } from "@/lib/api";

export type ProductSort =
  | "default"
  | "best-match"
  | "orders-desc"
  | "price-asc"
  | "price-desc";

export type SearchQuality = "strict" | "balanced" | "broad";

export const SEARCH_QUALITY_OPTIONS: {
  value: SearchQuality;
  label: string;
  description: string;
}[] = [
  {
    value: "strict",
    label: "Massima",
    description: "Solo corrispondenze solide su prodotto e specifiche.",
  },
  {
    value: "balanced",
    label: "Bilanciata",
    description: "Più scelta, mantenendo i risultati probabilmente pertinenti.",
  },
  {
    value: "broad",
    label: "Esplorativa",
    description: "Copertura ampia per la revisione manuale.",
  },
];

export function qualityLabel(quality: SearchQuality): string {
  return (
    SEARCH_QUALITY_OPTIONS.find((option) => option.value === quality)?.label ??
    quality
  );
}

export type SearchEngine =
  | "taobao"
  | "tmall"
  | "alibaba"
  | "aliexpress"
  | "made-in-china"
  | "chinagoods"
  | "yiwugo";

interface SearchEngineConfig {
  label: string;
  shortLabel: string;
  supportsSort: boolean;
  supportsPagination: boolean;
  bulkConcurrency: number;
  transport: "api" | "browser";
  maturity: "stable" | "beta";
  loadingNote: string;
  externalLinkLabel: string;
}

/** Configurazione unica usata da ricerca singola, bulk, card e CSV. */
export const SEARCH_ENGINE_CONFIG = {
  taobao: {
    label: "Catalogo OTAPI — Taobao",
    shortLabel: "Catalogo OTAPI (Taobao)",
    supportsSort: true,
    supportsPagination: true,
    bulkConcurrency: 3,
    transport: "api",
    maturity: "stable",
    loadingNote: "Interrogazione OTAPI… può richiedere anche 20-30 secondi.",
    externalLinkLabel: "Apri su Taobao",
  },
  tmall: {
    label: "Catalogo OTAPI — Tmall (archivio)",
    shortLabel: "Tmall · archivio OTAPI",
    supportsSort: true,
    supportsPagination: true,
    bulkConcurrency: 2,
    transport: "api",
    maturity: "beta",
    loadingNote:
      "Interrogazione del catalogo storico Tmall in OTAPI… può richiedere 20-30 secondi.",
    externalLinkLabel: "Apri su Tmall",
  },
  alibaba: {
    label: "Alibaba — Beta browser",
    shortLabel: "Alibaba · Beta",
    supportsSort: false,
    supportsPagination: false,
    bulkConcurrency: 1,
    transport: "browser",
    maturity: "beta",
    loadingNote: "Ricerca su Alibaba via browser… può richiedere 10-30 secondi.",
    externalLinkLabel: "Apri su Alibaba",
  },
  aliexpress: {
    label: "AliExpress — Beta browser",
    shortLabel: "AliExpress · Beta",
    supportsSort: false,
    supportsPagination: false,
    bulkConcurrency: 1,
    transport: "browser",
    maturity: "beta",
    loadingNote:
      "Ricerca su AliExpress via browser… può richiedere 10-30 secondi.",
    externalLinkLabel: "Apri su AliExpress",
  },
  "made-in-china": {
    label: "Made-in-China — Beta browser",
    shortLabel: "Made-in-China · Beta",
    supportsSort: false,
    supportsPagination: false,
    bulkConcurrency: 1,
    transport: "browser",
    maturity: "beta",
    loadingNote:
      "Ricerca su Made-in-China via browser… può richiedere 10-30 secondi.",
    externalLinkLabel: "Apri su Made-in-China",
  },
  chinagoods: {
    label: "Chinagoods / Yiwu — Beta browser",
    shortLabel: "Chinagoods · Beta",
    supportsSort: false,
    supportsPagination: false,
    bulkConcurrency: 1,
    transport: "browser",
    maturity: "beta",
    loadingNote:
      "Ricerca nel catalogo Yiwu di Chinagoods… può richiedere 10-30 secondi.",
    externalLinkLabel: "Apri su Chinagoods",
  },
  yiwugo: {
    label: "Yiwugo / Yiwu — Beta browser",
    shortLabel: "Yiwugo · Beta",
    supportsSort: false,
    supportsPagination: false,
    bulkConcurrency: 1,
    transport: "browser",
    maturity: "beta",
    loadingNote:
      "Ricerca nel catalogo internazionale Yiwugo… può richiedere 10-30 secondi.",
    externalLinkLabel: "Apri su Yiwugo",
  },
} as const satisfies Record<SearchEngine, SearchEngineConfig>;

export const SEARCH_ENGINES = Object.keys(
  SEARCH_ENGINE_CONFIG
) as SearchEngine[];

export function isSearchEngine(value: string): value is SearchEngine {
  return Object.prototype.hasOwnProperty.call(SEARCH_ENGINE_CONFIG, value);
}

export const SORT_OPTIONS: { value: ProductSort; label: string }[] = [
  { value: "default", label: "Rilevanza" },
  { value: "best-match", label: "Parole + prezzo + vendite" },
  { value: "orders-desc", label: "Più ordini" },
  { value: "price-asc", label: "Prezzo più basso" },
  { value: "price-desc", label: "Prezzo più alto" },
];

export interface SearchProduct {
  id: string;
  provider: string;
  title: string;
  originalTitle: string | null;
  imageUrl: string | null;
  originalPrice: number | null;
  currency: string;
  vendorName: string | null;
  totalSales: number | null;
  rating?: number | null;
  reviewCount?: number | null;
  moq: number | null;
  productUrl: string | null;
  warnings: string[];
  sourceFeatures?: string[];
  sourceSnippet?: string | null;
  relevanceScore?: number | null;
  sourceConfidenceScore?: number | null;
  matchReasons?: string[];
  matchWarnings?: string[];
  canonicalKey?: string;
  offers?: SearchOffer[];
}

export interface SearchOffer {
  provider: string;
  id: string;
  url: string | null;
  price: number | null;
  currency: string;
  vendor: string | null;
  score: number;
}

export interface SearchDiagnostics {
  quality: SearchQuality;
  queryUsed: string;
  sourceTotalCount: number | null;
  fetchedCount: number;
  qualifiedCount: number;
  discardedCount: number;
  duplicatesRemoved: number;
  truncatedCount: number;
  threshold: number;
  processingMs: number;
}

export interface SearchResult {
  provider: string;
  query: string;
  framePosition: number;
  frameSize: number;
  sort: ProductSort;
  totalCount: number | null;
  hasMore?: boolean;
  items: SearchProduct[];
  diagnostics?: SearchDiagnostics;
}

export interface AggregateSourceStatus {
  engine: SearchEngine;
  status: "done" | "error";
  durationMs: number;
  acceptedCount: number;
  diagnostics: SearchDiagnostics | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
}

export interface AggregateSearchResult {
  searchId: string;
  query: string;
  quality: SearchQuality;
  createdAt: string;
  durationMs: number;
  sources: AggregateSourceStatus[];
  items: SearchProduct[];
  diagnostics: {
    engineCount: number;
    succeededCount: number;
    failedCount: number;
    fetchedCount: number;
    acceptedBeforeMerge: number;
    uniqueCount: number;
    duplicatesMerged: number;
  };
}

export function searchProducts(
  q: string,
  framePosition: number,
  frameSize: number,
  sort: ProductSort,
  engine: SearchEngine = "taobao",
  quality: SearchQuality = "strict",
  signal?: AbortSignal
): Promise<SearchResult> {
  return api<SearchResult>(
    withApiQuery("/search", {
      q,
      framePosition,
      frameSize,
      sort,
      engine,
      quality,
    }),
    { signal }
  );
}

export function searchAllProducts(
  q: string,
  engines: SearchEngine[],
  frameSize: number,
  sort: ProductSort,
  quality: SearchQuality,
  signal?: AbortSignal
): Promise<AggregateSearchResult> {
  return api<AggregateSearchResult>("/v1/searches", {
    method: "POST",
    signal,
    body: JSON.stringify({ q, engines, frameSize, sort, quality }),
  });
}

export function SearchDiagnosticsSummary({
  diagnostics,
}: {
  diagnostics?: SearchDiagnostics;
}) {
  if (!diagnostics) return null;

  return (
    <div className="search-diagnostics" aria-label="Diagnostica qualità">
      <span>
        Qualità <strong>{qualityLabel(diagnostics.quality)}</strong>
      </span>
      <span>
        Analizzati <strong>{diagnostics.fetchedCount.toLocaleString("it-IT")}</strong>
      </span>
      <span>
        Pertinenti <strong>{diagnostics.qualifiedCount.toLocaleString("it-IT")}</strong>
      </span>
      <span>
        Scartati <strong>{diagnostics.discardedCount.toLocaleString("it-IT")}</strong>
      </span>
      <span>
        Deduplicati{" "}
        <strong>{diagnostics.duplicatesRemoved.toLocaleString("it-IT")}</strong>
      </span>
      <span title="Punteggio minimo di pertinenza richiesto">
        Soglia <strong>{diagnostics.threshold}/100</strong>
      </span>
      {diagnostics.truncatedCount > 0 && (
        <span title="Risultati pertinenti oltre il numero massimo mostrato">
          Oltre il top <strong>{diagnostics.truncatedCount.toLocaleString("it-IT")}</strong>
        </span>
      )}
    </div>
  );
}

export function SearchEmptyState({ result }: { result: SearchResult }) {
  const diagnostics = result.diagnostics;
  const allFiltered =
    result.items.length === 0 &&
    diagnostics != null &&
    diagnostics.fetchedCount > 0 &&
    diagnostics.discardedCount + diagnostics.duplicatesRemoved > 0;

  return (
    <div className={`panel search-empty${allFiltered ? " filtered" : ""}`}>
      <p>
        {allFiltered
          ? `Nessuno dei ${diagnostics.fetchedCount.toLocaleString(
              "it-IT"
            )} articoli analizzati supera i controlli di qualità.`
          : `Nessun risultato per “${result.query}”.`}
      </p>
      {allFiltered && diagnostics && (
        <p className="muted">
          Il profilo {qualityLabel(diagnostics.quality)} ha escluso risultati
          poco pertinenti, duplicati o con specifiche incompatibili. Puoi
          provare il profilo Bilanciata o Esplorativa.
        </p>
      )}
    </div>
  );
}

function relevanceBadgeClass(score: number): string {
  if (score >= 75) return "ok";
  // Una query cinese su una vetrina con titoli in inglese si ferma qui: è un
  // risultato da controllare a mano, non un errore di pertinenza.
  if (score >= 50) return "warn";
  return "err";
}

export function ProductCard({ p }: { p: SearchProduct }) {
  const externalLinkLabel = isSearchEngine(p.provider)
    ? SEARCH_ENGINE_CONFIG[p.provider].externalLinkLabel
    : "Apri prodotto";

  return (
    <article className="product-card">
      {p.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.imageUrl}
          alt={p.title}
          loading="lazy"
          // Yiwugo e altri CDN cinesi rifiutano le immagini quando arriva un
          // referer esterno: senza referer servono lo stesso file.
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="no-image muted">nessuna immagine</div>
      )}
      <div className="card-body">
        {p.relevanceScore != null && (
          <div className="card-relevance-head">
            <span
              className={`badge ${relevanceBadgeClass(p.relevanceScore)}`}
              title="Punteggio deterministico di pertinenza"
            >
              Pertinenza {Math.round(p.relevanceScore)}/100
            </span>
            {p.sourceConfidenceScore != null &&
              p.sourceConfidenceScore < 100 && (
                <span
                  className={`badge ${relevanceBadgeClass(p.sourceConfidenceScore)}`}
                  title="Affidabilità dei dati dichiarati dalla fonte"
                >
                  Fonte {Math.round(p.sourceConfidenceScore)}/100
                </span>
              )}
          </div>
        )}
        <div className="price">
          {p.originalPrice != null ? (
            <>
              {p.originalPrice.toLocaleString("it-IT", {
                minimumFractionDigits: 2,
              })}
              <span className="cur">{p.currency}</span>
            </>
          ) : (
            <span className="muted">prezzo n.d.</span>
          )}
        </div>
        <div className="card-title" title={p.title}>
          {p.title || "(senza titolo)"}
        </div>
        {p.originalTitle && (
          <div className="muted card-original-title" title={p.originalTitle}>
            {p.originalTitle}
          </div>
        )}
        <div className="muted card-meta">
          {[
            // Per lo scraper l'id è l'URL del prodotto: inutile mostrarlo
            p.id.startsWith("http") ? null : `ID ${p.id}`,
            p.vendorName,
            p.totalSales != null
              ? `${p.totalSales.toLocaleString("it-IT")} ordini`
              : null,
            p.moq != null ? `MOQ ${p.moq.toLocaleString("it-IT")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {(p.matchReasons?.length ?? 0) > 0 && (
          <div className="card-match-reasons" aria-label="Motivi di pertinenza">
            {p.matchReasons!.slice(0, 2).map((reason) => (
              <span key={reason}>✓ {reason}</span>
            ))}
            {p.matchReasons!.length > 2 && (
              <details>
                <summary>
                  Altri {p.matchReasons!.length - 2} motivi
                </summary>
                {p.matchReasons!.slice(2).map((reason) => (
                  <span key={reason}>✓ {reason}</span>
                ))}
              </details>
            )}
          </div>
        )}
        {(p.matchWarnings?.length ?? 0) > 0 && (
          <div className="card-match-warnings" aria-label="Avvisi di pertinenza">
            {p.matchWarnings!.map((warning) => (
              <span key={warning}>Attenzione: {warning}</span>
            ))}
          </div>
        )}
        {(p.offers?.length ?? 0) > 1 && (
          <div className="card-offers">
            <strong>{p.offers!.length} offerte raggruppate</strong>
            {p.offers!.map((offer) => (
              <a
                key={`${offer.provider}-${offer.id}-${offer.url ?? ""}`}
                href={offer.url ?? undefined}
                target={offer.url ? "_blank" : undefined}
                rel={offer.url ? "noreferrer noopener" : undefined}
                aria-disabled={!offer.url}
              >
                <span>
                  {isSearchEngine(offer.provider)
                    ? SEARCH_ENGINE_CONFIG[offer.provider].shortLabel
                    : offer.provider}
                </span>
                <span>
                  {offer.price != null
                    ? `${offer.price.toLocaleString("it-IT")} ${offer.currency}`
                    : "prezzo n.d."}
                </span>
              </a>
            ))}
          </div>
        )}
        {p.productUrl && (
          <a
            className="card-link"
            href={p.productUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {externalLinkLabel} ↗
          </a>
        )}
      </div>
    </article>
  );
}
