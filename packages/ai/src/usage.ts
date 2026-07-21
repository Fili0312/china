/**
 * Log dei token consumati da ogni chiamata Claude, per monitorare i costi.
 * Prezzi claude-opus-4-8: $5/M input, $25/M output (thinking incluso).
 */
interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}

const PRICE_IN_PER_M = 5;
const PRICE_OUT_PER_M = 25;

/**
 * Costo stimato in dollari di una chiamata, ai prezzi di listino.
 *
 * «Stimato» è letterale: i prezzi sono una costante di questo file, non un
 * dato restituito dall'API. Serve a dare un ordine di grandezza in interfaccia
 * — «questo file costa qualche centesimo» — non a fare fatturazione.
 */
export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_IN_PER_M +
    (outputTokens / 1_000_000) * PRICE_OUT_PER_M
  );
}

export function logUsage(step: string, usage: UsageLike): void {
  const cost = estimateCostUsd(usage.input_tokens, usage.output_tokens);
  console.log(
    `[ai] ${step}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `≈ $${cost.toFixed(4)}`
  );
}
