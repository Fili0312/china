import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import type { AnalysisInputRow } from "@china/ai";
import {
  ProductAnalysisSchema,
  computeVariantIdentity,
  type AnalysisRowState,
  type DatasetColumn,
  type DatasetMapping,
  type ProductAnalysis,
  type StartTaobaoAnalysisRequest,
  type TaobaoAnalysisRow,
  type TaobaoAnalysisRun,
  type TaobaoMemoryMatch,
  type UpdateAnalysisRowRequest,
  type VariantIdentity,
} from "@china/shared";
import { readMappedValues } from "../scouting/normalize-request";
import { ClaudeProductAnalysisService } from "../analysis/claude-product-analysis.service";
import { ClarificationService } from "./clarification.service";
import { ClientService } from "./client.service";
import { TaobaoDatasetService } from "./taobao-dataset.service";
import { TaobaoMemoryService } from "./taobao-memory.service";
import { hasReviewableWarning, resolveAnalysisState } from "./review-gate";
import { findShareInRow } from "./share-text";
import {
  normalizeV2Analysis,
} from "./v2-requirement-policy";
import { t } from "../i18n/messages";

/**
 * L'analisi delle richieste per lo scouting v1.
 *
 * Riusa il servizio Claude dello scouting classico — stesso prompt, stessa
 * cache, stesso conteggio dei costi — e cambia due cose:
 *
 * 1. **L'identità.** Le chiavi si calcolano con `computeVariantIdentity`, che
 *    aggiunge alla configurazione tecnica il residuo del testo originale. È la
 *    correzione dei falsi duplicati: se l'estrazione perde una misura, la
 *    misura è ancora nel testo e continua a separare le varianti.
 * 2. **La memoria interrogata.** Si guarda in `TaobaoRequest`, cioè in quello
 *    che sappiamo dei prodotti **su Taobao**, non nella memoria
 *    multi-marketplace.
 *
 * La cache delle chiamate resta condivisa fra i due flussi: è la stessa riga
 * di Excel, analizzata con lo stesso prompt e lo stesso modello. Rianalizzare
 * qui un file già analizzato nell'altra pagina costa zero.
 */

/**
 * Sotto questa confidenza la riga non parte da sola.
 *
 * È più bassa di quella dello scouting multi-marketplace (0,65), e la ragione
 * è la scala del prompt stesso: «0.4-0.7 un elemento importante è ambiguo;
 * sotto 0.4 non sei sicuro di quale prodotto si tratti». Solo la seconda
 * riga descrive una richiesta che non si può cercare. La prima descrive una
 * richiesta cercabilissima con un dettaglio incerto — e su Taobao quel
 * dettaglio non cambia nemmeno la query, perché parte il testo cinese così
 * com'è.
 */
const DEFAULT_MIN_CONFIDENCE = 0.45;

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function clean(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text || null;
}

export type ClarificationHarvestMode = "legacy" | "v2" | "none";

/**
 * Decide quale raccoglitore può vedere i warning di un'analisi.
 *
 * La distinzione esplicita evita un fallback pericoloso: una rianalisi v2 che
 * ha già consumato il proprio unico giro di domande non deve mai finire nel
 * raccoglitore legacy globale.
 */
export function clarificationHarvestMode(
  v2?: { allowQuestions?: boolean }
): ClarificationHarvestMode {
  if (!v2) return "legacy";
  return v2.allowQuestions === false ? "none" : "v2";
}

/**
 * Contesto integrale della riga, solo per l'analisi v2.
 *
 * Le celle restano nello stesso ordine del dataset e ricevono un'etichetta
 * stabile basata sull'indice Excel. Questo blocco entra nel testo inviato al
 * modello e nel contesto requisiti, ma non nella firma di identità: reparto,
 * richiedente o note amministrative aiutano a capire la riga senza creare una
 * variante prodotto diversa.
 */
export function v2FullRowContext(
  cells: readonly string[],
  columnIndexes: readonly number[],
  hyperlink: string | null,
  columns: readonly Pick<DatasetColumn, "header" | "index">[] = []
): string | null {
  const columnsByIndex = new Map(columns.map((column) => [column.index, column]));
  const lines = cells
    .map((cell, position) => {
      const value = cell.trim();
      if (!value) return null;
      const columnIndex = columnIndexes[position] ?? position;
      const header = columnsByIndex
        .get(columnIndex)
        ?.header.replace(/\s+/gu, " ")
        .trim();
      const label = header
        ? `${header} (Cella ${columnIndex + 1})`
        : `Cella ${columnIndex + 1}`;
      return `${label}: ${value}`;
    })
    .filter((line): line is string => line != null);
  if (hyperlink?.trim() && !lines.some((line) => line.includes(hyperlink.trim()))) {
    lines.push(`Link originale: ${hyperlink.trim()}`);
  }
  return lines.length > 0
    ? ["Contesto completo della riga:", ...lines].join("\n")
    : null;
}

@Injectable()
export class TaobaoAnalysisService {
  private readonly logger = new Logger("TaobaoAnalysis");

  constructor(
    private readonly clients: ClientService,
    private readonly datasets: TaobaoDatasetService,
    private readonly claude: ClaudeProductAnalysisService,
    private readonly memory: TaobaoMemoryService,
    private readonly clarifications: ClarificationService
  ) {}

  get minConfidence(): number {
    // Soglia **propria** di questo flusso: `ANALYSIS_MIN_CONFIDENCE` continua a
    // regolare `/scouting`, dove le condizioni sono diverse.
    return numericEnv("TAOBAO_MIN_CONFIDENCE", DEFAULT_MIN_CONFIDENCE);
  }

  async status() {
    // Provider, modello e (per DeepSeek) budget residuo arrivano dal servizio
    // di analisi: qui si aggiunge solo la soglia propria di questo flusso.
    return {
      ...(await this.claude.status()),
      minConfidence: this.minConfidence,
    };
  }

  /**
   * Analizza un file e apre la sessione di revisione.
   *
   * Sincrona come nello scouting classico: su qualche centinaio di righe, a
   * lotti e con la cache, sono decine di secondi, e restituire subito il
   * risultato completo evita di dover interrogare un avanzamento per una fase
   * che mentre è in corso non ha niente da mostrare.
   */
  async startRun(
    clientId: string,
    datasetId: string,
    input: StartTaobaoAnalysisRequest,
    v2?: { pipelineId: string; locale: string; allowQuestions?: boolean }
  ): Promise<TaobaoAnalysisRun> {
    const { clientId: owner } = await this.datasets.loadRows(datasetId);
    this.clients.assertOwnership(clientId, owner, "resource.file");

    const mapping = input.mapping as DatasetMapping[];
    if (!mapping.some((entry) => entry.field === "name")) {
      throw new BadRequestException(
        t("err.needNameColumn")
      );
    }

    const { columns, columnIndexes, rows } = await this.datasets.loadRows(datasetId);
    const selected = input.maxRows ? rows.slice(0, input.maxRows) : rows;
    if (selected.length === 0) {
      throw new BadRequestException(t("err.fileNoRows"));
    }

    const inputs: AnalysisInputRow[] = [];
    const signatureByRow = new Map<number, string>();
    const emptyRows: number[] = [];

    for (const row of selected) {
      const values = readMappedValues(row, mapping, columnIndexes);

      // Senza nome mappato la riga sembra vuota, ma spesso non lo è: qualcuno
      // ha incollato il blocco di condivisione di Taobao in una colonna
      // qualsiasi, e quel blocco contiene il nome esatto del prodotto e il
      // link a quello che il cliente ha già guardato. Buttarla via sarebbe
      // perdere la riga più informativa del foglio.
      const share = findShareInRow(row.cells);
      const name = clean(values.name) ?? share?.title ?? null;
      if (!name) {
        emptyRows.push(row.rowNumber);
        continue;
      }

      const spec = this.buildSpecText(values);
      const usage = clean(values.notes);
      const declaredTitle = clean(values.title) ?? share?.title ?? null;
      const fullRowContext = v2
        ? v2FullRowContext(row.cells, columnIndexes, row.hyperlink, columns)
        : null;
      const analysisUsage = [usage, fullRowContext].filter(Boolean).join("\n") || null;

      // Il testo della firma contiene **solo** ciò che descrive la merce: la
      // quantità e il link non dicono nulla sul prodotto e, se entrassero,
      // due richieste identiche in quantità diverse diventerebbero due
      // varianti.
      signatureByRow.set(
        row.rowNumber,
        [name, spec, usage, declaredTitle].filter(Boolean).join("\n")
      );

      inputs.push({
        rowIndex: row.rowNumber,
        name,
        spec,
        usage: analysisUsage,
        quantity: clean(values.quantity),
        unit: clean(values.unit),
        declaredTitle,
        referenceUrl: clean(values.referenceUrl) ?? row.hyperlink ?? share?.url ?? null,
        // Richiedente, reparto, centro di costo, firme e prezzi interni non
        // sono mappabili su nessun campo prodotto: non arrivano mai qui.
      });
    }

    const run = await prisma.taobaoAnalysisRun.create({
      data: {
        datasetId,
        clientId,
        mapping: toJson(mapping),
        promptVersion: this.claude.promptVersion,
        model: this.claude.model,
        totalRows: selected.length,
      },
      select: { id: true },
    });

    // Le risposte già date entrano nel prompt come conoscenza: la stessa
    // domanda non viene rifatta, e l'ambiguità risolta non ferma più la riga.
    const knowledge = v2
      ? await this.clarifications.knowledgeForClient(clientId)
      : await this.clarifications.knowledge();

    let result;
    try {
      result = await this.claude.analyzeRows(inputs, {
        ignoreCache: input.ignoreCache,
        knowledge: knowledge.digest
          ? { entries: knowledge.entries, digest: knowledge.digest }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("err.unexpected");
      await prisma.taobaoAnalysisRun.update({
        where: { id: run.id },
        data: { error: message.slice(0, 500), finishedAt: new Date() },
      });
      throw new BadRequestException(message);
    }

    const datasetRows = await prisma.taobaoDatasetRow.findMany({
      where: { datasetId, rowNumber: { in: selected.map((row) => row.rowNumber) } },
      select: { id: true, rowNumber: true },
    });
    const rowIdByNumber = new Map(datasetRows.map((row) => [row.rowNumber, row.id]));

    let analyzed = 0;
    let failed = 0;
    const effectiveByRow = new Map<number, ProductAnalysis | null>();

    for (const outcome of result.outcomes) {
      const datasetRowId = rowIdByNumber.get(outcome.rowIndex);
      if (!datasetRowId) continue;

      const signatureText = signatureByRow.get(outcome.rowIndex) ?? null;
      const prepared =
        v2 && outcome.analysis
          ? normalizeV2Analysis(outcome.analysis, outcome.submittedText)
          : null;
      const effectiveAnalysis = prepared?.analysis ?? outcome.analysis;
      effectiveByRow.set(outcome.rowIndex, effectiveAnalysis);

      const identity = effectiveAnalysis
        ? computeVariantIdentity(effectiveAnalysis, signatureText)
        : null;
      if (effectiveAnalysis) analyzed += 1;
      else failed += 1;

      await prisma.taobaoAnalysisRow.create({
        data: {
          runId: run.id,
          datasetRowId,
          analysisId: outcome.analysisId || null,
          rowNumber: outcome.rowIndex,
          state: this.resolveState(effectiveAnalysis, identity, null, false),
          signatureText,
          effectiveAnalysis: effectiveAnalysis ? toJson(effectiveAnalysis) : Prisma.DbNull,
          ...(prepared
            ? {
                manualEdits: toJson({
                  _v2RequirementContext: prepared.context,
                }),
              }
            : {}),
          fromCache: outcome.fromCache,
          familyKey: identity?.familyKey ?? null,
          variantKey: identity?.variantKey ?? null,
          duplicateKey: identity?.duplicateKey ?? null,
          confidence: effectiveAnalysis?.confidence ?? null,
          error: outcome.error,
        },
      });
    }

    // Le righe senza nome restano visibili: nasconderle farebbe sparire righe
    // del file senza dire perché.
    for (const rowNumber of emptyRows) {
      const datasetRowId = rowIdByNumber.get(rowNumber);
      if (!datasetRowId) continue;
      failed += 1;
      await prisma.taobaoAnalysisRow.create({
        data: {
          runId: run.id,
          datasetRowId,
          rowNumber,
          state: "ANALYSIS_FAILED",
          error: "Riga senza nome prodotto: non c'è niente da cercare.",
        },
      });
    }

    await prisma.taobaoAnalysisRun.update({
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
      `analisi ${run.id} (cliente ${clientId}): ${analyzed} ok, ${failed} fallite, ` +
        `${result.usage.apiCalls} chiamate, ${result.usage.cachedRows} da cache, ` +
        `≈ $${result.usage.costUsd.toFixed(4)}`
    );

    // Le ambiguità rimaste dopo l'analisi diventano domande: una per dubbio,
    // mai una già risposta. E si registra quali risposte sono servite.
    const clarificationRows = result.outcomes.map((outcome) => ({
      // La v2 interroga soltanto l'analisi operativa ripulita. La risposta
      // grezza del modello resta nella cache per audit, ma un attributo
      // opzionale dedotto non può trasformarsi in una domanda falsa.
      analysis: v2
        ? (effectiveByRow.get(outcome.rowIndex) ?? null)
        : outcome.analysis,
      submittedText: outcome.submittedText,
    }));
    const harvestMode = clarificationHarvestMode(v2);
    if (harvestMode === "v2" && v2) {
      await this.clarifications.harvestForPipeline({
        clientId,
        pipelineId: v2.pipelineId,
        datasetId,
        analysisRunId: run.id,
        locale: v2.locale,
        rows: clarificationRows,
      });
    } else if (harvestMode === "legacy") {
      await this.clarifications.harvestFromAnalysis(clarificationRows);
    }
    if (knowledge.digest && result.usage.apiCalls > 0) {
      await this.clarifications.markApplied(knowledge.ids);
    }

    return this.getRun(clientId, run.id);
  }

  /** Sessione completa, con lo stato della memoria riletto adesso. */
  async getRun(clientId: string, runId: string): Promise<TaobaoAnalysisRun> {
    const run = await prisma.taobaoAnalysisRun.findUnique({
      where: { id: runId },
      include: {
        dataset: { select: { fileName: true } },
        client: { select: { name: true } },
        rows: {
          orderBy: { rowNumber: "asc" },
          include: {
            datasetRow: { select: { cells: true, hyperlink: true } },
            analysis: { select: { submittedText: true } },
          },
        },
      },
    });
    if (!run) throw new NotFoundException(t("err.analysisNotFound", { id: runId }));
    this.clients.assertOwnership(clientId, run.clientId, "resource.analysis");

    // Lo stato della memoria si rilegge ora: fra l'analisi e la revisione può
    // essere finita un'altra ricerca sulla stessa variante.
    const variantKeys = run.rows
      .map((row) => row.variantKey)
      .filter((key): key is string => !!key);
    const matches = await this.memory.lookupVariants(variantKeys);

    const rows: TaobaoAnalysisRow[] = [];
    let ready = 0;
    let withWarnings = 0;

    for (const row of run.rows) {
      const analysis = this.readAnalysis(row.effectiveAnalysis);
      const identity =
        analysis && row.familyKey && row.variantKey && row.duplicateKey
          ? {
              familyKey: row.familyKey,
              variantKey: row.variantKey,
              duplicateKey: row.duplicateKey,
              residual: computeVariantIdentity(analysis, row.signatureText).residual,
            }
          : null;
      const memory = row.variantKey ? (matches.get(row.variantKey) ?? null) : null;
      const state = this.resolveState(analysis, identity, memory, row.approvedByUser);
      if (state !== "ANALYSIS_FAILED" && state !== "NEEDS_REVIEW") ready += 1;
      if (state !== "ANALYSIS_FAILED" && hasReviewableWarning(analysis)) {
        withWarnings += 1;
      }

      rows.push({
        analysisRowId: row.id,
        rowNumber: row.rowNumber,
        originalCells: (row.datasetRow.cells as unknown as string[]) ?? [],
        submittedText: row.analysis?.submittedText ?? row.signatureText ?? "",
        referenceUrl: row.datasetRow.hyperlink,
        state,
        analysis,
        identity,
        memory,
        edited: row.edited,
        fromCache: row.fromCache,
        error: row.error,
      });
    }

    return {
      runId: run.id,
      datasetId: run.datasetId,
      clientId: run.clientId,
      clientName: run.client.name,
      fileName: run.dataset.fileName,
      totalRows: run.totalRows,
      analyzedRows: run.analyzedRows,
      failedRows: run.failedRows,
      readyRows: ready,
      warningRows: withWarnings,
      usage: {
        model: run.model,
        // Le sessioni non registrano il provider: si ricava dal modello, che
        // è univoco fra i fornitori (deepseek-* contro claude-*).
        provider: run.model.startsWith("deepseek") ? "deepseek" : "claude",
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

  /** Sessioni di analisi di un file, dalla più recente. */
  async listRuns(clientId: string, datasetId: string, limit = 10) {
    const runs = await prisma.taobaoAnalysisRun.findMany({
      where: { datasetId, clientId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        totalRows: true,
        analyzedRows: true,
        failedRows: true,
        costUsd: true,
        apiCalls: true,
        cachedRows: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    return runs.map((run) => ({
      runId: run.id,
      totalRows: run.totalRows,
      analyzedRows: run.analyzedRows,
      failedRows: run.failedRows,
      apiCalls: run.apiCalls,
      cachedRows: run.cachedRows,
      estimatedCostUsd: run.costUsd,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Correzione manuale di una riga.
   *
   * Non tocca il record in `RequestAnalysis`: quella resta la fotografia di
   * ciò che ha risposto il modello, ed è l'unico modo per capire in seguito se
   * il prompt stia peggiorando. Cambia l'analisi **effettiva**, che è quella
   * che alimenta identità e ricerca.
   */
  async updateRow(
    clientId: string,
    analysisRowId: string,
    patch: UpdateAnalysisRowRequest
  ): Promise<TaobaoAnalysisRow> {
    const row = await prisma.taobaoAnalysisRow.findUnique({
      where: { id: analysisRowId },
      select: {
        id: true,
        runId: true,
        signatureText: true,
        effectiveAnalysis: true,
        manualEdits: true,
        run: { select: { clientId: true } },
      },
    });
    if (!row) throw new NotFoundException(t("err.rowNotFound", { id: analysisRowId }));
    this.clients.assertOwnership(clientId, row.run.clientId, "resource.row");

    const current = this.readAnalysis(row.effectiveAnalysis);
    if (!current) {
      throw new BadRequestException(
        t("err.rowNoAnalysis")
      );
    }

    const { approve, ...fields } = patch;
    const changes = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    );
    const merged = ProductAnalysisSchema.safeParse({ ...current, ...changes });
    if (!merged.success) {
      throw new BadRequestException(
        t("err.invalidCorrection", {
          reason: merged.error.issues.map((issue) => issue.message).join("; "),
        })
      );
    }

    const identity = computeVariantIdentity(merged.data, row.signatureText);
    const hasChanges = Object.keys(changes).length > 0;
    const previousEdits = (row.manualEdits as Record<string, unknown> | null) ?? {};

    await prisma.taobaoAnalysisRow.update({
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
        error: null,
      },
    });

    const run = await this.getRun(clientId, row.runId);
    const updated = run.rows.find((entry) => entry.analysisRowId === analysisRowId);
    if (!updated) throw new NotFoundException(t("err.rowNotFound", { id: analysisRowId }));
    return updated;
  }

  /**
   * Informazioni di prodotto sparse su più colonne, in un solo testo
   * etichettato: il modello deve sapere che `304` è un materiale e non una
   * misura.
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

  /** Stato della riga. La regola vive in `review-gate.ts`, ed è testata lì. */
  private resolveState(
    analysis: ProductAnalysis | null,
    identity: Pick<VariantIdentity, "variantKey"> | null,
    memory: TaobaoMemoryMatch | null,
    approvedByUser: boolean
  ): AnalysisRowState {
    return resolveAnalysisState({
      analysis,
      hasIdentity: identity != null,
      approvedByUser,
      memory,
      minConfidence: this.minConfidence,
    });
  }

  private readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
    if (value == null) return null;
    const parsed = ProductAnalysisSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
