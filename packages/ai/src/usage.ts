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

export function logUsage(step: string, usage: UsageLike): void {
  const cost =
    (usage.input_tokens / 1_000_000) * PRICE_IN_PER_M +
    (usage.output_tokens / 1_000_000) * PRICE_OUT_PER_M;
  console.log(
    `[ai] ${step}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `≈ $${cost.toFixed(4)}`
  );
}
