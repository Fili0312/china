import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ParsedRequest, ParsedRequestSchema } from "@china/shared";
import { CLAUDE_MODEL, getClient, isAiMock } from "./client";
import { mockParseRequest } from "./mock";
import { logUsage } from "./usage";

const SYSTEM = `Sei un assistente di sourcing per un'azienda che importa prodotti dalla Cina.
Ricevi un messaggio libero di un cliente (in italiano o altra lingua) che elenca prodotti da acquistare,
anche fino a 100 righe, con quantità, colori, misure e altre caratteristiche scritte in modo informale.

Estrai OGNI prodotto richiesto come voce separata. Regole:
- Non inventare prodotti né quantità: se la quantità non è indicata usa 1.
- Normalizza il nome prodotto (conciso, senza quantità/colore dentro il nome).
- Colore e misura vanno nei campi dedicati; ogni altra caratteristica (materiale, capacità, voltaggio, personalizzazione, ...) in "attributes".
- Se una riga contiene più varianti dello stesso prodotto (es. "10 rosse e 5 blu"), crea una voce per variante.
- "notes" contiene solo indicazioni utili del cliente non catturate altrove.`;

export async function parseRequest(rawText: string): Promise<ParsedRequest> {
  if (isAiMock()) return mockParseRequest(rawText);

  const client = getClient();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: rawText }],
    output_config: { format: zodOutputFormat(ParsedRequestSchema) },
  });

  logUsage("parse", response.usage);
  if (response.stop_reason === "refusal") {
    throw new Error("Claude ha rifiutato la richiesta di parsing (refusal).");
  }
  if (!response.parsed_output) {
    throw new Error(
      `Parsing fallito: output non conforme allo schema (stop_reason=${response.stop_reason}).`
    );
  }
  return response.parsed_output;
}
