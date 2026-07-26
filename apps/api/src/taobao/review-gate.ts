import { CRITICAL_WARNING_CODES, type AnalysisRowState, type ProductAnalysis } from "@china/shared";

/**
 * Il cancello della revisione: quali righe non partono da sole.
 *
 * Sta in un modulo suo, puro, per una ragione che è costata un file reale: è
 * la regola che decide quanto lavoro manuale scarica addosso all'operatore, e
 * una regola del genere va misurata, non intuita.
 *
 * La prima versione (ereditata dallo scouting multi-marketplace) fermava ogni
 * riga con un warning «critico». Su 498 righe vere ne bloccava 135 — e di
 * quelle 135, **zero** erano righe che non si potevano cercare: 57 dicevano
 * «questa misura non ha unità», 45 «unità ambigua», 10 «modello incerto».
 * Un cancello che non separa i casi buoni dai cattivi non protegge nessuno:
 * insegna a premere «conferma tutte» senza leggere, che è il contrario del
 * suo scopo.
 *
 * Il criterio qui è uno solo: **si sa quale prodotto cercare?**
 */

/** Cosa serve per decidere. Volutamente poco: la regola dev'essere leggibile. */
export interface GateInput {
  analysis: ProductAnalysis | null;
  hasIdentity: boolean;
  /** Conferma esplicita dell'operatore: supera il cancello. */
  approvedByUser: boolean;
  /** Cosa sa già la memoria di questa variante. */
  memory: { requestId: string | null; familyRequestCount: number } | null;
  minConfidence: number;
}

/** Perché una riga è ferma, per poterlo scrivere in interfaccia. */
export type GateReason = "NO_QUERY" | "MULTIPLE_PRODUCTS" | "LOW_CONFIDENCE" | null;

export function gateReason(input: GateInput): GateReason {
  const { analysis, approvedByUser, minConfidence } = input;
  if (!analysis || approvedByUser) return null;

  // Senza query cinese non c'è niente da mandare a Taobao.
  const query = (analysis.searchQueryChinese ?? analysis.productNameChinese ?? "").trim();
  if (!query) return "NO_QUERY";

  // Più prodotti in una riga: cercarne uno solo è una risposta sbagliata data
  // con sicurezza, ed è l'unico warning che descrive *quale* prodotto cercare.
  if (analysis.warnings.some((warning) => warning.code === "MULTIPLE_PRODUCTS")) {
    return "MULTIPLE_PRODUCTS";
  }

  // Sotto la soglia il modello dichiara di non sapere di che prodotto si tratti.
  if (analysis.confidence < minConfidence) return "LOW_CONFIDENCE";

  return null;
}

/**
 * Stato della riga.
 *
 * L'ordine conta: prima ciò che impedisce di cercare, poi ciò che la memoria
 * sa. Una riga incerta non diventa «già conosciuto» solo perché la variante
 * calcolata su dati dubbi esiste già.
 */
export function resolveAnalysisState(input: GateInput): AnalysisRowState {
  if (!input.analysis || !input.hasIdentity) return "ANALYSIS_FAILED";
  if (gateReason(input)) return "NEEDS_REVIEW";

  if (input.memory?.requestId) return "KNOWN_PRODUCT";
  if (input.memory && input.memory.familyRequestCount > 0) return "NEW_VARIANT";
  return "NEW_PRODUCT";
}

/**
 * `true` se la riga porta un avviso che vale la pena guardare.
 *
 * Non ferma niente: serve a contarli e a marcarli, così «121 righe con avvisi»
 * resta un'informazione invece di diventare un muro.
 */
export function hasReviewableWarning(analysis: ProductAnalysis | null): boolean {
  if (!analysis) return false;
  return analysis.warnings.some((warning) =>
    CRITICAL_WARNING_CODES.includes(warning.code)
  );
}
