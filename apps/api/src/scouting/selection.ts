import {
  extractRequirements,
  normalizeProductName,
  type NormalizedRequest,
  type ProductRequirement,
} from "@china/shared";

/**
 * Vincoli obbligatori, punteggio e scelta dei finalisti.
 *
 * Il criterio guida è la distinzione fra tre esiti diversi, che è ciò che
 * rende utile la selezione fra lingue diverse:
 *
 * - **violato**: il prodotto dichiara un valore incompatibile con il requisito
 *   (chiede 200 mm, il titolo dice 400 mm) → scartato, con motivazione;
 * - **verificato**: il prodotto dichiara il valore giusto → punteggio pieno;
 * - **non verificabile**: il prodotto non dichiara nulla → **neutro**, mai
 *   penalizzante. Un titolo cinese di 40 caratteri non elenca le
 *   certificazioni: assumere che manchino scarterebbe i prodotti giusti.
 *
 * Nessuna IA: il punteggio dev'essere spiegabile e identico a distanza di
 * mesi. La motivazione discorsiva (M7, facoltativa e a consumo) si aggiunge
 * dopo, senza mai cambiare la classifica.
 */

export interface CandidateForSelection {
  candidateId: string;
  engine: string;
  title: string;
  /** Specifiche dichiarate dalla scheda prodotto, se già scaricata. */
  specs?: Record<string, string>;
  price: number | null;
  currency: string | null;
  moq: number | null;
  rating: number | null;
  reviewCount: number | null;
  totalSales: number | null;
  relevanceScore: number | null;
  unavailable: boolean;
}

export interface RequirementCheck {
  key: string;
  label: string;
  kind: ProductRequirement["kind"];
  outcome: "verified" | "violated" | "unverifiable";
  detail: string;
}

export type RejectionCode =
  | "HARD_CONSTRAINT"
  | "UNAVAILABLE"
  | "NO_PRICE"
  | "MOQ_TOO_HIGH"
  | "PRICE_OVER_TARGET"
  | "DUPLICATE"
  | "BELOW_THRESHOLD";

export interface CandidateEvaluation {
  candidateId: string;
  score: number;
  /**
   * `true` se almeno un requisito è stato verificato oppure la pertinenza
   * supera la soglia: senza di esso il prodotto non può essere finalista.
   */
  hasPositiveSignal: boolean;
  breakdown: Record<string, number>;
  checks: RequirementCheck[];
  rejectionCode: RejectionCode | null;
  rejectionReason: string | null;
  /** Chiave di deduplica: due candidati con la stessa chiave sono lo stesso prodotto. */
  duplicateKey: string;
}

/** Peso di ciascun criterio nel punteggio finale (somma 100). */
export const SCORE_WEIGHTS = {
  relevance: 45,
  requirements: 25,
  price: 12,
  reputation: 10,
  moq: 8,
} as const;

/**
 * Quanto sopra il prezzo obiettivo si accetta prima di scartare.
 * I prezzi dei marketplace cinesi sono all'ingrosso e in valute diverse: un
 * margine stretto scarterebbe prodotti validi per un semplice cambio valuta.
 */
const PRICE_TOLERANCE = 2.5;

/**
 * Pertinenza minima perché un prodotto possa essere proposto come finalista
 * senza che nessun requisito sia stato verificato.
 *
 * Serve contro un caso reale: su Chinagoods una query cinese incontra titoli
 * inglesi, il motore di pertinenza non può confrontarli e assegna a tutti lo
 * stesso punteggio neutro. Senza questa soglia il sistema presenterebbe come
 * «finalisti» cinque prodotti a pari merito scelti a caso — nel caso provato,
 * pettini per una richiesta di tappetini antistatici. Un prodotto senza un
 * solo segnale positivo verificabile resta in elenco, ma non viene proposto.
 */
const FINALIST_RELEVANCE_FLOOR = 55;

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Confronto numerico entro tolleranza. `null` significa «il prodotto non lo
 * dichiara», che non è una violazione.
 */
function compareNumeric(
  required: number,
  declared: number | null,
  tolerance: number
): "verified" | "violated" | "unverifiable" {
  if (declared == null) return "unverifiable";
  const margin = Math.abs(required * tolerance);
  return Math.abs(declared - required) <= margin ? "verified" : "violated";
}

/**
 * Verifica i requisiti della richiesta contro ciò che il prodotto dichiara.
 *
 * Le dichiarazioni si leggono dal titolo e, quando la scheda prodotto è già
 * stata scaricata, dalle specifiche: si usa lo stesso estrattore della
 * richiesta, così i confronti avvengono sempre in unità base.
 */
export function checkRequirements(
  requirements: readonly ProductRequirement[],
  candidate: CandidateForSelection
): RequirementCheck[] {
  const declaredText = [
    candidate.title,
    ...Object.entries(candidate.specs ?? {}).map(
      ([name, value]) => `${name} ${value}`
    ),
  ].join(" ");
  const declared = extractRequirements(declaredText);

  return requirements.map((requirement): RequirementCheck => {
    const [family, detail] = requirement.key.split(".");

    if (family === "dimension" && detail) {
      const value = declared.dimensions[detail] ?? null;
      const outcome = compareNumeric(
        Number(requirement.value),
        value,
        requirement.tolerance ?? 0.02
      );
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        outcome,
        detail:
          outcome === "unverifiable"
            ? "misura non dichiarata dal prodotto"
            : `dichiarato ${value} mm`,
      };
    }

    if (requirement.key === "power" || requirement.key === "voltage") {
      const value =
        requirement.key === "power" ? declared.power : declared.voltage;
      const outcome = compareNumeric(
        Number(requirement.value),
        value,
        requirement.tolerance ?? 0.05
      );
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        outcome,
        detail:
          outcome === "unverifiable"
            ? "valore non dichiarato"
            : `dichiarato ${value} ${requirement.unit}`,
      };
    }

    if (requirement.key === "capacity") {
      const sameUnit =
        declared.requiredVariant.capacityUnit === undefined ||
        declared.requiredVariant.capacityUnit ===
          (requirement.unit ?? undefined);
      const outcome = !sameUnit
        ? "unverifiable"
        : compareNumeric(
            Number(requirement.value),
            declared.capacity,
            requirement.tolerance ?? 0.05
          );
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        outcome,
        detail:
          outcome === "unverifiable"
            ? "capacità non dichiarata o in un'unità diversa"
            : `dichiarato ${declared.capacity} ${requirement.unit}`,
      };
    }

    if (requirement.key === "material") {
      const value = declared.material;
      const outcome =
        value == null
          ? "unverifiable"
          : value === requirement.value
            ? "verified"
            : "violated";
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        outcome,
        detail:
          outcome === "unverifiable"
            ? "materiale non dichiarato"
            : `dichiarato ${value}`,
      };
    }

    if (family === "certification" && detail) {
      const present = declared.certifications.includes(detail);
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        // Una certificazione assente dal titolo non è una certificazione
        // mancante: quasi nessun titolo le elenca.
        outcome: present ? "verified" : "unverifiable",
        detail: present ? "dichiarata" : "non dichiarata nel titolo",
      };
    }

    if (family === "variant" && detail) {
      const value = declared.requiredVariant[detail];
      const outcome =
        value == null
          ? "unverifiable"
          : String(value) === String(requirement.value)
            ? "verified"
            : "violated";
      return {
        key: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        outcome,
        detail:
          outcome === "unverifiable"
            ? "non dichiarato"
            : `dichiarato ${String(value)}`,
      };
    }

    return {
      key: requirement.key,
      label: requirement.label,
      kind: requirement.kind,
      outcome: "unverifiable",
      detail: "non confrontabile automaticamente",
    };
  });
}

/**
 * Chiave di deduplica. Lo stesso prodotto rivenduto su più marketplace ha
 * titoli quasi identici: si confronta il nome normalizzato, che è insensibile
 * all'ordine delle parole, insieme al prezzo arrotondato.
 */
export function duplicateKeyFor(candidate: CandidateForSelection): string {
  const name = normalizeProductName(candidate.title).slice(0, 80);
  const price =
    candidate.price == null
      ? "?"
      : `${Math.round(candidate.price * 100)}${candidate.currency ?? ""}`;
  return `${name}|${price}`;
}

export interface EvaluationContext {
  request: Pick<
    NormalizedRequest,
    "requirements" | "targetPrice" | "requestedQuantity"
  >;
  /** Punteggio minimo per entrare fra i finalisti. */
  threshold: number;
}

/** Valuta un candidato: vincoli, punteggio e motivazione dell'eventuale scarto. */
export function evaluateCandidate(
  candidate: CandidateForSelection,
  context: EvaluationContext
): CandidateEvaluation {
  const checks = checkRequirements(context.request.requirements, candidate);
  const duplicateKey = duplicateKeyFor(candidate);
  const breakdown: Record<string, number> = {};

  const hasPositiveSignal =
    checks.some((check) => check.outcome === "verified") ||
    (candidate.relevanceScore ?? 0) >= FINALIST_RELEVANCE_FLOOR;

  const reject = (
    code: RejectionCode,
    reason: string
  ): CandidateEvaluation => ({
    candidateId: candidate.candidateId,
    score: 0,
    hasPositiveSignal,
    breakdown,
    checks,
    rejectionCode: code,
    rejectionReason: reason,
    duplicateKey,
  });

  if (candidate.unavailable) {
    return reject("UNAVAILABLE", "Prodotto non più raggiungibile alla fonte.");
  }

  const violated = checks.filter(
    (check) => check.kind === "hard" && check.outcome === "violated"
  );
  if (violated.length > 0) {
    return reject(
      "HARD_CONSTRAINT",
      `Requisito obbligatorio non rispettato: ${violated
        .map((check) => `${check.label} (${check.detail})`)
        .join("; ")}.`
    );
  }

  // Il minimo d'ordine è un vincolo solo se la quantità richiesta è nota.
  const quantity = context.request.requestedQuantity;
  if (quantity != null && candidate.moq != null && candidate.moq > quantity) {
    return reject(
      "MOQ_TOO_HIGH",
      `Minimo d'ordine ${candidate.moq} superiore alla quantità richiesta ${quantity}.`
    );
  }

  const target = context.request.targetPrice;
  if (
    target != null &&
    target > 0 &&
    candidate.price != null &&
    candidate.price > target * PRICE_TOLERANCE
  ) {
    return reject(
      "PRICE_OVER_TARGET",
      `Prezzo ${candidate.price} oltre ${PRICE_TOLERANCE}× il riferimento ${target}.`
    );
  }

  // --- Punteggio -----------------------------------------------------------
  breakdown.relevance =
    (SCORE_WEIGHTS.relevance * clamp(candidate.relevanceScore ?? 0)) / 100;

  const relevantChecks = checks.filter(
    (check) => check.outcome !== "unverifiable"
  );
  // Nessun requisito verificabile: il criterio resta neutro a metà punteggio
  // invece di azzerarsi, perché l'assenza di prova non è prova contraria.
  breakdown.requirements =
    relevantChecks.length === 0
      ? SCORE_WEIGHTS.requirements * 0.5
      : (SCORE_WEIGHTS.requirements *
          relevantChecks.filter((check) => check.outcome === "verified").length) /
        relevantChecks.length;

  if (target != null && target > 0 && candidate.price != null) {
    // 1 quando costa la metà o meno del riferimento, 0 quando lo raggiunge.
    const ratio = candidate.price / target;
    breakdown.price = SCORE_WEIGHTS.price * clamp(1.5 - ratio, 0, 1);
  } else {
    breakdown.price = SCORE_WEIGHTS.price * 0.5;
  }

  const reviews = candidate.reviewCount ?? 0;
  const sales = candidate.totalSales ?? 0;
  const volume = Math.log1p(reviews + sales) / Math.log1p(10_000);
  const rating = candidate.rating != null ? candidate.rating / 5 : 0.6;
  breakdown.reputation =
    SCORE_WEIGHTS.reputation * clamp(volume * rating, 0, 1);

  if (quantity != null && candidate.moq != null) {
    // Premia chi accetta ordini piccoli rispetto a quanto serve.
    breakdown.moq = SCORE_WEIGHTS.moq * clamp(1 - candidate.moq / quantity, 0, 1);
  } else {
    breakdown.moq = SCORE_WEIGHTS.moq * 0.5;
  }

  const score = clamp(
    Object.values(breakdown).reduce((total, value) => total + value, 0)
  );

  return {
    candidateId: candidate.candidateId,
    score: Math.round(score * 10) / 10,
    hasPositiveSignal,
    breakdown,
    checks,
    rejectionCode: null,
    rejectionReason: null,
    duplicateKey,
  };
}

/**
 * Punteggio già calcolato in passato per un candidato i cui dati non sono
 * cambiati. Riusarlo non è un'ottimizzazione: è la regola richiesta — i
 * prodotti immutati devono conservare **esattamente** il punteggio di prima,
 * altrimenti la classifica si muoverebbe senza che nulla sia cambiato.
 */
export interface StoredEvaluation {
  score: number;
  breakdown: Record<string, number>;
  rejectionCode: RejectionCode | null;
  rejectionReason: string | null;
  checks: RequirementCheck[];
}

export interface SelectionOutcome {
  candidateId: string;
  outcome: "FINALIST" | "SHORTLISTED" | "REJECTED";
  rank: number | null;
  evaluation: CandidateEvaluation;
  /** `true` se il punteggio arriva dal calcolo precedente, non da uno nuovo. */
  scoreReused: boolean;
}

/**
 * Ordina, deduplica e sceglie i finalisti.
 *
 * La deduplica avviene **dopo** il punteggio: fra due copie dello stesso
 * prodotto si tiene quella con il punteggio migliore, e l'altra viene scartata
 * con motivazione invece che sparire senza spiegazione.
 */
export function selectFinalists(
  candidates: readonly CandidateForSelection[],
  context: EvaluationContext,
  finalistCount: number,
  /** Punteggi già calcolati, per i candidati i cui dati non sono cambiati. */
  storedScores?: ReadonlyMap<string, StoredEvaluation>
): SelectionOutcome[] {
  const evaluations = candidates.map((candidate) => {
    const fresh = evaluateCandidate(candidate, context);
    const stored = storedScores?.get(candidate.candidateId);
    if (!stored) return { candidate, reused: false, evaluation: fresh };

    // Del calcolo precedente si conserva il **punteggio** — è ciò che deve
    // restare stabile finché i dati del prodotto non cambiano — mentre i
    // controlli e la proponibilità si rideducono sempre da capo: dipendono
    // dalle regole, non dai dati, e un esito salvato con regole vecchie
    // sopravvivrebbe a ogni correzione successiva.
    return {
      candidate,
      reused: true,
      evaluation: {
        ...fresh,
        score: stored.score,
        breakdown: stored.breakdown,
        rejectionCode: stored.rejectionCode ?? fresh.rejectionCode,
        rejectionReason: stored.rejectionReason ?? fresh.rejectionReason,
      } satisfies CandidateEvaluation,
    };
  });

  const ordered = [...evaluations].sort(
    (left, right) => right.evaluation.score - left.evaluation.score
  );

  const seen = new Map<string, string>();
  const outcomes: SelectionOutcome[] = [];
  let rank = 0;

  for (const entry of ordered) {
    const { evaluation } = entry;

    if (evaluation.rejectionCode) {
      outcomes.push({
        candidateId: evaluation.candidateId,
        outcome: "REJECTED",
        rank: null,
        evaluation,
        scoreReused: entry.reused,
      });
      continue;
    }

    const twin = seen.get(evaluation.duplicateKey);
    if (twin) {
      outcomes.push({
        candidateId: evaluation.candidateId,
        outcome: "REJECTED",
        rank: null,
        evaluation: {
          ...evaluation,
          rejectionCode: "DUPLICATE",
          rejectionReason:
            "Stesso prodotto già presente con punteggio uguale o migliore.",
        },
        scoreReused: entry.reused,
      });
      continue;
    }
    seen.set(evaluation.duplicateKey, evaluation.candidateId);

    if (evaluation.score < context.threshold) {
      outcomes.push({
        candidateId: evaluation.candidateId,
        outcome: "REJECTED",
        rank: null,
        evaluation: {
          ...evaluation,
          rejectionCode: "BELOW_THRESHOLD",
          rejectionReason: `Punteggio ${evaluation.score} sotto la soglia ${context.threshold}.`,
        },
        scoreReused: entry.reused,
      });
      continue;
    }

    rank += 1;
    // Un prodotto senza alcun segnale positivo verificabile resta in elenco,
    // ma non viene mai proposto come finalista: dire «non ho trovato nulla di
    // verificabile» è più utile che indicare con sicurezza il prodotto
    // sbagliato.
    const proposable = evaluation.hasPositiveSignal;
    outcomes.push({
      candidateId: evaluation.candidateId,
      outcome: proposable && rank <= finalistCount ? "FINALIST" : "SHORTLISTED",
      rank,
      evaluation: proposable
        ? evaluation
        : {
            ...evaluation,
            rejectionReason:
              "Nessun requisito verificabile e pertinenza non conclusiva: " +
              "il prodotto è in elenco ma non viene proposto.",
          },
      scoreReused: entry.reused,
    });
  }

  return outcomes;
}
