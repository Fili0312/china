import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import {
  verifyCandidateCoherence,
  COHERENCE_PROMPT_VERSION,
  hasClaudeApiKey,
  hasDeepSeekApiKey,
  type CoherenceInputRow,
} from "@china/ai";
import {
  ProductAnalysisSchema,
  type ProductAnalysis,
  type TaobaoVerifyResult,
  type VerifyTaobaoJobRequest,
} from "@china/shared";
import { ClarificationService } from "./clarification.service";
import { ClientService } from "./client.service";
import {
  deriveV2RequirementContext,
  evaluateV2Candidate,
  readV2RequirementContext,
  type V2CandidateEvidence,
  type V2RequirementContext,
} from "./v2-requirement-policy";
import { selectV2Variant } from "./v2-variant-selection";
import { DataHubProvider } from "./providers/datahub.provider";
import { t } from "../i18n/messages";

/**
 * La seconda passata: i prodotti trovati vengono giudicati, non solo mostrati.
 *
 * La ricerca ordina i candidati per compatibilità **testuale** — quanti
 * requisiti si ritrovano nel titolo. Questa passata fa la domanda successiva,
 * quella che finora faceva l'operatore a occhio: «questo prodotto è davvero
 * quello che il foglio chiede?». Il verdetto finisce sul risultato e resta lì:
 * riaprire la pagina non lo ripaga.
 *
 * Quando il giudizio dipende da qualcosa che solo l'operatore sa, il verdetto
 * è «dubbio» e nasce una domanda — nella stessa memoria delle domande
 * dell'analisi, con lo stesso principio: chiesta una volta, mai più.
 */

/**
 * Righe per chiamata: ~3 candidati l'una.
 *
 * Configurabile perché i modelli non reggono lotti uguali: Claude giudica
 * bene 5 righe (15 candidati) in una risposta, DeepSeek su lotti così grandi
 * ne salta la maggior parte — con lotti piccoli li copre tutti. Il default
 * basso vale per DeepSeek (motore predefinito della verifica); chi mette
 * Claude può alzarlo con `COHERENCE_ROWS_PER_CALL`.
 */
const ROWS_PER_CALL = (() => {
  const parsed = Number(process.env.COHERENCE_ROWS_PER_CALL);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
})();
/** Chiamate contemporanee: basso, come nell'analisi. */
const CONCURRENCY = 2;

/**
 * Quante schede prodotto leggere al massimo per job quando il titolo non basta.
 *
 * Serve un tetto perché è una chiamata a pagamento per candidato. Il default
 * copre un foglio medio senza sorprese in fattura; `V2_DETAIL_BUDGET=0`
 * disattiva del tutto l'arricchimento e lascia decidere il solo giudizio
 * semantico sul titolo.
 */
const V2_DETAIL_BUDGET = (() => {
  const parsed = Number(process.env.V2_DETAIL_BUDGET);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 120;
})();

/**
 * Dopo quante schede vuote di fila si smette di chiederle.
 *
 * Un endpoint di dettaglio può esserci ed essere inerte: senza questo limite
 * il job spenderebbe l'intero budget per non ricevere nulla.
 */
const V2_DETAIL_GIVE_UP = 3;

export type CoherenceExecutionMode = "legacy" | "v2-review";

export interface CoherenceExecutionContext {
  /**
   * La v1 mantiene le domande globali storiche. Nella v2 un dubbio su una
   * singola inserzione è una voce di revisione: non deve creare domande né
   * leggere preferenze di altri clienti.
   */
  mode?: CoherenceExecutionMode;
  /**
   * Salta le righe che hanno già un candidato promosso.
   *
   * Serve alla seconda passata: la ricerca porta a casa dieci candidati per
   * riga ma la prima verifica ne guarda solo i primi. Quando nessuno di quelli
   * convince, gli altri sono già stati pagati e stanno lì inutilizzati — vale
   * la pena giudicarli prima di dichiarare la riga senza risultato. Sulle
   * righe già risolte non si spende nulla.
   */
  onlyUnresolvedRows?: boolean;
  /**
   * Limita la verifica a queste righe.
   *
   * Serve alla riprova mirata: chi ha scelto tre righe scoperte non deve
   * pagare la riverifica di tutte le altre quattrocentonovanta.
   */
  onlyRowNumbers?: ReadonlySet<number>;
}

export function shouldCreateCoherenceQuestion(
  mode: CoherenceExecutionMode,
  verdict: string,
  question: string | null
): boolean {
  return mode === "legacy" && verdict === "unsure" && Boolean(question?.trim());
}

/** Provider ammessi: il gate legacy resta identico, la v2 segue il verifier. */
export function canRunCoherence(
  mode: CoherenceExecutionMode,
  configured: { claude: boolean; deepseek: boolean }
): boolean {
  return mode === "legacy"
    ? configured.claude
    : configured.claude || configured.deepseek;
}

function readAnalysis(value: Prisma.JsonValue | null): ProductAnalysis | null {
  if (value == null) return null;
  const parsed = ProductAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Il verdetto salvato su un risultato, senza fidarsi della forma del JSON. */
function readCoherenceVerdict(value: Prisma.JsonValue | null): string | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const verdict = (value as Record<string, unknown>).verdict;
  return typeof verdict === "string" ? verdict : null;
}

/** La richiesta come la vede il giudice: tutto ciò che il foglio specifica. */
function describeRequest(analysis: ProductAnalysis, searchQuery: string): string {
  const parts: string[] = [
    `Prodotto: ${analysis.productNameChinese ?? analysis.productFamily}`,
    `Famiglia: ${analysis.productFamily}`,
  ];
  if (analysis.model) parts.push(`Modello: ${analysis.model}`);
  if (analysis.material) parts.push(`Materiale: ${analysis.material}`);
  if (analysis.color) parts.push(`Colore: ${analysis.color}`);
  if (analysis.dimensions.length > 0) {
    parts.push(
      `Misure: ${analysis.dimensions
        .map((d) => `${d.axis === "other" ? (d.label ?? "misura") : d.axis} ${d.value}${d.unit ?? ""}`)
        .join(", ")}`
    );
  }
  if (analysis.technicalSpecifications.length > 0) {
    parts.push(
      `Specifiche: ${analysis.technicalSpecifications
        .map((s) => `${s.key}=${s.value}${s.unit ?? ""}`)
        .join(", ")}`
    );
  }
  if (analysis.hardRequirements.length > 0) {
    parts.push(`Vincoli obbligatori: ${analysis.hardRequirements.join("; ")}`);
  }
  if (analysis.requestedQuantity != null) {
    parts.push(`Quantità richiesta: ${analysis.requestedQuantity} ${analysis.unit ?? ""}`.trim());
  }
  parts.push(`Query usata: ${searchQuery}`);
  return parts.join("\n");
}

/**
 * Prompt v2 con provenienza esplicita. I dati dedotti restano contesto utile,
 * ma il giudice riceve l'istruzione strutturata di non trattarli come vincoli.
 */
export function describeV2CoherenceRequest(
  analysis: ProductAnalysis,
  searchQuery: string,
  sourceText: string,
  originalCells: readonly string[],
  persistedContext?: V2RequirementContext | null
): string {
  const provenance =
    persistedContext ?? deriveV2RequirementContext(analysis, sourceText);
  const parts = [
    describeRequest(analysis, searchQuery),
    `Contesto originale inviato all'analisi:\n${sourceText.slice(0, 6_000)}`,
  ];
  const cells = originalCells
    .map((cell, index) => (cell.trim() ? `Cella ${index + 1}: ${cell.trim()}` : null))
    .filter((entry): entry is string => entry != null);
  if (cells.length > 0) {
    parts.push(`Riga Excel originale:\n${cells.join("\n").slice(0, 6_000)}`);
  }
  if (provenance.explicit.length > 0) {
    parts.push(
      `VINCOLI ESPLICITI IMMUTABILI: ${provenance.explicit.join("; ")}`
    );
  }
  if (provenance.normalized.length > 0) {
    parts.push(`VALORI NORMALIZZATI: ${provenance.normalized.join("; ")}`);
  }
  if (provenance.inferred.length > 0) {
    parts.push(
      `DATI DEDOTTI, NON VINCOLANTI: ${provenance.inferred.join("; ")}`
    );
  }
  parts.push(
    "Giudica numeri, unità, modelli, quantità e caratteristiche esplicite come immutabili; " +
      "non bocciare un candidato per un attributo opzionale non richiesto."
  );
  return parts.join("\n\n");
}

/** Il candidato come lo vede il giudice: solo dati veri, mai dedotti. */
/** L'evidenza disponibile su un candidato, nella forma attesa dal gate. */
function productEvidence(product: {
  title: string;
  titleEn: string | null;
  sku: string | null;
  shopName: string | null;
  specs: Prisma.JsonValue | null;
  variants: Prisma.JsonValue | null;
  moq: number | null;
}): V2CandidateEvidence {
  return {
    title: product.title,
    titleEn: product.titleEn,
    sku: product.sku,
    shopName: product.shopName,
    specs: (product.specs as Record<string, string> | null) ?? null,
    variants:
      (product.variants as Array<{ name: string; options: string[] }> | null) ??
      null,
    moq: product.moq,
  };
}

export function describeCoherenceCandidate(product: {
  platform: string;
  title: string;
  titleEn: string | null;
  price: Prisma.Decimal | null;
  promotionPrice: Prisma.Decimal | null;
  currency: string | null;
  moq: number | null;
  shopName: string | null;
  specs: Prisma.JsonValue | null;
  sku: string | null;
  variants: Prisma.JsonValue | null;
  availability: string | null;
  url: string | null;
  sources: string[];
}, mode: CoherenceExecutionMode = "legacy"): string {
  const parts: string[] = [`Titolo: ${product.title}`];
  if (product.titleEn) parts.push(`Titolo tradotto: ${product.titleEn}`);
  parts.push(`Marketplace: ${product.platform}`);
  if (product.price != null) {
    parts.push(`Prezzo: ${Number(product.price)} ${product.currency ?? "CNY"}`);
  }
  if (product.promotionPrice != null) {
    parts.push(`Prezzo promozionale: ${Number(product.promotionPrice)} ${product.currency ?? "CNY"}`);
  }
  if (product.moq != null) parts.push(`Minimo d'ordine: ${product.moq}`);
  if (product.shopName) parts.push(`Negozio: ${product.shopName}`);
  const specs = product.specs as Record<string, string> | null;
  if (specs) {
    const entries = Object.entries(specs).slice(0, 12);
    if (entries.length > 0) {
      parts.push(`Specifiche: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}`);
    }
  }
  if (mode === "v2-review") {
    if (product.sku) parts.push(`SKU: ${product.sku}`);
    if (Array.isArray(product.variants)) {
      const variants = product.variants
        .slice(0, 8)
        .flatMap((variant) => {
          if (
            !variant ||
            typeof variant !== "object" ||
            Array.isArray(variant)
          ) {
            return [];
          }
          const name =
            "name" in variant && typeof variant.name === "string"
              ? variant.name.trim()
              : "";
          const options =
            "options" in variant && Array.isArray(variant.options)
              ? variant.options
                  .filter((option): option is string => typeof option === "string")
                  .map((option) => option.trim())
                  .filter(Boolean)
                  .slice(0, 12)
              : [];
          return name && options.length > 0
            ? [`${name}: ${options.join(" / ")}`]
            : [];
        });
      if (variants.length > 0) parts.push(`Varianti: ${variants.join("; ")}`);
    }
    if (product.availability) {
      parts.push(`Disponibilità: ${product.availability}`);
    }
    if (product.url) parts.push(`Link prodotto: ${product.url}`);
  }
  if (product.sources.includes("excel")) {
    parts.push("Nota: il link di questo prodotto era già nel foglio del cliente (usato in precedenza).");
  }
  return parts.join("\n");
}

@Injectable()
export class CoherenceService {
  private readonly logger = new Logger("TaobaoCoherence");

  /**
   * Risposte di dettaglio vuote consecutive.
   *
   * Serve da interruttore: se la fonte non serve schede, insistere costerebbe
   * una chiamata a pagamento per ogni candidato incerto senza aggiungere una
   * sola informazione. Si smette e si lascia decidere il giudizio semantico.
   */
  private emptyDetails = 0;

  constructor(
    private readonly clients: ClientService,
    private readonly clarifications: ClarificationService,
    private readonly api: DataHubProvider
  ) {}

  /**
   * Legge la scheda dell'inserzione e ne conserva specifiche e varianti.
   *
   * Il dettaglio **completa** il prodotto, non lo sostituisce: titolo, prezzo e
   * negozio restano quelli della ricerca. Un guasto della fonte non è un errore
   * del job — si torna a giudicare con il solo titolo.
   */
  private async enrichProductDetail<
    T extends {
      id: string;
      itemId: string;
      specs: Prisma.JsonValue | null;
      variants: Prisma.JsonValue | null;
    },
  >(product: T): Promise<T | null> {
    if (!this.api.isConfigured) {
      this.emptyDetails = Number.POSITIVE_INFINITY;
      return null;
    }
    try {
      const detail = await this.api.detail(product.itemId);
      const specs = detail.patch.specs ?? null;
      const variants = detail.patch.variants ?? null;
      if (specs == null && variants == null) {
        // Risposta valida ma senza contenuto: capita quando il piano espone
        // l'endpoint di dettaglio ma non lo serve. Va detto, altrimenti il
        // job sembra semplicemente non aver mai provato.
        this.emptyDetails += 1;
        if (this.emptyDetails === V2_DETAIL_GIVE_UP) {
          this.logger.warn(
            `la fonte non restituisce schede prodotto (${V2_DETAIL_GIVE_UP} risposte vuote di fila): ` +
              "arricchimento sospeso per questo job, i candidati incerti vanno al giudizio semantico col solo titolo."
          );
        }
        return null;
      }
      this.emptyDetails = 0;
      await prisma.taobaoProduct.update({
        where: { id: product.id },
        data: {
          ...(specs != null ? { specs: specs as Prisma.InputJsonValue } : {}),
          ...(variants != null
            ? { variants: variants as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      return {
        ...product,
        specs: (specs ?? product.specs) as Prisma.JsonValue | null,
        variants: (variants ?? product.variants) as Prisma.JsonValue | null,
      };
    } catch (error) {
      this.logger.warn(
        `dettaglio non disponibile per ${product.itemId}: ${(error as Error).message}`
      );
      return null;
    }
  }

  async verifyJob(
    clientId: string,
    jobId: string,
    input: VerifyTaobaoJobRequest,
    context: CoherenceExecutionContext = {}
  ): Promise<TaobaoVerifyResult> {
    const mode = context.mode ?? "legacy";
    const job = await prisma.taobaoJob.findUnique({
      where: { id: jobId },
      select: { id: true, clientId: true },
    });
    if (!job) throw new NotFoundException(t("err.jobNotFound", { id: jobId }));
    this.clients.assertOwnership(clientId, job.clientId, "resource.job");

    if (
      !canRunCoherence(mode, {
        claude: hasClaudeApiKey(),
        deepseek: hasDeepSeekApiKey(),
      })
    ) {
      throw new BadRequestException(
        t("err.claudeKeyMissing")
      );
    }

    const rows = await prisma.taobaoJobRow.findMany({
      where: {
        jobId,
        status: "DONE",
        ...(context.onlyRowNumbers
          ? { rowNumber: { in: [...context.onlyRowNumbers] } }
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
            datasetRow: { select: { cells: true } },
          },
        },
        results: {
          // La v2 carica tutti i candidati per applicare a ciascuno il gate
          // deterministico; soltanto i primi `topN` compatibili arrivano
          // davvero al verificatore IA. La query legacy resta identica.
          where:
            mode === "v2-review"
              ? {}
              : { rank: { lte: input.topN } },
          orderBy: { rank: "asc" },
          include: { product: true },
        },
      },
    });

    // Cosa giudicare: i risultati già verificati si saltano — il verdetto è
    // salvato e riaprire la pagina non deve ripagarlo.
    interface Target {
      resultId: string;
      rowIndex: number;
      candidateIndex: number;
      familyKey: string | null;
      requestText: string;
      candidateText: string;
      selectedVariant: string | null;
      variantSelectionRequired: boolean;
      variantChoices: string[];
    }
    const targets: Target[] = [];
    let skipped = 0;
    let deterministicallyRejected = 0;
    // Tetto sulle letture di dettaglio: sono chiamate a pagamento. Si spendono
    // solo per i candidati che il titolo non basta a giudicare.
    let detailBudget = mode === "v2-review" ? V2_DETAIL_BUDGET : 0;
    let detailFetched = 0;
    // L'interruttore vale per il singolo job: una fonte tornata disponibile
    // deve poter essere riprovata alla verifica successiva.
    this.emptyDetails = 0;
    for (const row of rows) {
      const analysis = readAnalysis(row.analysisRow?.effectiveAnalysis ?? null);
      if (!analysis || row.results.length === 0) continue;
      // Seconda passata: una riga che ha già un prodotto promosso è chiusa.
      if (
        context.onlyUnresolvedRows &&
        row.results.some(
          (candidate) =>
            readCoherenceVerdict(candidate.coherence) === "coherent" &&
            !candidate.product.unavailable
        )
      ) {
        continue;
      }
      const sourceText =
        row.analysisRow?.analysis?.submittedText ??
        row.analysisRow?.signatureText ??
        "";
      const originalCells = Array.isArray(row.analysisRow?.datasetRow.cells)
        ? row.analysisRow.datasetRow.cells.filter(
            (cell): cell is string => typeof cell === "string"
          )
        : [];
      const requirementContext =
        mode === "v2-review"
          ? readV2RequirementContext(row.analysisRow?.manualEdits) ??
            deriveV2RequirementContext(analysis, sourceText)
          : null;
      const requestText =
        mode === "v2-review"
          ? describeV2CoherenceRequest(
              analysis,
              row.searchQuery,
              sourceText,
              originalCells,
              requirementContext
            )
          : describeRequest(analysis, row.searchQuery);
      for (const result of row.results) {
        let product = result.product;
        let evaluation = requirementContext
          ? evaluateV2Candidate(productEvidence(product), requirementContext)
          : null;

        if (
          requirementContext &&
          evaluation?.status === "unknown" &&
          !product.unavailable &&
          result.rank <= input.topN &&
          detailBudget > 0 &&
          this.emptyDetails < V2_DETAIL_GIVE_UP &&
          product.specs == null &&
          product.variants == null
        ) {
          // Il titolo non basta a decidere: si legge la scheda dell'inserzione,
          // dove misure e varianti stanno davvero. È l'unico modo di verificare
          // un vincolo senza inventarlo — e si paga solo per i candidati che
          // arriverebbero comunque al giudizio semantico.
          detailBudget -= 1;
          const enriched = await this.enrichProductDetail(product);
          if (enriched) {
            product = enriched;
            detailFetched += 1;
            evaluation = evaluateV2Candidate(
              productEvidence(product),
              requirementContext
            );
          }
        }

        const variantSelection = requirementContext
          ? selectV2Variant(
              {
                sku: product.sku,
                variants:
                  (product.variants as Array<{
                    name: string;
                    options: string[];
                  }> | null) ?? null,
              },
              requirementContext
            )
          : {
              selectedVariant: null,
              requiresHumanChoice: false,
              choices: [],
            };
        // Il gate deterministico v2 scartava i CONFLICT, ma escludeva anche molti
        // candidati corretti: la ricerca cinese esigente restituisce pochi titoli
        // esatti, e il titolo raramente nomina tutte le misure. Adesso si prova
        // solo il dettaglio (se presente), poi tutto a DeepSeek come la v1 — il
        // giudice semantico ha più contesto e fa meno falsi positivi.
        if (product.unavailable) {
          await prisma.taobaoJobResult.update({
            where: { id: result.id },
            data: {
              coherence: {
                verdict: "incoherent",
                issues: ["V2_PRODUCT_UNAVAILABLE"],
                confidence: 1,
                model: "deterministic-v2",
                promptVersion: "v2-explicit-constraints-2",
                selectedVariant: variantSelection.selectedVariant,
                variantSelectionRequired: variantSelection.requiresHumanChoice,
                variantChoices: variantSelection.choices,
              } as unknown as Prisma.InputJsonValue,
              coherenceCheckedAt: new Date(),
            },
          });
          deterministicallyRejected += 1;
          continue;
        }
        if (mode === "v2-review" && result.rank > input.topN) continue;
        // Una decisione umana non si rigiudica: `force` vale per i verdetti
        // della macchina, non per quelli di chi ha guardato la scheda.
        if ((result.coherence as { acceptedByHuman?: boolean } | null)?.acceptedByHuman) {
          skipped += 1;
          continue;
        }
        if (result.coherenceCheckedAt && !input.force) {
          skipped += 1;
          continue;
        }
        targets.push({
          resultId: result.id,
          rowIndex: row.rowNumber,
          candidateIndex: result.rank,
          familyKey: analysis.familyKey,
          requestText,
          // Il prodotto arricchito porta al giudice specifiche e varianti
          // lette dalla scheda: è l'evidenza che il titolo non aveva.
          candidateText: describeCoherenceCandidate(product, mode),
          selectedVariant: variantSelection.selectedVariant,
          variantSelectionRequired: variantSelection.requiresHumanChoice,
          variantChoices: variantSelection.choices,
        });
      }
    }

    const totals: TaobaoVerifyResult = {
      jobId,
      checkedCandidates: deterministicallyRejected,
      skippedCandidates: skipped,
      coherent: 0,
      incoherent: deterministicallyRejected,
      unsure: 0,
      questionsOpened: 0,
      apiCalls: 0,
      estimatedCostUsd: 0,
    };
    if (targets.length === 0) return totals;

    const knowledge =
      mode === "v2-review"
        ? await this.clarifications.knowledgeForClient(clientId)
        : await this.clarifications.knowledge();

    // Le righe si ricompongono per la chiamata: stessa `rowIndex`, candidati
    // insieme. Poi si spezzano in lotti da poche righe.
    const byRow = new Map<number, { requestText: string; targets: Target[] }>();
    for (const target of targets) {
      const bucket = byRow.get(target.rowIndex) ?? {
        requestText: target.requestText,
        targets: [],
      };
      bucket.targets.push(target);
      byRow.set(target.rowIndex, bucket);
    }

    const callRows: CoherenceInputRow[] = [...byRow.entries()].map(([rowIndex, bucket]) => ({
      rowIndex,
      request: bucket.requestText,
      candidates: bucket.targets.map((target) => ({
        candidateIndex: target.candidateIndex,
        description: target.candidateText,
      })),
    }));
    const batches: CoherenceInputRow[][] = [];
    for (let index = 0; index < callRows.length; index += ROWS_PER_CALL) {
      batches.push(callRows.slice(index, index + ROWS_PER_CALL));
    }

    const targetByKey = new Map(
      targets.map((target) => [`${target.rowIndex}:${target.candidateIndex}`, target])
    );
    let lastError: string | null = null;

    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= batches.length) return;
        const batch = batches[index]!;
        try {
          const result = await verifyCandidateCoherence(batch, {
            knowledge: knowledge.entries,
          });
          totals.apiCalls += 1;
          totals.estimatedCostUsd += result.costUsd;

          for (const [key, verdict] of result.verdicts) {
            const target = targetByKey.get(key);
            if (!target) continue;

            await prisma.taobaoJobResult.update({
              where: { id: target.resultId },
              data: {
                coherence: {
                  verdict: verdict.verdict,
                  issues: verdict.issues,
                  confidence: verdict.confidence,
                  model: result.model,
                  promptVersion: COHERENCE_PROMPT_VERSION,
                  ...(mode === "v2-review"
                    ? {
                        selectedVariant: target.selectedVariant,
                        variantSelectionRequired:
                          target.variantSelectionRequired,
                        variantChoices: target.variantChoices,
                      }
                    : {}),
                } as unknown as Prisma.InputJsonValue,
                coherenceCheckedAt: new Date(),
              },
            });
            totals.checkedCandidates += 1;
            if (verdict.verdict === "coherent") totals.coherent += 1;
            else if (verdict.verdict === "incoherent") totals.incoherent += 1;
            else totals.unsure += 1;

            // Un dubbio con una domanda diventa memoria: la prossima verifica
            // la troverà già risposta e giudicherà da sola.
            if (shouldCreateCoherenceQuestion(mode, verdict.verdict, verdict.question)) {
              const opened = await this.clarifications.upsertVerifyQuestion(
                target.familyKey,
                verdict.question!,
                target.requestText.split("\n")[0] ?? ""
              );
              if (opened) totals.questionsOpened += 1;
            }
          }
        } catch (error) {
          totals.apiCalls += 1;
          lastError = error instanceof Error ? error.message : "Errore imprevisto";
          this.logger.warn(`verifica coerenza: lotto fallito (${lastError})`);
        }
      }
    });
    await Promise.all(workers);

    if (totals.checkedCandidates === 0 && lastError) {
      throw new BadRequestException(t("err.verifyFailed", { reason: String(lastError) }));
    }

    if (knowledge.digest && totals.apiCalls > 0) {
      await this.clarifications.markApplied(knowledge.ids);
    }

    this.logger.log(
      `verifica job ${jobId}: ${totals.checkedCandidates} candidati giudicati ` +
        `(${totals.coherent} coerenti, ${totals.incoherent} no, ${totals.unsure} dubbi), ` +
        `${deterministicallyRejected} scartati per conflitto, ${detailFetched} schede lette, ` +
        `${totals.questionsOpened} domande nuove, ≈ $${totals.estimatedCostUsd.toFixed(4)}`
    );
    return totals;
  }
}
