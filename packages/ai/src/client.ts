import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

/** true se le chiamate Claude vanno simulate (dev/test senza API key). */
export const isAiMock = () => process.env.AI_MOCK === "1";

/**
 * Chiave dell'API Claude.
 *
 * `CLAUDE_API_KEY` è il nome previsto dalla piattaforma; `ANTHROPIC_API_KEY`
 * resta accettato perché è quello che l'SDK legge da solo ed era già in uso.
 *
 * La chiave vive **solo** in questo processo: non viene mai restituita da
 * un'API, scritta in un log o salvata a database. Per questo all'esterno si
 * espone `hasClaudeApiKey()`, che dice se c'è, e mai il valore.
 */
function readApiKey(): string | undefined {
  return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;
}

/** `true` se una chiave è configurata, senza rivelarne il valore. */
export function hasClaudeApiKey(): boolean {
  return Boolean(readApiKey());
}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error(
        "CLAUDE_API_KEY mancante: impostala nel .env del server. " +
          "(È accettata anche ANTHROPIC_API_KEY; per la sola pipeline preventivi " +
          "esiste AI_MOCK=1, che però non vale per l'analisi delle richieste.)"
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}
