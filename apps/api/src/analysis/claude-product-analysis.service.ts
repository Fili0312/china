import { Injectable, Logger } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  ANALYSIS_PROMPT_VERSION,
  activeAnalysisProvider,
  analysisInputHash,
  ProductAnalysisError,
  estimateCostUsd,
  renderRowForAnalysis,
  type AnalysisInputRow,
  type AnalysisProvider,
} from "@china/ai";
import {
  CRITICAL_WARNING_CODES,
  ProductAnalysisSchema,
  sanitizeProductAnalysis,
  type ProductAnalysis,
} from "@china/shared";

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

/**
 * Righe per chiamata.
 *
 * Il prompt di sistema pesa ~2000 token e viene ripagato a ogni chiamata: con
 * lotti da 5 erano 400 token di sola intestazione per riga. A 10 si dimezzano,
 * e la risposta resta ampiamente sotto il tetto di `max_tokens`. Più su non
 * conviene: una risposta troncata costa comunque e va rifatta.
 */
const DEFAULT_BATCH_SIZE = 10;
/** Chiamate contemporanee: basso di proposito, per non saturare i limiti. */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Profondità di ragionamento chiesta al modello.
 *
 * `low` di default: questo è un compito di estrazione strutturata, non di
 * ragionamento: su dieci righe reali `low` ha prodotto le stesse famiglie, le
 * stesse varianti e gli stessi avvertimenti di `high`, con le confidenze entro
 * 0,05 — a un terzo dei token di ragionamento. Alzarlo resta possibile
 * (`ANALYSIS_EFFORT=high`) se un foglio particolarmente ostico lo richiede.
 */
function analysisEffort(): "low" | "medium" | "high" {
  const raw = (process.env.ANALYSIS_EFFORT ?? "low").toLowerCase();
  return raw === "high" || raw === "medium" ? raw : "low";
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

/** Stato del budget di prova DeepSeek: quanto si può ancora spendere. */
export interface DeepSeekBudget {
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

@Injectable()
export class ClaudeProductAnalysisService {
  private readonly logger = new Logger("ProductAnalysis");

  /**
   * Il provider attivo, riletto a ogni uso.
   *
   * La scelta sta in `AI_ANALYSIS_PROVIDER` (`claude` di default,
   * `deepseek` per il test). Nessun fallback automatico: se il provider
   * scelto fallisce, le righe falliscono con il suo errore.
   */
  private get activeProvider(): AnalysisProvider {
    return activeAnalysisProvider();
  }

  get promptVersion(): string {
    // La versione è del provider: DeepSeek ha una pipeline propria (estrazione
    // + revisione) e la sua cache non deve mescolarsi con analisi meno
    // profonde. Per Claude coincide con `ANALYSIS_PROMPT_VERSION` di sempre.
    return this.activeProvider.promptVersion;
  }

  get model(): string {
    return this.activeProvider.model;
  }

  get providerName(): string {
    return this.activeProvider.name;
  }

  /** `true` se la chiave del provider attivo è configurata (mai il valore). */
  get isConfigured(): boolean {
    return this.activeProvider.configured;
  }

  /** Tetto di spesa per il test DeepSeek, dal `.env`. */
  private static deepSeekBudgetLimit(): number {
    const parsed = Number(process.env.DEEPSEEK_TEST_BUDGET_USD);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
  }

  /**
   * Quanto è già stato speso con DeepSeek, letto dalla cache delle analisi.
   *
   * È il totale storico, non quello della sessione: il budget è un tetto di
   * prova complessivo, e riavviare il processo non deve azzerarlo.
   */
  async deepSeekBudget(): Promise<DeepSeekBudget> {
    const limitUsd = ClaudeProductAnalysisService.deepSeekBudgetLimit();
    const aggregate = await prisma.requestAnalysis.aggregate({
      where: { provider: "deepseek" },
      _sum: { costUsd: true },
    });
    const spentUsd = aggregate._sum.costUsd ?? 0;
    return { limitUsd, spentUsd, remainingUsd: Math.max(0, limitUsd - spentUsd) };
  }

  /** Stato del motore di analisi: provider, modello, budget. Mai le chiavi. */
  async status() {
    const provider = this.activeProvider;
    return {
      configured: provider.configured,
      provider: provider.name,
      model: provider.model,
      promptVersion: provider.promptVersion,
      budget: provider.name === "deepseek" ? await this.deepSeekBudget() : null,
    };
  }

  /**
   * Analizza un insieme di righe.
   *
   * L'ordine dell'array restituito segue quello delle righe in ingresso, ma
   * l'associazione vera passa sempre da `rowIndex`.
   */
  async analyzeRows(
    rows: readonly AnalysisInputRow[],
    options: {
      ignoreCache?: boolean;
      /** Risposte già date dall'operatore, con la loro impronta. */
      knowledge?: { entries: readonly string[]; digest: string };
    } = {}
  ): Promise<AnalyzeRowsResult> {
    const usage: AnalysisUsageTotals = {
      apiCalls: 0,
      cachedRows: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    // Un'istantanea per tutta la sessione: se il .env cambiasse a metà file,
    // metà righe con un modello e metà con l'altro sarebbero inconfrontabili.
    const provider = this.activeProvider;
    const budget = provider.name === "deepseek" ? await this.deepSeekBudget() : null;

    const outcomes = new Map<number, RowAnalysisOutcome>();
    if (rows.length === 0) {
      return { outcomes: [], usage, model: provider.model, promptVersion: provider.promptVersion };
    }

    // La conoscenza entra nella chiave di cache: una risposta nuova produce
    // analisi nuove. Il testo salvato resta pulito — il sale sta solo
    // nell'impronta, così l'interfaccia continua a mostrare la riga vera.
    const salt = options.knowledge?.digest
      ? `\n[conoscenza:${options.knowledge.digest}]`
      : "";
    const hashFor = (text: string) => analysisInputHash(text + salt);

    // 1. Cache. Si fa in blocco: una sola interrogazione per tutto il file.
    const pending: AnalysisInputRow[] = [];
    const textByRow = new Map<number, string>();
    for (const row of rows) {
      textByRow.set(row.rowIndex, renderRowForAnalysis(row));
    }

    if (options.ignoreCache) {
      pending.push(...rows);
    } else {
      const hashes = [
        ...new Set(
          [...textByRow.values()].flatMap((text) =>
            salt ? [hashFor(text), analysisInputHash(text)] : [analysisInputHash(text)]
          )
        ),
      ];
      // La cache distingue provider e modello: un'analisi Claude non è mai
      // una risposta DeepSeek. Le due convivono per la stessa riga, ed è ciò
      // che permette di confrontarle senza rifare chiamate.
      const cached = await prisma.requestAnalysis.findMany({
        where: {
          inputHash: { in: hashes },
          promptVersion: provider.promptVersion,
          model: provider.model,
          provider: provider.name,
        },
      });
      const byHash = new Map(cached.map((entry) => [entry.inputHash, entry]));

      for (const row of rows) {
        const submittedText = textByRow.get(row.rowIndex)!;
        let hit = byHash.get(hashFor(submittedText));

        // Conoscenza nuova, riga vecchia: la risposta di un operatore cambia
        // solo le righe che avevano un'ambiguità critica. Una riga analizzata
        // senza quei warning non aveva niente da chiedere — riusarla evita di
        // ripagare l'intero file a ogni risposta data.
        if ((!hit || !hit.ok || !hit.analysis) && salt) {
          const unsalted = byHash.get(analysisInputHash(submittedText));
          if (unsalted?.ok && unsalted.analysis) {
            const parsed = ProductAnalysisSchema.safeParse(unsalted.analysis);
            if (
              parsed.success &&
              !parsed.data.warnings.some((warning) =>
                (CRITICAL_WARNING_CODES as readonly string[]).includes(warning.code)
              )
            ) {
              hit = unsalted;
            }
          }
        }

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

    // Righe identiche nello stesso file: si analizza **una volta sola** e il
    // risultato vale per tutte. Nei fogli reali è la metà del lavoro — un
    // foglio di riepilogo che ripete i reparti — e senza questo passo si
    // pagherebbe due volte la stessa identica domanda. La cache a database non
    // basta: dentro una singola esecuzione le righe partono insieme e nessuna
    // ha ancora scritto il proprio risultato.
    const duplicatesByHash = new Map<string, number[]>();
    const unique: AnalysisInputRow[] = [];
    for (const row of pending) {
      const hash = hashFor(textByRow.get(row.rowIndex)!);
      const seen = duplicatesByHash.get(hash);
      if (seen) {
        seen.push(row.rowIndex);
        continue;
      }
      duplicatesByHash.set(hash, []);
      unique.push(row);
    }
    const duplicateRows = pending.length - unique.length;
    if (duplicateRows > 0) {
      this.logger.log(
        `${duplicateRows} righe ripetute nel file: analizzate una volta sola`
      );
    }

    if (unique.length > 0 && !provider.configured) {
      // Meglio fermarsi qui che marcare tutte le righe come «analisi fallita»:
      // il problema è di configurazione, non delle righe.
      throw new ProductAnalysisError(
        provider.name === "deepseek"
          ? "DEEP_SEEK_API non configurata: impossibile analizzare con DeepSeek."
          : "CLAUDE_API_KEY non configurata: impossibile analizzare le richieste.",
        false
      );
    }

    // 2. Chiamate a lotti, con un numero limitato di lotti in volo.
    // I lotti li decide il provider (Claude 10, DeepSeek più piccoli), salvo
    // un override esplicito dal .env che vale per tutti.
    const batchSize = Math.max(
      1,
      Math.floor(numericEnv("ANALYSIS_BATCH_SIZE", provider.preferredBatchSize))
    );
    const concurrency = Math.max(
      1,
      Math.floor(numericEnv("ANALYSIS_CONCURRENCY", DEFAULT_CONCURRENCY))
    );

    const batches: AnalysisInputRow[][] = [];
    for (let index = 0; index < unique.length; index += batchSize) {
      batches.push(unique.slice(index, index + batchSize));
    }

    const missed: AnalysisInputRow[] = [];
    const failures = new Map<number, string>();
    /** L'errore del lotto, da riportare se anche il tentativo singolo fallisce. */
    const lastBatchError = new Map<number, string | null>();

    await this.runBatches(batches, concurrency, async (batch) => {
      const result = await this.callBatch(batch, usage, provider, budget, options.knowledge?.entries);
      for (const row of batch) {
        const analysis = result.analyses.get(row.rowIndex);
        if (analysis) {
          const stored = await this.remember(
            provider,
            textByRow.get(row.rowIndex)!,
            hashFor(textByRow.get(row.rowIndex)!),
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
          //
          // Si ritenta comunque, anche quando l'errore non si dichiara
          // ritentabile: il secondo tentativo è per riga singola, quindi
          // affronta un problema diverso da quello del lotto — una riga che
          // il modello ha saltato, o un lotto troppo lungo. Costa una
          // chiamata per riga fallita e in cambio non si perdono righe per
          // un errore che riguardava le vicine. Se fallisce anche da sola,
          // l'errore viene registrato lì.
          missed.push(row);
          lastBatchError.set(row.rowIndex, result.error ?? null);
        }
      }
    });

    // 3. Un solo nuovo tentativo, riga per riga: se il lotto era troppo grande
    //    o il modello ne ha saltata una, da sola ce la fa.
    if (missed.length > 0) {
      this.logger.warn(`${missed.length} righe da ritentare singolarmente`);
      await this.runBatches([...missed.map((row) => [row])], concurrency, async (batch) => {
        const result = await this.callBatch(batch, usage, provider, budget, options.knowledge?.entries);
        for (const row of batch) {
          const analysis = result.analyses.get(row.rowIndex);
          if (analysis) {
            const stored = await this.remember(
              provider,
              textByRow.get(row.rowIndex)!,
              hashFor(textByRow.get(row.rowIndex)!),
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
              result.error ??
                lastBatchError.get(row.rowIndex) ??
                "Analisi non restituita dal modello dopo un nuovo tentativo."
            );
          }
        }
      });
    }

    // 4. Le righe gemelle ricevono l'esito della loro capofila — successo o
    //    fallimento che sia. Si copia anche `submittedText`, che è identico
    //    per costruzione: è la ragione stessa per cui sono gemelle.
    for (const [hash, gemelle] of duplicatesByHash) {
      if (gemelle.length === 0) continue;
      const capofila = [...outcomes.values()].find(
        (outcome) => hashFor(outcome.submittedText) === hash
      );
      const errore = capofila
        ? null
        : (failures.get(gemelle[0]!) ?? "Riga non analizzata.");
      for (const rowIndex of gemelle) {
        outcomes.set(
          rowIndex,
          capofila
            ? { ...capofila, rowIndex }
            : {
                rowIndex,
                analysisId: "",
                analysis: null,
                error: errore,
                fromCache: false,
                submittedText: textByRow.get(rowIndex) ?? "",
              }
        );
      }
    }

    // 5. I fallimenti vengono salvati anch'essi: l'errore è un dato, e senza
    //    salvarlo l'interfaccia non potrebbe spiegare perché la riga è ferma.
    for (const [rowIndex, error] of failures) {
      const submittedText = textByRow.get(rowIndex)!;
      const stored = await this.rememberFailure(
        provider,
        submittedText,
        hashFor(submittedText),
        error
      );
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
      model: provider.model,
      promptVersion: provider.promptVersion,
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
    usage: AnalysisUsageTotals,
    provider: AnalysisProvider,
    budget: DeepSeekBudget | null,
    knowledge?: readonly string[]
  ): Promise<{
    analyses: Map<number, ProductAnalysis>;
    perRow: { inputTokens: number; outputTokens: number; costUsd: number };
    retryable: boolean;
    error: string | null;
  }> {
    // Il tetto di prova si controlla PRIMA di ogni lotto: quando la spesa
    // storica più quella di questa sessione lo raggiunge, i lotti successivi
    // non partono e le righe restano con un errore che dice quanto resta.
    if (budget && budget.spentUsd + usage.costUsd >= budget.limitUsd) {
      const residuo = Math.max(0, budget.limitUsd - budget.spentUsd - usage.costUsd);
      return {
        analyses: new Map(),
        perRow: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        retryable: false,
        error:
          `Budget di prova DeepSeek raggiunto (limite $${budget.limitUsd.toFixed(2)}, ` +
          `residuo $${residuo.toFixed(2)}): analisi interrotta senza nuove chiamate. ` +
          `Alza DEEPSEEK_TEST_BUDGET_USD per continuare.`,
      };
    }

    const timeoutMs = numericEnv("ANALYSIS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    try {
      const result = await provider.analyzeBatch(batch, {
        timeoutMs,
        effort: analysisEffort(),
        knowledge,
      });
      // Le pulizie deterministiche valgono per ogni provider: le regole che i
      // prompt possono violare (quantità nella query) qui diventano codice.
      for (const [rowIndex, analysis] of result.analyses) {
        result.analyses.set(rowIndex, sanitizeProductAnalysis(analysis));
      }
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

  /**
   * Salva un'analisi riuscita nella memoria del sistema.
   *
   * `cacheHash` è l'impronta **con** l'eventuale sale della conoscenza: il
   * testo salvato resta quello vero, la chiave riflette le condizioni in cui
   * l'analisi è stata prodotta.
   */
  private async remember(
    provider: AnalysisProvider,
    submittedText: string,
    cacheHash: string,
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
        inputHash_promptVersion_model_provider: {
          inputHash: cacheHash,
          promptVersion: provider.promptVersion,
          model: provider.model,
          provider: provider.name,
        },
      },
      create: {
        inputHash: cacheHash,
        promptVersion: provider.promptVersion,
        model: provider.model,
        provider: provider.name,
        ...data,
      },
      update: data,
      select: { id: true },
    });
    return record.id;
  }

  private async rememberFailure(
    provider: AnalysisProvider,
    submittedText: string,
    cacheHash: string,
    error: string
  ): Promise<string> {
    const data = {
      submittedText,
      analysis: Prisma.DbNull,
      ok: false,
      error: error.slice(0, 500),
    };
    const record = await prisma.requestAnalysis.upsert({
      where: {
        inputHash_promptVersion_model_provider: {
          inputHash: cacheHash,
          promptVersion: provider.promptVersion,
          model: provider.model,
          provider: provider.name,
        },
      },
      create: {
        inputHash: cacheHash,
        promptVersion: provider.promptVersion,
        model: provider.model,
        provider: provider.name,
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
