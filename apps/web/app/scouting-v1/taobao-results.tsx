"use client";

import {
  TAOBAO_PLATFORM_LABELS,
  TAOBAO_RERUN_SCOPES,
  TAOBAO_RERUN_SCOPE_LABELS,
  TAOBAO_ROW_STATUS_LABELS,
  TAOBAO_SOURCE_LABELS,
  type TaobaoRerunScope,
  type TaobaoCandidate,
  type TaobaoJobResults,
  type TaobaoProductHistory,
  type TaobaoProductRecord,
  type TaobaoProductRefreshResult,
  type TaobaoRefineResult,
  type TaobaoRowResults,
  type TaobaoVerifyResult,
} from "@china/shared";
import { useCallback, useState } from "react";
import { api, apiDownloadUrl } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { formatDateTime, formatPrice } from "../i18n/format";

/**
 * I risultati: tutti i prodotti trovati, senza un vincitore designato.
 *
 * Nessuna riga viene «risolta» dal sistema. Per ogni richiesta si vedono tutti
 * i candidati nell'ordine deciso dalla compatibilità tecnica, ciascuno con i
 * requisiti che soddisfa, quelli che gli mancano e da dove arriva il dato. La
 * scelta è di chi compra: qui c'è ciò che serve per farla, non la scelta già
 * fatta.
 */

const ROW_TONE: Record<string, string> = {
  DONE: "ok",
  FAILED: "err",
  SKIPPED: "warn",
  PENDING: "",
  REFRESHING: "warn",
  SEARCHING_API: "warn",
  SEARCHING_BROWSER: "warn",
};

/** Ore passate dall'ultimo controllo alla fonte. */
function hoursSince(value: string): number {
  return (Date.now() - new Date(value).getTime()) / 3_600_000;
}

/**
 * Oltre questa età il prezzo va considerato «di ieri»: su Taobao i prezzi
 * cambiano anche più volte al giorno, e la carta lo deve dire prima che sia il
 * click sul link a dirlo.
 */
const PRICE_STALE_HOURS = 24;

interface ResultsProps {
  clientId: string;
  results: TaobaoJobResults;
  onRefresh: () => void;
  onRerun: (scope: TaobaoRerunScope) => void;
  /** La verifica può aprire domande nuove: il genitore le ricarica. */
  onQuestionsOpened?: () => void;
  busy: boolean;
}

export function TaobaoResults({
  clientId,
  results,
  onRefresh,
  onRerun,
  onQuestionsOpened,
  busy,
}: ResultsProps) {
  const { t, locale } = useI18n();
  const { job, rows } = results;
  const running = job.status === "RUNNING" || job.status === "QUEUED";

  // Quante righe rientrerebbero in ogni ambito: rilanciare alla cieca su un
  // ambito vuoto è il modo più rapido di sprecare una schermata.
  const failedRows = rows.filter((row) => row.status === "FAILED").length;
  const emptyRows = rows.filter((row) => row.candidates.length === 0).length;
  const rerunCount: Record<TaobaoRerunScope, number> = {
    all: rows.length,
    failed: failedRows,
    empty: emptyRows,
  };
  const [rerunScope, setRerunScope] = useState<TaobaoRerunScope>(
    failedRows > 0 ? "failed" : emptyRows > 0 ? "empty" : "all"
  );
  /** Ricarico % applicato al report per il cliente, scelto al download. */
  const [markupPct, setMarkupPct] = useState(15);

  const [verifying, setVerifying] = useState(false);
  const [verifySummary, setVerifySummary] = useState<TaobaoVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [refining, setRefining] = useState(false);
  const [refineSummary, setRefineSummary] = useState<TaobaoRefineResult | null>(null);
  const [refineError, setRefineError] = useState<string | null>(null);

  /**
   * Ri-ricerca guidata: per le righe senza un prodotto coerente, l'IA riscrive
   * la query dai motivi del fallimento e si cerca di nuovo. Va dopo la verifica.
   */
  const runRefine = useCallback(async () => {
    setRefining(true);
    setRefineError(null);
    try {
      const summary = await api<TaobaoRefineResult>(
        `/taobao/clients/${clientId}/jobs/${job.jobId}/refine`,
        { method: "POST", body: JSON.stringify({ topN: 3 }) }
      );
      setRefineSummary(summary);
      onRefresh();
      if (summary.rowsRecovered > 0) onQuestionsOpened?.();
    } catch (cause) {
      setRefineError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefining(false);
    }
  }, [clientId, job.jobId, onQuestionsOpened, onRefresh]);

  /**
   * Seconda passata IA sui primi 3 candidati di ogni riga. I verdetti restano
   * salvati: rilanciarla non ripaga i candidati già giudicati.
   */
  const runVerify = useCallback(async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const summary = await api<TaobaoVerifyResult>(
        `/taobao/clients/${clientId}/jobs/${job.jobId}/verify`,
        { method: "POST", body: JSON.stringify({ topN: 3 }) }
      );
      setVerifySummary(summary);
      onRefresh();
      if (summary.questionsOpened > 0) onQuestionsOpened?.();
    } catch (cause) {
      setVerifyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVerifying(false);
    }
  }, [clientId, job.jobId, onQuestionsOpened, onRefresh]);

  return (
    <section className="panel scouting-step">
      <h2>{t("results.step")}</h2>

      <div className="scouting-row">
        <span className={`badge ${running ? "warn" : job.failedRows > 0 ? "warn" : "ok"}`}>
          {job.status}
        </span>
        <strong>
          {t("results.progress", { processed: job.processedRows, total: job.totalRows })}
        </strong>
        <span className="muted">
          {t("results.breakdown", {
            reused: job.reusedRows,
            searched: job.searchedRows,
            failed: job.failedRows,
          })}
        </span>
      </div>

      <div className="scouting-engine-chips">
        {/* Ogni fonte compare solo se ha davvero fatto chiamate. */}
        {job.usage.hwhCalls > 0 ? (
          <span className="chip" title={t("results.hwhTitle")}>
            {t("results.hwhCalls", { count: job.usage.hwhCalls })}
          </span>
        ) : null}
        {job.usage.apiCalls > 0 ? (
          <span className="chip" title={t("results.apiTitle")}>
            {t("results.apiCalls", { count: job.usage.apiCalls })}
          </span>
        ) : null}
        <span className="chip">
          {t("results.cacheHits", { count: job.usage.apiCacheHits })}
        </span>
        <span className="chip">
          {t("results.reusedProducts", { count: job.usage.reusedProducts })}
        </span>
        <span className="chip">
          {t("results.newProducts", { count: job.usage.newProducts })}
        </span>
        {job.usage.browserCalls > 0 ? (
          <span className="chip">
            {t("results.browserCalls", { count: job.usage.browserCalls })}
          </span>
        ) : null}
      </div>

      <div className="scouting-bar">
        <div
          className="scouting-bar-fill"
          style={{
            width: `${job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0}%`,
          }}
        />
      </div>

      <div className="scouting-row scouting-controls">
        <button type="button" onClick={onRefresh} disabled={busy}>
          {t("results.refresh")}
        </button>
        <a
          className="link-btn scouting-download"
          href={apiDownloadUrl(`/taobao/clients/${clientId}/jobs/${job.jobId}/export`)}
        >
          {t("results.export")}
        </a>
      </div>

      {!running ? (
        <div className="scouting-row scouting-controls">
          <button
            type="button"
            disabled={busy || verifying}
            onClick={() => void runVerify()}
            title={t("results.verifyTitle")}
          >
            {verifying ? t("results.verifying") : t("results.verify")}
          </button>
          {verifySummary ? (
            <span className="muted">
              {t("results.verifySummary", {
                checked: verifySummary.checkedCandidates,
                coherent: verifySummary.coherent,
                incoherent: verifySummary.incoherent,
                unsure: verifySummary.unsure,
              })}
              {verifySummary.questionsOpened > 0
                ? t("results.verifyQuestions", { count: verifySummary.questionsOpened })
                : ""}
              {verifySummary.skippedCandidates > 0
                ? t("results.verifySkipped", { count: verifySummary.skippedCandidates })
                : ""}{" "}
              · ≈ ${verifySummary.estimatedCostUsd.toFixed(4)}
            </span>
          ) : null}
        </div>
      ) : null}
      {verifyError ? <div className="scouting-engine-error">{verifyError}</div> : null}

      {!running && verifySummary ? (
        <div className="scouting-row scouting-controls">
          <button
            type="button"
            disabled={busy || refining}
            onClick={() => void runRefine()}
            title={t("results.refineTitle")}
          >
            {refining ? t("results.refining") : t("results.refine")}
          </button>
          {refineSummary ? (
            <span className="muted">
              {refineSummary.note
                ? refineSummary.note
                : t("results.refineSummary", {
                    refined: refineSummary.rowsRefined,
                    problematic: refineSummary.rowsProblematic,
                    recovered: refineSummary.rowsRecovered,
                    products: refineSummary.newProducts,
                    calls: refineSummary.apiCalls,
                    cost: refineSummary.estimatedCostUsd.toFixed(4),
                  })}
            </span>
          ) : null}
        </div>
      ) : null}
      {refineError ? <div className="scouting-engine-error">{refineError}</div> : null}

      <div className="scouting-row scouting-controls">
        <label title={t("results.markupTitle")}>
          {t("results.markup")}
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            value={markupPct}
            disabled={busy}
            onChange={(event) => setMarkupPct(Number(event.target.value))}
          />
          %
        </label>
        <a
          className="link-btn scouting-download"
          href={apiDownloadUrl(`/taobao/clients/${clientId}/jobs/${job.jobId}/report`, {
            markupPct,
          })}
        >
          {t("results.report", { markup: markupPct })}
        </a>
      </div>

      {!running ? (
        <div className="scouting-row scouting-bulk">
          <label>
            {t("results.rerunScope")}
            <select
              value={rerunScope}
              disabled={busy}
              onChange={(event) => setRerunScope(event.target.value as TaobaoRerunScope)}
            >
              {TAOBAO_RERUN_SCOPES.map((scope) => (
                <option key={scope} value={scope} disabled={rerunCount[scope] === 0}>
                  {TAOBAO_RERUN_SCOPE_LABELS[locale][scope]} ({rerunCount[scope]})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || rerunCount[rerunScope] === 0}
            onClick={() => onRerun(rerunScope)}
            title={t("results.rerunTitle")}
          >
            {t("results.rerun", { count: rerunCount[rerunScope] })}
          </button>
          <span className="muted">{t("results.rerunHint")}</span>
        </div>
      ) : null}

      {rows.map((row) => (
        <RowResults key={row.jobRowId} row={row} clientId={clientId} />
      ))}
    </section>
  );
}

function RowResults({ row, clientId }: { row: TaobaoRowResults; clientId: string }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const visible = open ? row.candidates : row.candidates.slice(0, 3);

  return (
    <div className="scouting-result-row">
      <div className="scouting-row scouting-engine-head">
        <span className="muted">{t("results.row", { number: row.rowNumber })}</span>
        <strong>{row.displayName}</strong>
        <span className={`badge ${ROW_TONE[row.status] ?? ""}`}>
          {TAOBAO_ROW_STATUS_LABELS[locale][row.status] ?? row.status}
        </span>
        {row.reused ? <span className="chip ok">{t("results.reused")}</span> : null}
        <span className="scouting-hint">
          {t("results.query", { query: row.searchQuery || t("common.none") })}
        </span>
      </div>

      {row.reuseReason ? <div className="scouting-hint">{row.reuseReason}</div> : null}
      {row.error ? <div className="scouting-engine-error">{row.error}</div> : null}

      <div className="scouting-engine-chips">
        {/* Ogni fonte compare solo se ha davvero cercato per questa riga. */}
        {row.hwhStatus && row.hwhStatus !== "REUSED" ? (
          <span
            className={`chip ${row.hwhStatus === "ERROR" ? "err" : ""}`}
            title={t("results.hwhTitle")}
          >
            {t("results.engineStatus", {
              engine: "Taobao API",
              status: row.hwhStatus,
              count: row.hwhCount,
            })}
          </span>
        ) : null}
        {row.apiStatus && row.apiStatus !== "REUSED" ? (
          <span
            className={`chip ${row.apiStatus === "ERROR" ? "err" : ""}`}
            title={t("results.apiTitle")}
          >
            {t("results.engineStatus", {
              engine: "DataHub",
              status: row.apiStatus,
              count: row.apiCount,
            })}
          </span>
        ) : null}
        {row.browserStatus && !["REUSED", "DISABLED"].includes(row.browserStatus) ? (
          <span
            className={`chip ${row.browserStatus === "VERIFICATION_REQUIRED" ? "warn" : ""}`}
          >
            {t("results.engineStatus", {
              engine: "Playwright",
              status: row.browserStatus,
              count: row.browserCount,
            })}
          </span>
        ) : null}
      </div>
      {row.hwhError ? <div className="scouting-warning">{row.hwhError}</div> : null}
      {row.apiError ? <div className="scouting-engine-error">{row.apiError}</div> : null}

      {row.candidates.length === 0 ? (
        <p className="muted">{t("results.empty")}</p>
      ) : (
        <>
          <div className="results-grid">
            {visible.map((candidate) => (
              <CandidateCard
                key={candidate.product.productId}
                candidate={candidate}
                clientId={clientId}
              />
            ))}
          </div>
          {row.candidates.length > 3 ? (
            <button type="button" className="chip" onClick={() => setOpen(!open)}>
              {open
                ? t("results.showTop")
                : t("results.showAll", { count: row.candidates.length })}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  clientId,
}: {
  candidate: TaobaoCandidate;
  clientId: string;
}) {
  const { t, locale, intlLocale } = useI18n();
  const dash = t("common.none");

  /**
   * La verifica immediata sostituisce i dati della carta senza ricaricare la
   * pagina: `fresh` è il prodotto riletto adesso, e vince su quello del job.
   */
  const [fresh, setFresh] = useState<TaobaoProductRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const product = fresh ?? candidate.product;

  const [history, setHistory] = useState<TaobaoProductHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const verifyNow = useCallback(async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const result = await api<TaobaoProductRefreshResult>(
        `/taobao/clients/${clientId}/products/${product.productId}/refresh`,
        { method: "POST" }
      );
      setFresh(result.product);
      if (result.product.unavailable) {
        setRefreshNote(t("card.unavailableNow"));
      } else if (
        result.priceBefore != null &&
        result.product.price != null &&
        result.priceBefore !== result.product.price
      ) {
        setRefreshNote(
          t("card.priceChanged", {
            before: formatPrice(result.priceBefore, result.product.currency, intlLocale, dash),
            after: formatPrice(
              result.product.price,
              result.product.currency,
              intlLocale,
              dash
            ),
          })
        );
      } else {
        setRefreshNote(t("card.priceConfirmed"));
      }
    } catch (cause) {
      setRefreshNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [clientId, dash, intlLocale, product.productId, t]);

  const staleHours = hoursSince(product.lastCheckedAt);
  const usedBefore = product.sources.includes("excel");
  const coherence = candidate.coherence;

  /**
   * Lo storico si chiede solo quando serve.
   *
   * Caricarlo per ogni scheda significherebbe decine di richieste per una
   * pagina di risultati, quasi tutte per prodotti che nessuno aprirà.
   */
  const toggleHistory = useCallback(async () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history) return;
    try {
      setHistory(
        await api<TaobaoProductHistory>(
          `/taobao/clients/${clientId}/products/${product.productId}/history`
        )
      );
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId, history, historyOpen, product.productId]);

  return (
    <article className="product-card">
      {product.imageUrl ? (
        // Il CDN di 1688 (`cbu01.alicdn.com`) rifiuta con 403 le richieste che
        // portano un `Referer` di un altro sito: senza questa riga le immagini
        // delle offerte 1688 restano rotte, mentre quelle Taobao caricano.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="skeleton-img" />
      )}

      <div className="card-body">
        <div className="card-relevance-head">
          <span className="badge">#{candidate.rank}</span>
          {usedBefore ? (
            <span className="badge ok" title={t("card.usedBeforeTitle")}>
              {t("card.usedBefore")}
            </span>
          ) : null}
          <span className="chip" title={t("card.platformTitle")}>
            {TAOBAO_PLATFORM_LABELS[locale][product.platform] ?? product.platform}
          </span>
          {candidate.scoreBreakdown ? (
            <span
              className={`badge ${candidate.scoreBreakdown.compatibility >= 0.7 ? "ok" : "warn"}`}
              title={t("card.compatibilityTitle")}
            >
              {t("card.compatibility", {
                percent: Math.round(candidate.scoreBreakdown.compatibility * 100),
              })}
            </span>
          ) : null}
          {product.sources.map((source) => (
            <span key={source} className="chip">
              {TAOBAO_SOURCE_LABELS[locale][source] ?? source}
            </span>
          ))}
          {coherence ? (
            <span
              className={`badge ${
                coherence.verdict === "coherent"
                  ? "ok"
                  : coherence.verdict === "incoherent"
                    ? "err"
                    : "warn"
              }`}
              title={t("card.coherenceTitle", {
                percent: Math.round(coherence.confidence * 100),
              })}
            >
              {coherence.verdict === "coherent"
                ? t("card.coherent")
                : coherence.verdict === "incoherent"
                  ? t("card.incoherent")
                  : t("card.unsure")}
            </span>
          ) : null}
        </div>
        {coherence && coherence.issues.length > 0 ? (
          <div className="card-match-warnings">
            {t("card.coherenceIssues", { issues: coherence.issues.join(" · ") })}
          </div>
        ) : null}

        <a
          className="card-title"
          href={product.url ?? "#"}
          target="_blank"
          rel="noreferrer"
        >
          {product.title}
        </a>

        {product.titleEn ? (
          <div className="card-original-title">{product.titleEn}</div>
        ) : null}

        <div className="card-meta">
          <strong>{formatPrice(product.price, product.currency, intlLocale, dash)}</strong>
          {product.promotionPrice != null ? (
            <span className="badge ok" title={t("card.promoTitle")}>
              {t("card.promo")}
            </span>
          ) : null}
          {product.moq != null ? (
            <span className="muted">{t("card.moq", { count: product.moq })}</span>
          ) : null}
          {product.variantPrice != null ? (
            <span className="muted">
              {t("card.variantPrice", {
                price: formatPrice(product.variantPrice, product.currency, intlLocale, dash),
              })}
            </span>
          ) : null}
          {product.totalSales != null ? (
            <span className="muted">{t("card.sales", { count: product.totalSales })}</span>
          ) : null}
          {product.reviewCount != null ? (
            <span className="muted">{t("card.reviews", { count: product.reviewCount })}</span>
          ) : null}
          {product.rating != null ? (
            <span className="muted">{t("card.rating", { rating: product.rating })}</span>
          ) : null}
        </div>

        <div className="card-meta">
          {product.shopName ? (
            <a
              className="card-link"
              href={product.shopUrl ?? product.url ?? "#"}
              target="_blank"
              rel="noreferrer"
            >
              {product.shopName}
            </a>
          ) : (
            <span className="muted">{t("card.noShop")}</span>
          )}
          <span
            className={staleHours > PRICE_STALE_HOURS ? "chip warn" : "muted"}
            title={staleHours > PRICE_STALE_HOURS ? t("card.staleTitle") : undefined}
          >
            {t("card.checkedAt", {
              date: formatDateTime(product.lastCheckedAt, intlLocale),
            })}
          </span>
          {product.shipping ? <span className="muted">{product.shipping}</span> : null}
        </div>

        {candidate.matchedRequirements.length > 0 ? (
          <div className="card-match-reasons">
            {t("card.matched", { list: candidate.matchedRequirements.join(" · ") })}
          </div>
        ) : null}
        {candidate.missingRequirements.length > 0 ? (
          <div className="card-match-warnings">
            {t("card.missing", { list: candidate.missingRequirements.join(" · ") })}
          </div>
        ) : null}
        {[...candidate.warnings, ...candidate.sourceConflicts].length > 0 ? (
          <div className="card-warnings">
            {[...candidate.warnings, ...candidate.sourceConflicts].join(" | ")}
          </div>
        ) : null}
        {product.changedFields.length > 0 ? (
          <div className="scouting-changed">
            {t("card.changed", { list: product.changedFields.join(", ") })}
          </div>
        ) : null}

        <div className="scouting-row">
          <button
            type="button"
            className="chip"
            disabled={refreshing}
            onClick={() => void verifyNow()}
            title={t("card.checkNowTitle")}
          >
            {refreshing ? t("card.checking") : t("card.checkNow")}
          </button>
          <button type="button" className="chip" onClick={() => void toggleHistory()}>
            {historyOpen ? t("card.hideHistory") : t("card.showHistory")}
          </button>
        </div>
        {refreshNote ? <div className="scouting-hint">{refreshNote}</div> : null}

        {historyOpen ? (
          <div className="scouting-hint">
            {historyError ? (
              <span className="scouting-engine-error">{historyError}</span>
            ) : !history ? (
              t("common.loading")
            ) : history.entries.length === 0 ? (
              t("card.historyEmpty", {
                first: formatDateTime(history.firstSeenAt, intlLocale),
                last: formatDateTime(history.lastCheckedAt, intlLocale),
              })
            ) : (
              <ul className="scouting-samples">
                {history.entries.map((entry) => (
                  <li key={entry.capturedAt}>
                    {formatDateTime(entry.capturedAt, intlLocale)}:{" "}
                    {entry.changedFields.join(", ")}
                    {entry.price != null
                      ? t("card.historyWas", {
                          price: entry.price,
                          currency: entry.currency ?? "",
                        })
                      : null}
                    {!entry.available ? t("card.historyUnavailable") : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}
