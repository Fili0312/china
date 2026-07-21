import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ProductAnalysisBatchSchema,
  type ProductAnalysis,
} from "@china/shared";
import { createHash } from "node:crypto";
import { CLAUDE_MODEL, getClient } from "./client";
import { estimateCostUsd } from "./usage";

/**
 * Analisi delle richieste d'acquisto con Claude.
 *
 * Questo è l'**unico** punto del progetto che parla con l'API di Claude per lo
 * scouting. Chi lo usa passa righe e riceve analisi validate: non vede la
 * chiave, non vede il prompt, non vede l'SDK. La chiave sta solo nel processo
 * server (`CLAUDE_API_KEY` / `ANTHROPIC_API_KEY`) e non compare mai nei log,
 * nelle risposte API o a database.
 *
 * Due decisioni meritano una spiegazione.
 *
 * **Perché a lotti.** Una chiamata per riga pagherebbe il prompt di sistema
 * decine di volte su un file da 200 righe. Le righe viaggiano insieme, ma ogni
 * risultato torna etichettato con il proprio `rowIndex`: non ci si affida mai
 * all'ordine dell'array, perché una riga saltata dal modello sposterebbe in
 * silenzio tutte le analisi successive sulla riga sbagliata.
 *
 * **Perché nessuna modalità simulata.** `parse-request` ha un `AI_MOCK` per
 * sviluppare senza chiave. Qui no: un'analisi finta produrrebbe chiavi di
 * variante finte, che finirebbero a database e resterebbero lì a decidere il
 * riuso di prodotti veri. Senza chiave questo modulo fallisce, e lo dice.
 */

/**
 * Versione del prompt. **Va cambiata a ogni modifica del testo qui sotto**:
 * fa parte della chiave della cache, quindi un prompt nuovo produce analisi
 * nuove invece di riusare quelle vecchie chiedendo domande diverse.
 */
export const ANALYSIS_PROMPT_VERSION = "2026-07-21.2";

const SYSTEM = `Sei un tecnico d'acquisti che prepara la ricerca di prodotti industriali sui marketplace cinesi (Taobao, 1688, Alibaba, Yiwugo, Chinagoods, Made-in-China).

Ricevi righe di un foglio di richiesta d'acquisto, spesso in cinese, a volte in inglese o italiano. Per ogni riga produci l'analisi strutturata che permetterà di cercare ESATTAMENTE quel prodotto.

## Regola assoluta: non inventare

Riporta solo ciò che la riga dice.
- Se il modello non è indicato, "model" è null. Non dedurlo dal nome del prodotto.
- Se il materiale non è indicato, "material" è null. Non dedurlo dall'uso tipico.
- Se una misura non ha unità (es. "60*60"), riporta il numero e lascia "unit" a null. NON scegliere tu l'unità.
- Se non riesci a costruire una query in una lingua, quel campo è null.
Un campo null è un'informazione utile; un campo inventato fa comprare il prodotto sbagliato.

## Regola assoluta: termini letterali

In "model", "material", "color", "includedAccessories" e nei valori di "technicalSpecifications" riporta il termine ESATTAMENTE come appare nella riga. Niente traduzioni, niente glosse fra parentesi, niente sinonimi.
Scrivi "陶瓷", non "陶瓷 (ceramica)" né "ceramica". Scrivi "珍珠白", non "珍珠白 (bianco perla)".
Questi campi identificano la variante tecnica: due modi diversi di scrivere lo stesso materiale diventano due prodotti diversi, e la richiesta viene cercata due volte. Le traduzioni vanno in "productNameEnglish" e "searchQueryEnglish", che esistono per quello.

## Ambiguità

Quando una misura, un modello, un'unità o la quantità sono ambigui:
1. inserisci un warning con il codice giusto ("AMBIGUOUS_MEASURE", "AMBIGUOUS_MODEL", "AMBIGUOUS_UNIT", "AMBIGUOUS_QUANTITY", "MULTIPLE_PRODUCTS", "MISSING_INFO", "UNCLEAR_TEXT", "OTHER");
2. abbassa "confidence".
Se la riga contiene più prodotti distinti, analizza il principale e segnala "MULTIPLE_PRODUCTS".

Scala di "confidence": 0.9-1.0 riga chiara e completa; 0.7-0.9 chiara ma con dettagli mancanti non essenziali; 0.4-0.7 un elemento importante è ambiguo; sotto 0.4 non sei sicuro di quale prodotto si tratti.

## Famiglia e variante

- "familyKey": identità della famiglia in inglese, kebab-case, SENZA misure, modelli, colori o materiali specifici. Righe che chiedono lo stesso tipo di prodotto devono ricevere la stessa familyKey, anche se scritte in lingue diverse.
  Esempi: 陶瓷针规 5mm e 陶瓷针规 6mm -> entrambe "ceramic-pin-gauge"; 平板灯 60*60 -> "led-panel-light"; 砝码 M1镀铬400g -> "calibration-weight".
- "productFamily": la stessa famiglia in italiano, leggibile.
- "variantKey": etichetta breve e leggibile della configurazione (es. "5 mm", "60x60 bianco", "M1 400 g"). Serve solo a farla riconoscere a un umano.

## Misure e specifiche

- "dimensions": una voce per quota, con asse ("length", "width", "height", "depth", "diameter", "outerDiameter", "innerDiameter", "thickness", "other"), valore e unità come scritta. Con "other" indica l'etichetta originale in "label"; negli altri casi "label" è null.
  In "长200*宽40" -> length 200 e width 40. In "60*60" senza etichette usa length e width in quest'ordine, con unit null.
- "technicalSpecifications": specifiche tecniche OBBLIGATORIE con chiave inglese minuscola, valore e unità separati. Usa queste chiavi quando applicabili: voltage, power, capacity, weight, frequency, current, pressure, flow, temperature, accuracyClass, protectionRating, threadSize, tolerance.
  "砝码 M1镀铬400g" -> [{"key":"accuracyClass","value":"M1","unit":null},{"key":"weight","value":"400","unit":"g"}].
- Non mettere in technicalSpecifications ciò che è già in dimensions, model, material o color.
- "includedAccessories": solo accessori esplicitamente inclusi nella fornitura.
- "hardRequirements": vincoli che il prodotto DEVE rispettare (certificazioni, normative, compatibilità obbligatorie).
- "softRequirements": preferenze che non escludono un prodotto.

## Query di ricerca

- "searchQueryChinese": termini che un compratore cinese digiterebbe su Taobao/1688. Se il nome originale è già cinese, partine e aggiungi le caratteristiche distintive (misura, modello, materiale). Niente quantità, niente reparto, niente parole amministrative.
- "searchQueryEnglish": l'equivalente per le fonti export.
- Mantieni codici e modelli IDENTICI in entrambe le lingue: un codice non si traduce.

## Quantità

"requestedQuantity" e "unit" sono la quantità richiesta e la sua unità, se indicate. Non influenzano famiglia e variante: servono solo a valutare minimi d'ordine e prezzi a scaglioni.`;

/** Una riga da analizzare, già ripulita dai dati amministrativi. */
export interface AnalysisInputRow {
  /** Indice stabile scelto da chi chiama: torna identico nella risposta. */
  rowIndex: number;
  /** Nome prodotto originale, nella lingua del foglio. */
  name: string;
  /** Specifiche/descrizione, se la riga ne ha. */
  spec: string | null;
  /** Uso previsto (`用途`), quando presente. */
  usage: string | null;
  quantity: string | null;
  unit: string | null;
  /** Titolo prodotto già indicato nel foglio, se c'è. */
  declaredTitle: string | null;
  /** Link presente nell'Excel, se c'è. */
  referenceUrl: string | null;
}

export interface AnalysisCallResult {
  /** Analisi riuscite, indicizzate per `rowIndex`. */
  analyses: Map<number, ProductAnalysis>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

/**
 * Testo di una riga come viene inviato al modello.
 *
 * È anche la chiave della cache: due righe che producono lo stesso testo
 * riusano la stessa analisi. Per questo il formato deve essere stabile —
 * campi sempre nello stesso ordine, campi vuoti sempre omessi — e non deve
 * contenere nulla che cambi da un file all'altro senza cambiare il prodotto.
 */
export function renderRowForAnalysis(row: AnalysisInputRow): string {
  const parts: string[] = [`Nome: ${row.name.trim()}`];
  if (row.spec?.trim()) parts.push(`Specifiche: ${row.spec.trim()}`);
  if (row.usage?.trim()) parts.push(`Utilizzo: ${row.usage.trim()}`);
  if (row.quantity?.trim()) parts.push(`Quantità: ${row.quantity.trim()}`);
  if (row.unit?.trim()) parts.push(`Unità: ${row.unit.trim()}`);
  if (row.declaredTitle?.trim()) parts.push(`Titolo indicato: ${row.declaredTitle.trim()}`);
  if (row.referenceUrl?.trim()) parts.push(`Link: ${row.referenceUrl.trim()}`);
  return parts.join("\n");
}

/**
 * Impronta del testo inviato: è la chiave della cache delle analisi.
 *
 * Sta qui e non nel servizio perché deve cambiare **insieme** al formato del
 * testo: se un giorno `renderRowForAnalysis` aggiungesse un campo, tutte le
 * impronte cambierebbero, e le due funzioni devono restare nello stesso file
 * perché quel legame sia evidente a chi modifica.
 */
export function analysisInputHash(submittedText: string): string {
  return createHash("sha256").update(submittedText).digest("hex").slice(0, 32);
}

/** Errore dell'analisi, con l'indicazione se valga la pena riprovare. */
export class ProductAnalysisError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ProductAnalysisError";
  }
}

/**
 * Analizza un lotto di righe in una sola chiamata.
 *
 * Non ritenta e non gestisce la concorrenza: quelle decisioni appartengono a
 * chi orchestra l'analisi di un file intero, che sa quante righe restano e
 * quanto si è già speso. Qui si fa una chiamata e si riportano i risultati
 * validi, quelli che non lo sono e quanto è costata.
 */
export async function analyzeProductRows(
  rows: readonly AnalysisInputRow[],
  options: { timeoutMs?: number; effort?: "low" | "medium" | "high" } = {}
): Promise<AnalysisCallResult> {
  if (rows.length === 0) {
    return {
      analyses: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: CLAUDE_MODEL,
    };
  }

  const client = getClient();
  const payload = rows
    .map((row) => `<riga indice="${row.rowIndex}">\n${renderRowForAnalysis(row)}\n</riga>`)
    .join("\n\n");

  let response;
  try {
    response = await client.messages.parse(
      {
        model: CLAUDE_MODEL,
        // Ampio ma non enorme: con lotti piccoli basta, e resta sotto i tempi
        // di attesa HTTP dell'SDK senza dover passare allo streaming.
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `Analizza queste ${rows.length} righe. Restituisci un risultato per ` +
              `ogni riga, riportando in "rowIndex" lo stesso indice che trovi ` +
              `nell'attributo della riga.\n\n${payload}`,
          },
        ],
        output_config: {
          format: zodOutputFormat(ProductAnalysisBatchSchema),
          // L'estrazione strutturata non ha bisogno di ragionamento profondo:
          // è il ragionamento a costare, non lo schema.
          effort: options.effort ?? "low",
        },
      },
      { timeout: options.timeoutMs ?? 120_000 }
    );
  } catch (error) {
    // I messaggi dell'SDK non contengono la chiave, ma il tipo dell'errore sì
    // può contenere l'intestazione della richiesta: si riporta solo il testo.
    const message = error instanceof Error ? error.message : "Errore imprevisto";
    const status = (error as { status?: number }).status ?? 0;
    // 4xx (a parte 429) significa richiesta sbagliata: ritentarla è inutile.
    const retryable = status === 0 || status === 429 || status >= 500;
    throw new ProductAnalysisError(message, retryable);
  }

  if (response.stop_reason === "refusal") {
    throw new ProductAnalysisError(
      "Claude ha rifiutato di analizzare queste righe.",
      false
    );
  }
  if (!response.parsed_output) {
    throw new ProductAnalysisError(
      `Analisi non conforme allo schema (stop_reason=${response.stop_reason}).`,
      // `max_tokens` è l'unico caso in cui riprovare ha senso: con un lotto
      // più piccolo la risposta ci sta.
      response.stop_reason === "max_tokens"
    );
  }

  const requested = new Set(rows.map((row) => row.rowIndex));
  const analyses = new Map<number, ProductAnalysis>();
  for (const entry of response.parsed_output.results) {
    // Un indice non richiesto è un'allucinazione: scartarlo è meglio che
    // attribuire l'analisi a una riga a caso.
    if (!requested.has(entry.rowIndex)) continue;
    analyses.set(entry.rowIndex, entry.analysis);
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    analyses,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(inputTokens, outputTokens),
    model: CLAUDE_MODEL,
  };
}
