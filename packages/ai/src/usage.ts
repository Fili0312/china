import { CLAUDE_MODEL } from "./client";

/**
 * Costo delle chiamate Claude, per poter dire quanto è costato un file.
 *
 * I prezzi dipendono dal **modello**, e per questo la tabella è indicizzata su
 * di esso invece di essere una coppia di costanti. Il motivo è concreto: il
 * modello si cambia dal `.env` (`CLAUDE_MODEL`), e con i prezzi cablati su
 * Opus una sessione girata con Sonnet sarebbe stata mostrata a circa il doppio
 * del suo costo reale — un errore invisibile, perché il numero resta
 * plausibile.
 *
 * Restano stime: i prezzi sono scritti qui, non restituiti dall'API. Servono a
 * dare un ordine di grandezza in interfaccia — «questo file costa qualche
 * centesimo» — non a fare fatturazione.
 */
interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}

/** Prezzo di listino in dollari per milione di token. */
interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Listino per modello (aggiornato al 2026-07-22).
 *
 * Sonnet 5 ha un prezzo introduttivo più basso ($2/$10) fino al 2026-08-31:
 * qui resta il prezzo pieno, perché una stima che sottovaluta il costo è
 * peggio di una che lo sopravvaluta.
 */
const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Modello sconosciuto: si usa il listino Opus, il più caro fra quelli noti. */
const FALLBACK_PRICE: ModelPrice = { input: 5, output: 25 };

export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? FALLBACK_PRICE;
}

/**
 * Costo stimato di una chiamata.
 *
 * `model` è facoltativo e vale `CLAUDE_MODEL`: i chiamanti esistenti non
 * cambiano, e chi ha bisogno di stimare il costo di un modello diverso da
 * quello configurato può dirlo.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string = CLAUDE_MODEL
): number {
  const price = priceFor(model);
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output
  );
}

/**
 * Costo stimato di una chiamata DeepSeek.
 *
 * Listino `deepseek-v4-flash` dalla documentazione ufficiale (2026-07-24):
 * $0,14/M input a cache miss, $0,0028/M a cache hit, $0,28/M output. I valori
 * si possono correggere dal `.env` senza toccare il codice, perché DeepSeek
 * ha cambiato listino più volte in un anno.
 */
function deepSeekPrice(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function estimateDeepSeekCostUsd(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0
): number {
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  return (
    (missTokens / 1_000_000) * deepSeekPrice("DEEPSEEK_PRICE_INPUT_MTOK", 0.14) +
    (cacheHitTokens / 1_000_000) * deepSeekPrice("DEEPSEEK_PRICE_CACHE_HIT_MTOK", 0.0028) +
    (outputTokens / 1_000_000) * deepSeekPrice("DEEPSEEK_PRICE_OUTPUT_MTOK", 0.28)
  );
}

export function logUsage(step: string, usage: UsageLike): void {
  const cost = estimateCostUsd(usage.input_tokens, usage.output_tokens);
  console.log(
    `[ai] ${step}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `≈ $${cost.toFixed(4)} (${CLAUDE_MODEL})`
  );
}
