"use client";

import { useCallback, useEffect, useState } from "react";
import type { TaobaoClarification } from "@china/shared";
import { api } from "../../lib/api";
import { useI18n } from "../i18n/context";

/**
 * Le domande dell'IA: cosa non le torna, e cosa ha già imparato.
 *
 * Il pannello mostra le domande aperte in ordine di quante righe le hanno
 * incontrate — rispondere alla prima aiuta più righe di tutte. Ogni risposta
 * diventa conoscenza permanente: entra nel prompt delle analisi successive e
 * la stessa domanda non viene mai rifatta.
 *
 * Le domande si possono anche archiviare («non chiedere più»): utile quando il
 * dubbio non ha una risposta unica e va deciso riga per riga nella revisione.
 */

interface PanelProps {
  /** Cambia dopo ogni analisi: fa ricaricare le domande. */
  reloadToken: number;
  onError: (message: string) => void;
}

export function ClarificationsPanel({ reloadToken, onError }: PanelProps) {
  const { t, tr } = useI18n();
  const [items, setItems] = useState<TaobaoClarification[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);
  const [showAllOpen, setShowAllOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setItems(await api<TaobaoClarification[]>("/taobao/clarifications"));
      } catch {
        // Le domande sono un di più: senza, la pagina resta usabile.
      }
    })();
  }, [reloadToken]);

  const submit = useCallback(
    async (item: TaobaoClarification, dismiss: boolean) => {
      const answer = (drafts[item.clarificationId] ?? "").trim();
      if (!dismiss && !answer) return;
      setSavingId(item.clarificationId);
      try {
        const updated = await api<TaobaoClarification>(
          `/taobao/clarifications/${item.clarificationId}`,
          {
            method: "PATCH",
            body: JSON.stringify(dismiss ? { dismiss: true } : { answer }),
          }
        );
        setItems((current) =>
          current.map((entry) =>
            entry.clarificationId === updated.clarificationId ? updated : entry
          )
        );
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingId(null);
      }
    },
    [drafts, onError]
  );

  // Le domande si presentano dalla più incontrata: rispondere alla prima
  // aiuta più righe di tutte. Oltre le prime 5 si apre a richiesta — un muro
  // di domande insegna solo a ignorarle.
  const open = items
    .filter((item) => item.status === "OPEN")
    .sort((a, b) => b.hitCount - a.hitCount);
  const visibleOpen = showAllOpen ? open : open.slice(0, 5);
  const answered = items.filter((item) => item.status === "ANSWERED");

  if (open.length === 0 && answered.length === 0) return null;

  return (
    <section className="panel scouting-step">
      <h2>{t("clarify.step")}</h2>
      <p className="scouting-hint">{tr("clarify.hint")}</p>

      {open.length === 0 ? (
        <p className="muted">{t("clarify.empty")}</p>
      ) : (
        visibleOpen.map((item) => (
          <div key={item.clarificationId} className="scouting-result-row">
            <div className="scouting-row">
              <span className="chip warn">
                {item.hitCount === 1
                  ? t("clarify.rowsOne", { count: item.hitCount })
                  : t("clarify.rowsMany", { count: item.hitCount })}
              </span>
              {item.source === "verify" ? (
                <span className="chip" title={t("clarify.fromVerifyTitle")}>
                  {t("clarify.fromVerify")}
                </span>
              ) : null}
              <strong>{item.question}</strong>
            </div>
            {item.examples.length > 0 ? (
              <div className="scouting-hint scouting-samples">
                {t("clarify.example", { example: item.examples[0]!.split("\n")[0]! })}
              </div>
            ) : null}
            <div className="scouting-row scouting-controls">
              <input
                type="text"
                placeholder={t("clarify.placeholder")}
                value={drafts[item.clarificationId] ?? ""}
                disabled={savingId === item.clarificationId}
                style={{ flex: 1, minWidth: "260px" }}
                onChange={(event) =>
                  setDrafts({ ...drafts, [item.clarificationId]: event.target.value })
                }
              />
              <button
                type="button"
                disabled={
                  savingId === item.clarificationId ||
                  !(drafts[item.clarificationId] ?? "").trim()
                }
                onClick={() => void submit(item, false)}
              >
                {t("clarify.save")}
              </button>
              <button
                type="button"
                className="chip"
                disabled={savingId === item.clarificationId}
                title={t("clarify.dismissTitle")}
                onClick={() => void submit(item, true)}
              >
                {t("clarify.dismiss")}
              </button>
            </div>
          </div>
        ))
      )}

      {open.length > 5 ? (
        <button type="button" className="chip" onClick={() => setShowAllOpen(!showAllOpen)}>
          {showAllOpen ? t("clarify.showTop") : t("clarify.showAll", { count: open.length })}
        </button>
      ) : null}

      {answered.length > 0 ? (
        <>
          <button
            type="button"
            className="chip"
            onClick={() => setShowAnswered(!showAnswered)}
          >
            {showAnswered
              ? t("clarify.hideAnswered")
              : t("clarify.showAnswered", { count: answered.length })}
          </button>
          {showAnswered ? (
            <ul className="scouting-samples">
              {answered.map((item) => (
                <li key={item.clarificationId}>
                  <strong>{t("clarify.question")}</strong> {item.question}{" "}
                  <strong>{t("clarify.answer")}</strong> {item.answer}
                  <span className="muted">
                    {item.timesApplied === 1
                      ? t("clarify.appliedOne", { count: item.timesApplied })
                      : t("clarify.appliedMany", { count: item.timesApplied })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
