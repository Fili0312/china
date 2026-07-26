import { z } from "zod";
import { deepSeekModel, hasDeepSeekApiKey } from "./analyze-products-deepseek";
import { estimateDeepSeekCostUsd } from "./usage";

/**
 * Riscrittura della query per le righe senza un prodotto coerente.
 *
 * Nasce dalla ri-ricerca «guidata dai difetti»: la verifica di coerenza ha già
 * detto **perché** i prodotti trovati non andavano bene (misura diversa,
 * materiale sbagliato, altra famiglia). Qui quel «perché» diventa una query
 * cinese nuova, pensata per correggere proprio quell'errore — invece di
 * ripetere la ricerca che aveva già mancato il bersaglio.
 *
 * Gira su DeepSeek (economico): è un compito di riscrittura mirata, non di
 * ragionamento profondo. Una chiamata sola per tutte le righe da rifare.
 */

export interface RefineQueryInput {
  /** Indice stabile della riga: torna identico nella risposta. */
  rowIndex: number;
  /** La richiesta come interpretata (nome, misure, materiale, vincoli). */
  request: string;
  /** La query cinese già usata, che ha mancato il bersaglio. */
  previousQuery: string;
  /** Perché i risultati non andavano: i motivi della verifica di coerenza. */
  failureReasons: string[];
}

const SYSTEM = `Sei un tecnico d'acquisti esperto di ricerche su Taobao/1688.

Per ogni riga ricevi: la richiesta del cliente, la query cinese già provata (che NON ha trovato il prodotto giusto) e i MOTIVI per cui i risultati non andavano bene. Proponi UNA query cinese nuova, migliore, che ritrovi esattamente il prodotto della richiesta.

Regole:
- Correggi ciò che i motivi segnalano: se dicono "misura diversa", metti la misura ESATTA della richiesta; se "materiale diverso", aggiungi il materiale giusto; se "altra famiglia/tipo", cambia il termine principale.
- Usa SOLO caratteristiche distintive del prodotto: tipo, misura, modello/codice, materiale, finitura.
- NON mettere quantità né unità di conteggio (个/张/支/件/套/pcs).
- La query deve essere DIVERSA dalla precedente: se ripeti la stessa, non serve a niente.
- Codici e modelli restano identici a come sono scritti.
- Se davvero non sai come migliorarla, riscrivi la richiesta nei termini cinesi più semplici e generali (una ricerca ampia è meglio di una ricerca sbagliata).`;

const BatchSchema = z.object({
  results: z.array(z.object({ rowIndex: z.number(), query: z.string() })),
});

export interface RefineQueryResult {
  /** Query nuova per `rowIndex`; assente se il modello non ne ha proposta una valida. */
  queries: Map<number, string>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export class RefineQueryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "RefineQueryError";
  }
}

/** `true` se DeepSeek è configurato per la riscrittura. */
export function canRefineQueries(): boolean {
  return hasDeepSeekApiKey();
}

/** Propone una query cinese nuova per ogni riga, in una sola chiamata DeepSeek. */
export async function proposeSearchQueries(
  rows: readonly RefineQueryInput[],
  options: { timeoutMs?: number } = {}
): Promise<RefineQueryResult> {
  const model = deepSeekModel();
  if (rows.length === 0) {
    return { queries: new Map(), inputTokens: 0, outputTokens: 0, costUsd: 0, model };
  }

  const apiKey = (process.env.DEEP_SEEK_API || process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    throw new RefineQueryError("DEEP_SEEK_API non configurata: impossibile riscrivere le query.", false);
  }
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const timeout = options.timeoutMs ?? (Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60_000);
  const schema = JSON.stringify(z.toJSONSchema(BatchSchema));

  const payload = rows
    .map(
      (row) =>
        `<riga indice="${row.rowIndex}">\n` +
        `richiesta: ${row.request}\n` +
        `query già provata: ${row.previousQuery || "(nessuna)"}\n` +
        `motivi del fallimento: ${row.failureReasons.length ? row.failureReasons.join("; ") : "nessun prodotto coerente trovato"}\n` +
        `</riga>`
    )
    .join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              SYSTEM +
              `\n\n## Formato della risposta (obbligatorio)\n\nRispondi con un SOLO oggetto json conforme a: ${schema}\n` +
              `Una voce per OGNI riga, con lo stesso "rowIndex".`,
          },
          {
            role: "user",
            content: `Proponi una query cinese migliore per queste ${rows.length} righe. Rispondi in json.\n\n${payload}`,
          },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 4000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    throw new RefineQueryError(
      aborted ? `DeepSeek non ha risposto entro ${timeout} ms.` : (error as Error).message,
      true
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new RefineQueryError(
      `DeepSeek ha risposto ${response.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
      response.status === 429 || response.status >= 500
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new RefineQueryError("DeepSeek ha restituito una risposta vuota.", true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RefineQueryError("DeepSeek ha restituito json non valido.", false);
  }

  const requested = new Set(rows.map((row) => row.rowIndex));
  const previousByRow = new Map(rows.map((row) => [row.rowIndex, row.previousQuery.trim()]));
  const loose = z
    .object({ results: z.array(z.object({}).passthrough()) })
    .safeParse(parsed);
  const queries = new Map<number, string>();
  if (loose.success) {
    for (const raw of loose.data.results as Array<Record<string, unknown>>) {
      const rowIndex = Number(raw.rowIndex);
      const query = typeof raw.query === "string" ? raw.query.trim() : "";
      if (!Number.isFinite(rowIndex) || !requested.has(rowIndex) || !query) continue;
      // Una query identica alla precedente non aiuta: si scarta.
      if (query === previousByRow.get(rowIndex)) continue;
      queries.set(rowIndex, query);
    }
  }

  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? 0;
  return {
    queries,
    inputTokens,
    outputTokens,
    costUsd: estimateDeepSeekCostUsd(inputTokens, outputTokens, cacheHitTokens),
    model,
  };
}
