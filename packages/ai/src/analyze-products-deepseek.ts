import { z } from "zod";
import { ProductAnalysisSchema, ProductAnalysisBatchSchema, type ProductAnalysis } from "@china/shared";
import {
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SYSTEM_PROMPT,
  knowledgeBlock,
  renderRowForAnalysis,
  ProductAnalysisError,
  type AnalysisCallResult,
  type AnalysisInputRow,
} from "./analyze-products";
import { estimateDeepSeekCostUsd } from "./usage";

/**
 * Analisi delle righe con DeepSeek: stesso prompt base di Claude, ma pipeline
 * **più profonda** — perché qui la profondità costa centesimi.
 *
 * Il ragionamento economico è ribaltato rispetto a Claude. Con un modello da
 * $5/$25 al milione di token ogni passata in più si paga cara, e la pipeline
 * fa una chiamata sola per lotto. Con `deepseek-v4-flash` ($0,14/$0,28) la
 * stessa passata costa ~50 volte meno: si può spendere il doppio ed essere
 * comunque due ordini di grandezza sotto — e quel doppio si spende in
 * **precisione**:
 *
 * 1. **Lotti più piccoli** (6 righe invece di 10): più attenzione per riga,
 *    risposte più corte e meno troncabili.
 * 2. **Addendum di precisione** nel prompt di estrazione: gli errori osservati
 *    nel confronto con Claude (quantità infilate nella query, dettagli persi,
 *    confidenza gonfiata) diventano regole esplicite.
 * 3. **Seconda passata di revisione**: il modello rilegge il testo originale
 *    accanto alla propria analisi e corregge — campo per campo, con una
 *    checklist. È il controllo qualità che su Claude non ci si può permettere
 *    di serie, e qui sì.
 *
 * Il resto non cambia: stesso schema, stessa validazione Zod, stessa cache
 * (con la versione di pipeline **propria** di questo provider nella chiave),
 * stessi warning e stessa revisione manuale a valle. La chiave
 * (`DEEP_SEEK_API`) vive solo nel processo server: mai nei log, mai nelle
 * risposte, mai a database.
 */

/** Modello di listino: il chat non-reasoning attuale. `deepseek-chat` è
 * deprecato dal 2026-07-24 e mappa su questo. */
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 60_000;
/** Lotti piccoli di proposito: la profondità va spesa per riga, non per file. */
const DEFAULT_BATCH_SIZE = 6;

/**
 * Versione della pipeline DeepSeek: prompt condiviso + revisione propria.
 * Va cambiata a ogni modifica dell'addendum o della checklist di revisione —
 * è ciò che impedisce di spacciare un'analisi vecchia per una nuova.
 */
const PIPELINE_SUFFIX = "ds.2";

export function deepSeekPipelineVersion(): string {
  return `${ANALYSIS_PROMPT_VERSION}+${PIPELINE_SUFFIX}`;
}

export function deepSeekPreferredBatchSize(): number {
  const parsed = Number(process.env.DEEPSEEK_ANALYSIS_BATCH_SIZE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_BATCH_SIZE;
}

/** La revisione si può spegnere (`DEEPSEEK_REFINE=0`), ma di serie è accesa. */
function refineEnabled(): boolean {
  return process.env.DEEPSEEK_REFINE !== "0";
}

function readApiKey(): string | undefined {
  // `DEEP_SEEK_API` è il nome già presente nel .env del progetto;
  // `DEEPSEEK_API_KEY` è l'alias convenzionale, accettato per robustezza.
  return process.env.DEEP_SEEK_API || process.env.DEEPSEEK_API_KEY || undefined;
}

/** `true` se una chiave è configurata, senza rivelarne il valore. */
export function hasDeepSeekApiKey(): boolean {
  return Boolean(readApiKey());
}

export function deepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
}

function deepSeekBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function deepSeekTimeoutMs(): number {
  const parsed = Number(process.env.DEEPSEEK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Regole di precisione aggiunte al prompt di estrazione.
 *
 * Ogni voce nasce da un errore **osservato** nel confronto con Claude sullo
 * stesso file, non da un timore teorico: è la lista di ciò che questo modello
 * sbaglia quando non glielo si dice.
 */
const PRECISION_ADDENDUM = `

## Precisione (regole aggiuntive, obbligatorie)

- Nelle query di ricerca NON mettere MAI la quantità richiesta né la sua unità di conteggio (个, 张, 支, 件, 套, pcs…): "100张" in una query trasforma la ricerca del prodotto nella ricerca di una confezione.
- Riporta nella query TUTTE le caratteristiche distintive presenti nel testo (materiale, predisposizioni, finitura): perdere "带锁孔" o "树脂制" significa trovare il prodotto sbagliato.
- Estrai OGNI quota presente nel testo in "dimensions", nessuna esclusa, con l'asse giusto.
- La confidenza va guadagnata: se un'unità manca, un modello è incerto o il testo è povero, la confidenza DEVE scendere secondo la scala. Una confidenza alta con un warning attivo è una contraddizione.`;

/**
 * Il contratto JSON, spiegato nel prompt.
 *
 * Con `json_object` DeepSeek garantisce solo «JSON valido»: la forma la deve
 * imparare dal prompt. Lo schema si genera dagli **stessi** Zod usati per la
 * validazione — scriverlo a mano qui creerebbe due verità destinate a
 * divergere alla prima modifica dello schema.
 */
function jsonInstructions(): string {
  const schema = JSON.stringify(z.toJSONSchema(ProductAnalysisBatchSchema));
  return (
    `\n\n## Formato della risposta (obbligatorio)\n\n` +
    `Rispondi con un SOLO oggetto json, senza testo fuori dal json, conforme a questo JSON Schema:\n` +
    `${schema}\n\n` +
    `Esempio della forma (valori inventati):\n` +
    `{"results":[{"rowIndex":3,"analysis":{"productFamily":"pesi di taratura","familyKey":"calibration-weight",` +
    `"variantKey":"M1 400 g","productNameChinese":"砝码","productNameEnglish":"calibration weight",` +
    `"model":null,"material":null,"color":null,"dimensions":[],` +
    `"technicalSpecifications":[{"key":"accuracyClass","value":"M1","unit":null}],` +
    `"includedAccessories":[],"hardRequirements":[],"softRequirements":[],` +
    `"requestedQuantity":2,"unit":"个","searchQueryChinese":"砝码 M1 400g","searchQueryEnglish":"calibration weight M1 400g",` +
    `"confidence":0.95,"warnings":[]}}]}\n\n` +
    `Includi in "results" una voce per OGNI riga ricevuta, con lo stesso "rowIndex".`
  );
}

/**
 * La checklist della seconda passata: il revisore rilegge testo e analisi.
 *
 * Non è un secondo parere libero — è un controllo puntuale delle regole che
 * la prima passata può aver violato. Il revisore restituisce l'analisi
 * corretta (identica, se era già giusta): mai un commento, mai una nota.
 */
const REVIEW_SYSTEM = `Sei il revisore qualità delle analisi di un foglio di richieste d'acquisto per marketplace cinesi.

Ricevi coppie: il testo ORIGINALE di una riga e l'analisi PROPOSTA (json). Il tuo compito è restituire l'analisi CORRETTA — identica a quella proposta se è già giusta, corretta dove non lo è. Controlla nell'ordine:

1. NIENTE INVENZIONI. Ogni valore non scritto nel testo deve essere null: unità mancante → "unit" null + warning "AMBIGUOUS_UNIT"; modello non indicato → "model" null. Se l'analisi ha riempito un campo che il testo non dice, svuotalo.
2. TERMINI LETTERALI. "model", "material", "color", "includedAccessories" e i valori delle specifiche devono essere ESATTAMENTE come nel testo (niente traduzioni o sinonimi).
3. MISURE COMPLETE. Ogni quota del testo deve stare in "dimensions" con l'asse giusto; niente quote duplicate in "technicalSpecifications".
4. SPECIFICHE COMPLETE. Tensioni, potenze, portate, classi di precisione presenti nel testo devono stare in "technicalSpecifications" con chiave inglese minuscola.
5. QUERY PULITE E COMPLETE. Le query non contengono quantità, unità di conteggio (个/张/支/件/套/pcs), reparto o parole amministrative; contengono TUTTE le caratteristiche distintive (misura, modello, materiale, finiture, predisposizioni); i codici restano identici nelle due lingue.
6. WARNING GIUSTI. Un warning per ogni ambiguità reale (codici: AMBIGUOUS_MEASURE, AMBIGUOUS_MODEL, AMBIGUOUS_UNIT, AMBIGUOUS_QUANTITY, MULTIPLE_PRODUCTS, MISSING_INFO, UNCLEAR_TEXT, OTHER); nessun warning se non c'è ambiguità.
7. CONFIDENZA ONESTA. Scala: 0.9-1.0 riga chiara e completa; 0.7-0.9 chiara con dettagli non essenziali mancanti; 0.4-0.7 un elemento importante è ambiguo; sotto 0.4 prodotto incerto. Se hai corretto errori o ci sono warning, la confidenza deve rifletterlo.

Non cambiare "rowIndex". Non aggiungere righe. Non togliere righe.`;

/** Forma esterna letta con tolleranza: ogni analisi si valida da sé. */
const LooseBatchSchema = z.object({
  results: z.array(z.object({ rowIndex: z.number(), analysis: z.unknown() })),
});

interface DeepSeekResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Campi DeepSeek: token del prompt serviti dalla cache del fornitore. */
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string };
}

interface DeepSeekCallOutcome {
  /** Analisi valide per rowIndex; le righe non conformi restano assenti. */
  analyses: Map<number, ProductAnalysis>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Una chiamata DeepSeek in JSON mode, dal prompt alle analisi validate.
 *
 * Unica per le due passate: estrazione e revisione differiscono solo nei
 * messaggi, e due copie di trasporto+validazione divergerebbero alla prima
 * correzione.
 */
async function callDeepSeek(
  requestedRowIndexes: ReadonlySet<number>,
  system: string,
  user: string,
  options: { timeoutMs?: number; temperature: number }
): Promise<DeepSeekCallOutcome> {
  const apiKey = readApiKey();
  if (!apiKey) {
    throw new ProductAnalysisError(
      "DEEP_SEEK_API mancante: impostala nel .env del server per usare DeepSeek.",
      false
    );
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? deepSeekTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${deepSeekBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: deepSeekModel(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        // Estrazione, non ragionamento: la modalità thinking di default
        // costerebbe token senza cambiare lo schema (parametro documentato).
        thinking: { type: "disabled" },
        // Generoso: un json troncato costa comunque e va rifatto.
        max_tokens: 16000,
        temperature: options.temperature,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    // Timeout o rete: vale la pena riprovare, magari con un lotto più piccolo.
    const message = controller.signal.aborted
      ? `DeepSeek non ha risposto entro ${timeoutMs} ms.`
      : error instanceof Error
        ? error.message
        : "Errore di rete verso DeepSeek.";
    throw new ProductAnalysisError(message, true);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Il corpo può contenere il messaggio d'errore del fornitore, mai la
    // chiave: si riporta solo il testo.
    const body = (await response.json().catch(() => null)) as DeepSeekResponse | null;
    const detail = body?.error?.message ? `: ${body.error.message}` : "";
    throw new ProductAnalysisError(
      `DeepSeek ha risposto ${response.status}${detail}`,
      response.status === 429 || response.status >= 500
    );
  }

  const body = (await response.json()) as DeepSeekResponse;
  const content = body.choices?.[0]?.message?.content ?? "";
  const finishReason = body.choices?.[0]?.finish_reason ?? "";

  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? 0;
  const costUsd = estimateDeepSeekCostUsd(inputTokens, outputTokens, cacheHitTokens);

  if (!content.trim()) {
    // Caso documentato da DeepSeek: il json mode può tornare vuoto. Riprovare
    // (da soli, riga per riga) di solito lo risolve.
    throw new ProductAnalysisError("DeepSeek ha restituito una risposta vuota.", true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProductAnalysisError(
      `DeepSeek ha restituito json non valido (finish_reason=${finishReason}).`,
      finishReason === "length"
    );
  }

  const outer = LooseBatchSchema.safeParse(parsed);
  if (!outer.success) {
    throw new ProductAnalysisError(
      "DeepSeek ha restituito json con una forma diversa da quella richiesta.",
      true
    );
  }

  // Ogni analisi si valida da sola: una riga non conforme non butta il lotto,
  // resta assente e viene ritentata singolarmente dal chiamante — lo stesso
  // comportamento del flusso Claude.
  const analyses = new Map<number, ProductAnalysis>();
  for (const entry of outer.data.results) {
    if (!requestedRowIndexes.has(entry.rowIndex)) continue;
    const analysis = ProductAnalysisSchema.safeParse(entry.analysis);
    if (!analysis.success) continue;
    analyses.set(entry.rowIndex, analysis.data);
  }

  return { analyses, inputTokens, outputTokens, costUsd };
}

/**
 * Analizza un lotto di righe con DeepSeek: estrazione + revisione.
 *
 * Stesso contratto di `analyzeProductRows`: nessun ritento e nessuna
 * concorrenza qui — le decide chi orchestra il file intero. La revisione è
 * migliorativa per costruzione: se la sua chiamata fallisce o una riga
 * rivista non è conforme, resta la bozza dell'estrazione. Una passata di
 * qualità non deve mai *perdere* righe.
 */
export async function deepSeekAnalyzeRows(
  rows: readonly AnalysisInputRow[],
  options: { timeoutMs?: number; knowledge?: readonly string[] } = {}
): Promise<AnalysisCallResult> {
  const model = deepSeekModel();
  if (rows.length === 0) {
    return { analyses: new Map(), inputTokens: 0, outputTokens: 0, costUsd: 0, model };
  }

  const knowledge = options.knowledge?.length ? knowledgeBlock(options.knowledge) : "";
  const requested = new Set(rows.map((row) => row.rowIndex));
  const textByRow = new Map(rows.map((row) => [row.rowIndex, renderRowForAnalysis(row)]));

  // 1. Estrazione: il prompt condiviso, più le regole di precisione.
  const extraction = await callDeepSeek(
    requested,
    ANALYSIS_SYSTEM_PROMPT + PRECISION_ADDENDUM + knowledge + jsonInstructions(),
    `Analizza queste ${rows.length} righe e rispondi in json. Restituisci un ` +
      `risultato per ogni riga, riportando in "rowIndex" lo stesso indice ` +
      `dell'attributo della riga.\n\n` +
      rows
        .map((row) => `<riga indice="${row.rowIndex}">\n${textByRow.get(row.rowIndex)}\n</riga>`)
        .join("\n\n"),
    { timeoutMs: options.timeoutMs, temperature: 0.2 }
  );

  let analyses = extraction.analyses;
  let inputTokens = extraction.inputTokens;
  let outputTokens = extraction.outputTokens;
  let costUsd = extraction.costUsd;

  // 2. Revisione: il modello rilegge testo e bozza, e corregge. Best effort:
  //    un errore qui non tocca ciò che l'estrazione ha già prodotto.
  if (refineEnabled() && analyses.size > 0) {
    try {
      const drafts = [...analyses.entries()];
      const review = await callDeepSeek(
        new Set(drafts.map(([rowIndex]) => rowIndex)),
        REVIEW_SYSTEM + knowledge + jsonInstructions(),
        `Rivedi queste ${drafts.length} analisi e restituisci il json corretto.\n\n` +
          drafts
            .map(
              ([rowIndex, draft]) =>
                `<riga indice="${rowIndex}">\n<testo-originale>\n${textByRow.get(rowIndex)}\n</testo-originale>\n` +
                `<analisi-proposta>\n${JSON.stringify(draft)}\n</analisi-proposta>\n</riga>`
            )
            .join("\n\n"),
        { timeoutMs: options.timeoutMs, temperature: 0.1 }
      );
      inputTokens += review.inputTokens;
      outputTokens += review.outputTokens;
      costUsd += review.costUsd;

      // La versione rivista sostituisce la bozza solo dove esiste ed è
      // conforme; ogni altra riga tiene la bozza.
      const merged = new Map(analyses);
      for (const [rowIndex, revised] of review.analyses) {
        merged.set(rowIndex, revised);
      }
      analyses = merged;
    } catch {
      // La bozza resta: la revisione è un miglioramento, non un requisito.
    }
  }

  return { analyses, inputTokens, outputTokens, costUsd, model };
}
