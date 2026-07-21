import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import type { AnalysisInputRow } from "@china/ai";
import {
  ANALYSIS_ROW_STATE_LABELS,
  CRITICAL_WARNING_CODES,
  ProductAnalysisSchema,
  computeProductIdentity,
  type AnalysisDbMatch,
  type AnalysisRow,
  type AnalysisRowState,
  type AnalysisRun,
  type DatasetMapping,
  type ProductAnalysis,
  type ProductIdentity,
  type StartAnalysisRequest,
  type UpdateAnalysisRowRequest,
} from "@china/shared";
import { readMappedValues } from "../scouting/normalize-request";
import { ScoutingService } from "../scouting/scouting.service";
import { ClaudeProductAnalysisService } from "./claude-product-analysis.service";
import { KnownProductService } from "../scouting/known-product.service";

/**
 * La fase di revisione: dal file analizzato a righe pronte per la ricerca.
 *
 * Sta fra il servizio Claude e il resto del mondo. I controller parlano solo
 * con questo; Claude non sa nulla di dataset, mappature o database, e il
 * database non sa nulla di prompt.
 *
 * Il lavoro è in tre passi, e vale la pena tenerli distinti:
 *
 * 1. **Cosa chiede la riga** — l'analisi di Claude, validata.
 * 2. **Che prodotto è** — le tre chiavi di identità, calcolate da noi.
 * 3. **Cosa ne sappiamo già** — l'interrogazione al database sulla variante.
 *
 * Il terzo passo si rifà a ogni correzione manuale: se l'utente corregge una
 * misura, la variante cambia, e con essa cambia ciò che il database sa. Non
 * ricalcolarlo mostrerebbe all'utente lo stato del prodotto **precedente**.
 */

/** Sotto questa confidenza la riga non parte da sola. */
const DEFAULT_MIN_CONFIDENCE = 0.65;

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Testo di una cella, ripulito; `null` se vuoto. */
function clean(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text || null;
}

@Injectable()
export class RequestAnalysisService {
  private readonly logger = new Logger("RequestAnalysis");

  constructor(
    private readonly scouting: ScoutingService,
    private readonly claude: ClaudeProductAnalysisService,
    private readonly known: KnownProductService
  ) {}

  get minConfidence(): number {
    return numericEnv("ANALYSIS_MIN_CONFIDENCE", DEFAULT_MIN_CONFIDENCE);
  }

  /**
   * Analizza un file e apre la sessione di revisione.
   *
   * L'analisi è sincrona: su file di qualche centinaio di righe, a lotti e con
   * la cache, dura decine di secondi, e restituire subito il risultato completo
   * evita a chi guarda di dover interrogare un avanzamento per una fase che
   * non ha niente da mostrare mentre è in corso.
   */
  async startRun(
    datasetId: string,
    input: StartAnalysisRequest
  ): Promise<AnalysisRun> {
    const dataset = await prisma.scoutingDataset.findUnique({
      where: { id: datasetId },
      select: { id: true, fileName: true },
    });
    if (!dataset) throw new NotFoundException(`Dataset non trovato: ${datasetId}`);

    const mapping = input.mapping as DatasetMapping[];
    if (!mapping.some((entry) => entry.field === "name")) {
      throw new BadRequestException(
        "Serve almeno una colonna associata al nome prodotto."
      );
    }

    const { columnIndexes, rows } = await this.scouting.loadRows(datasetId);
    const selected = input.maxRows ? rows.slice(0, input.maxRows) : rows;
    if (selected.length === 0) {
      throw new BadRequestException("Il file non contiene righe da elaborare.");
    }

    // Le righe senza nome non vengono mandate a Claude: non c'è niente da
    // analizzare, e pagherebbero una chiamata per tornare vuote.
    const inputs: AnalysisInputRow[] = [];
    const emptyRows: number[] = [];
    for (const row of selected) {
      const values = readMappedValues(row, mapping, columnIndexes);
      const name = clean(values.name);
      if (!name) {
        emptyRows.push(row.rowNumber);
        continue;
      }
      inputs.push({
        rowIndex: row.rowNumber,
        name,
        // Le informazioni di prodotto sparse su più colonne viaggiano insieme
        // alle specifiche, etichettate: il modello deve poterle distinguere.
        spec: this.buildSpecText(values),
        // `用途` finisce fra le note nei fogli reali ed è ciò che spiega a cosa
        // serve il prodotto: è l'indizio più utile quando il nome è generico.
        usage: clean(values.notes),
        quantity: clean(values.quantity),
        unit: clean(values.unit),
        declaredTitle: clean(values.title),
        referenceUrl: clean(values.referenceUrl) ?? row.hyperlink,
        // Richiedente, reparto, centro di costo, firme e prezzi interni non
        // sono mappabili su nessun campo prodotto e quindi non arrivano mai
        // qui: a Claude va solo ciò che descrive la merce.
      });
    }

    const run = await prisma.analysisRun.create({
      data: {
        datasetId,
        mapping: toJson(mapping),
        promptVersion: this.claude.promptVersion,
        model: this.claude.model,
        totalRows: selected.length,
      },
      select: { id: true },
    });

    let result;
    try {
      result = await this.claude.analyzeRows(inputs, {
        ignoreCache: input.ignoreCache,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Errore imprevisto";
      await prisma.analysisRun.update({
        where: { id: run.id },
        data: { error: message.slice(0, 500), finishedAt: new Date() },
      });
      throw new BadRequestException(message);
    }

    // Le righe si salvano una per una, con identità e stato già calcolati.
    const datasetRows = await prisma.scoutingDatasetRow.findMany({
      where: { datasetId, rowNumber: { in: selected.map((row) => row.rowNumber) } },
      select: { id: true, rowNumber: true },
    });
    const rowIdByNumber = new Map(datasetRows.map((row) => [row.rowNumber, row.id]));

    let analyzed = 0;
    let failed = 0;

    for (const outcome of result.outcomes) {
      const datasetRowId = rowIdByNumber.get(outcome.rowIndex);
      if (!datasetRowId) continue;

      const identity = outcome.analysis
        ? computeProductIdentity(outcome.analysis)
        : null;
      const state = this.resolveState(outcome.analysis, identity, null, false);
      if (outcome.analysis) analyzed += 1;
      else failed += 1;

      await prisma.analysisRunRow.create({
        data: {
          runId: run.id,
          datasetRowId,
          analysisId: outcome.analysisId || null,
          rowNumber: outcome.rowIndex,
          state,
          effectiveAnalysis: outcome.analysis ? toJson(outcome.analysis) : Prisma.DbNull,
          fromCache: outcome.fromCache,
          familyKey: identity?.familyKey ?? null,
          variantKey: identity?.variantKey ?? null,
          duplicateKey: identity?.duplicateKey ?? null,
          confidence: outcome.analysis?.confidence ?? null,
          error: outcome.error,
        },
      });
    }

    // Le righe senza nome esistono comunque nella revisione: nasconderle
    // farebbe sparire righe del file senza dire perché.
    for (const rowNumber of emptyRows) {
      const datasetRowId = rowIdByNumber.get(rowNumber);
      if (!datasetRowId) continue;
      failed += 1;
      await prisma.analysisRunRow.create({
        data: {
          runId: run.id,
          datasetRowId,
          rowNumber,
          state: "ANALYSIS_FAILED",
          error: "Riga senza nome prodotto: non c'è niente da cercare.",
        },
      });
    }

    await prisma.analysisRun.update({
      where: { id: run.id },
      data: {
        analyzedRows: analyzed,
        failedRows: failed,
        apiCalls: result.usage.apiCalls,
        cachedRows: result.usage.cachedRows,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        finishedAt: new Date(),
      },
    });

    this.logger.log(
      `analisi ${run.id}: ${analyzed} righe ok, ${failed} fallite, ` +
        `${result.usage.apiCalls} chiamate, ${result.usage.cachedRows} da cache, ` +
        `≈ $${result.usage.costUsd.toFixed(4)}`
    );

    return this.getRun(run.id);
  }

  /**
   * Informazioni di prodotto sparse su più colonne, in un solo testo.
   *
   * Etichettate perché il modello deve sapere che `304` è un materiale e non
   * una misura; concatenarle senza etichetta produrrebbe esattamente quel tipo
   * di confusione.
   */
  private buildSpecText(values: Record<string, string | undefined>): string | null {
    const parts: string[] = [];
    const add = (label: string, value: string | undefined) => {
      const text = clean(value);
      if (text) parts.push(`${label}: ${text}`);
    };
    add("Specifiche", values.spec);
    add("Categoria", values.category);
    add("Marca", values.brand);
    add("Modello/codice", values.model);
    add("Materiale", values.material);
    add("Certificazioni", values.certifications);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  /**
   * Stato della riga.
   *
   * L'ordine dei controlli è la regola: prima ciò che impedisce di cercare
   * (analisi assente, confidenza bassa, warning critici), poi ciò che il
   * database sa. Una riga ambigua non diventa «prodotto già conosciuto» solo
   * perché la variante calcolata su dati incerti esiste già.
   */
  private resolveState(
    analysis: ProductAnalysis | null,
    identity: ProductIdentity | null,
    dbMatch: AnalysisDbMatch | null,
    approvedByUser: boolean
  ): AnalysisRowState {
    if (!analysis || !identity) return "ANALYSIS_FAILED";

    if (!approvedByUser) {
      const hasCriticalWarning = analysis.warnings.some((warning) =>
        CRITICAL_WARNING_CODES.includes(warning.code)
      );
      if (hasCriticalWarning || analysis.confidence < this.minConfidence) {
        return "NEEDS_REVIEW";
      }
    }

    if (dbMatch?.requestId) return "KNOWN_PRODUCT";
    if (dbMatch && dbMatch.familyRequestCount > 0) return "NEW_VARIANT";
    return "NEW_PRODUCT";
  }

  /** Sessione di analisi completa, pronta per la revisione. */
  async getRun(runId: string): Promise<AnalysisRun> {
    const run = await prisma.analysisRun.findUnique({
      where: { id: runId },
      include: {
        dataset: { select: { fileName: true } },
        rows: {
          orderBy: { rowNumber: "asc" },
          include: {
            datasetRow: { select: { cells: true, hyperlink: true } },
            analysis: { select: { submittedText: true } },
          },
        },
      },
    });
    if (!run) throw new NotFoundException(`Analisi non trovata: ${runId}`);

    // Lo stato rispetto al database si rilegge ora, non si serve dalla cache:
    // fra l'analisi e la revisione può essere finito un altro job che ha
    // trovato prodotti per la stessa variante.
    const variantKeys = run.rows
      .map((row) => row.variantKey)
      .filter((key): key is string => !!key);
    const matches = await this.known.lookupVariants(variantKeys);

    const rows: AnalysisRow[] = [];
    let ready = 0;

    for (const row of run.rows) {
      const analysis = this.readAnalysis(row.effectiveAnalysis);
      const identity =
        row.familyKey && row.variantKey && row.duplicateKey
          ? {
              familyKey: row.familyKey,
              variantKey: row.variantKey,
              duplicateKey: row.duplicateKey,
            }
          : null;
      const dbMatch = row.variantKey ? (matches.get(row.variantKey) ?? null) : null;
      const state = this.resolveState(analysis, identity, dbMatch, row.approvedByUser);
      if (state !== "ANALYSIS_FAILED" && state !== "NEEDS_REVIEW") ready += 1;

      rows.push({
        analysisRowId: row.id,
        rowNumber: row.rowNumber,
        originalCells: (row.datasetRow.cells as unknown as string[]) ?? [],
        submittedText: row.analysis?.submittedText ?? "",
        referenceUrl: row.datasetRow.hyperlink,
        state,
        analysis,
        identity,
        dbMatch,
        edited: row.edited,
        fromCache: row.fromCache,
        error: row.error,
      });
    }

    return {
      runId: run.id,
      datasetId: run.datasetId,
      fileName: run.dataset.fileName,
      totalRows: run.totalRows,
      analyzedRows: run.analyzedRows,
      failedRows: run.failedRows,
      readyRows: ready,
      usage: {
        model: run.model,
        promptVersion: run.promptVersion,
        apiCalls: run.apiCalls,
        cachedRows: run.cachedRows,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        estimatedCostUsd: run.costUsd,
      },
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      rows,
    };
  }

  /** Sessioni di analisi di un dataset, dalla più recente. */
  async listRuns(datasetId: string, limit = 10) {
    const runs = await prisma.analysisRun.findMany({
      where: { datasetId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        totalRows: true,
        analyzedRows: true,
        failedRows: true,
        costUsd: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    return runs.map((run) => ({
      runId: run.id,
      totalRows: run.totalRows,
      analyzedRows: run.analyzedRows,
      failedRows: run.failedRows,
      estimatedCostUsd: run.costUsd,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Applica una correzione manuale.
   *
   * La correzione **non** tocca il record in `RequestAnalysis`: quello resta la
   * fotografia di ciò che ha risposto il modello, ed è l'unico modo per capire
   * in seguito se il prompt stia peggiorando. Ciò che cambia è l'analisi
   * effettiva della riga, che è quella che alimenta ricerca e identità.
   */
  async updateRow(
    analysisRowId: string,
    patch: UpdateAnalysisRowRequest
  ): Promise<AnalysisRow> {
    const row = await prisma.analysisRunRow.findUnique({
      where: { id: analysisRowId },
      select: { id: true, runId: true, effectiveAnalysis: true, manualEdits: true },
    });
    if (!row) throw new NotFoundException(`Riga non trovata: ${analysisRowId}`);

    const current = this.readAnalysis(row.effectiveAnalysis);
    if (!current) {
      throw new BadRequestException(
        "Questa riga non ha un'analisi da correggere: rilancia l'analisi IA."
      );
    }

    const { approve, ...fields } = patch;
    // Solo i campi davvero presenti sovrascrivono: una PATCH parziale non
    // deve azzerare ciò che non nomina.
    const changes = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    );
    const merged = ProductAnalysisSchema.safeParse({ ...current, ...changes });
    if (!merged.success) {
      throw new BadRequestException(
        `Correzione non valida: ${merged.error.issues.map((issue) => issue.message).join("; ")}`
      );
    }

    const identity = computeProductIdentity(merged.data);
    const hasChanges = Object.keys(changes).length > 0;
    const previousEdits = (row.manualEdits as Record<string, unknown> | null) ?? {};

    await prisma.analysisRunRow.update({
      where: { id: analysisRowId },
      data: {
        effectiveAnalysis: toJson(merged.data),
        manualEdits: hasChanges ? toJson({ ...previousEdits, ...changes }) : undefined,
        edited: hasChanges ? true : undefined,
        approvedByUser: approve ?? undefined,
        familyKey: identity.familyKey,
        variantKey: identity.variantKey,
        duplicateKey: identity.duplicateKey,
        confidence: merged.data.confidence,
        // Una riga corretta a mano non è più «analisi fallita»: se aveva un
        // errore, ora ha un'analisi valida.
        error: null,
      },
    });

    const run = await this.getRun(row.runId);
    const updated = run.rows.find((entry) => entry.analysisRowId === analysisRowId);
    if (!updated) throw new NotFoundException(`Riga non trovata: ${analysisRowId}`);
    return updated;
  }

  /** JSON salvato → analisi tipizzata, o `null` se non conforme. */
  private readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
    if (value == null) return null;
    const parsed = ProductAnalysisSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /** Etichetta italiana di uno stato, per interfaccia ed export. */
  stateLabel(state: AnalysisRowState): string {
    return ANALYSIS_ROW_STATE_LABELS[state];
  }
}
