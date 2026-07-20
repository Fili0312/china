"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface QuoteListEntry {
  id: string;
  status: string;
  markupPct: number;
  createdAt: string;
  error: string | null;
  rawText: string;
  _count: { items: number };
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  RECEIVED: { label: "In coda", cls: "" },
  PARSING: { label: "Analisi messaggio", cls: "warn" },
  SEARCHING: { label: "Ricerca in corso", cls: "warn" },
  ASSEMBLING: { label: "Calcolo preventivo", cls: "warn" },
  READY: { label: "Preventivo pronto", cls: "ok" },
  FAILED: { label: "Errore", cls: "err" },
};

export default function HomePage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [markup, setMarkup] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<QuoteListEntry[]>([]);

  useEffect(() => {
    api<QuoteListEntry[]>("/quotes")
      .then(setRecent)
      .catch(() => {});
  }, []);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ id: string }>("/quotes", {
        method: "POST",
        body: JSON.stringify({ text, markupPct: markup }),
      });
      router.push(`/quotes/${res.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore imprevisto");
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>China Sourcing — Preventivi (legacy)</h1>
      <p className="subtitle">
        Incolla la richiesta del cliente: la piattaforma estrae i prodotti,
        cerca sui marketplace e genera il preventivo. Modalità
        Playwright/scraping temporaneamente accantonata (adapter su mock) —{" "}
        <Link href="/">torna alla ricerca OTAPI</Link>.
      </p>

      <div className="panel">
        <textarea
          placeholder={
            "Es.\n200 tazze in ceramica bianche con logo\n50 zaini impermeabili 30L neri\n1000 penne a sfera blu…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginTop: 14,
          }}
        >
          <label className="muted">
            Ricarico&nbsp;
            <input
              type="number"
              min={0}
              max={1000}
              value={markup}
              onChange={(e) => setMarkup(Number(e.target.value))}
            />
            &nbsp;%
          </label>
          <button onClick={submit} disabled={submitting || text.trim().length < 3}>
            {submitting ? "Invio…" : "Genera preventivo"}
          </button>
          {error && <span style={{ color: "var(--err)" }}>{error}</span>}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="panel">
          <h1 style={{ fontSize: 16 }}>Richieste recenti</h1>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Richiesta</th>
                <th>Articoli</th>
                <th>Stato</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const s = STATUS_LABEL[r.status] ?? { label: r.status, cls: "" };
                return (
                  <tr
                    key={r.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => router.push(`/quotes/${r.id}`)}
                  >
                    <td className="muted">
                      {new Date(r.createdAt).toLocaleString("it-IT")}
                    </td>
                    <td>{r.rawText.slice(0, 80)}…</td>
                    <td>{r._count.items}</td>
                    <td>
                      <span className={`badge ${s.cls}`}>{s.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
