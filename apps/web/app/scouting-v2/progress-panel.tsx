"use client";

import {
  TAOBAO_PIPELINE_PHASES,
  type TaobaoPipelinePhase,
  type TaobaoPipelineState,
} from "@china/shared";
import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/messages-en";

/**
 * La barra e il racconto di cosa sta succedendo.
 *
 * Una percentuale da sola non basta: «62%» non dice se il sistema sta
 * lavorando o si è piantato su una richiesta che non torna. Sotto la barra c'è
 * sempre una frase al presente con dentro un numero che cambia — la riga a cui
 * è arrivato, il nome del prodotto che sta cercando — perché è quel numero che
 * cambia a dire «è vivo», non l'animazione.
 *
 * Le fasi restano tutte visibili, anche quelle già passate: chi torna dopo
 * dieci minuti deve capire a colpo d'occhio cosa è stato fatto, non solo dove
 * si è arrivati.
 */

/** Chiave del dizionario per ogni fase e per ogni passo. */
const PHASE_KEYS: Record<TaobaoPipelinePhase, MessageKey> = {
  QUEUED: "v2.phase.QUEUED",
  ANALYSIS: "v2.phase.ANALYSIS",
  QUESTIONS: "v2.phase.QUESTIONS",
  REVIEW: "v2.phase.REVIEW",
  SEARCH: "v2.phase.SEARCH",
  VERIFY: "v2.phase.VERIFY",
  REFINE: "v2.phase.REFINE",
  REPORT: "v2.phase.REPORT",
};

/**
 * I passi arrivano dal server come chiavi `step.*`; il dizionario li tiene
 * sotto `v2.step.*`. La conversione sta qui e non nel dizionario perché la
 * chiave del server descrive lo *stato*, non la frase: se un giorno la stessa
 * fase venisse raccontata in due punti diversi, i due testi divergerebbero
 * senza che il tipo se ne accorga.
 */
function stepKey(step: string, params: Record<string, string | number>): MessageKey {
  // Il singolare è una chiave a parte, non una variante della stessa frase:
  // «1 questions» è il genere di dettaglio che fa sembrare automatico — e
  // quindi poco affidabile — tutto ciò che gli sta intorno.
  if (step === "step.questions" && Number(params.count) === 1) return "v2.step.questionsOne";
  return `v2.${step}` as MessageKey;
}

function elapsed(startedAt: string | null): { minutes: string; seconds: string } {
  if (!startedAt) return { minutes: "0", seconds: "00" };
  const total = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  return {
    minutes: String(Math.floor(total / 60)),
    seconds: String(total % 60).padStart(2, "0"),
  };
}

interface ProgressPanelProps {
  state: TaobaoPipelineState;
  busy: boolean;
  onCancel: () => void;
}

export function ProgressPanel({ state, busy, onCancel }: ProgressPanelProps) {
  const { t } = useI18n();
  const waiting = state.status === "WAITING_ANSWERS";
  const time = elapsed(state.startedAt);

  return (
    <section className="v2-run">
      <header className="v2-run-head">
        <h2>{t("v2.run.title", { file: state.fileName })}</h2>
        <span className="muted">{t("v2.run.elapsed", time)}</span>
      </header>

      <div
        className={`v2-bar${waiting ? " paused" : ""}`}
        role="progressbar"
        aria-valuenow={state.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t(PHASE_KEYS[state.phase])}
      >
        <div className="v2-bar-fill" style={{ width: `${state.progress}%` }} />
      </div>

      <div className="v2-run-now">
        <strong>{state.progress}%</strong>
        <span>{t(stepKey(state.step, state.stepParams), state.stepParams)}</span>
      </div>

      <ol className="v2-steps">
        {TAOBAO_PIPELINE_PHASES.filter((phase) => phase !== "QUEUED").map((phase) => {
          const done = state.completedPhases.includes(phase);
          const active = state.phase === phase && !done;
          return (
            <li
              key={phase}
              className={`v2-step${done ? " done" : ""}${active ? " active" : ""}`}
            >
              <span className="v2-step-dot" aria-hidden="true" />
              {t(PHASE_KEYS[phase])}
            </li>
          );
        })}
      </ol>

      {state.status === "RUNNING" ? (
        <div className="v2-run-actions">
          <p className="muted">{t("v2.run.leaveSafe")}</p>
          <button type="button" className="chip" disabled={busy} onClick={onCancel}>
            {t("v2.run.cancel")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
