"use client";

import { useMemo, useState } from "react";
import type { TaobaoClarification } from "@china/shared";
import { useI18n } from "../i18n/context";

/**
 * Le domande dell'IA, poste come le porrebbe una persona.
 *
 * La differenza con il pannello della v1 non è grafica. Lì le domande sono un
 * riquadro fra gli altri, che si può ignorare: il flusso prosegue comunque, e
 * infatti resta pieno di dubbi mai chiariti. Qui sono l'unica cosa a schermo e
 * l'elaborazione è ferma dietro di loro — perché è vero: senza risposta il
 * sistema andrebbe avanti tirando a indovinare, ed è esattamente ciò che
 * rende inaffidabile una quotazione.
 *
 * Per la stessa ragione «non saprei» è un pulsante e non un'omissione: chi non
 * conosce la risposta deve poterlo dire in un gesto, invece di abbandonare la
 * pagina lasciando l'elaborazione appesa.
 */

interface QuestionsPanelProps {
  questions: readonly TaobaoClarification[];
  round: number;
  busy: boolean;
  onSubmit: (answers: Array<{ clarificationId: string; answer: string; skip: boolean }>) => void;
}

export function QuestionsPanel({ questions, round, busy, onSubmit }: QuestionsPanelProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const remaining = useMemo(
    () =>
      questions.filter(
        (item) => !skipped[item.clarificationId] && !(drafts[item.clarificationId] ?? "").trim()
      ).length,
    [drafts, questions, skipped]
  );

  function submit() {
    onSubmit(
      questions.map((item) => ({
        clarificationId: item.clarificationId,
        answer: (drafts[item.clarificationId] ?? "").trim(),
        // Una domanda lasciata in bianco senza premere «non saprei» vale come
        // «non saprei»: meglio proseguire che restare fermi su un campo vuoto.
        skip: skipped[item.clarificationId] === true || !(drafts[item.clarificationId] ?? "").trim(),
      }))
    );
  }

  return (
    <section className="v2-ask">
      <header className="v2-ask-head">
        <h2>{t("v2.ask.title")}</h2>
        {round > 0 ? <span className="chip">{t("v2.ask.round", { round: round + 1 })}</span> : null}
      </header>
      <p className="v2-ask-hint">{t("v2.ask.hint")}</p>

      <ol className="v2-ask-list">
        {questions.map((item) => {
          const isSkipped = skipped[item.clarificationId] === true;
          return (
            <li
              key={item.clarificationId}
              className={`v2-ask-item${isSkipped ? " skipped" : ""}`}
            >
              <div className="v2-ask-question">{item.question}</div>
              <div className="v2-ask-meta">
                <span className="chip warn">
                  {item.hitCount === 1
                    ? t("v2.ask.affectsOne")
                    : t("v2.ask.affects", { count: item.hitCount })}
                </span>
                {item.examples[0] ? (
                  <span className="v2-ask-example">
                    {t("v2.ask.example", { example: item.examples[0].split("\n")[0]! })}
                  </span>
                ) : null}
              </div>
              <div className="v2-ask-answer">
                <input
                  type="text"
                  placeholder={t("v2.ask.placeholder")}
                  value={drafts[item.clarificationId] ?? ""}
                  disabled={busy || isSkipped}
                  onChange={(event) =>
                    setDrafts({ ...drafts, [item.clarificationId]: event.target.value })
                  }
                />
                <button
                  type="button"
                  className={`chip${isSkipped ? " active" : ""}`}
                  disabled={busy}
                  title={t("v2.ask.skipHint")}
                  aria-pressed={isSkipped}
                  onClick={() =>
                    setSkipped({ ...skipped, [item.clarificationId]: !isSkipped })
                  }
                >
                  {t("v2.ask.skip")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="v2-ask-actions">
        <button type="button" disabled={busy} onClick={submit}>
          {busy ? t("v2.ask.submitting") : t("v2.ask.submit")}
        </button>
        {remaining > 0 ? (
          <span className="muted">{t("v2.ask.remaining", { count: remaining })}</span>
        ) : null}
      </div>
    </section>
  );
}
