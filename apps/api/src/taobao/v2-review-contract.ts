import type {
  TaobaoCandidate,
  TaobaoPipelineReviewIssue,
} from "@china/shared";

/**
 * Contratto aggiuntivo del solo flusso v2.
 *
 * Non viene aggiunto agli schemi condivisi dalla v1: i valori sono JSON
 * opzionali salvati nei risultati e nelle pipeline v2, mentre i record storici
 * e tutte le risposte v1 continuano ad avere esattamente la forma precedente.
 */
export const V2_PIPELINE_HUMAN_ACTIONS = [
  "APPROVE_EQUIVALENT",
  "CHOOSE_VARIANT",
  "CLARIFY_REQUIREMENT",
  "CHANGE_TOLERANCE",
  "MARK_UNAVAILABLE",
] as const;

export type V2PipelineHumanAction =
  (typeof V2_PIPELINE_HUMAN_ACTIONS)[number];

export type V2PipelineReviewIssue = TaobaoPipelineReviewIssue & {
  humanAction?: V2PipelineHumanAction | null;
};

export type V2CandidateCoherence = NonNullable<
  TaobaoCandidate["coherence"]
> & {
  selectedVariant?: string | null;
  variantSelectionRequired?: boolean;
  variantChoices?: string[];
};

export function v2CandidateCoherence(
  candidate: TaobaoCandidate
): V2CandidateCoherence | null {
  return candidate.coherence as V2CandidateCoherence | null;
}
