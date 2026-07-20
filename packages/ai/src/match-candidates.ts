import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MatchResult, MatchResultSchema } from "@china/shared";
import { CLAUDE_MODEL, getClient, isAiMock } from "./client";
import { mockMatchCandidates } from "./mock";
import { logUsage } from "./usage";

const SYSTEM = `Sei un buyer esperto di sourcing dalla Cina. Ricevi:
1. la descrizione di un articolo richiesto dal cliente (nome, quantità, colore, misura, caratteristiche);
2. una lista di candidati trovati sui marketplace (id, marketplace, titolo, prezzo, MOQ).

Scegli i 2-3 candidati MIGLIORI valutando, in ordine:
- corrispondenza reale del prodotto con la richiesta (tipo, misura, materiale, caratteristiche);
- compatibilità del MOQ con la quantità richiesta;
- prezzo competitivo a parità di corrispondenza.
Scarta i candidati che sono chiaramente un prodotto diverso, anche se economici.
Se nessun candidato è adeguato, restituisci una lista vuota.
Usa SOLO gli id presenti in input.`;

export interface MatchCandidateInput {
  id: string;
  marketplace: string;
  title: string;
  price?: string | null;
  moq?: number | null;
  snippet?: string | null;
}

export interface MatchItemInput {
  name: string;
  quantity: number;
  color?: string | null;
  size?: string | null;
  attributes?: Record<string, string> | null;
  notes?: string | null;
}

export async function matchCandidates(
  item: MatchItemInput,
  candidates: MatchCandidateInput[]
): Promise<MatchResult> {
  if (isAiMock()) return mockMatchCandidates(item, candidates);

  const payload = {
    richiesta: item,
    candidati: candidates,
  };

  const client = getClient();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
    output_config: { format: zodOutputFormat(MatchResultSchema) },
  });

  logUsage("match", response.usage);
  if (!response.parsed_output) {
    throw new Error(
      `Matching fallito (stop_reason=${response.stop_reason}).`
    );
  }

  // Difesa: tieni solo id realmente esistenti e al massimo 3 selezioni.
  const validIds = new Set(candidates.map((c) => c.id));
  return {
    selections: response.parsed_output.selections
      .filter((s) => validIds.has(s.candidateId))
      .slice(0, 3),
  };
}
