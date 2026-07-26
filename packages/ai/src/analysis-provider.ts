import {
  ANALYSIS_PROMPT_VERSION,
  analyzeProductRows,
  type AnalysisCallResult,
  type AnalysisInputRow,
} from "./analyze-products";
import {
  deepSeekAnalyzeRows,
  deepSeekModel,
  deepSeekPipelineVersion,
  deepSeekPreferredBatchSize,
  hasDeepSeekApiKey,
} from "./analyze-products-deepseek";
import { CLAUDE_MODEL, hasClaudeApiKey } from "./client";

/**
 * L'interfaccia comune dei provider di analisi.
 *
 * Il resto del sistema — cache, lotti, ritenti, revisione, identità delle
 * varianti — non sa quale modello sta parlando: riceve righe e restituisce
 * `AnalysisCallResult`. Cambiare motore è una riga di `.env`
 * (`AI_ANALYSIS_PROVIDER=deepseek`), non una modifica al codice.
 *
 * Nessun fallback automatico: se il provider scelto fallisce, le righe
 * falliscono con il suo errore. Un ripiego silenzioso su un altro modello
 * mischierebbe nella stessa sessione analisi di qualità diversa — che è
 * esattamente ciò che un confronto fra provider deve evitare.
 */

export const ANALYSIS_PROVIDERS = ["claude", "deepseek"] as const;
export type AnalysisProviderName = (typeof ANALYSIS_PROVIDERS)[number];

export interface AnalysisBatchOptions {
  timeoutMs?: number;
  /** Profondità di ragionamento: usata da Claude, ignorata da DeepSeek
   * (che gira comunque in modalità non-reasoning). */
  effort?: "low" | "medium" | "high";
  /** Risposte già date dall'operatore, iniettate come istruzioni. */
  knowledge?: readonly string[];
}

export interface AnalysisProvider {
  readonly name: AnalysisProviderName;
  readonly model: string;
  /**
   * Versione della pipeline di analisi di **questo** provider: entra nella
   * chiave di cache. Cambia quando cambia il modo in cui il provider analizza
   * (prompt, passate), così le analisi vecchie non vengono spacciate per
   * nuove — senza invalidare la cache degli altri provider.
   */
  readonly promptVersion: string;
  /**
   * Righe per chiamata che rendono meglio con questo motore. Un modello
   * economico può permettersi lotti piccoli — più attenzione per riga allo
   * stesso ordine di costo.
   */
  readonly preferredBatchSize: number;
  /** `true` se la chiave è configurata (mai il valore). */
  readonly configured: boolean;
  analyzeBatch(
    rows: readonly AnalysisInputRow[],
    options?: AnalysisBatchOptions
  ): Promise<AnalysisCallResult>;
}

const claudeProvider: AnalysisProvider = {
  name: "claude",
  get model() {
    return CLAUDE_MODEL;
  },
  // Claude resta esattamente com'era: stessa versione, stessi lotti da 10.
  promptVersion: ANALYSIS_PROMPT_VERSION,
  preferredBatchSize: 10,
  get configured() {
    return hasClaudeApiKey();
  },
  analyzeBatch(rows, options = {}) {
    return analyzeProductRows(rows, options);
  },
};

const deepSeekProvider: AnalysisProvider = {
  name: "deepseek",
  get model() {
    return deepSeekModel();
  },
  get promptVersion() {
    return deepSeekPipelineVersion();
  },
  get preferredBatchSize() {
    return deepSeekPreferredBatchSize();
  },
  get configured() {
    return hasDeepSeekApiKey();
  },
  analyzeBatch(rows, options = {}) {
    return deepSeekAnalyzeRows(rows, {
      timeoutMs: options.timeoutMs,
      knowledge: options.knowledge,
    });
  },
};

/** Nome del provider scelto nel `.env`; tutto ciò che non è noto è Claude. */
export function analysisProviderName(): AnalysisProviderName {
  const raw = (process.env.AI_ANALYSIS_PROVIDER ?? "claude").trim().toLowerCase();
  return raw === "deepseek" ? "deepseek" : "claude";
}

export function analysisProviderByName(name: AnalysisProviderName): AnalysisProvider {
  return name === "deepseek" ? deepSeekProvider : claudeProvider;
}

/** Il provider attivo, deciso da `AI_ANALYSIS_PROVIDER`. */
export function activeAnalysisProvider(): AnalysisProvider {
  return analysisProviderByName(analysisProviderName());
}
