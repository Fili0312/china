import { z } from "zod";
import { getClient } from "./client";
import { deepSeekModel, hasDeepSeekApiKey } from "./analyze-products-deepseek";
import { estimateCostUsd, estimateDeepSeekCostUsd } from "./usage";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

/**
 * Quale variante comprare, quando il confronto meccanico non decide.
 *
 * La scelta della variante è prima di tutto un lavoro da stringhe: se il foglio
 * scrive «50MM宽*50米长» e l'inserzione ha quella riga identica, nessun modello
 * serve. Ma restano i casi in cui più varianti combaciano davvero e a separarle
 * è il significato, non il testo: «110CM平板拖把 蓝色» sta bene sia su
 * «110CM、蓝色拖把（含杆子）» — il mocio completo, 61,62 — sia su
 * «110CM、蓝色单个替换布（不含铁架）» — solo il panno di ricambio, 24,96. Sono
 * due prodotti diversi a due prezzi diversi, e sbagliare significa quotare un
 * panno al posto di un mocio.
 *
 * Il modello qui fa **una cosa sola**: sceglie fra le varianti che esistono
 * davvero, indicandole per numero. Non inventa prezzi, non propone alternative,
 * non riscrive nulla. E può rispondere «nessuna», che è la risposta giusta
 * quando l'inserzione non vende ciò che il foglio chiede — meglio una riga da
 * guardare a mano di una variante scelta per non lasciare il campo vuoto.
 */

const ChoiceSchema = z.object({
  /**
   * Il numero della variante scelta, come compare nell'elenco; `null` se
   * nessuna corrisponde a ciò che il foglio chiede.
   */
  index: z.number().int().nullable(),
  /** Perché quella e non le altre, in una riga. Serve a chi rilegge la scelta. */
  reason: z.string(),
  /** Quanto è sicuro: sotto la soglia la riga resta da controllare. */
  confidence: z.number().min(0).max(1),
});

export type VariantChoice = z.infer<typeof ChoiceSchema>;

export interface VariantPickInput {
  /** Il nome del prodotto come sta nel foglio del cliente. */
  productName: string;
  /** La colonna delle specifiche: è questa che deve combaciare. */
  spec: string;
  /** Il titolo dell'inserzione, che spesso dice cosa si sta guardando. */
  listingTitle: string;
  /** Le varianti in ballo, nell'ordine in cui verranno indicate per numero. */
  variants: ReadonlyArray<{ label: string; price: number | null }>;
}

export interface VariantPickResult {
  choice: VariantChoice | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

const CLAUDE_MODEL = "claude-sonnet-5";

const SYSTEM = `Sei un buyer che compra ricambi e materiali di consumo su Taobao per un'azienda italiana.

Ti viene data una riga di un foglio di richiesta d'acquisto — nome del prodotto e specifica — e l'elenco delle varianti che l'inserzione vende davvero. Devi dire **quale variante** corrisponde a ciò che il foglio chiede.

## Come scegliere

1. La **specifica** comanda: misura, modello, colore, quantità per confezione.
2. Attenzione a **che cosa** è la variante, non solo a quanto misura. Un panno di ricambio non è un mocio; un cofanetto da 101 pezzi non è il pezzo singolo; «含杆子» (con manico) e «不含铁架» (senza telaio) sono prodotti diversi.
3. Se la specifica indica una misura e le varianti sono fasce, scegli la fascia che **contiene** quella misura.
4. A parità di tutto il resto, la più economica.

## Quando rispondere «nessuna»

Rispondi \`index: null\` se l'inserzione non vende ciò che il foglio chiede: modello assente, misura fuori da ogni fascia, prodotto di un altro tipo. Una riga lasciata da controllare costa a chi la guarda cinque secondi; una variante sbagliata costa un ordine.

Rispondi \`index: null\` anche quando due varianti sono **davvero** equivalenti rispetto a ciò che il foglio dice e a separarle è un dato che il foglio non contiene: quella scelta spetta a una persona.

La confidenza dev'essere alta solo quando la specifica indica la variante senza margini: se stai interpretando, dillo abbassandola.`;

function renderPrompt(input: VariantPickInput): string {
  const elenco = input.variants
    .map((variant, index) => {
      const prezzo = variant.price != null ? `${variant.price}` : "prezzo assente";
      return `${index}. «${variant.label}» — ${prezzo}`;
    })
    .join("\n");
  return [
    `Riga del foglio:`,
    `  prodotto: ${input.productName}`,
    `  specifica: ${input.spec}`,
    ``,
    `Inserzione: ${input.listingTitle}`,
    ``,
    `Varianti in vendita:`,
    elenco,
    ``,
    `Quale variante corrisponde alla riga del foglio? Rispondi con il suo numero.`,
  ].join("\n");
}

/**
 * Sceglie la variante con il modello, o restituisce `null` se non ci riesce.
 *
 * **Non solleva mai.** Questa è una scorciatoia opzionale su una strada che
 * funziona già: se il modello non risponde, o risponde male, la riga torna a
 * essere quella che era — una variante da scegliere a mano. Far fallire una
 * ricerca da centinaia di righe perché un modello ha risposto 500 sarebbe uno
 * scambio pessimo.
 */
export async function pickVariantWithAi(
  input: VariantPickInput,
  options: { timeoutMs?: number } = {}
): Promise<VariantPickResult> {
  const useDeepSeek = hasDeepSeekApiKey();
  const vuoto: VariantPickResult = {
    choice: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    model: useDeepSeek ? deepSeekModel() : CLAUDE_MODEL,
  };
  if (input.variants.length === 0) return vuoto;

  try {
    const result = useDeepSeek
      ? await pickWithDeepSeek(input, options.timeoutMs)
      : await pickWithClaude(input, options.timeoutMs);
    if (!result.choice) return result;
    // Un numero fuori dall'elenco è una variante che non esiste: si scarta.
    const index = result.choice.index;
    if (index != null && (index < 0 || index >= input.variants.length)) {
      return { ...result, choice: { ...result.choice, index: null } };
    }
    return result;
  } catch {
    return vuoto;
  }
}

async function pickWithClaude(
  input: VariantPickInput,
  timeoutMs?: number
): Promise<VariantPickResult> {
  const client = getClient();
  const response = await client.messages.parse(
    {
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: renderPrompt(input) }],
      output_config: { format: zodOutputFormat(ChoiceSchema), effort: "low" },
    },
    { timeout: timeoutMs ?? 60_000 }
  );
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    choice: response.parsed_output ?? null,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(inputTokens, outputTokens),
    model: CLAUDE_MODEL,
  };
}

async function pickWithDeepSeek(
  input: VariantPickInput,
  timeoutMs?: number
): Promise<VariantPickResult> {
  const apiKey = (process.env.DEEP_SEEK_API || process.env.DEEPSEEK_API_KEY || "").trim();
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(
    /\/+$/,
    ""
  );
  const timeout = timeoutMs ?? (Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60_000);
  const schema = JSON.stringify(z.toJSONSchema(ChoiceSchema));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: deepSeekModel(),
        messages: [
          {
            role: "system",
            content: `${SYSTEM}\n\n## Formato della risposta (obbligatorio)\n\nRispondi con un SOLO oggetto json conforme a questo JSON Schema:\n${schema}`,
          },
          { role: "user", content: `${renderPrompt(input)}\n\nRispondi in json.` },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 800,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DeepSeek ha risposto ${response.status}`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    const parsed = ChoiceSchema.safeParse(JSON.parse(content));
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    return {
      choice: parsed.success ? parsed.data : null,
      inputTokens,
      outputTokens,
      costUsd: estimateDeepSeekCostUsd(inputTokens, outputTokens),
      model: deepSeekModel(),
    };
  } finally {
    clearTimeout(timer);
  }
}
