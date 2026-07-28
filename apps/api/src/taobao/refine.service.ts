import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  canRefineQueries,
  proposeSearchQueries,
  RefineQueryError,
  type RefineQueryInput,
} from "@china/ai";
import {
  ProductAnalysisSchema,
  type ProductAnalysis,
  type RefineTaobaoJobRequest,
  type TaobaoRefineResult,
} from "@china/shared";
import { ClientService } from "./client.service";
import {
  CoherenceService,
  type CoherenceExecutionContext,
} from "./coherence.service";
import { mergeProducts } from "./merge";
import { DataHubProvider } from "./providers/datahub.provider";
import { HwhProvider } from "./providers/hwh.provider";
import type { RawTaobaoProduct } from "./providers/taobao-item";
import { rankCandidates, type ScoredProduct } from "./scoring";
import { TaobaoMemoryService } from "./taobao-memory.service";
import {
  buildV2RetryQueries,
  deriveV2RequirementContext,
  executeV2RetryPlan,
  isV2CandidateCompatible,
  readV2RequirementContext,
  V2_MAX_RETRY_QUERIES,
  v2NoCompatibleReason,
  type V2RequirementContext,
} from "./v2-requirement-policy";
import { t } from "../i18n/messages";

/**
 * Ri-ricerca «guidata dai difetti» (Approccio A, on-demand).
 *
 * È il passo dopo la verifica di coerenza. Per le righe che non hanno **nessun
 * prodotto coerente** fra i primi candidati, la verifica ha già scritto il
 * *perché* (misura diversa, materiale sbagliato, altra famiglia). Qui:
 *
 * 1. l'IA riscrive la query cinese da richiesta + motivi del fallimento;
 * 2. si cerca UNA volta con la query nuova (fonte di ricerca primaria);
 * 3. i nuovi candidati si uniscono ai vecchi, si riordinano e si salvano;
 * 4. si ri-verifica: solo i candidati non ancora giudicati — cioè quelli delle
 *    righe appena rifatte — riusando lo stesso `CoherenceService`.
 *
 * Un solo giro, su richiesta: la spesa DataHub è +1 chiamata per riga
 * problematica, visibile nel riepilogo. Non tocca le righe che avevano già un
 * prodotto coerente.
 */

/** Verdetto salvato su un risultato. */
interface StoredCoherence {
  verdict?: string;
  issues?: string[];
}

@Injectable()
export class RefineService {
  private readonly logger = new Logger("TaobaoRefine");

  constructor(
    private readonly clients: ClientService,
    private readonly memory: TaobaoMemoryService,
    private readonly api: DataHubProvider,
    private readonly hwh: HwhProvider,
    private readonly coherence: CoherenceService
  ) {}

  async refineJob(
    clientId: string,
    jobId: string,
    input: RefineTaobaoJobRequest,
    coherenceContext: CoherenceExecutionContext = {}
  ): Promise<TaobaoRefineResult> {
    const v2Mode = coherenceContext.mode === "v2-review";
    const job = await prisma.taobaoJob.findUnique({
      where: { id: jobId },
      select: { id: true, clientId: true, maxCandidates: true },
    });
    if (!job) throw new NotFoundException(t("err.jobNotFound", { id: jobId }));
    this.clients.assertOwnership(clientId, job.clientId, "resource.job");

    if (!canRefineQueries() && !v2Mode) {
      throw new BadRequestException(
        t("err.deepseekMissing")
      );
    }

    const rows = await prisma.taobaoJobRow.findMany({
      where: {
        jobId,
        status: "DONE",
        requestId: { not: null },
        // La riprova mirata sceglie le righe: senza questo filtro «rifai
        // queste tre» diventerebbe «rifai tutto il foglio».
        ...(coherenceContext.onlyRowNumbers
          ? { rowNumber: { in: [...coherenceContext.onlyRowNumbers] } }
          : {}),
      },
      orderBy: { rowNumber: "asc" },
      include: {
        analysisRow: {
          select: {
            effectiveAnalysis: true,
            signatureText: true,
            manualEdits: true,
            analysis: { select: { submittedText: true } },
          },
        },
        results: {
          where: { rank: { lte: input.topN } },
          orderBy: { rank: "asc" },
          select: {
            coherence: true,
            product: { select: { unavailable: true } },
          },
        },
      },
    });

    const empty: TaobaoRefineResult = {
      jobId,
      rowsProblematic: 0,
      rowsRefined: 0,
      rowsRecovered: 0,
      newProducts: 0,
      apiCalls: 0,
      reverifiedCandidates: 0,
      estimatedCostUsd: 0,
      note: null,
    };

    // Righe da rifare: verificate (i risultati hanno un verdetto) e senza
    // nessun prodotto coerente. Una riga non ancora verificata non ha il
    // "perché", quindi si salta — va verificata prima.
    interface Target {
      rowId: string;
      rowNumber: number;
      requestId: string;
      analysis: ProductAnalysis;
      signatureText: string | null;
      sourceText: string;
      requirementContext: V2RequirementContext;
      previousQuery: string;
      failureReasons: string[];
    }
    const targets: Target[] = [];
    let notVerified = 0;

    for (const row of rows) {
      const analysis = this.readAnalysis(row.analysisRow?.effectiveAnalysis ?? null);
      if (!analysis || !row.requestId) continue;

      const verdicts = row.results.map((r) => r.coherence as StoredCoherence | null);
      if (row.results.length > 0) {
        const anyVerified = verdicts.some((v) => v?.verdict);
        if (!anyVerified && !v2Mode) {
          notVerified += 1;
          continue;
        }
        const hasCoherent = row.results.some(
          (result) =>
            !result.product.unavailable &&
            (result.coherence as StoredCoherence | null)?.verdict === "coherent"
        );
        if (hasCoherent) continue;
      } else if (!v2Mode) {
        // Il refine legacy nasce dopo la verifica e continua a richiederla.
        // La v2 invece deve poter recuperare anche una ricerca tornata vuota.
        continue;
      }

      // I motivi del fallimento, dai verdetti non coerenti/dubbi.
      const reasons = new Set<string>();
      if (row.results.length === 0) {
        reasons.add("La ricerca precedente non ha restituito candidati.");
      } else if (!verdicts.some((verdict) => verdict?.verdict)) {
        reasons.add(
          "I candidati precedenti non sono stati verificati; applicare i vincoli espliciti."
        );
      }
      for (const v of verdicts) {
        for (const issue of v?.issues ?? []) if (issue.trim()) reasons.add(issue.trim());
      }

      targets.push({
        rowId: row.id,
        rowNumber: row.rowNumber,
        requestId: row.requestId,
        analysis,
        signatureText: row.analysisRow?.signatureText ?? null,
        sourceText:
          row.analysisRow?.analysis?.submittedText ??
          row.analysisRow?.signatureText ??
          "",
        requirementContext:
          readV2RequirementContext(row.analysisRow?.manualEdits) ??
          deriveV2RequirementContext(
            analysis,
            row.analysisRow?.analysis?.submittedText ??
              row.analysisRow?.signatureText ??
              ""
          ),
        previousQuery: row.searchQuery,
        failureReasons: [...reasons].slice(0, 6),
      });
    }

    if (targets.length === 0) {
      return {
        ...empty,
        note: notVerified
          ? `Nessuna riga da rifare: ${notVerified} righe non ancora verificate. Lancia prima «Verifica coerenza».`
          : "Nessuna riga senza prodotto coerente: non c'è niente da rifare.",
      };
    }

    // 1. L'IA riscrive le query, in una sola chiamata.
    let costUsd = 0;
    let newQueries = new Map<number, string>();
    if (canRefineQueries()) {
      try {
        const proposal = await proposeSearchQueries(
          targets.map<RefineQueryInput>((target) => ({
            rowIndex: target.rowNumber,
            request: v2Mode
              ? this.describeV2Request(target)
              : this.describeRequest(target.analysis),
            previousQuery: target.previousQuery,
            failureReasons: target.failureReasons,
          }))
        );
        costUsd += proposal.costUsd;
        newQueries = proposal.queries;
      } catch (error) {
        const message =
          error instanceof RefineQueryError ? error.message : "Errore imprevisto";
        if (!v2Mode) {
          throw new BadRequestException(t("err.refineFailed", { reason: message }));
        }
        // La v2 ha un piano deterministico: un guasto della sola riscrittura
        // IA non deve impedire query corrette basate sulla riga originale.
        this.logger.warn(`riscrittura IA v2 saltata: ${message}`);
      }
    }

    // 2. Una nuova ricerca per riga, con la query riscritta.
    let rowsRefined = 0;
    let newProducts = 0;
    let apiCalls = 0;
    const refinedRowIds: string[] = [];

    for (const target of targets) {
      const proposedQuery = newQueries.get(target.rowNumber) ?? null;
      let newQuery: string;
      let searchedProducts: RawTaobaoProduct[];

      if (v2Mode) {
        const queryPlan = buildV2RetryQueries({
          analysis: target.analysis,
          context: target.requirementContext,
          previousQuery: target.previousQuery,
          proposedQuery,
        });
        try {
          const retry = await executeV2RetryPlan(
            queryPlan,
            // Niente `exactQuery`: si riusa la scala di query del provider,
            // quella che la v1 ha sempre avuto. I marketplace cinesi combinano
            // i termini in AND, quindi una query completa non trova nulla e va
            // accorciata per gradi. Forzare la query esatta disattivava proprio
            // il meccanismo che rendeva migliore la ricerca della v1.
            (query) => this.searchPrimary(query, job.maxCandidates * 2),
            (product) =>
              isV2CandidateCompatible(product, target.requirementContext)
          );
          apiCalls += retry.calls;
          // Sulla riga resta la query **più precisa** tentata, non l'ultima:
          // la scala finisce con un tentativo volutamente largo, che descrive
          // il prodotto ma non la richiesta.
          newQuery =
            retry.attemptedQueries[0] ??
            queryPlan[0] ??
            target.previousQuery;
          searchedProducts = retry.products;
          await prisma.taobaoJobRow.update({
            where: { id: target.rowId },
            data: { attemptedQueries: retry.attemptedQueries },
          });
          if (searchedProducts.length === 0) {
            await prisma.taobaoJobRow.update({
              where: { id: target.rowId },
              data: {
                reuseReason: v2NoCompatibleReason(
                  retry.attemptedQueries.length
                ),
                // Le query provate restano sulla riga: senza di loro
                // «nessun risultato» non è una spiegazione.
                attemptedQueries: retry.attemptedQueries,
              },
            });
            continue;
          }
        } catch (error) {
          this.logger.warn(
            `riga ${target.rowNumber}: ri-ricerca v2 fallita (${(error as Error).message})`
          );
          continue;
        }
      } else {
        if (!proposedQuery) continue;
        newQuery = proposedQuery;
        let found;
        try {
          found = await this.searchPrimary(newQuery, job.maxCandidates * 2);
        } catch (error) {
          this.logger.warn(
            `riga ${target.rowNumber}: ri-ricerca fallita (${(error as Error).message})`
          );
          continue;
        }
        apiCalls += found.calls;
        if (found.products.length === 0) continue;
        searchedProducts = found.products;
      }

      // Candidati vecchi (dalla memoria della variante) + nuovi, uniti e
      // riordinati con lo stesso criterio della ricerca principale.
      const existing = await this.memory.loadProducts(target.requestId);
      const merged = mergeProducts([...existing, ...searchedProducts]);
      const compatibleMerged = v2Mode
        ? merged.filter((product) =>
            isV2CandidateCompatible(product, target.requirementContext)
          )
        : merged;
      const ranked = this.pinExcelFirst(
        rankCandidates(target.analysis, compatibleMerged)
      ).slice(0, job.maxCandidates);
      if (ranked.length === 0) {
        if (v2Mode) {
          await prisma.taobaoJobRow.update({
            where: { id: target.rowId },
            data: { reuseReason: v2NoCompatibleReason(1) },
          });
        }
        continue;
      }

      const beforeIds = new Set(existing.map((p) => `${p.platform}:${p.itemId}`));
      const saved = await this.memory.recordProducts(
        target.requestId,
        ranked.map((entry) => entry.product),
        newQuery
      );
      newProducts += ranked.filter(
        (entry) => !beforeIds.has(`${entry.product.platform}:${entry.product.itemId}`)
      ).length;

      await this.writeRowResults(target.rowId, ranked, saved.productIds);
      // La query mostrata diventa quella che ha davvero cercato ora.
      await prisma.taobaoJobRow.update({
        where: { id: target.rowId },
        data: {
          searchQuery: newQuery,
          reuseReason: t("reason.refined", { previous: target.previousQuery }),
        },
      });
      rowsRefined += 1;
      refinedRowIds.push(target.rowId);
    }

    if (rowsRefined === 0) {
      return {
        ...empty,
        rowsProblematic: targets.length,
        estimatedCostUsd: costUsd,
        note: "L'IA non ha trovato query migliori, o la ricerca non ha portato prodotti nuovi.",
      };
    }

    // 3. Ri-verifica: i risultati riscritti hanno coherence azzerata, quindi
    //    `force: false` giudica esattamente e solo le righe appena rifatte.
    const verify = await this.coherence.verifyJob(clientId, jobId, {
      topN: input.topN,
      force: false,
    }, coherenceContext);
    costUsd += verify.estimatedCostUsd;

    // Quante righe ora hanno almeno un prodotto coerente.
    const recoveredRowIds = await this.recoveredRowIds(
      refinedRowIds,
      input.topN
    );
    const rowsRecovered = recoveredRowIds.size;
    if (v2Mode) {
      const unrecovered = refinedRowIds.filter(
        (rowId) => !recoveredRowIds.has(rowId)
      );
      if (unrecovered.length > 0) {
        await prisma.taobaoJobRow.updateMany({
          where: { id: { in: unrecovered } },
          data: {
            reuseReason: v2NoCompatibleReason(V2_MAX_RETRY_QUERIES),
          },
        });
      }
    }

    this.logger.log(
      `refine job ${jobId}: ${targets.length} problematiche, ${rowsRefined} rifatte, ` +
        `${rowsRecovered} recuperate, ${newProducts} prodotti nuovi, ` +
        `${apiCalls} chiamate DataHub, ≈ $${costUsd.toFixed(4)}`
    );

    return {
      jobId,
      rowsProblematic: targets.length,
      rowsRefined,
      rowsRecovered,
      newProducts,
      apiCalls,
      reverifiedCandidates: verify.checkedCandidates,
      estimatedCostUsd: costUsd,
      note: null,
    };
  }

  /** Quali righe hanno ora un prodotto coerente e ancora disponibile nei top-N. */
  private async recoveredRowIds(
    rowIds: readonly string[],
    topN: number
  ): Promise<Set<string>> {
    if (rowIds.length === 0) return new Set();
    const results = await prisma.taobaoJobResult.findMany({
      where: { jobRowId: { in: [...rowIds] }, rank: { lte: topN } },
      select: {
        jobRowId: true,
        coherence: true,
        product: { select: { unavailable: true } },
      },
    });
    const byRow = new Map<string, boolean>();
    for (const r of results) {
      const verdict = (r.coherence as StoredCoherence | null)?.verdict;
      if (verdict === "coherent" && !r.product.unavailable) {
        byRow.set(r.jobRowId, true);
      }
      else if (!byRow.has(r.jobRowId)) byRow.set(r.jobRowId, false);
    }
    return new Set(
      [...byRow.entries()]
        .filter(([, recovered]) => recovered)
        .map(([rowId]) => rowId)
    );
  }

  /** Ricerca con la fonte primaria (H-W-H o DataHub) secondo `.env`. */
  private async searchPrimary(
    query: string,
    limit: number,
    exactQuery = false
  ): Promise<{ products: RawTaobaoProduct[]; calls: number }> {
    const primary = (process.env.TAOBAO_PRIMARY_SEARCH ?? "hwh").trim().toLowerCase();
    if (primary !== "datahub" && this.hwh.isConfigured) {
      const r = await this.hwh.search(query, { limit, exactQuery });
      return { products: r.products, calls: r.fromCache ? 0 : r.attempts };
    }
    const r = await this.api.search(query, { limit, exactQuery });
    return { products: r.products, calls: r.fromCache ? 0 : r.attempts };
  }

  /** Il prodotto del foglio resta in cima (stessa regola della ricerca). */
  private pinExcelFirst(ranked: ScoredProduct[]): ScoredProduct[] {
    const excel = ranked.filter((e) => e.product.sources.includes("excel"));
    if (excel.length === 0) return ranked;
    return [...excel, ...ranked.filter((e) => !e.product.sources.includes("excel"))];
  }

  /**
   * Riscrive i risultati di una riga con la nuova classifica.
   *
   * I verdetti già emessi su un prodotto **seguono il prodotto**. La riga
   * viene riscritta perché è cambiata la classifica, non perché sia cambiato
   * ciò che il giudice ha visto: un candidato che rientra identico è lo
   * stesso prodotto, giudicato sugli stessi dati. Buttare il suo verdetto
   * significa ricomprarlo — nella corsa del 28/07 erano ~1700 verifiche
   * rifatte in due minuti, tutte già pagate una volta.
   *
   * Un prodotto che invece **entra ora** non ha verdetto e resta da
   * giudicare, come dev'essere.
   */
  private async writeRowResults(
    rowId: string,
    ranked: readonly ScoredProduct[],
    productIds: Map<string, string>
  ): Promise<void> {
    const previous = await prisma.taobaoJobResult.findMany({
      where: { jobRowId: rowId },
      select: { productId: true, coherence: true, coherenceCheckedAt: true },
    });
    const judged = new Map(
      previous
        .filter((entry) => entry.coherenceCheckedAt != null)
        .map((entry) => [entry.productId, entry])
    );

    await prisma.taobaoJobResult.deleteMany({ where: { jobRowId: rowId } });
    let rank = 0;
    for (const entry of ranked) {
      const productId = productIds.get(`${entry.product.platform}:${entry.product.itemId}`);
      if (!productId) continue;
      rank += 1;
      const carried = judged.get(productId);
      await prisma.taobaoJobResult.create({
        data: {
          jobRowId: rowId,
          productId,
          rank,
          score: entry.score,
          scoreBreakdown: entry.breakdown as unknown as Prisma.InputJsonValue,
          matchedRequirements: entry.matchedRequirements,
          missingRequirements: entry.missingRequirements,
          warnings: entry.warnings,
          sources: entry.product.sources,
          sourceConflicts: entry.product.conflicts,
          ...(carried
            ? {
                coherence: carried.coherence as Prisma.InputJsonValue,
                coherenceCheckedAt: carried.coherenceCheckedAt,
              }
            : {}),
        },
      });
    }
  }

  /** La richiesta in una riga di testo per la riscrittura della query. */
  private describeRequest(a: ProductAnalysis): string {
    const parts = [a.productNameChinese ?? a.productFamily];
    if (a.model) parts.push(`modello ${a.model}`);
    if (a.material) parts.push(`materiale ${a.material}`);
    if (a.color) parts.push(`colore ${a.color}`);
    if (a.dimensions.length > 0) {
      parts.push(
        a.dimensions
          .map((d) => `${d.axis === "other" ? (d.label ?? "misura") : d.axis} ${d.value}${d.unit ?? ""}`)
          .join(" ")
      );
    }
    for (const s of a.technicalSpecifications) parts.push(`${s.key} ${s.value}${s.unit ?? ""}`);
    if (a.hardRequirements.length > 0) parts.push(`vincoli: ${a.hardRequirements.join(", ")}`);
    return parts.filter(Boolean).join(" · ");
  }

  private describeV2Request(target: {
    analysis: ProductAnalysis;
    sourceText: string;
    requirementContext: V2RequirementContext;
  }): string {
    const parts = [
      this.describeRequest(target.analysis),
      `Contesto originale:\n${target.sourceText.slice(0, 6_000)}`,
    ];
    if (target.requirementContext.explicit.length > 0) {
      parts.push(
        `VINCOLI ESPLICITI IMMUTABILI: ${target.requirementContext.explicit.join("; ")}`
      );
    }
    if (target.requirementContext.normalized.length > 0) {
      parts.push(
        `NORMALIZZAZIONI: ${target.requirementContext.normalized.join("; ")}`
      );
    }
    if (target.requirementContext.inferred.length > 0) {
      parts.push(
        `DEDUZIONI NON VINCOLANTI: ${target.requirementContext.inferred.join("; ")}`
      );
    }
    parts.push(
      "La nuova query deve conservare senza alterazioni numeri, unità, modelli, " +
        "quantità e caratteristiche esplicite."
    );
    return parts.join("\n\n");
  }

  private readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
    if (value == null) return null;
    const parsed = ProductAnalysisSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
