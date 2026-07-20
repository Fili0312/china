"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { API_URL, api } from "@/lib/api";

interface Candidate {
  id: string;
  marketplace: string;
  title: string;
  url: string;
  imageUrl: string | null;
  priceValue: string | null;
  priceCurrency: string | null;
  moq: number | null;
  selectedRank: number | null;
  score: number | null;
  reason: string | null;
  variant: string | null;
}

interface Item {
  id: string;
  position: number;
  name: string;
  quantity: number;
  color: string | null;
  size: string | null;
  status: string;
  error: string | null;
  queryEn: string | null;
  candidates: Candidate[];
}

interface QuoteLine {
  id: string;
  itemId: string;
  description: string;
  quantity: number;
  unitCost: string;
  unitPrice: string;
  lineTotal: string;
  marketplace: string | null;
  url: string | null;
  imageUrl: string | null;
  moq: number | null;
  variant: string | null;
  note: string | null;
}

interface QuoteDetail {
  id: string;
  rawText: string;
  status: string;
  markupPct: number;
  currency: string;
  error: string | null;
  createdAt: string;
  items: Item[];
  quote: {
    totalCost: string;
    totalPrice: string;
    currency: string;
    markupPct: number;
    lines: QuoteLine[];
  } | null;
}

const REQ_STATUS: Record<string, { label: string; cls: string }> = {
  RECEIVED: { label: "In coda", cls: "" },
  PARSING: { label: "Analisi messaggio…", cls: "warn" },
  SEARCHING: { label: "Ricerca sui marketplace…", cls: "warn" },
  ASSEMBLING: { label: "Calcolo preventivo…", cls: "warn" },
  READY: { label: "Preventivo pronto", cls: "ok" },
  FAILED: { label: "Errore", cls: "err" },
};

const ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "In attesa", cls: "" },
  SEARCHING: { label: "Ricerca…", cls: "warn" },
  MATCHING: { label: "Selezione AI…", cls: "warn" },
  SELECTED: { label: "Selezionato", cls: "ok" },
  NO_RESULTS: { label: "Nessun risultato", cls: "err" },
  FAILED: { label: "Errore", cls: "err" },
};

function money(v: string | null | undefined, currency = "USD") {
  if (v == null) return "—";
  return `${Number(v).toFixed(2)} ${currency}`;
}

export function QuoteView({ id }: { id: string }) {
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    // Debounce: molti eventi ravvicinati → una sola rilettura.
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      api<QuoteDetail>(`/quotes/${id}`).then(setDetail).catch((e) =>
        setError(e instanceof Error ? e.message : "Errore")
      );
    }, 250);
  }, [id]);

  useEffect(() => {
    refresh();
    const es = new EventSource(`${API_URL}/api/quotes/${id}/events`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type !== "ping") refresh();
      } catch {
        /* ignora */
      }
    };
    es.onerror = () => {
      /* EventSource riconnette da solo */
    };
    return () => {
      es.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [id, refresh]);

  if (error) {
    return (
      <div className="panel" style={{ color: "var(--err)" }}>
        {error} — <Link href="/">torna alla home</Link>
      </div>
    );
  }
  if (!detail) return <p className="muted">Caricamento…</p>;

  const s = REQ_STATUS[detail.status] ?? { label: detail.status, cls: "" };
  const done = detail.items.filter((i) =>
    ["SELECTED", "NO_RESULTS", "FAILED"].includes(i.status)
  ).length;

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link href="/" className="muted">
          ← Nuova richiesta
        </Link>
      </p>
      <h1>
        Richiesta <span className="muted">{detail.id.slice(-8)}</span>{" "}
        <span className={`badge ${s.cls}`}>{s.label}</span>
      </h1>
      <p className="subtitle">
        {new Date(detail.createdAt).toLocaleString("it-IT")} · ricarico{" "}
        {detail.markupPct}% ·{" "}
        {detail.items.length > 0
          ? `${done}/${detail.items.length} articoli completati`
          : "in analisi"}
        {detail.error && (
          <span style={{ color: "var(--err)" }}> · {detail.error}</span>
        )}
      </p>

      {detail.quote && (
        <div className="panel">
          <h1 style={{ fontSize: 16 }}>Preventivo</h1>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Articolo</th>
                <th>Qtà</th>
                <th>Costo unit.</th>
                <th>Prezzo unit.</th>
                <th>Totale riga</th>
                <th>Fonte</th>
              </tr>
            </thead>
            <tbody>
              {detail.quote.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={l.imageUrl}
                        alt=""
                        style={{
                          width: 44,
                          height: 44,
                          objectFit: "cover",
                          borderRadius: 6,
                        }}
                      />
                    ) : null}
                  </td>
                  <td>
                    {l.description}
                    {l.variant && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {l.variant}
                      </div>
                    )}
                    {l.note && (
                      <div style={{ color: "var(--warn)", fontSize: 12 }}>
                        {l.note}
                      </div>
                    )}
                  </td>
                  <td>{l.quantity}</td>
                  <td className="muted">
                    {money(l.unitCost, detail.quote!.currency)}
                  </td>
                  <td>{money(l.unitPrice, detail.quote!.currency)}</td>
                  <td>
                    <strong>{money(l.lineTotal, detail.quote!.currency)}</strong>
                  </td>
                  <td>
                    {l.url ? (
                      <a href={l.url} target="_blank" rel="noreferrer">
                        {l.marketplace}
                        {l.moq ? ` · MOQ ${l.moq}` : ""}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals" style={{ marginTop: 16 }}>
            <span className="muted">
              Costo totale: {money(detail.quote.totalCost, detail.quote.currency)}
            </span>
            <span>
              Totale preventivo:{" "}
              <strong>
                {money(detail.quote.totalPrice, detail.quote.currency)}
              </strong>
            </span>
          </div>
        </div>
      )}

      <div className="panel">
        <h1 style={{ fontSize: 16 }}>Articoli</h1>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Articolo</th>
              <th>Qtà</th>
              <th>Stato</th>
              <th>Candidati selezionati</th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => {
              const st = ITEM_STATUS[item.status] ?? {
                label: item.status,
                cls: "",
              };
              return (
                <tr key={item.id}>
                  <td className="muted">{item.position + 1}</td>
                  <td>
                    {item.name}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[item.color, item.size].filter(Boolean).join(" · ")}
                      {item.queryEn && (
                        <span> · query: “{item.queryEn}”</span>
                      )}
                    </div>
                    {item.error && (
                      <div style={{ color: "var(--err)", fontSize: 12 }}>
                        {item.error}
                      </div>
                    )}
                  </td>
                  <td>{item.quantity}</td>
                  <td>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                  </td>
                  <td>
                    {item.candidates.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      item.candidates.map((c) => (
                        <div className="candidate" key={c.id}>
                          {c.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.imageUrl} alt="" />
                          ) : (
                            <div
                              style={{
                                width: 44,
                                height: 44,
                                borderRadius: 6,
                                background: "var(--border)",
                                flex: "none",
                              }}
                            />
                          )}
                          <div style={{ fontSize: 13 }}>
                            <a href={c.url} target="_blank" rel="noreferrer">
                              {c.title.slice(0, 90)}
                            </a>
                            <div className="muted" style={{ fontSize: 12 }}>
                              #{c.selectedRank} · {c.marketplace} ·{" "}
                              {money(c.priceValue, c.priceCurrency ?? "USD")}
                              {c.moq ? ` · MOQ ${c.moq}` : ""}
                              {c.score != null
                                ? ` · match ${(c.score * 100).toFixed(0)}%`
                                : ""}
                            </div>
                            {c.reason && (
                              <div className="muted" style={{ fontSize: 12 }}>
                                {c.reason}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
