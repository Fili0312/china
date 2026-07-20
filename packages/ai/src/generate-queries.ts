import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  GeneratedQueries,
  GeneratedQueriesSchema,
  ParsedItem,
} from "@china/shared";
import { CLAUDE_MODEL, getClient, isAiMock } from "./client";
import { mockGenerateQueries } from "./mock";
import { logUsage } from "./usage";

const SYSTEM = `Generi query di ricerca per marketplace B2B di sourcing (Alibaba, Made-in-China, 1688).
Per ogni articolo produci:
- queryEn: query in inglese, 3-6 parole chiave commerciali (come le scriverebbe un buyer), includendo le caratteristiche discriminanti: materiale, misura/capacità e personalizzazione se richiesta (es. "custom logo"). NON includere quantità né colore se il prodotto è disponibile in più colori.
- queryZh: la stessa query in cinese semplificato, con i termini merceologici usati su 1688/Taobao.
Rispondi con una voce per ogni articolo di input, usando lo stesso indice.`;

export async function generateQueries(
  items: ParsedItem[]
): Promise<GeneratedQueries> {
  if (isAiMock()) return mockGenerateQueries(items);

  const input = items
    .map((it, i) => {
      const attrs = Object.entries(it.attributes ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `${i}. ${it.name}${it.color ? ` | colore: ${it.color}` : ""}${
        it.size ? ` | misura: ${it.size}` : ""
      }${attrs ? ` | ${attrs}` : ""}`;
    })
    .join("\n");

  const client = getClient();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: input }],
    output_config: { format: zodOutputFormat(GeneratedQueriesSchema) },
  });

  logUsage("queries", response.usage);
  if (!response.parsed_output) {
    throw new Error(
      `Generazione query fallita (stop_reason=${response.stop_reason}).`
    );
  }
  return response.parsed_output;
}
