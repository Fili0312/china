import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "@china/db";
import type { AnalysisDbMatch, ProductAnalysis, ProductIdentity } from "@china/shared";
import { CandidateRefreshService } from "./candidate-refresh.service";
import {
  decideReuse,
  evaluateKnownProducts,
  readReuseSettings,
  type InvalidProduct,
  type KnownProductState,
  type ReuseSettings,
} from "./known-product";

/**
 * Il controllo nel database: cosa sappiamo già di questa variante.
 *
 * Traduce i tre casi della specifica in due operazioni.
 *
 * `lookupVariants` risponde in **lettura**, per la fase di revisione: la
 * variante esiste (caso A), esiste solo la famiglia (caso B), oppure è tutto
 * nuovo (caso C). Non tocca la rete: deve poter girare su tutte le righe di un
 * file mentre l'utente guarda.
 *
 * `prepareReuse` risponde in **azione**, per l'esecuzione del job: riapre le
 * pagine dei prodotti noti, li rivaluta con le soglie configurate e dice se
 * bastano o se serve la ricerca completa.
 *
 * La separazione conta: mostrare uno stato costa una query, agire su quello
 * stato costa decine di visite ai siti. Confonderle renderebbe la revisione
 * lentissima e la ricerca imprevedibile.
 */
@Injectable()
export class KnownProductService {
  private readonly logger = new Logger("KnownProduct");

  constructor(private readonly refresh: CandidateRefreshService) {}

  get settings(): ReuseSettings {
    return readReuseSettings();
  }

  /**
   * Famiglia di una variante.
   *
   * La chiave di variante porta lo slug di famiglia in testa (`famiglia:hash`)
   * proprio per rendere questa operazione una lettura di stringa invece di una
   * seconda colonna da tenere allineata.
   */
  private familyOf(variantKey: string): string {
    const separator = variantKey.indexOf(":");
    return separator > 0 ? variantKey.slice(0, separator) : variantKey;
  }

  /**
   * Cosa sa il database di ciascuna variante.
   *
   * Il conteggio dei prodotti «ancora validi» qui è una stima prudente basata
   * su ciò che è già salvato: disponibilità, prezzo presente e data dell'ultimo
   * controllo. Le regole complete — variazione di prezzo, venditore sparito,
   * variante non più a catalogo — richiedono di riaprire le pagine, e si
   * applicano al momento della ricerca, non della revisione.
   */
  async lookupVariants(
    variantKeys: readonly string[]
  ): Promise<Map<string, AnalysisDbMatch>> {
    const result = new Map<string, AnalysisDbMatch>();
    const unique = [...new Set(variantKeys)].filter(Boolean);
    if (unique.length === 0) return result;

    const families = [...new Set(unique.map((key) => this.familyOf(key)))];

    // Una sola interrogazione per tutte le famiglie coinvolte: da qui si
    // ricavano sia il caso A (variante esatta) sia il caso B (stessa famiglia).
    const requests = await prisma.scoutingRequest.findMany({
      where: { familyKey: { in: families } },
      select: {
        id: true,
        familyKey: true,
        variantKey: true,
        lastSearchedAt: true,
        lastVerifiedAt: true,
        searchQuery: true,
        searchQueryChinese: true,
        searchQueryEnglish: true,
        _count: { select: { candidates: true } },
      },
    });

    const byVariant = new Map(
      requests
        .filter((request) => request.variantKey)
        .map((request) => [request.variantKey!, request])
    );
    const byFamily = new Map<string, typeof requests>();
    for (const request of requests) {
      if (!request.familyKey) continue;
      const bucket = byFamily.get(request.familyKey) ?? [];
      bucket.push(request);
      byFamily.set(request.familyKey, bucket);
    }

    // Prodotti ancora plausibilmente validi, contati in blocco.
    const settings = this.settings;
    const cutoff = new Date(Date.now() - settings.maxCacheAgeHours * 3_600_000);
    const requestIds = requests.map((request) => request.id);
    const validCounts = requestIds.length
      ? await prisma.productCandidateRecord.groupBy({
          by: ["requestId"],
          where: {
            requestId: { in: requestIds },
            unavailable: false,
            price: { not: null },
            lastCheckedAt: { gte: cutoff },
          },
          _count: { _all: true },
        })
      : [];
    const validByRequest = new Map(
      validCounts.map((entry) => [entry.requestId, entry._count._all])
    );

    for (const variantKey of unique) {
      const family = this.familyOf(variantKey);
      const exact = byVariant.get(variantKey);
      const siblings = (byFamily.get(family) ?? []).filter(
        (request) => request.variantKey !== variantKey
      );

      // Le query che hanno già funzionato sulla famiglia sono il punto di
      // partenza del caso B: non si riusa il risultato, si riusa il modo di
      // cercarlo.
      const familyQueries = [
        ...new Set(
          siblings
            .flatMap((request) => [
              request.searchQueryChinese,
              request.searchQueryEnglish,
              request.searchQuery,
            ])
            .filter((query): query is string => !!query)
        ),
      ].slice(0, 8);

      result.set(variantKey, {
        requestId: exact?.id ?? null,
        candidateCount: exact?._count.candidates ?? 0,
        validCandidateCount: exact ? (validByRequest.get(exact.id) ?? 0) : 0,
        lastSearchedAt: exact?.lastSearchedAt?.toISOString() ?? null,
        lastVerifiedAt: exact?.lastVerifiedAt?.toISOString() ?? null,
        familyRequestCount: siblings.length,
        familyQueries,
      });
    }

    return result;
  }

  /** Esito della preparazione al riuso di una variante conosciuta. */
  async prepareReuse(
    requestId: string,
    options: { forceFullSearch?: boolean; refreshLimit?: number } = {}
  ): Promise<{
    reuse: boolean;
    reason: string;
    validCandidates: string[];
    invalid: InvalidProduct[];
    refreshed: number;
  }> {
    const settings = this.settings;

    if (options.forceFullSearch) {
      return {
        reuse: false,
        reason: "Ricerca completa richiesta esplicitamente.",
        validCandidates: [],
        invalid: [],
        refreshed: 0,
      };
    }

    const existing = await prisma.productCandidateRecord.count({ where: { requestId } });
    if (existing === 0) {
      return {
        reuse: false,
        reason: "Nessun prodotto salvato per questa variante.",
        validCandidates: [],
        invalid: [],
        refreshed: 0,
      };
    }

    // Prima si guarda, poi si giudica: riaprire le pagine è l'unico modo per
    // sapere se un link vecchio vale ancora qualcosa.
    const outcomes = await this.refresh.refreshRequest(requestId, {
      limit: options.refreshLimit ?? 20,
    });
    const failedByCandidate = new Map(
      outcomes.map((outcome) => [outcome.candidateId, outcome.status === "error"])
    );

    await prisma.scoutingRequest.update({
      where: { id: requestId },
      data: { lastVerifiedAt: new Date() },
    });

    const states = await this.readProductStates(requestId, failedByCandidate);
    const evaluation = evaluateKnownProducts(states, settings);
    const decision = decideReuse(evaluation, settings);

    this.logger.log(
      `variante ${requestId}: ${decision.validCandidates.length} validi, ` +
        `${evaluation.invalid.length} scartati — ${decision.reason}`
    );

    return {
      reuse: decision.reuse,
      reason: decision.reason,
      validCandidates: decision.validCandidates,
      invalid: evaluation.invalid,
      refreshed: outcomes.length,
    };
  }

  /**
   * Stato dei prodotti di una richiesta, nella forma che le regole si aspettano.
   *
   * Il prezzo precedente arriva dallo storico: è l'ultima istantanea salvata,
   * cioè il valore **prima** dell'ultimo cambiamento. È esattamente ciò che
   * serve per dire «costava X, ora costa Y».
   */
  private async readProductStates(
    requestId: string,
    failedByCandidate: Map<string, boolean>
  ): Promise<KnownProductState[]> {
    const request = await prisma.scoutingRequest.findUnique({
      where: { id: requestId },
      select: { requiredVariant: true },
    });
    const requiredVariant =
      (request?.requiredVariant as Record<string, string | number> | null) ?? {};

    const candidates = await prisma.productCandidateRecord.findMany({
      where: { requestId },
      select: {
        id: true,
        unavailable: true,
        price: true,
        vendorName: true,
        lastCheckedAt: true,
        variants: true,
        snapshots: {
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { price: true },
        },
        // Verdetto più recente del motore di selezione su questo prodotto.
        results: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outcome: true, rejectionCode: true },
        },
      },
    });

    return candidates.map((candidate) => {
      const snapshot = candidate.snapshots[0];
      const verdict = candidate.results[0];

      return {
        candidateId: candidate.id,
        unavailable: candidate.unavailable,
        refreshFailed: failedByCandidate.get(candidate.id) ?? false,
        variantMissing: variantNoLongerAvailable(candidate.variants, requiredVariant),
        // Solo una violazione di **vincolo obbligatorio** conta. Gli
        // avvertimenti di pertinenza (`matchWarnings`) no: dicono «il titolo
        // non contiene tutti i termini» o «la fonte non conferma la
        // disponibilità», e sono presenti quasi sempre. Usarli qui
        // invaliderebbe ogni prodotto a ogni passaggio, cioè spegnerebbe il
        // riuso fingendo di controllarlo.
        requirementsFailed:
          verdict?.outcome === "REJECTED" && verdict.rejectionCode === "HARD_CONSTRAINT",
        price: candidate.price == null ? null : Number(candidate.price),
        previousPrice: snapshot?.price == null ? null : Number(snapshot.price),
        vendorName: candidate.vendorName,
        hadVendor: candidate.vendorName != null,
        lastCheckedAt: candidate.lastCheckedAt,
      };
    });
  }

  /**
   * Crea o aggiorna la richiesta corrispondente a una variante analizzata.
   *
   * (Segue `variantNoLongerAvailable`, in fondo al file.)
   *
   * È il punto in cui l'analisi diventa identità persistente: da qui in poi la
   * variante ha un record suo, e tutto ciò che si troverà le resterà attaccato.
   */
  async upsertVariantRequest(
    analysis: ProductAnalysis,
    identity: ProductIdentity,
    extra: {
      fingerprint: string;
      normalizedNameKey: string;
      displayName: string;
      normalizedName: string;
      requirements: unknown;
      dimensions: unknown;
      requiredVariant: unknown;
      certifications: string[];
      targetPrice: number | null;
      notes: string | null;
      referenceUrl: string | null;
      searchQuery: string;
      language: "zh" | "en";
    }
  ): Promise<string> {
    const common = {
      familyKey: identity.familyKey,
      variantKey: identity.variantKey,
      duplicateKey: identity.duplicateKey,
      normalizedNameKey: extra.normalizedNameKey,
      displayName: extra.displayName,
      normalizedName: extra.normalizedName,
      productNameChinese: analysis.productNameChinese,
      productNameEnglish: analysis.productNameEnglish,
      searchQueryChinese: analysis.searchQueryChinese,
      searchQueryEnglish: analysis.searchQueryEnglish,
      model: analysis.model,
      material: analysis.material,
      requestedQuantity: analysis.requestedQuantity,
      unit: analysis.unit,
      certifications: extra.certifications,
      dimensions: extra.dimensions as never,
      requiredVariant: extra.requiredVariant as never,
      requirements: extra.requirements as never,
      targetPrice: extra.targetPrice,
      notes: extra.notes,
      referenceUrl: extra.referenceUrl,
      searchQuery: extra.searchQuery,
      language: extra.language,
    };

    // L'upsert è sulla variante, non sull'impronta: è la variante l'identità
    // del prodotto da cercare. L'impronta resta salvata perché serve al
    // percorso senza analisi IA, che continua a funzionare.
    const existing = await prisma.scoutingRequest.findUnique({
      where: { variantKey: identity.variantKey },
      select: { id: true },
    });
    if (existing) {
      await prisma.scoutingRequest.update({
        where: { id: existing.id },
        data: common,
      });
      return existing.id;
    }

    const created = await prisma.scoutingRequest.upsert({
      where: { fingerprint: extra.fingerprint },
      create: { fingerprint: extra.fingerprint, ...common },
      update: common,
      select: { id: true },
    });
    return created.id;
  }
}

/** Opzioni di variante esposte da una scheda prodotto. */
type CandidateVariants = Array<{ name: string; options: string[] }>;

/**
 * `true` se la variante richiesta non compare più fra quelle disponibili.
 *
 * Il controllo è deliberatamente **conservativo**: invalida solo quando la
 * scheda espone davvero un elenco di opzioni e nessuna corrisponde. Le fonti
 * che non espongono le varianti (la maggior parte dei risultati di ricerca)
 * non fanno scattare nulla — un dato assente non è un dato negativo, e
 * trattarlo come tale butterebbe via prodotti buoni a ogni aggiornamento.
 */
export function variantNoLongerAvailable(
  variants: unknown,
  requiredVariant: Record<string, string | number>
): boolean {
  const required = Object.values(requiredVariant ?? {}).map((value) =>
    String(value).normalize("NFKC").toLowerCase().trim()
  );
  if (required.length === 0) return false;

  const groups = (Array.isArray(variants) ? variants : []) as CandidateVariants;
  const options = groups
    .flatMap((group) => group?.options ?? [])
    .map((option) => String(option).normalize("NFKC").toLowerCase());
  if (options.length === 0) return false;

  // Basta che una sola delle caratteristiche richieste non sia più ordinabile
  // perché il prodotto non serva più: le varianti sono requisiti, non gusti.
  return required.some(
    (value) => value !== "" && !options.some((option) => option.includes(value))
  );
}
