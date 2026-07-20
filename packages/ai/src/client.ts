import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

/** true se le chiamate Claude vanno simulate (dev/test senza API key). */
export const isAiMock = () => process.env.AI_MOCK === "1";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY mancante. Impostala nel .env oppure usa AI_MOCK=1 per lo sviluppo."
      );
    }
    client = new Anthropic();
  }
  return client;
}
