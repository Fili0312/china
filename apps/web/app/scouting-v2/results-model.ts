import type {
  TaobaoCandidate,
  TaobaoPipelineGap,
  TaobaoPipelineReviewIssue,
  TaobaoPlatform,
  TaobaoRowResults,
} from "@china/shared";

/**
 * Le sole decisioni che la v2 può chiedere a una persona.
 *
 * Restano locali finché l'API non espone azioni persistite: in questo modo la
 * pagina può presentare una coda coerente senza allargare o reinterpretare i
 * contratti condivisi usati dalla v1.
 */
export const V2_HUMAN_ACTION_TYPES = [
  "APPROVE_EQUIVALENT",
  "CHOOSE_VARIANT",
  "CLARIFY_REQUIREMENT",
  "CHANGE_TOLERANCE",
  "MARK_UNAVAILABLE",
  /** Prodotto giusto, prezzo assente: va letto sulla pagina. */
  "CONFIRM_PRICE",
] as const;

export type V2HumanActionType = (typeof V2_HUMAN_ACTION_TYPES)[number];

export type V2ReviewIssue = TaobaoPipelineReviewIssue & {
  humanAction?: V2HumanActionType | null;
};

export type V2CandidateCoherence = NonNullable<
  TaobaoCandidate["coherence"]
> & {
  selectedVariant?: string | null;
  variantSelectionRequired?: boolean;
  variantChoices?: string[];
};

export type V2ResultSection =
  | "corrected"
  | "review"
  /**
   * Trovati, ma il giudice li ha respinti tutti.
   *
   * Stavano in «nessun risultato», e chi apriva quella sezione ci trovava
   * prodotti — a volte pure giusti — sotto un'etichetta che diceva il
   * contrario. Sono una cosa diversa e chiedono un gesto diverso: guardare il
   * motivo del rifiuto e, se il motivo non regge, accettare il prodotto.
   */
  | "rejected"
  | "no_result"
  /** Righe che nessun marketplace vende: moduli, servizi, codici interni. */
  | "not_procurable"
  | "auto_resolved";

export type V2ResultSectionFilter = V2ResultSection | "all";
export type V2ResultPlatformFilter = TaobaoPlatform | "all";
export type V2ResultSort =
  | "row_asc"
  | "name_asc"
  | "confidence_desc"
  | "price_asc";

export interface V2HumanAction {
  id: string;
  type: V2HumanActionType;
  rowId: string;
  rowNumber: number;
  displayName: string;
  /** Evidenza leggibile, non un comando libero da inviare al backend. */
  detail: string | null;
  attributeKey: string | null;
}

export interface V2ResultRow {
  id: string;
  rowNumber: number;
  displayName: string;
  searchQuery: string | null;
  /** Le query realmente inviate: spiegano una riga senza risultato. */
  attemptedQueries: readonly string[];
  /** Quanto ordinare, come lo chiede il foglio: serve a compilare l'ordine. */
  requestedQuantity: number | null;
  requestedUnit: string | null;
  status: TaobaoRowResults["status"] | "UNKNOWN";
  reused: boolean;
  section: V2ResultSection;
  candidate: TaobaoCandidate | null;
  candidates: readonly TaobaoCandidate[];
  candidateCount: number;
  confidence: number | null;
  price: number | null;
  /**
   * La promozione **dichiarata dalla fonte**, quando è più bassa del listino.
   *
   * Non entra nei conti: è un'informazione da verificare sulla pagina. Su una
   * riga di stecchini la fonte diceva 1,51 e la pagina Taobao 3,00, e in
   * archivio ci sono inserzioni la cui «promozione» costa più del listino.
   */
  promoPrice: number | null;
  currency: string | null;
  /** Unità di vendita del marketplace, mai l'unità richiesta nel foglio. */
  salesUnit: string | null;
  imageUrl: string | null;
  platform: TaobaoPlatform | null;
  sku: string | null;
  error: string | null;
  gap: TaobaoPipelineGap | null;
  reviewIssues: readonly V2ReviewIssue[];
  automaticIssues: readonly V2ReviewIssue[];
  actions: readonly V2HumanAction[];
  source: TaobaoRowResults | null;
  searchText: string;
}

export interface V2ResultsContext {
  gaps?: readonly TaobaoPipelineGap[];
  reviewIssues?: readonly V2ReviewIssue[];
}

export interface V2ResultFilters {
  query: string;
  section: V2ResultSectionFilter;
  platform: V2ResultPlatformFilter;
  sort: V2ResultSort;
}

export function buildV2ResultRows(
  rows: readonly TaobaoRowResults[],
  context: V2ResultsContext = {}
): V2ResultRow[] {
  const gapsByRow = new Map(
    (context.gaps ?? []).map((gap) => [gap.rowNumber, gap])
  );
  const issuesByRow = groupByRow(context.reviewIssues ?? []);
  const sourceByNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const rowNumbers = new Set<number>([
    ...rows.map((row) => row.rowNumber),
    ...gapsByRow.keys(),
    ...issuesByRow.keys(),
  ]);

  return [...rowNumbers]
    .sort((left, right) => left - right)
    .map((rowNumber) => {
      const source = sourceByNumber.get(rowNumber) ?? null;
      const gap = gapsByRow.get(rowNumber) ?? null;
      const allIssues = issuesByRow.get(rowNumber) ?? [];
      const reviewIssues = allIssues.filter((issue) => !issue.resolvedAutomatically);
      const automaticIssues = allIssues.filter(
        (issue) => issue.resolvedAutomatically
      );
      // Un gap è l'esito finale della pipeline dopo i retry, ma «scoperta» ha
      // due sensi diversi e vanno trattati diversamente.
      //
      // `no_results` / `failed`: non è stato trovato nulla, non c'è niente da
      // mostrare. `no_coherent`: prodotti la ricerca li ha trovati, è il
      // giudice ad averli respinti tutti — e quelli vanno lasciati visibili.
      // Nasconderli toglie all'operatore l'unica cosa che gli permette di
      // ribaltare un rifiuto sbagliato, e fa sembrare vuota una riga che
      // vuota non è: su una corsa da 498 righe erano 38 righe con 380
      // prodotti dietro, spariti dalla vista.
      const candidates =
        gap && gap.reason !== "no_coherent"
          ? []
          : usableCandidates(source?.candidates ?? []);
      const candidate = bestCandidate(candidates);
      const coherence = v2CandidateCoherence(candidate);
      const displayName =
        source?.displayName ||
        gap?.displayName ||
        allIssues[0]?.displayName ||
        `#${rowNumber}`;
      const rowId = source?.jobRowId ?? `pipeline-row-${rowNumber}`;
      const issueActions = gap
        ? []
        : deriveActions({
            rowId,
            rowNumber,
            displayName,
            reviewIssues,
          });
      const actions =
        !gap &&
        coherence?.variantSelectionRequired === true &&
        !issueActions.some((action) => action.type === "CHOOSE_VARIANT")
          ? [
              ...issueActions,
              {
                id: `${rowId}:CHOOSE_VARIANT`,
                type: "CHOOSE_VARIANT" as const,
                rowId,
                rowNumber,
                displayName,
                detail: coherence.variantChoices?.join(" · ") || null,
                attributeKey: "variant",
              },
            ]
          : issueActions;
      const section = classifyRow({
        source,
        gap,
        reviewIssues,
        automaticIssues,
        candidate,
        actions,
      });
      // Si quota sul listino della variante predefinita: è la cifra che la
      // pagina chiede davvero. La promozione dichiarata dalla fonte resta
      // accanto come nota, perché smentisce la pagina troppo spesso.
      const price =
        candidate?.product.price ?? candidate?.product.promotionPrice ?? null;
      const declaredPromo = candidate?.product.promotionPrice ?? null;
      const promoPrice =
        price != null && declaredPromo != null && declaredPromo < price
          ? declaredPromo
          : null;
      const salesUnit = salesUnitFromCandidate(candidate);
      const imageUrl = normalizeImageUrl(candidate?.product.imageUrl ?? null);
      const searchQuery = source?.searchQuery || gap?.searchQuery || null;
      const searchText = normalizeSearch(
        [
          displayName,
          searchQuery,
          candidate?.product.title,
          candidate?.product.titleEn,
          candidate?.product.sku,
          candidate?.product.platform,
          gap?.detail,
          source?.error,
          ...reviewIssues.flatMap((issue) => [
            issue.code,
            issue.attributeKey,
            issue.detail,
          ]),
          ...automaticIssues.flatMap((issue) => [
            issue.code,
            issue.attributeKey,
            issue.detail,
          ]),
        ]
          .filter((value): value is string => Boolean(value))
          .join(" ")
      );

      return {
        id: rowId,
        rowNumber,
        displayName,
        searchQuery,
        attemptedQueries: source?.attemptedQueries ?? [],
        requestedQuantity: source?.requestedQuantity ?? null,
        requestedUnit: source?.requestedUnit ?? null,
        status: source?.status ?? "UNKNOWN",
        reused: source?.reused ?? false,
        section,
        candidate,
        candidates,
        candidateCount: candidates.length,
        confidence: coherence?.confidence ?? null,
        price,
        promoPrice,
        currency: candidate?.product.currency ?? null,
        salesUnit,
        imageUrl,
        platform: candidate?.product.platform ?? null,
        sku:
          candidate?.product.sku ??
          coherence?.selectedVariant ??
          null,
        error: source?.error ?? gap?.detail ?? null,
        gap,
        reviewIssues,
        automaticIssues,
        actions,
        source,
        searchText,
      };
    });
}

export function filterAndSortV2ResultRows(
  rows: readonly V2ResultRow[],
  filters: V2ResultFilters
): V2ResultRow[] {
  const query = normalizeSearch(filters.query);
  const filtered = rows.filter((row) => {
    if (filters.section !== "all" && row.section !== filters.section) return false;
    if (filters.platform !== "all" && row.platform !== filters.platform) return false;
    return !query || row.searchText.includes(query);
  });

  return [...filtered].sort((left, right) => {
    let difference = 0;
    if (filters.sort === "name_asc") {
      difference = left.displayName.localeCompare(right.displayName);
    } else if (filters.sort === "confidence_desc") {
      difference = compareNullableDescending(left.confidence, right.confidence);
    } else if (filters.sort === "price_asc") {
      difference = compareNullableAscending(left.price, right.price);
    } else {
      difference = left.rowNumber - right.rowNumber;
    }
    return difference || left.rowNumber - right.rowNumber || left.id.localeCompare(right.id);
  });
}

export function groupV2ResultRows(
  rows: readonly V2ResultRow[]
): Record<V2ResultSection, V2ResultRow[]> {
  const grouped: Record<V2ResultSection, V2ResultRow[]> = {
    corrected: [],
    review: [],
    rejected: [],
    no_result: [],
    not_procurable: [],
    auto_resolved: [],
  };
  for (const row of rows) grouped[row.section].push(row);
  return grouped;
}

export interface VirtualWindow {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

export function calculateVirtualWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const safeScrollTop = Math.max(0, scrollTop);
  const visibleStart = Math.floor(safeScrollTop / rowHeight);
  const visibleEnd = Math.ceil((safeScrollTop + viewportHeight) / rowHeight);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(total, visibleEnd + overscan);
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (total - end) * rowHeight),
  };
}

/**
 * Consente solo thumbnail HTTP(S). Gli URL relativi al protocollo sono comuni
 * nei marketplace cinesi e vengono normalizzati; valori vuoti o schemi attivi
 * (`javascript:`, `data:`) usano il fallback visivo.
 */
export function normalizeImageUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Il marketplace vero di un'inserzione, letto dal suo indirizzo.
 *
 * La ricerca «Taobao» restituisce anche inserzioni **Tmall**: è la vetrina B2C
 * dello stesso gruppo, negozi ufficiali e marchi, e i suoi link stanno su
 * `detail.tmall.com`. Scrivere «Taobao» su tutti nasconde una differenza che
 * per chi compra conta — negozio ufficiale, fattura, prezzi in genere più
 * alti — e fa sembrare sbagliato un link che sbagliato non è.
 */
export function marketplaceLabel(
  url: string | null | undefined,
  platform: string | null | undefined
): string {
  const address = (url ?? "").toLowerCase();
  if (address.includes("tmall.com")) return "Tmall";
  if (address.includes("1688.com")) return "1688";
  if (address.includes("taobao.com")) return "Taobao";
  return platform === "1688" ? "1688" : "Taobao";
}

export function salesUnitFromCandidate(
  candidate: TaobaoCandidate | null | undefined
): string | null {
  const specs = candidate?.product.specs;
  if (!specs) return null;
  const acceptedKeys = new Set([
    "saleunit",
    "salesunit",
    "unit",
    "计量单位",
    "单位",
    "包装单位",
  ]);
  for (const [key, value] of Object.entries(specs)) {
    if (!acceptedKeys.has(key.trim().toLocaleLowerCase())) continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

/** Quanto una scheda è mostrabile: prezzo e immagine valgono un punto ciascuno. */
function candidateCompleteness(candidate: TaobaoCandidate): number {
  const product = candidate.product;
  const hasPrice =
    product.promotionPrice != null ||
    product.price != null ||
    product.variantPrice != null;
  return (hasPrice ? 1 : 0) + (product.imageUrl ? 1 : 0);
}

function bestCandidate(
  candidates: readonly TaobaoCandidate[]
): TaobaoCandidate | null {
  const usable = usableCandidates(candidates);
  if (usable.length === 0) return null;
  return [...usable].sort((left, right) => {
    const leftCoherence = v2CandidateCoherence(left);
    const rightCoherence = v2CandidateCoherence(right);
    const verdictDifference =
      verdictPriority(rightCoherence?.verdict) -
      verdictPriority(leftCoherence?.verdict);
    const selectionDifference =
      Number(leftCoherence?.variantSelectionRequired === true) -
      Number(rightCoherence?.variantSelectionRequired === true);
    // A pari verdetto vince la scheda che si può mostrare: una senza prezzo
    // né immagine è un riquadro vuoto, e non deve rappresentare la riga anche
    // quando la ricerca l'aveva messa prima.
    const completenessDifference =
      candidateCompleteness(right) - candidateCompleteness(left);
    return (
      verdictDifference ||
      selectionDifference ||
      completenessDifference ||
      left.rank - right.rank ||
      right.score - left.score
    );
  })[0]!;
}

function usableCandidates(
  candidates: readonly TaobaoCandidate[]
): TaobaoCandidate[] {
  // Si esclude solo ciò che non è acquistabile. Un candidato bocciato dalla
  // verifica resta un prodotto trovato: nasconderlo faceva apparire la riga
  // come «nessun risultato» anche quando la ricerca aveva prodotto qualcosa.
  // L'ordinamento per verdetto lo tiene comunque in fondo.
  return candidates.filter((candidate) => !candidate.product.unavailable);
}

/**
 * Il prodotto ha superato il giudizio dell'IA?
 *
 * «Incerto» conta come superato: il giudice non ha obiezioni, solo evidenza
 * incompleta — e la scheda che gliela darebbe la fonte non la serve. Un
 * rifiuto esplicito invece resta un rifiuto.
 */
function acceptedByAi(candidate: TaobaoCandidate | null): boolean {
  const verdict = v2CandidateCoherence(candidate)?.verdict;
  return verdict === "coherent" || verdict === "unsure";
}

/**
 * L'IA ha guardato questo prodotto e l'ha respinto — o non l'ha mai visto?
 *
 * Sono due esiti diversi e vanno in due sezioni diverse: un rifiuto esplicito
 * è «non trovato» (non c'è niente da decidere, il giudice ha già deciso),
 * mentre un candidato mai giudicato è «da confermare», perché la verifica non
 * è stata disponibile e qualcuno deve guardarlo. Confonderli è ciò che faceva
 * divergere i contatori in alto da quelli del report.
 */
function rejectedByAi(candidate: TaobaoCandidate | null): boolean {
  return v2CandidateCoherence(candidate)?.verdict === "incoherent";
}

function classifyRow({
  source,
  gap,
  reviewIssues,
  automaticIssues,
  candidate,
  actions,
}: {
  source: TaobaoRowResults | null;
  gap: TaobaoPipelineGap | null;
  reviewIssues: readonly V2ReviewIssue[];
  automaticIssues: readonly V2ReviewIssue[];
  candidate: TaobaoCandidate | null;
  actions: readonly V2HumanAction[];
}): V2ResultSection {
  // Prima di tutto: la riga era comprabile? Una richiesta che nessun venditore
  // può evadere non è un fallimento della ricerca, e metterla fra i «nessun
  // risultato» chiede all'operatore di riprovare qualcosa che non riuscirà
  // mai. Vale solo per le righe rimaste scoperte: se un prodotto coerente è
  // stato trovato lo stesso, la pipeline non emette questo gap.
  if (gap?.reason === "not_procurable") return "not_procurable";
  // Prodotti ce ne sono, li ha respinti il giudice: è un'altra sezione e
  // un'altra azione.
  if (gap?.reason === "no_coherent") return "rejected";
  const hasNoResult =
    Boolean(gap) ||
    source?.status === "FAILED" ||
    source?.status === "SKIPPED" ||
    (!candidate && Boolean(source));
  if (hasNoResult) return "no_result";
  // In revisione ci va solo ciò che una persona deve davvero decidere: una
  // scelta commerciale aperta (`actions`) o un rilievo esplicito. Un verdetto
  // «incerto» dell'IA non è una decisione umana — è il giudice che non si
  // sbilancia — e mandarci ogni riga incerta riempiva la sezione di prodotti
  // corretti, rendendola inutile da leggere.
  if (reviewIssues.length > 0 || actions.length > 0 || Boolean(gap)) {
    return "review";
  }
  // `bestCandidate` ordina per verdetto: se nemmeno il primo è accettato,
  // nessun candidato della riga lo è. Un rifiuto esplicito non lascia niente
  // da confermare — il giudice ha già deciso, e mandarlo in revisione
  // riempiva "Da confermare" di righe senza proposta: su una corsa da 498
  // righe erano 110 su 129, da aprire a una a una per scoprirle vuote.
  if (rejectedByAi(candidate)) return "no_result";
  // Mai giudicato è un'altra cosa: la verifica non c'è stata, quindi la
  // decisione tocca davvero a una persona.
  if (!acceptedByAi(candidate)) return "review";
  if (automaticIssues.length > 0) return "auto_resolved";
  return "corrected";
}

function deriveActions({
  rowId,
  rowNumber,
  displayName,
  reviewIssues,
}: {
  rowId: string;
  rowNumber: number;
  displayName: string;
  reviewIssues: readonly V2ReviewIssue[];
}): V2HumanAction[] {
  const pending: Array<{
    type: V2HumanActionType;
    detail: string | null;
    attributeKey: string | null;
  }> = [];

  for (const issue of reviewIssues) {
    const type = actionTypeForIssue(issue);
    if (!type) continue;
    pending.push({
      type,
      detail: issue.detail || issue.code,
      attributeKey: issue.attributeKey,
    });
  }

  const seen = new Set<V2HumanActionType>();
  return pending
    .filter((item) => {
      if (seen.has(item.type)) return false;
      seen.add(item.type);
      return true;
    })
    .map((item) => ({
      id: `${rowId}:${item.type}`,
      type: item.type,
      rowId,
      rowNumber,
      displayName,
      detail: item.detail,
      attributeKey: item.attributeKey,
    }));
}

function actionTypeForIssue(
  issue: V2ReviewIssue
): V2HumanActionType | null {
  return issue.humanAction ?? null;
}

function groupByRow(
  issues: readonly V2ReviewIssue[]
): Map<number, V2ReviewIssue[]> {
  const result = new Map<number, V2ReviewIssue[]>();
  for (const issue of issues) {
    const current = result.get(issue.rowNumber) ?? [];
    current.push(issue);
    result.set(issue.rowNumber, current);
  }
  return result;
}

export function v2CandidateCoherence(
  candidate: TaobaoCandidate | null | undefined
): V2CandidateCoherence | null {
  return candidate?.coherence as V2CandidateCoherence | null;
}

function verdictPriority(
  verdict: TaobaoCandidate["coherence"] extends infer Coherence
    ? Coherence extends { verdict: infer Verdict }
      ? Verdict
      : undefined
    : undefined
): number {
  if (verdict === "coherent") return 3;
  if (verdict === "unsure") return 2;
  if (verdict === "incoherent") return 1;
  return 0;
}

function compareNullableAscending(
  left: number | null,
  right: number | null
): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return left - right;
}

function compareNullableDescending(
  left: number | null,
  right: number | null
): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return right - left;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase();
}
