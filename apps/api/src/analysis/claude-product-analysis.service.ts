import { Injectable, Logger } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  ANALYSIS_PROMPT_VERSION,
  CLAUDE_MODEL,
  analysisInputHash,
  ProductAnalysisError,
  analyzeProductRows,
  estimateCostUsd,
  hasClaudeApiKey,
  renderRowForAnalysis,
  type AnalysisInputRow,
} from "@china/ai";
import { ProductAnalysisSchema, type ProductAnalysis } from "@china/shared";

/**
 * Analisi delle righe con Claude: cache, lotti, concorrenza e costi.
 *
 * È il servizio isolato di cui parla la specifica. Nessun controller e nessun
 * componente React parla con Claude: parlano con questo servizio, che riceve
 * righe e restituisce analisi validate.
 *
 * Tre proprietà, in ordine di importanza.
 *
 * **La memoria sta a database, non nella conversazione.** Ogni analisi finisce
 * in `RequestAnalysis` con la versione del prompt e il modello che l'hanno
 * prodotta. Prima di chiamare l'API si cerca lì: la stessa riga, con lo stesso
 * prompt e lo stesso modello, non viene mai pagata due volte — nemmeno se
 * arriva da un altro file, sei mesi dopo.
 *
 * **Un fallimento resta locale alla sua riga.** Le righe viaggiano a lotti; se
 * un lotto non torna conforme, le righe che mancano vengono ritentate una sola
 * volta e, se ancora non arrivano, marcate come fallite. Le altre proseguono.
 *
 * **Si sa sempre quanto si è speso.** Chiamate, token e costo stimato tornano
 * insieme ai risultati, e vengono salvati sulla sessione di analisi.
 */

/** Righe per chiamata: piccolo abbastanza da non troncare la risposta. */
const DEFAULT_BATCH_SIZE = 5;
/** Chiamate contemporanee: basso di proposito, per non saturare i limiti. */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Esito dell'analisi di una riga. */
export interface RowAnalysisOutcome {
  rowIndex: number;
  /** Record in `RequestAnalysis`: è la memoria riusabile di questa analisi. */
  analysisId: string;
  analysis: ProductAnalysis | null;
  error: string | null;
  /** `true` se è arrivata dalla cache senza spendere una chiamata. */
  fromCache: boolean;
  submittedText: string;
}

export interface AnalysisUsageTotals {
  apiCalls: number;
  cachedRows: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AnalyzeRowsResult {
  outcomes: RowAnalysisOutcome[];
  usage: AnalysisUsageTotals;
  model: string;
  promptVersion: string;
}

@Injectable()
export class ClaudeProductAnalysisService {
  private readonly logger = new Logger("ClaudeProductAnalysis");

  get promptVersion(): string {
    return ANALYSIS_PROMPT_VERSION;
  }

  get model(): string {
    return CLAUDE_MODEL;
  }

  /** `true` se una chiave è configurata (mai il valore). */
  get isConfigured(): boolean {
    return hasClaudeApiKey();
  }

  /**
   * Analizza un insieme di righe.
   *
   * L'ordine dell'array restituito segue quello delle righe in ingresso, ma
   * l'associazione vera passa sempre da `rowIndex`.
   */
  async analyzeRows(
    rows: readonly AnalysisInputRow[],
    options: { ignoreCache?: boolean } = {}
  ): Promise<AnalyzeRowsResult> {
    const usage: AnalysisUsageTotals = {
      apiCalls: 0,
      cachedRows: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const outcomes = new Map<number, RowAnalysisOutcome>();
    if (rows.length === 0) {
      return { outcomes: [], usage, model: this.model, promptVersion: this.promptVersion };
    }

    // 1. Cache. Si fa in blocco: una sola interrogazione per tutto il file.
    const pending: AnalysisInputRow[] = [];
    const textByRow = new Map<number, string>();
    for (const row of rows) {
      textByRow.set(row.rowIndex, renderRowForAnalysis(row));
    }

    if (options.ignoreCache) {
      pending.push(...rows);
    } else {
      const hashes = [...new Set([...textByRow.values()].map(analysisInputHash))];
      const cached = await prisma.requestAnalysis.findMany({
        where: {
          inputHash: { in: hashes },
          promptVersion: this.promptVersion,
          model: this.model,
        },
      });
      const byHash = new Map(cached.map((entry) => [entry.inputHash, entry]));

      for (const row of rows) {
        const submittedText = textByRow.get(row.rowIndex)!;
        const hit = byHash.get(analysisInputHash(submittedText));
        // Un fallimento in cache non viene riusato: l'errore poteva essere
        // temporaneo, e ripetere la riga costa una chiamata, non una consegna
        // sbagliata.
        if (!hit || !hit.ok || !hit.analysis) {
          pending.push(row);
          continue;
        }
        const parsed = ProductAnalysisSchema.safeParse(hit.analysis);
        if (!parsed.success) {
          // Analisi salvata con uno schema più vecchio: si rianalizza.
          pending.push(row);
          continue;
        }
        usage.cachedRows += 1;
        outcomes.set(row.rowIndex, {
          rowIndex: row.rowIndex,
          analysisId: hit.id,
          analysis: parsed.data,
          error: null,
          fromCache: true,
          submittedText,
        });
      }
    }

    if (pending.length > 0 && !this.isConfigured) {
      // Meglio fermarsi qui che marcare tutte le righe come «analisi fallita»:
      // il problema è di configurazione, non delle righe.
      throw new ProductAnalysisError(
        "CLAUDE_API_KEY non configurata: impossibile analizzare le richieste.",
        false
      );
    }

    // 2. Chiamate a lotti, con un numero limitato di lotti in volo.
    const batchSize = Math.max(1, Math.floor(numericEnv("ANALYSIS_BATCH_SIZE", DEFAULT_BATCH_SIZE)));
    const concurrency = Math.max(
      1,
      Math.floor(numericEnv("ANALYSIS_CONCURRENCY", DEFAULT_CONCURRENCY))
    );

    const batches: AnalysisInputRow[][] = [];
    for (let index = 0; index < pending.length; index += batchSize) {
      batches.push(pending.slice(index, index + batchSize));
    }

    const missed: AnalysisInputRow[] = [];
    const failures = new Map<number, string>();

    await this.runBatches(batches, concurrency, async (batch) => {
      const result = await this.callBatch(batch, usage);
      for (const row of batch) {
        const analysis = result.analyses.get(row.rowIndex);
        if (analysis) {
          const stored = await this.remember(
            textByRow.get(row.rowIndex)!,
            analysis,
            result.perRow
          );
          outcomes.set(row.rowIndex, {
            rowIndex: row.rowIndex,
            analysisId: stored,
            analysis,
            error: null,
            fromCache: false,
            submittedText: textByRow.get(row.rowIndex)!,
          });
        } else {
          // Riga assente dalla risposta, o lotto fallito per intero.
          if (result.retryable) missed.push(row);
          else failures.set(row.rowIndex, result.error ?? "Analisi non restituita dal modello.");
        }
      }
    });

    // 3. Un solo nuovo tentativo, riga per riga: se il lotto era troppo grande
    //    o il modello ne ha saltata una, da sola ce la fa.
    if (missed.length > 0) {
      this.logger.warn(`${missed.length} righe da ritentare singolarmente`);
      await this.runBatches([...missed.map((row) => [row])], concurrency, async (batch) => {
        const result = await this.callBatch(batch, usage);
        for (const row of batch) {
          const analysis = result.analyses.get(row.rowIndex);
          if (analysis) {
            const stored = await this.remember(
              textByRow.get(row.rowIndex)!,
              analysis,
              result.perRow
            );
            outcomes.set(row.rowIndex, {
              rowIndex: row.rowIndex,
              analysisId: stored,
              analysis,
              error: null,
              fromCache: false,
              submittedText: textByRow.get(row.rowIndex)!,
            });
          } else {
            failures.set(
              row.rowIndex,
              result.error ?? "Analisi non restituita dal modello dopo un nuovo tentativo."
            );
          }
        }
      });
    }

    // 4. I fallimenti vengono salvati anch'essi: l'errore è un dato, e senza
    //    salvarlo l'interfaccia non potrebbe spiegare perché la riga è ferma.
    for (const [rowIndex, error] of failures) {
      const submittedText = textByRow.get(rowIndex)!;
      const stored = await this.rememberFailure(submittedText, error);
      outcomes.set(rowIndex, {
        rowIndex,
        analysisId: stored,
        analysis: null,
        error,
        fromCache: false,
        submittedText,
      });
    }

    return {
      outcomes: rows.map(
        (row) =>
          outcomes.get(row.rowIndex) ?? {
            rowIndex: row.rowIndex,
            analysisId: "",
            analysis: null,
            error: "Riga non analizzata.",
            fromCache: false,
            submittedText: textByRow.get(row.rowIndex) ?? "",
          }
      ),
      usage,
      model: this.model,
      promptVersion: this.promptVersion,
    };
  }

  /**
   * Esegue una chiamata e aggiorna i totali.
   *
   * Non rilancia: un lotto fallito è un esito, non un'eccezione. Il chiamante
   * decide se ritentare guardando `retryable`.
   */
  private async callBatch(
    batch: readonly AnalysisInputRow[],
    usage: AnalysisUsageTotals
  ): Promise<{
    analyses: Map<number, ProductAnalysis>;
    perRow: { inputTokens: number; outputTokens: number; costUsd: number };
    retryable: boolean;
    error: string | null;
  }> {
    const timeoutMs = numericEnv("ANALYSIS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    try {
      const result = await analyzeProductRows(batch, { timeoutMs });
      usage.apiCalls += 1;
      usage.inputTokens += result.inputTokens;
      usage.outputTokens += result.outputTokens;
      usage.costUsd += result.costUsd;

      // I token di un lotto si ripartiscono fra le righe che ne sono uscite:
      // è una stima, ma è l'unica ripartizione onesta possibile e permette di
      // dire quanto è costata una singola riga.
      const produced = Math.max(1, result.analyses.size);
      const perRow = {
        inputTokens: Math.round(result.inputTokens / produced),
        outputTokens: Math.round(result.outputTokens / produced),
        costUsd: result.costUsd / produced,
      };
      return { analyses: result.analyses, perRow, retryable: false, error: null };
    } catch (error) {
      // La chiamata è stata tentata: va contata anche se non ha prodotto nulla.
      usage.apiCalls += 1;
      const retryable = error instanceof ProductAnalysisError ? error.retryable : false;
      const message = error instanceof Error ? error.message : "Errore imprevisto";
      this.logger.warn(`lotto di ${batch.length} righe fallito: ${message}`);
      return {
        analyses: new Map(),
        perRow: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        // Un lotto di una riga sola non si ritenta ancora: sarebbe il secondo
        // tentativo, e il limite è uno.
        retryable: retryable && batch.length > 1,
        error: message,
      };
    }
  }

  /** Esegue i lotti con al massimo `concurrency` chiamate in volo. */
  private async runBatches<T>(
    batches: readonly T[],
    concurrency: number,
    run: (batch: T) => Promise<void>
  ): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= batches.length) return;
        await run(batches[index]!);
      }
    });
    await Promise.all(workers);
  }

  /** Salva un'analisi riuscita nella memoria del sistema. */
  private async remember(
    submittedText: string,
    analysis: ProductAnalysis,
    perRow: { inputTokens: number; outputTokens: number; costUsd: number }
  ): Promise<string> {
    const data = {
      submittedText,
      analysis: toJson(analysis),
      ok: true,
      error: null,
      confidence: analysis.confidence,
      inputTokens: perRow.inputTokens,
      outputTokens: perRow.outputTokens,
      costUsd: perRow.costUsd,
    };
    const record = await prisma.requestAnalysis.upsert({
      where: {
        inputHash_promptVersion_model: {
          inputHash: analysisInputHash(submittedText),
          promptVersion: this.promptVersion,
          model: this.model,
        },
      },
      create: {
        inputHash: analysisInputHash(submittedText),
        promptVersion: this.promptVersion,
        model: this.model,
        ...data,
      },
      update: data,
      select: { id: true },
    });
    return record.id;
  }

  private async rememberFailure(submittedText: string, error: string): Promise<string> {
    const data = {
      submittedText,
      analysis: Prisma.DbNull,
      ok: false,
      error: error.slice(0, 500),
    };
    const record = await prisma.requestAnalysis.upsert({
      where: {
        inputHash_promptVersion_model: {
          inputHash: analysisInputHash(submittedText),
          promptVersion: this.promptVersion,
          model: this.model,
        },
      },
      create: {
        inputHash: analysisInputHash(submittedText),
        promptVersion: this.promptVersion,
        model: this.model,
        ...data,
      },
      update: data,
      select: { id: true },
    });
    return record.id;
  }

  /** Costo stimato di un consumo, ai prezzi di listino del modello. */
  estimateCost(inputTokens: number, outputTokens: number): number {
    return estimateCostUsd(inputTokens, outputTokens);
  }
}
