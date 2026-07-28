import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CLAUDE_MODEL, getClient } from "./client";
import { deepSeekModel, hasDeepSeekApiKey } from "./analyze-products-deepseek";
import { estimateCostUsd, estimateDeepSeekCostUsd } from "./usage";

/**
 * Seconda passata IA: i prodotti trovati sono davvero ciò che il foglio chiede?
 *
 * La prima passata legge il foglio; la ricerca trova candidati; questa passata
 * li **giudica**. Riceve la richiesta com'è stata interpretata e i candidati
 * con titolo, specifiche e prezzo, e per ciascuno risponde a una sola domanda:
 * è coerente con la richiesta?
 *
 * Quando il giudizio dipende da un'informazione che solo l'operatore ha (es.
 * «il cliente accetta il modello successivo?»), il verdetto è `unsure` e la
 * passata formula UNA domanda: la risposta finisce nella stessa memoria delle
 * domande dell'analisi, così la volta dopo il sistema giudica da solo.
 *
 * **Motore configurabile.** `AI_VERIFY_PROVIDER` sceglie chi giudica:
 * `deepseek` (default) o `claude`. È il passaggio con più testo — richiesta più
 * tre prodotti per riga — quindi quello dove il costo del modello pesa di più:
 * su DeepSeek la stessa verifica costa circa cinquanta volte meno. Il prompt,
 * lo schema e la validazione restano identici: cambia solo chi risponde.
 */

/** Va cambiata a ogni modifica del prompt: è parte dell'identità del verdetto. */
export const COHERENCE_PROMPT_VERSION = "2026-07-28.3";

const SYSTEM = `Sei il controllo qualità di uno scouting di prodotti su Taobao/1688.

Ricevi richieste d'acquisto (interpretate da un foglio Excel del cliente) e, per ognuna, i prodotti candidati trovati dalla ricerca. Per OGNI candidato giudichi se è coerente con la richiesta.

## La distinzione che conta: CONTRADDETTO ≠ NON DICHIARATO

Le inserzioni Taobao hanno titoli incompleti: quasi nessuna ripete tutte le specifiche richieste. Questa è la normalità, non un difetto del prodotto.

Per ogni cosa che la richiesta specifica, chiediti quale dei due casi è:

- **CONTRADDETTO** — l'inserzione dichiara un valore ed è diverso.
  «richiesti 5 pollici, il titolo dice 8 pollici» · «richiesto acciaio, il titolo dice plastica» · «richiesto modello X, il titolo dice modello Y».
- **NON DICHIARATO** — l'inserzione semplicemente non ne parla.
  «il titolo non menziona l'acciaio 420» · «non specifica se è in silicone» · «non riporta il codice modello».

Un dato NON DICHIARATO **non è mai** un motivo per respingere. Il prodotto può benissimo essere quello giusto: il venditore non l'ha scritto nel titolo. Chi legge il tuo verdetto andrà a controllare sulla scheda.

Compila "conflictType" con il caso peggiore che hai trovato:
- "explicit" → almeno una cosa CONTRADDETTA.
- "unstated" → niente di contraddetto, ma qualcosa di richiesto non è dichiarato.
- "none" → tutto ciò che la richiesta specifica trova riscontro.

### Quando è "explicit", senza esitare

Queste NON sono assenze. Se ricadi in uno di questi casi il tipo è "explicit":

1. **Puoi citare un valore dell'inserzione diverso da quello richiesto.** Se stai scrivendo «il titolo dice 50 metri ma ne servono 10» o «il titolo dice 30x60 ma serve 60x60», hai trovato una contraddizione. Il fatto che manchino ALTRE informazioni non la cancella.
2. **Il prodotto è di un'altra famiglia merceologica.** Un tester per ionizzatori al posto di un tester elettrostatico, un componente per stampi al posto di un blocchetto di fissaggio, un detergente al posto di un materiale industriale. Qui non serve che manchi un dato: è proprio un altro prodotto.
3. **L'inserzione elenca più valori e quello richiesto non c'è.** «8/10/12 pollici» quando ne servono 5 è una contraddizione, non un silenzio.

Non scrivere mai un dubbio nelle "issues" ("contraddetto?"): decidi. Se hai citato due valori diversi, è "explicit".

Usa "unstated" solo quando dell'attributo richiesto l'inserzione **non dice nulla**: nessun valore da confrontare, nessun elenco in cui cercarlo.

### Il campo "citedListingValue"

Se hai trovato nell'inserzione un valore che differisce da quello richiesto, **riportalo lì testualmente**, come compare: "长50米", "30x60", "8/10/12寸".

Se invece l'inserzione di quell'attributo non parla, "citedListingValue" è null. Non inventarlo e non riportarci il valore *richiesto*: va scritto solo ciò che hai letto nell'inserzione.

## Come giudicare

- "coherent": il prodotto è quello chiesto e nulla di specificato è contraddetto.
- "incoherent": **solo** se qualcosa è CONTRADDETTO, oppure se il prodotto è di un'altra famiglia merceologica (una pinzetta al posto di un calibro, un detergente viso al posto di un materiale industriale).
- "unsure": il prodotto è plausibile ma qualcosa di richiesto non è dichiarato.

Elenca in "issues" ogni cosa che non torna, in italiano, una frase per voce. Scrivi sempre se è contraddetta o solo non dichiarata.

Regole:
- Giudica SOLO dai dati forniti (titolo, specifiche, prezzo, note). Non inventare caratteristiche che non vedi.
- Un dettaglio che la richiesta NON specifica non rende un candidato incoerente.
- Confronta ciò che è confrontabile: il materiale del corpo di un contenitore non contraddice la specifica del suo tappo o del suo ugello.
- Un'inserzione che elenca più misure ("8/10/12 pollici") contiene la misura richiesta **solo se compare nell'elenco**: allora è una variante e non un conflitto. Se non compare, è un conflitto esplicito.
- Un assortimento (un set, una confezione multipla) che comprende plausibilmente il pezzo richiesto è "unsure", non un rifiuto: la variante si sceglie in fase d'ordine.
- Un prezzo fuori scala rispetto agli altri candidati della stessa richiesta va segnalato in "issues" (possibile unità di vendita diversa: pezzo singolo vs confezione), ma da solo non basta per "incoherent".
- "confidence" da 0 a 1 sul tuo verdetto.

## Domande

Se il verdetto è "unsure" per una ragione che l'operatore può chiarire una volta per tutte (convenzione del cliente, unità abituale, tolleranza sul modello), scrivi in "question" UNA domanda breve in italiano. Altrimenti "question" è null. Non fare domande la cui risposta è già nei dati o nella conoscenza fornita.`;

/** Blocco con le risposte già date: le domande risolte non si rifanno. */
function knowledgeBlock(entries: readonly string[]): string {
  return (
    `\n\n## Conoscenza acquisita dall'operatore\n\n` +
    `Risposte già date a domande precedenti — applicale e non rifare le stesse domande:\n\n` +
    entries.map((entry) => `- ${entry}`).join("\n")
  );
}

/** Una richiesta con i suoi candidati da giudicare. */
export interface CoherenceInputRow {
  /** Indice stabile scelto dal chiamante: torna identico nella risposta. */
  rowIndex: number;
  /** La richiesta come interpretata: nome, misure, specifiche, vincoli. */
  request: string;
  candidates: Array<{
    /** Indice del candidato dentro la riga: torna identico nella risposta. */
    candidateIndex: number;
    /** Descrizione del prodotto: titolo, specifiche, prezzo, provenienza. */
    description: string;
  }>;
}

const CoherenceBatchSchema = z.object({
  results: z.array(
    z.object({
      /** Indici della riga e del candidato **come inviati**. */
      rowIndex: z.number(),
      candidateIndex: z.number(),
      verdict: z.enum(["coherent", "incoherent", "unsure"]),
      /**
       * Il caso peggiore trovato: contraddetto, non dichiarato, o nulla.
       *
       * È il campo che decide davvero il verdetto — vedi `settleVerdict`.
       * Chiederlo esplicitamente costringe il modello a separare le due cose
       * invece di fonderle in un unico «non torna».
       */
      conflictType: z.enum(["explicit", "unstated", "none"]),
      /**
       * Il valore **letto nell'inserzione** che differisce da quello richiesto.
       *
       * Se il modello riesce a citarlo, l'inserzione quel dato lo dichiara — e
       * allora non è un silenzio, qualunque cosa abbia scritto in
       * `conflictType`. Serve a chiudere il caso in cui descriveva la
       * contraddizione a parole («il titolo dice 50 metri ma ne servono 10»)
       * e poi votava «non dichiarato».
       */
      citedListingValue: z.string().nullable(),
      /** Cosa non torna, in italiano; vuoto se coerente. */
      issues: z.array(z.string()),
      /** Domanda per l'operatore; null se non serve. */
      question: z.string().nullable(),
      confidence: z.number(),
    })
  ),
});
export type CoherenceBatch = z.infer<typeof CoherenceBatchSchema>;

export interface CoherenceCallResult {
  /** Verdetti per `${rowIndex}:${candidateIndex}`. */
  verdicts: Map<
    string,
    {
      verdict: "coherent" | "incoherent" | "unsure";
      issues: string[];
      question: string | null;
      confidence: number;
    }
  >;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export class CoherenceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "CoherenceError";
  }
}

/** Motore della verifica: DeepSeek di default, Claude su richiesta. */
function verifyProvider(): "deepseek" | "claude" {
  return (process.env.AI_VERIFY_PROVIDER ?? "deepseek").trim().toLowerCase() === "claude"
    ? "claude"
    : "deepseek";
}

/** Il testo dei candidati di tutte le righe, con gli indici che li rilegano. */
function buildPayload(rows: readonly CoherenceInputRow[]): string {
  return rows
    .map((row) => {
      const candidates = row.candidates
        .map(
          (candidate) =>
            `<candidato indice="${candidate.candidateIndex}">\n${candidate.description}\n</candidato>`
        )
        .join("\n");
      return `<richiesta indice="${row.rowIndex}">\n${row.request}\n\n${candidates}\n</richiesta>`;
    })
    .join("\n\n");
}

/**
 * Il verdetto finale, deciso qui e non dal modello.
 *
 * Il modello sbagliava sistematicamente un caso solo: rispondeva `incoherent`
 * per cose che l'inserzione non dichiarava — «il titolo non menziona l'acciaio
 * 420» — respingendo prodotti giusti perché il venditore è stato sintetico.
 * Misurato su una corsa da 498 righe: 183 candidati su 1693 respinti così, che
 * lasciavano 23 righe senza alcun risultato.
 *
 * Chiedere «contraddetto o non dichiarato?» separatamente e derivare qui il
 * verdetto toglie di mezzo l'ambiguità: `unstated` non può più diventare un
 * rifiuto, qualunque cosa il modello scriva in `verdict`. Il caso opposto
 * resta intatto: `explicit` che il modello giudica coerente resta coerente,
 * perché contraddizioni innocue esistono (una misura elencata fra le varianti).
 */
export function settleVerdict(
  verdict: "coherent" | "incoherent" | "unsure",
  conflictType: "explicit" | "unstated" | "none",
  citedListingValue: string | null = null
): "coherent" | "incoherent" | "unsure" {
  // Il modello ha citato un valore letto nell'inserzione: allora quel dato
  // l'inserzione lo dichiara, e «non dichiarato» è una contraddizione in
  // termini. Capitava che descrivesse il conflitto a parole e poi votasse
  // silenzio — un nastro da 50 metri dove ne servivano 10 tornava valutabile.
  const cited = citedListingValue?.trim();
  if (cited && conflictType === "unstated") return verdict;
  if (verdict === "incoherent" && conflictType === "unstated") return "unsure";
  return verdict;
}

/** Verdetti validi per `${rowIndex}:${candidateIndex}`; gli indici non chiesti si scartano. */
function extractVerdicts(
  results: CoherenceBatch["results"],
  rows: readonly CoherenceInputRow[]
): CoherenceCallResult["verdicts"] {
  const requested = new Set(
    rows.flatMap((row) =>
      row.candidates.map((candidate) => `${row.rowIndex}:${candidate.candidateIndex}`)
    )
  );
  const verdicts: CoherenceCallResult["verdicts"] = new Map();
  for (const entry of results) {
    const key = `${entry.rowIndex}:${entry.candidateIndex}`;
    if (!requested.has(key)) continue; // indice non richiesto = allucinazione
    verdicts.set(key, {
      verdict: settleVerdict(entry.verdict, entry.conflictType, entry.citedListingValue),
      issues: entry.issues,
      question: entry.question,
      confidence: Math.min(1, Math.max(0, entry.confidence)),
    });
  }
  return verdicts;
}

/**
 * Giudica un lotto di righe in una sola chiamata.
 *
 * Come per l'analisi: niente ritenti e niente concorrenza qui — quelle
 * decisioni spettano a chi orchestra il job e sa quanto si è già speso. Il
 * motore lo decide `AI_VERIFY_PROVIDER`; se DeepSeek è scelto ma la chiave
 * manca, si ripiega su Claude invece di fallire.
 */
export async function verifyCandidateCoherence(
  rows: readonly CoherenceInputRow[],
  options: { timeoutMs?: number; knowledge?: readonly string[] } = {}
): Promise<CoherenceCallResult> {
  const useDeepSeek = verifyProvider() === "deepseek" && hasDeepSeekApiKey();
  if (rows.length === 0) {
    return {
      verdicts: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: useDeepSeek ? deepSeekModel() : CLAUDE_MODEL,
    };
  }

  const system = options.knowledge?.length ? SYSTEM + knowledgeBlock(options.knowledge) : SYSTEM;
  const payload = buildPayload(rows);
  const user =
    `Giudica i candidati di queste ${rows.length} richieste. Restituisci ` +
    `un risultato per OGNI candidato, riportando "rowIndex" e ` +
    `"candidateIndex" identici agli attributi.\n\n${payload}`;

  return useDeepSeek
    ? verifyWithDeepSeek(rows, system, user, options.timeoutMs)
    : verifyWithClaude(rows, system, user, options.timeoutMs);
}

/** Giudizio con Claude (output strutturato garantito dallo schema Zod). */
async function verifyWithClaude(
  rows: readonly CoherenceInputRow[],
  system: string,
  user: string,
  timeoutMs?: number
): Promise<CoherenceCallResult> {
  const client = getClient();
  let response;
  try {
    response = await client.messages.parse(
      {
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: zodOutputFormat(CoherenceBatchSchema), effort: "low" },
      },
      { timeout: timeoutMs ?? 120_000 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore imprevisto";
    const status = (error as { status?: number }).status ?? 0;
    throw new CoherenceError(message, status === 0 || status === 429 || status >= 500);
  }

  if (response.stop_reason === "refusal") {
    throw new CoherenceError("Claude ha rifiutato di giudicare questi candidati.", false);
  }
  if (!response.parsed_output) {
    throw new CoherenceError(
      `Verifica non conforme allo schema (stop_reason=${response.stop_reason}).`,
      response.stop_reason === "max_tokens"
    );
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    verdicts: extractVerdicts(response.parsed_output.results, rows),
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(inputTokens, outputTokens),
    model: CLAUDE_MODEL,
  };
}

/**
 * Giudizio con DeepSeek (endpoint OpenAI-compatible, `json_object`).
 *
 * DeepSeek non garantisce lo schema: lo si mette nel prompt (generato dagli
 * stessi Zod) e si valida tutto qui, come nell'analisi. Modalità non-reasoning
 * (`thinking: disabled`): è un giudizio strutturato, non un tema.
 */
async function verifyWithDeepSeek(
  rows: readonly CoherenceInputRow[],
  system: string,
  user: string,
  timeoutMs?: number
): Promise<CoherenceCallResult> {
  const apiKey = (process.env.DEEP_SEEK_API || process.env.DEEPSEEK_API_KEY || "").trim();
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const timeout = timeoutMs ?? (Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60_000);
  const schema = JSON.stringify(z.toJSONSchema(CoherenceBatchSchema));
  const jsonSystem =
    system +
    `\n\n## Formato della risposta (obbligatorio)\n\n` +
    `Rispondi con un SOLO oggetto json, senza testo fuori dal json, conforme a questo JSON Schema:\n${schema}\n` +
    `Includi in "results" una voce per OGNI candidato ricevuto, con gli stessi "rowIndex" e "candidateIndex".`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: deepSeekModel(),
        messages: [
          { role: "system", content: jsonSystem },
          { role: "user", content: `${user}\n\nRispondi in json.` },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 16000,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? `DeepSeek non ha risposto entro ${timeout} ms.`
      : error instanceof Error
        ? error.message
        : "Errore di rete verso DeepSeek.";
    throw new CoherenceError(message, true);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const detail = body?.error?.message ? `: ${body.error.message}` : "";
    throw new CoherenceError(
      `DeepSeek ha risposto ${response.status}${detail}`,
      response.status === 429 || response.status >= 500
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  const finishReason = body.choices?.[0]?.finish_reason ?? "";
  if (!content.trim()) {
    throw new CoherenceError("DeepSeek ha restituito una risposta vuota.", true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CoherenceError(
      `DeepSeek ha restituito json non valido (finish_reason=${finishReason}).`,
      finishReason === "length"
    );
  }

  // Forma esterna letta con tolleranza. DeepSeek spesso omette i campi vuoti
  // (`issues` quando è coerente, `question` quando non serve): pretendere lo
  // schema pieno scarterebbe verdetti validi — è ciò che lasciava metà dei
  // candidati senza giudizio. Qui si completano i default invece di buttarli.
  const loose = z
    .object({ results: z.array(z.object({}).passthrough()) })
    .safeParse(parsed);
  if (!loose.success) {
    throw new CoherenceError("DeepSeek ha restituito json con una forma inattesa.", true);
  }
  const valid: CoherenceBatch["results"] = [];
  for (const raw of loose.data.results as Array<Record<string, unknown>>) {
    const rowIndex = Number(raw.rowIndex);
    const candidateIndex = Number(raw.candidateIndex);
    const verdict = raw.verdict;
    if (!Number.isFinite(rowIndex) || !Number.isFinite(candidateIndex)) continue;
    if (verdict !== "coherent" && verdict !== "incoherent" && verdict !== "unsure") continue;
    // Manca il campo? Si resta al verdetto del modello: "explicit" è l'unico
    // valore che non muove nulla. Ammorbidire un rifiuto per un campo che non
    // è arrivato significherebbe promuovere candidati mai valutati come tali.
    const rawConflict = raw.conflictType;
    const conflictType =
      rawConflict === "explicit" || rawConflict === "unstated" || rawConflict === "none"
        ? rawConflict
        : "explicit";
    valid.push({
      rowIndex,
      candidateIndex,
      verdict,
      conflictType,
      citedListingValue:
        typeof raw.citedListingValue === "string" && raw.citedListingValue.trim()
          ? raw.citedListingValue
          : null,
      issues: Array.isArray(raw.issues)
        ? raw.issues.filter((x): x is string => typeof x === "string")
        : [],
      question: typeof raw.question === "string" && raw.question.trim() ? raw.question : null,
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    });
  }

  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? 0;
  return {
    verdicts: extractVerdicts(valid, rows),
    inputTokens,
    outputTokens,
    costUsd: estimateDeepSeekCostUsd(inputTokens, outputTokens, cacheHitTokens),
    model: deepSeekModel(),
  };
}
