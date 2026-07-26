"use client";

import { useCallback, useEffect, useState } from "react";
import type { TaobaoMemoryRequest } from "@china/shared";
import { api } from "../../lib/api";
import { useI18n } from "../i18n/context";
import { formatDate } from "../i18n/format";

/**
 * Lo storico della memoria interna: cosa il sistema conosce già.
 *
 * È la risposta a «questo pezzo l'abbiamo già cercato?» senza dover caricare
 * un file per scoprirlo. Ogni variante mostra quanti prodotti ha in memoria e
 * quando è stata cercata l'ultima volta: se un file nuovo chiede la stessa
 * variante, quei prodotti vengono riusati invece che ricercati (e ripagati).
 */
export function MemoryHistory() {
  const { t, tr, intlLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TaobaoMemoryRequest[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    try {
      setItems(
        await api<TaobaoMemoryRequest[]>(
          `/taobao/memory?limit=50${search ? `&query=${encodeURIComponent(search)}` : ""}`
        )
      );
    } catch {
      // Lo storico è consultazione: un errore qui non deve fermare il lavoro.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(query);
    // La ricerca parte dal pulsante: qui si carica solo all'apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <section className="panel scouting-step">
      <h2>
        {t("memory.step")}
        <button
          type="button"
          className="chip"
          style={{ marginLeft: "0.75rem" }}
          onClick={() => setOpen(!open)}
        >
          {open ? t("common.close") : t("common.open")}
        </button>
      </h2>

      {open ? (
        <>
          <p className="scouting-hint">{tr("memory.hint")}</p>
          <div className="scouting-row scouting-controls">
            <input
              type="text"
              placeholder={t("memory.placeholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load(query);
              }}
              style={{ flex: 1, minWidth: "220px" }}
            />
            <button type="button" disabled={loading} onClick={() => void load(query)}>
              {loading ? t("memory.searching") : t("memory.search")}
            </button>
          </div>

          {items.length === 0 ? (
            <p className="muted">{loading ? t("common.loading") : t("memory.empty")}</p>
          ) : (
            <div className="scouting-table-wrap">
              <table className="scouting-table">
                <thead>
                  <tr>
                    <th>{t("memory.col.variant")}</th>
                    <th>{t("memory.col.family")}</th>
                    <th>{t("memory.col.products")}</th>
                    <th>{t("memory.col.searches")}</th>
                    <th>{t("memory.col.lastSearch")}</th>
                    <th>{t("memory.col.topProduct")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.requestId}>
                      <td>
                        <div>{item.displayName}</div>
                        <div className="scouting-hint">{item.variantKey}</div>
                      </td>
                      <td className="muted">{item.familyKey}</td>
                      <td>{item.productCount}</td>
                      <td className="muted">{item.searchCount}</td>
                      <td className="muted">
                        {formatDate(item.lastSearchedAt, intlLocale, t("common.never"))}
                      </td>
                      <td className="scouting-samples">
                        {item.topProduct ? (
                          <a
                            href={item.topProduct.url ?? "#"}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.topProduct.title.slice(0, 60)}
                            {item.topProduct.price != null
                              ? ` — ${item.topProduct.price} ${item.topProduct.currency ?? ""}`
                              : ""}
                          </a>
                        ) : (
                          <span className="muted">{t("common.none")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="scouting-hint">{t("memory.closedHint")}</p>
      )}
    </section>
  );
}
