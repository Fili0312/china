import {
  convertToBaseUnit,
  type AnalysisWarning,
  type ProductAnalysis,
} from "@china/shared";

/**
 * Provenienza dei requisiti usata soltanto dalla pipeline v2.
 *
 * Il contratto pubblico `ProductAnalysis` rimane invariato. La v2 conserva:
 * - la riga originale in `TaobaoDatasetRow.cells`;
 * - la risposta grezza del modello in `RequestAnalysis.analysis`;
 * - l'analisi operativa, ripulita, in `TaobaoAnalysisRow.effectiveAnalysis`;
 * - questo contesto in `TaobaoAnalysisRow.manualEdits._v2RequirementContext`.
 *
 * In questo modo un dato dedotto resta disponibile per audit, ma non diventa
 * per errore un requisito obbligatorio o un warning da mostrare al cliente.
 */
export interface V2RequirementContext {
  sourceText: string;
  explicit: string[];
  normalized: string[];
  inferred: string[];
  immutableSearchTokens: string[];
  immutableTextRequirements: string[];
  modelTokens: string[];
  quantity: {
    value: number | null;
    unit: string | null;
  };
}

export interface V2NormalizedAnalysis {
  analysis: ProductAnalysis;
  context: V2RequirementContext;
}

export interface V2CandidateEvidence {
  title: string;
  titleEn?: string | null;
  sku?: string | null;
  shopName?: string | null;
  specs?: Record<string, string> | null;
  variants?: Array<{ name: string; options: string[] }> | null;
  moq?: number | null;
}

/** Esito del confronto fra un vincolo esplicito e l'evidenza disponibile. */
export type V2ConstraintVerdict = "match" | "conflict" | "unknown";

export interface V2CandidateEvaluation {
  status: V2ConstraintVerdict;
  /** Vincoli contraddetti dall'evidenza: bastano a escludere il candidato. */
  conflicts: string[];
  /** Vincoli non verificabili con l'evidenza attuale: servono dettaglio o IA. */
  unresolved: string[];
}

export interface V2RetrySearchResult<T> {
  products: T[];
  calls: number;
}

export interface V2RetryOutcome<T> {
  products: T[];
  calls: number;
  attemptedQueries: string[];
  sawCandidates: boolean;
}

export const V2_MAX_RETRY_QUERIES = 3;
export const V2_NO_COMPATIBLE_PREFIX = "V2_NO_COMPATIBLE";

const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
const QUANTITY_LABELS = ["quantità", "quantita", "quantity", "数量"];
const UNIT_LABELS = ["unità", "unita", "unit", "单位"];
const MODEL_LABELS = [
  "modello/codice",
  "modello",
  "model/code",
  "model",
  "codice",
  "code",
  "型号",
];
const MATERIAL_LABELS = ["materiale", "material", "材料"];
const COLOR_LABELS = ["colore", "color", "colour", "颜色"];

const UNIT_PATTERN = [
  "mm",
  "cm",
  "dm",
  "km",
  "m",
  "µm",
  "μm",
  "um",
  "nm",
  "in",
  "inch",
  "inches",
  "ft",
  "mg",
  "kg",
  "g",
  "lb",
  "oz",
  "ml",
  "cl",
  "dl",
  "l",
  "mv",
  "kv",
  "v",
  "mw",
  "kw",
  "w",
  "ma",
  "a",
  "mah",
  "ah",
  "khz",
  "mhz",
  "hz",
  "mbar",
  "bar",
  "kpa",
  "mpa",
  "pa",
  "psi",
  "rpm",
  "°c",
  "毫安时",
  "安时",
  "毫伏",
  "千伏",
  "伏特",
  "伏",
  "毫瓦",
  "千瓦",
  "瓦特",
  "瓦",
  "毫安",
  "安",
  "兆赫",
  "千赫",
  "赫兹",
  "赫",
  "毫巴",
  "兆帕",
  "千帕",
  "帕",
  "巴",
  "pcs?",
  "pieces?",
  "pz",
  "pezzi",
  "毫米",
  "厘米",
  "千米",
  "米",
  "毫克",
  "公斤",
  "千克",
  "克",
  "毫升",
  "升",
  "件",
  "个",
  "只",
  "套",
  "卷",
  "包",
  "箱",
  "片",
  "张",
]
  .sort((left, right) => right.length - left.length)
  .join("|");

const MEASUREMENT_RE = new RegExp(
  String.raw`\d+(?:[.,]\d+)?(?:\s*[x×*]\s*\d+(?:[.,]\d+)?){1,2}(?:\s*(?:${UNIT_PATTERN}))?|\d+(?:[.,]\d+)?\s*(?:${UNIT_PATTERN})`,
  "giu"
);
const PLAIN_NUMBER_RE = /\d+(?:[.,]\d+)?/gu;
const PHYSICAL_CONSTRAINT_RE = new RegExp(
  String.raw`^(\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?){0,2})(${UNIT_PATTERN})$`,
  "iu"
);
const DIMENSION_GROUP_RE = new RegExp(
  String.raw`^(\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)*)(${UNIT_PATTERN})?$`,
  "iu"
);
const RANGE_RE = new RegExp(
  String.raw`(\d+(?:\.\d+)?)[-~](\d+(?:\.\d+)?)(${UNIT_PATTERN})?`,
  "giu"
);
const MODEL_TOKEN_RE =
  /[\p{L}\p{N}]+(?:[-_/][\p{L}\p{N}]+)+|(?=[\p{L}\p{N}]{4,}(?:[^\p{L}\p{N}]|$))(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]{4,}/gu;

const V2_EXTRA_MEASURE_TABLES: Array<{
  base: string;
  units: Record<string, number>;
}> = [
  {
    base: "mm",
    units: {
      nm: 0.000001,
      um: 0.001,
      "µm": 0.001,
      "μm": 0.001,
      km: 1_000_000,
      ft: 304.8,
    },
  },
  {
    base: "kg",
    units: {
      lb: 0.45359237,
      oz: 0.028349523125,
    },
  },
  {
    base: "A",
    units: {
      ma: 0.001,
      a: 1,
      毫安: 0.001,
      安: 1,
    },
  },
  {
    base: "V",
    units: {
      毫伏: 0.001,
    },
  },
  {
    base: "W",
    units: {
      毫瓦: 0.001,
    },
  },
  {
    base: "Hz",
    units: {
      hz: 1,
      khz: 1_000,
      mhz: 1_000_000,
      赫: 1,
      赫兹: 1,
      千赫: 1_000,
      兆赫: 1_000_000,
    },
  },
  {
    base: "Pa",
    units: {
      pa: 1,
      kpa: 1_000,
      mpa: 1_000_000,
      mbar: 100,
      bar: 100_000,
      psi: 6_894.757293168,
      帕: 1,
      千帕: 1_000,
      兆帕: 1_000_000,
      毫巴: 100,
      巴: 100_000,
    },
  },
];

function normalizeSpace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineValue(sourceText: string, labels: readonly string[]): string | null {
  const aliases = [...labels]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex)
    .join("|");
  const match = sourceText.match(
    new RegExp(
      String.raw`(?:^|\n)[^\n]{0,80}?(?:${aliases})\s*:\s*([^\n]+)`,
      "iu"
    )
  );
  return match?.[1]?.trim() || null;
}

function stripAdministrativeLines(sourceText: string): string {
  const labels = [...QUANTITY_LABELS, ...UNIT_LABELS, "link", "url", "链接"]
    .map(escapeRegex)
    .join("|");
  return sourceText
    .replace(URL_RE, " ")
    .split(/\r?\n/u)
    .filter((line) => !new RegExp(String.raw`^\s*(?:${labels})\s*:`, "iu").test(line))
    .join("\n");
}

/**
 * Il blocco full-row serve al modello e all'audit, non all'estrazione
 * deterministica. Prezzi target, date e centri di costo presenti in celle non
 * mappate non devono mai diventare numeri della query prodotto.
 */
export function v2ConstraintSourceText(sourceText: string): string {
  const marker =
    /(?:^|\n)\s*(?:Utilizzo\s*:\s*)?Contesto completo della riga\s*:/iu;
  const index = sourceText.search(marker);
  return (index >= 0 ? sourceText.slice(0, index) : sourceText).trim();
}

function canonicalConstraint(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<=\d),(?=\d)/gu, ".")
    .replace(/[×*]/gu, "x")
    .replace(/\s+/gu, "")
    .replace(/[()[\]{}]/gu, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeSpace(value)).filter(Boolean))];
}

function extractMeasurementTokens(value: string): Array<{
  raw: string;
  canonical: string;
  start: number;
  end: number;
}> {
  const matches: Array<{ raw: string; canonical: string; start: number; end: number }> = [];
  for (const match of value.matchAll(MEASUREMENT_RE)) {
    if (match.index == null) continue;
    const raw = match[0].trim();
    matches.push({
      raw,
      canonical: canonicalConstraint(raw),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

function extractTechnicalTokens(value: string): string[] {
  const source = value.replace(URL_RE, " ");
  const measurements = extractMeasurementTokens(source);
  const masked = [...source];
  for (const match of measurements) {
    for (let index = match.start; index < match.end; index += 1) masked[index] = " ";
  }
  const plain = [...masked.join("").matchAll(PLAIN_NUMBER_RE)].map((match) =>
    canonicalConstraint(match[0])
  );
  return unique([
    ...measurements.map((match) => match.canonical),
    ...plain,
  ]);
}

function extractModelTokens(value: string, technicalTokens: readonly string[]): string[] {
  const technical = new Set(technicalTokens.map(canonicalConstraint));
  return unique(
    [...value.replace(URL_RE, " ").matchAll(MODEL_TOKEN_RE)]
      .map((match) => match[0])
      .filter((token) => !technical.has(canonicalConstraint(token)))
  );
}

function parseQuantity(value: string | null): number | null {
  if (!value) return null;
  const match = value.normalize("NFKC").match(/\d+(?:[.,]\d+)?/u);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function quantityUnit(quantityText: string | null, unitText: string | null): string | null {
  if (unitText?.trim()) return normalizeSpace(unitText);
  if (!quantityText) return null;
  const withoutNumber = quantityText
    .normalize("NFKC")
    .replace(/\d+(?:[.,]\d+)?/u, " ")
    .trim();
  return withoutNumber || null;
}

function sourceContains(sourceText: string, value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  const source = compact(sourceText);
  const expected = compact(value);
  return expected.length > 0 && source.includes(expected);
}

function matchingSourceModel(
  sourceText: string,
  analysisModel: string | null,
  modelTokens: readonly string[]
): string | null {
  const labelled = lineValue(sourceText, MODEL_LABELS);
  if (labelled) return normalizeSpace(labelled);
  if (analysisModel && sourceContains(sourceText, analysisModel)) {
    const exact = modelTokens.find(
      (token) => compact(token) === compact(analysisModel)
    );
    return exact ?? analysisModel;
  }
  return null;
}

function requestedField(
  sourceText: string,
  analysisValue: string | null,
  labels: readonly string[]
): string | null {
  const labelled = lineValue(sourceText, labels);
  if (labelled) return normalizeSpace(labelled);
  return analysisValue && sourceContains(sourceText, analysisValue)
    ? analysisValue
    : null;
}

function groundedRequirement(sourceText: string, requirement: string): boolean {
  const terms = fold(requirement)
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((term) => /\d/u.test(term) || term.length >= 3);
  if (terms.length === 0) return false;
  const source = fold(sourceText);
  const found = terms.filter((term) => source.includes(term)).length;
  return found >= Math.max(1, Math.ceil(terms.length * 0.6));
}

function hasExplicitOptionalField(
  field: string,
  sourceText: string,
  analysis: ProductAnalysis
): boolean {
  const key = fold(field);
  if (/(?:^|\b)(?:model|modello|codice|code|型号)(?:\b|$)/u.test(key)) {
    return matchingSourceModel(
      sourceText,
      analysis.model,
      extractModelTokens(sourceText, extractTechnicalTokens(sourceText))
    ) != null;
  }
  if (/(?:material|materiale|材料)/u.test(key)) {
    return requestedField(sourceText, analysis.material, MATERIAL_LABELS) != null;
  }
  if (/(?:colou?r|colore|颜色)/u.test(key)) {
    return requestedField(sourceText, analysis.color, COLOR_LABELS) != null;
  }
  if (/(?:quantity|quantita|quantità|数量)/u.test(key)) {
    return lineValue(sourceText, QUANTITY_LABELS) != null;
  }
  if (/(?:unit|unita|unità|单位)/u.test(key)) {
    return extractTechnicalTokens(stripAdministrativeLines(sourceText)).length > 0;
  }
  if (/(?:dimension|measure|misur|尺寸)/u.test(key)) {
    return extractTechnicalTokens(stripAdministrativeLines(sourceText)).length > 0;
  }
  if (/(?:accessor|brand|marca|certification|certificaz|sku|variant|variante)/u.test(key)) {
    return new RegExp(String.raw`(?:^|\n)\s*${escapeRegex(field)}\s*:`, "iu").test(
      sourceText
    );
  }
  return true;
}

/**
 * Un warning su un attributo opzionale mai richiesto è un falso warning.
 * I warning generali e `MULTIPLE_PRODUCTS` restano intatti.
 */
/**
 * L'unità che l'analisi ha dedotto ma non ha scritto.
 *
 * Il modello sa quasi sempre di cosa si parla — «presumibilmente cm» per uno
 * scaffale, «presumibilmente mm» per un calibro — e poi alza comunque un
 * avviso, che arriva all'operatore come una domanda senza risposta utile: la
 * risposta era nel messaggio stesso. Qui la si prende e la si applica.
 */
const PRESUMED_UNIT_RE = new RegExp(
  String.raw`(?:presumibilmente|probabilmente|presumably|probably|verosimilmente)\s*[:,]?\s*(${UNIT_PATTERN})\b`,
  "iu"
);

function presumedUnit(warning: AnalysisWarning): string | null {
  const match = warning.message.normalize("NFKC").match(PRESUMED_UNIT_RE);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Completa le quote senza unità e toglie l'avviso che le riguardava.
 *
 * Si interviene solo quando l'unità è **dichiarata nel messaggio**: dedurla
 * per conto nostro dal solo ordine di grandezza sarebbe indovinare, e su una
 * quota indovinare significa comprare il pezzo sbagliato.
 */
function applyPresumedUnits(
  dimensions: ProductAnalysis["dimensions"],
  warnings: readonly AnalysisWarning[]
): {
  dimensions: ProductAnalysis["dimensions"];
  warnings: AnalysisWarning[];
  applied: string | null;
} {
  const missing = dimensions.filter((dimension) => !dimension.unit);
  if (missing.length === 0) {
    return { dimensions, warnings: [...warnings], applied: null };
  }

  const source = warnings.find(
    (warning) => warning.code === "AMBIGUOUS_UNIT" && presumedUnit(warning)
  );
  const unit = source ? presumedUnit(source) : null;
  if (!unit) return { dimensions, warnings: [...warnings], applied: null };

  return {
    dimensions: dimensions.map((dimension) =>
      dimension.unit ? dimension : { ...dimension, unit }
    ),
    // Con l'unità scritta l'ambiguità non c'è più: l'avviso sparisce.
    warnings: warnings.filter((warning) => warning.code !== "AMBIGUOUS_UNIT"),
    applied: unit,
  };
}

export function isV2WarningRelevant(
  warning: AnalysisWarning,
  sourceText: string,
  analysis: ProductAnalysis
): boolean {
  const message = fold(warning.message);
  if (
    /\b(?:sku|listing|product page|item page|availability|available|in stock|out of stock|selectable variant|price per|included accessories?|inserzione|scheda prodotto|disponibilita|disponibile|variante selezionabile|prezzo per|accessori inclusi)\b/u.test(
      message
    ) ||
    /(?:商品详情|商品页面|库存|有货|缺货|可选规格|价格单位|单价|配件包含|淘宝)/u.test(
      message
    )
  ) {
    return true;
  }
  const constraintSource = v2ConstraintSourceText(sourceText);
  const technicalTokens = extractTechnicalTokens(
    stripAdministrativeLines(constraintSource)
  );
  switch (warning.code) {
    case "AMBIGUOUS_MODEL":
      return matchingSourceModel(
        constraintSource,
        analysis.model,
        extractModelTokens(constraintSource, technicalTokens)
      ) != null;
    case "AMBIGUOUS_UNIT":
    case "AMBIGUOUS_MEASURE":
      return technicalTokens.length > 0;
    case "AMBIGUOUS_QUANTITY":
      return lineValue(constraintSource, QUANTITY_LABELS) != null;
    case "MULTIPLE_PRODUCTS":
      return true;
    default:
      return warning.field
        ? hasExplicitOptionalField(warning.field, constraintSource, analysis)
        : true;
  }
}

function dimensionGrounded(sourceText: string, value: number, unit: string | null): boolean {
  const number = String(value).replace(/\.0+$/u, "");
  if (unit && sourceContains(sourceText, `${number}${unit}`)) return true;
  return new RegExp(
    String.raw`(?:^|[^\d])${escapeRegex(number)}(?:[^\d]|$)`,
    "u"
  ).test(sourceText);
}

function specGrounded(sourceText: string, value: string, unit: string | null): boolean {
  return (
    sourceContains(sourceText, `${value}${unit ?? ""}`) ||
    sourceContains(sourceText, value)
  );
}

function baseProductName(analysis: ProductAnalysis): string {
  return (
    analysis.productNameChinese?.trim() ||
    analysis.productNameEnglish?.trim() ||
    analysis.productFamily.trim()
  );
}

function queryRecognizesProduct(query: string, analysis: ProductAnalysis): boolean {
  const foldedQuery = compact(query);
  const names = [
    analysis.productNameChinese,
    analysis.productNameEnglish,
    analysis.productFamily,
  ].filter((value): value is string => Boolean(value?.trim()));
  return names.some((name) => {
    const whole = compact(name);
    if (whole.length >= 2 && foldedQuery.includes(whole)) return true;
    const terms = fold(name)
      .split(/[^\p{L}\p{N}]+/gu)
      .filter((term) => term.length >= 3);
    return terms.some((term) => fold(query).includes(term));
  });
}

function queryHasUnexpectedNumbers(
  query: string,
  context: V2RequirementContext,
  analysis: ProductAnalysis
): boolean {
  const allowed = new Set(
    [
      ...context.immutableSearchTokens,
      ...extractTechnicalTokens(
        [
          analysis.productNameChinese ?? "",
          analysis.productNameEnglish ?? "",
          analysis.productFamily,
        ].join(" ")
      ),
    ].map(canonicalConstraint)
  );
  return extractTechnicalTokens(query).some(
    (token) => !allowed.has(canonicalConstraint(token))
  );
}

/**
 * Ricostruisce la query quando quella proposta è inutilizzabile.
 *
 * Si riparte dal nome prodotto e dalle **misure dell'analisi**, non da tutti i
 * numeri presenti nella riga: codici articolo, quantità e prezzi non sono
 * termini di ricerca e restringono la query fino a non trovare niente.
 */
function rebuildQueryFromAnalysis(
  analysis: ProductAnalysis,
  context: V2RequirementContext
): string {
  const parts = [baseProductName(analysis)];
  const model = context.modelTokens[0] ?? analysis.model;
  if (model) parts.push(model);

  const seen = new Set(parts.map(compact));
  const push = (value: string) => {
    if (!value || seen.has(compact(value))) return;
    seen.add(compact(value));
    parts.push(value);
  };

  for (const dimension of analysis.dimensions ?? []) {
    if (dimension.value == null) continue;
    push(`${dimension.value}${dimension.unit ?? ""}`);
  }
  for (const token of context.immutableSearchTokens) {
    const parsed = dimensionGroup(token);
    // Solo misure vere: un valore con unità. Un numero nudo è quasi sempre un
    // codice articolo o una quantità, e in una query cerca sé stesso.
    if (!parsed?.unit) continue;
    // La quantità ordinata non è una caratteristica del prodotto.
    if (
      context.quantity.value != null &&
      parsed.values.length === 1 &&
      parsed.values[0] === context.quantity.value
    ) {
      continue;
    }
    push(token);
  }
  return normalizeSpace(parts.filter(Boolean).join(" "));
}

/**
 * Ripara una query v2 solo quando è davvero rotta.
 *
 * La query dell'analisi si usa **verbatim**, esattamente come fa la v1: è
 * scritta come la scriverebbe un compratore cinese — `品名 + 规格` — ed è più
 * precisa di qualunque ricostruzione. Aggiungerle ogni vincolo della riga la
 * trasformava in un elenco di numeri (`货架 300kg 4 200 40 140`) che il
 * marketplace cerca in AND e che quindi non trova nulla.
 *
 * Resta un solo motivo per intervenire: una riscrittura che perde l'identità
 * del prodotto o che introduce un numero in contrasto con la riga. In quel
 * caso si scarta per intero e si ricostruisce, perché affiancare il valore
 * giusto a quello sbagliato produrrebbe una query contraddittoria.
 */
export function repairV2SearchQuery(
  proposedQuery: string | null | undefined,
  analysis: ProductAnalysis,
  context: V2RequirementContext
): string {
  const cleaned = normalizeSpace((proposedQuery ?? "").replace(URL_RE, " "));
  const validProposal =
    cleaned &&
    queryRecognizesProduct(cleaned, analysis) &&
    !queryHasUnexpectedNumbers(cleaned, context, analysis);
  return tidySearchQuery(
    validProposal ? cleaned : rebuildQueryFromAnalysis(analysis, context),
    analysis,
    context
  );
}

/**
 * Descrittori che il foglio attacca alle misure e i venditori non scrivono.
 *
 * `50mm宽` («50mm di larghezza») non compare in nessun titolo: là si legge
 * `50mm`. Sono i caratteri che qualificano una quota — larghezza, lunghezza,
 * spessore, diametro interno ed esterno — e vivono nella richiesta, non
 * nell'inserzione. Toglierli non perde informazione: il vincolo resta nel
 * contesto e lo verifica il gate.
 */
const MEASURE_DESCRIPTORS = [
  "内径",
  "外径",
  "壁厚",
  "直径",
  "宽度",
  "长度",
  "高度",
  "厚度",
  "宽",
  "长",
  "高",
  "厚",
];

/** Stacca il descrittore da una misura: `内径80mm` → `80mm`, `50mm宽` → `50mm`. */
function stripMeasureDescriptor(token: string): string {
  let result = token;
  for (const descriptor of MEASURE_DESCRIPTORS) {
    // Solo se ciò che resta è ancora una misura: `厚度` da solo non è un numero.
    const asPrefix = new RegExp(`^${descriptor}(?=\\d)`, "u");
    const asSuffix = new RegExp(`(?<=[\\d\\p{L}])${descriptor}$`, "u");
    if (asPrefix.test(result)) result = result.replace(asPrefix, "");
    if (/\d/u.test(result) && asSuffix.test(result)) {
      result = result.replace(asSuffix, "");
    }
  }
  return result || token;
}

/** `5.00mm` e `5mm` sono la stessa misura, ma solo una la scrivono i venditori. */
function trimTrailingZeros(token: string): string {
  return token.replace(
    /(\d+)[.,](\d*?)0+(?=\D|$)/gu,
    (_match, whole: string, decimals: string) =>
      decimals.length > 0 ? `${whole}.${decimals}` : whole
  );
}

/**
 * Toglie dalla query ciò che nessun venditore scrive nel titolo.
 *
 * Tre pulizie, tutte misurate sulla fonte reale il 28/07/2026, dove ognuna
 * da sola faceva passare la stessa ricerca da **0 a 20 risultati**:
 *
 * - **zeri finali** — `陶瓷针规 5.00mm 塞规` non trova niente, `5mm` sì. Il
 *   foglio scrive le misure con la precisione dello strumento, il negozio con
 *   quella del linguaggio.
 * - **unità di conteggio** — `单支`, `单个`: vengono dalla colonna «unità» del
 *   foglio e dicono *come si contano* i pezzi, non *cosa* si compra. Si toglie
 *   l'unità dichiarata dal foglio e la sua forma con `单`, quindi senza
 *   elenchi di parole: il dato viene dalla riga.
 * - **numeri nudi** — vedi `groundBareNumbers`.
 */
function tidySearchQuery(
  query: string,
  analysis: ProductAnalysis,
  context: V2RequirementContext
): string {
  const unit = context.quantity.unit?.trim();
  const droppable = new Set(
    unit ? [compact(unit), compact(`单${unit}`)] : []
  );

  const kept = normalizeSpace(query)
    .split(/\s+/u)
    .map((token) => trimTrailingZeros(stripMeasureDescriptor(token)))
    .filter((token) => token && !droppable.has(compact(token)));

  const tidied = normalizeSpace(kept.join(" "));
  return groundBareNumbers(tidied || normalizeSpace(query), analysis);
}

/** Un termine è un numero e nient'altro: né unità, né separatori, né lettere. */
const BARE_NUMBER_RE = /^\d+(?:[.,]\d+)?$/u;

/**
 * Dà un'unità ai numeri nudi della query, o li toglie.
 *
 * Un numero senza unità è il modo più efficace di non trovare niente: il
 * marketplace mette i termini in AND e nessun titolo contiene «200» e «40» e
 * «140» tutti insieme. Misurato sulle query realmente inviate:
 *
 * - `货架 200 40 140 300kg` → **0 risultati**; `货架 300kg` → **20**
 * - `打标测试板 86 54 0.21` → **0 risultati**; `打标测试板` → **20**
 *
 * Quando il numero corrisponde a una misura dell'analisi si recupera la sua
 * unità (`2.48` → `2.48mm`): così la query resta precisa invece di allargarsi.
 * Quando non corrisponde a nulla è un frammento di dimensione o un codice
 * amministrativo, e va via. I termini con unità, separatore o lettera
 * (`300kg`, `60x60`, `M1`, `4P`) non vengono toccati: quelli il venditore li
 * scrive nel titolo.
 */
function groundBareNumbers(query: string, analysis: ProductAnalysis): string {
  const unitByValue = new Map<string, string>();
  for (const dimension of analysis.dimensions ?? []) {
    if (dimension.value == null || !dimension.unit) continue;
    unitByValue.set(String(dimension.value), dimension.unit);
  }

  const kept = normalizeSpace(query)
    .split(/\s+/u)
    .map((token) => {
      if (!BARE_NUMBER_RE.test(token)) return token;
      const unit = unitByValue.get(token.replace(",", "."));
      return unit ? `${token}${unit}` : "";
    })
    .filter(Boolean);

  const rebuilt = normalizeSpace(kept.join(" "));
  // Non si restituisce mai una query vuota: meglio quella di partenza.
  return rebuilt || normalizeSpace(query);
}

/**
 * Estrae il contesto esplicito senza modificare l'analisi.
 */
export function deriveV2RequirementContext(
  analysis: ProductAnalysis,
  sourceText: string
): V2RequirementContext {
  const source = sourceText.normalize("NFKC").trim();
  const constraintSource = v2ConstraintSourceText(source);
  const technicalSource = stripAdministrativeLines(constraintSource);
  const immutableSearchTokens = extractTechnicalTokens(technicalSource);
  const labelledModel = lineValue(constraintSource, MODEL_LABELS);
  const modelTokens = unique([
    ...(labelledModel ? extractModelTokens(labelledModel, immutableSearchTokens) : []),
    ...extractModelTokens(technicalSource, immutableSearchTokens).filter(
      (token) => analysis.model != null && compact(token) === compact(analysis.model)
    ),
  ]);
  if (labelledModel && modelTokens.length === 0) modelTokens.push(normalizeSpace(labelledModel));

  // Quantità e unità si leggono dal testo **intero**, non da quello troncato.
  //
  // Il troncamento serve ai vincoli tecnici: taglia via il riversamento
  // «Contesto completo della riga» perché lì dentro finiscono numeri
  // amministrativi che non sono misure. Ma le righe `Quantità:` e `Unità:`
  // vengono aggiunte **dopo** quel marcatore, quindi cercarle solo prima le
  // rendeva invisibili: era nullo su ogni riga, e il grounding sovrascriveva
  // con quel nulla anche la quantità che l'IA aveva letto correttamente.
  const quantityText =
    lineValue(constraintSource, QUANTITY_LABELS) ??
    lineValue(source, QUANTITY_LABELS);
  const unitText =
    lineValue(constraintSource, UNIT_LABELS) ?? lineValue(source, UNIT_LABELS);
  const quantity = {
    value: parseQuantity(quantityText),
    unit: quantityUnit(quantityText, unitText),
  };
  const explicitMaterial = requestedField(
    constraintSource,
    analysis.material,
    MATERIAL_LABELS
  );
  const explicitColor = requestedField(
    constraintSource,
    analysis.color,
    COLOR_LABELS
  );
  const explicitHardRequirements = analysis.hardRequirements.filter((requirement) =>
    groundedRequirement(constraintSource, requirement)
  );
  const explicitAccessories = analysis.includedAccessories.filter((accessory) =>
    groundedRequirement(constraintSource, accessory)
  );
  const explicitSpecs = analysis.technicalSpecifications
    .filter((spec) => specGrounded(constraintSource, spec.value, spec.unit))
    .map((spec) => `${spec.value}${spec.unit ?? ""}`);
  const immutableTextRequirements = unique([
    explicitMaterial ?? "",
    explicitColor ?? "",
    ...explicitHardRequirements,
    ...explicitAccessories,
    ...explicitSpecs,
  ]).filter(
    // I valori già protetti come numero/unità non devono essere verificati
    // due volte con regole testuali meno precise.
    (requirement) =>
      !immutableSearchTokens.some(
        (token) => compact(requirement) === compact(token)
      )
  );

  const explicit = unique([
    ...immutableSearchTokens.map((token) => `constraint:${token}`),
    ...modelTokens.map((token) => `model:${token}`),
    ...immutableTextRequirements.map((requirement) => `feature:${requirement}`),
    ...(quantity.value != null
      ? [`quantity:${quantity.value}${quantity.unit ? ` ${quantity.unit}` : ""}`]
      : []),
  ]);

  return {
    sourceText: source,
    explicit,
    normalized: [],
    inferred: [],
    immutableSearchTokens,
    immutableTextRequirements,
    modelTokens,
    quantity,
  };
}

/** Legge il contesto additivo senza rendere fragile l'apertura di righe storiche. */
export function readV2RequirementContext(value: unknown): V2RequirementContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const container = value as Record<string, unknown>;
  const candidate = container._v2RequirementContext;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const context = candidate as Record<string, unknown>;
  const quantity = context.quantity;
  if (
    typeof context.sourceText !== "string" ||
    !Array.isArray(context.explicit) ||
    !Array.isArray(context.normalized) ||
    !Array.isArray(context.inferred) ||
    !Array.isArray(context.immutableSearchTokens) ||
    !Array.isArray(context.immutableTextRequirements) ||
    !Array.isArray(context.modelTokens) ||
    typeof quantity !== "object" ||
    quantity === null ||
    Array.isArray(quantity)
  ) {
    return null;
  }
  const arrays = [
    context.explicit,
    context.normalized,
    context.inferred,
    context.immutableSearchTokens,
    context.immutableTextRequirements,
    context.modelTokens,
  ];
  if (arrays.some((entries) => entries.some((entry) => typeof entry !== "string"))) {
    return null;
  }
  const parsedQuantity = quantity as Record<string, unknown>;
  if (
    parsedQuantity.value !== null &&
    typeof parsedQuantity.value !== "number"
  ) {
    return null;
  }
  if (
    parsedQuantity.unit !== null &&
    typeof parsedQuantity.unit !== "string"
  ) {
    return null;
  }
  return {
    sourceText: context.sourceText,
    explicit: context.explicit as string[],
    normalized: context.normalized as string[],
    inferred: context.inferred as string[],
    immutableSearchTokens: context.immutableSearchTokens as string[],
    immutableTextRequirements: context.immutableTextRequirements as string[],
    modelTokens: context.modelTokens as string[],
    quantity: {
      value: parsedQuantity.value as number | null,
      unit: parsedQuantity.unit as string | null,
    },
  };
}

/**
 * Crea l'analisi operativa v2:
 * - i valori espliciti vengono ripristinati dalla sorgente;
 * - le traduzioni/chiavi restano come normalizzazioni utili;
 * - attributi e vincoli dedotti ma non presenti vengono tolti dai vincoli
 *   operativi e registrati in `context.inferred`;
 * - la query viene riparata deterministicamente.
 */
export function normalizeV2Analysis(
  analysis: ProductAnalysis,
  sourceText: string
): V2NormalizedAnalysis {
  const baseContext = deriveV2RequirementContext(analysis, sourceText);
  const constraintSource = v2ConstraintSourceText(sourceText);
  const normalized: string[] = [];
  const inferred: string[] = [];

  const model = matchingSourceModel(
    constraintSource,
    analysis.model,
    baseContext.modelTokens
  );
  if (analysis.model && !model) inferred.push(`model:${analysis.model}`);
  if (model && model !== analysis.model) normalized.push(`model:${analysis.model ?? "null"}→${model}`);

  const material = requestedField(
    constraintSource,
    analysis.material,
    MATERIAL_LABELS
  );
  if (analysis.material && !material) inferred.push(`material:${analysis.material}`);
  if (material && material !== analysis.material) {
    normalized.push(`material:${analysis.material ?? "null"}→${material}`);
  }

  const color = requestedField(
    constraintSource,
    analysis.color,
    COLOR_LABELS
  );
  if (analysis.color && !color) inferred.push(`color:${analysis.color}`);
  if (color && color !== analysis.color) {
    normalized.push(`color:${analysis.color ?? "null"}→${color}`);
  }

  const dimensions = analysis.dimensions.filter((dimension) => {
    const grounded = dimensionGrounded(
      constraintSource,
      dimension.value,
      dimension.unit
    );
    if (!grounded) {
      inferred.push(
        `dimension:${dimension.value}${dimension.unit ?? ""}`
      );
    }
    return grounded;
  });
  const technicalSpecifications = analysis.technicalSpecifications.filter((spec) => {
    const grounded = specGrounded(
      constraintSource,
      spec.value,
      spec.unit
    );
    if (!grounded) inferred.push(`spec:${spec.key}=${spec.value}${spec.unit ?? ""}`);
    return grounded;
  });
  const hardRequirements = analysis.hardRequirements.filter((requirement) => {
    const grounded = groundedRequirement(constraintSource, requirement);
    if (!grounded) inferred.push(`hard:${requirement}`);
    return grounded;
  });
  const softRequirements = analysis.softRequirements.filter((requirement) => {
    const grounded = groundedRequirement(constraintSource, requirement);
    if (!grounded) inferred.push(`soft:${requirement}`);
    return grounded;
  });

  // La colonna del foglio comanda, ma la sua assenza non cancella l'analisi:
  // se il foglio non dichiara una quantità si tiene quella che l'IA ha letto
  // dalle specifiche. Azzerarla faceva perdere la quantità da ordinare — che è
  // il dato con cui si compila l'ordine.
  const requestedQuantity =
    baseContext.quantity.value ?? analysis.requestedQuantity;
  const unit = baseContext.quantity.unit ?? analysis.unit;
  if (requestedQuantity !== analysis.requestedQuantity) {
    normalized.push(
      `quantity:${analysis.requestedQuantity ?? "null"}→${requestedQuantity ?? "null"}`
    );
  }
  if (unit !== analysis.unit) {
    normalized.push(`unit:${analysis.unit ?? "null"}→${unit ?? "null"}`);
  }

  const relevantWarnings = analysis.warnings.filter((warning) =>
    isV2WarningRelevant(warning, sourceText, analysis)
  );
  const withUnits = applyPresumedUnits(dimensions, relevantWarnings);
  if (withUnits.applied) {
    normalized.push(`dimensionUnit:null→${withUnits.applied}`);
  }

  const grounded: ProductAnalysis = {
    ...analysis,
    model,
    material,
    color,
    dimensions: withUnits.dimensions,
    technicalSpecifications,
    hardRequirements,
    softRequirements,
    requestedQuantity,
    unit,
    warnings: withUnits.warnings,
  };

  const query = repairV2SearchQuery(
    analysis.searchQueryChinese ?? analysis.productNameChinese,
    grounded,
    baseContext
  );
  if (query !== (analysis.searchQueryChinese ?? "")) {
    normalized.push(`query:${analysis.searchQueryChinese ?? "null"}→${query}`);
  }
  grounded.searchQueryChinese = query || null;

  return {
    analysis: grounded,
    context: {
      ...baseContext,
      normalized: unique(normalized),
      inferred: unique(inferred),
    },
  };
}

/**
 * Scala di tentativi progressivamente più semplice.
 *
 * L'ordine è deliberato: si parte dalla query più precisa e la si allarga a
 * ogni tentativo, invece di aggiungere parole. Parole-metadato come
 * «SKU 规格 厂家» chiedevano al marketplace le inserzioni che contengono nel
 * titolo i termini "SKU/specifiche/produttore": per costruzione non trovano
 * nulla e bruciavano un tentativo a pagamento per ogni riga.
 *
 * L'ultimo tentativo è volutamente **non** riparato con i vincoli immutabili:
 * deve essere il più largo possibile, perché a selezionare ci pensano il gate
 * deterministico e il giudizio semantico, non la stringa di ricerca.
 */
export function buildV2RetryQueries(input: {
  analysis: ProductAnalysis;
  context: V2RequirementContext;
  previousQuery: string;
  proposedQuery?: string | null;
}): string[] {
  const { analysis, context } = input;
  const preferred = baseProductName(analysis);
  // Sinonimi reali del prodotto, non etichette di catalogo.
  const synonyms = unique([
    analysis.productNameChinese ?? "",
    analysis.productNameEnglish ?? "",
    analysis.productFamily,
  ]).filter((alias) => compact(alias) !== compact(preferred));

  const precise = unique(
    [input.proposedQuery, input.previousQuery, analysis.searchQueryChinese]
      .filter((query): query is string => Boolean(query?.trim()))
      .map((query) => repairV2SearchQuery(query, analysis, context))
  );
  const withSynonyms = unique(
    synonyms.map((alias) => repairV2SearchQuery(alias, analysis, context))
  );
  // La taglia come la scrivono i venditori: un gruppo unico.
  //
  // Il foglio elenca le quote una per una — «外径14mm 内径8.1mm 厚7mm» — e in
  // AND non trovano niente; il negozio scrive `14x8x7`. Misurato il 28/07/2026:
  // la forma estesa dava 0 risultati, il gruppo venti.
  const dimensionValues = (analysis.dimensions ?? [])
    .map((dimension) => dimension.value)
    .filter((value): value is number => value != null);
  const grouped =
    dimensionValues.length >= 2
      ? normalizeSpace(`${preferred} ${dimensionValues.join("x")}`)
      : "";

  // Il tentativo più largo: prodotto e, se esiste, modello. Nessuna misura.
  const broad = normalizeSpace(
    [preferred, ...context.modelTokens.slice(0, 1)].filter(Boolean).join(" ")
  );

  const ladder = unique([...precise, grouped, ...withSynonyms].filter(Boolean)).slice(
    0,
    Math.max(0, V2_MAX_RETRY_QUERIES - 1)
  );
  if (broad && !ladder.some((query) => compact(query) === compact(broad))) {
    ladder.push(broad);
  }
  return unique(ladder).slice(0, V2_MAX_RETRY_QUERIES);
}

function candidateText(candidate: V2CandidateEvidence): string {
  const parts = [
    candidate.title,
    candidate.titleEn ?? "",
    candidate.sku ?? "",
    candidate.shopName ?? "",
  ];
  for (const [key, value] of Object.entries(candidate.specs ?? {})) {
    parts.push(`${key} ${value}`);
  }
  for (const variant of candidate.variants ?? []) {
    parts.push(`${variant.name} ${variant.options.join(" ")}`);
  }
  return parts.join(" ");
}

function convertV2ToBaseUnit(
  value: number,
  unit: string
): { value: number; unit: string } | null {
  const shared = convertToBaseUnit(value, unit);
  if (shared) return shared;
  const normalizedUnit = unit.normalize("NFKC").trim().toLowerCase();
  for (const table of V2_EXTRA_MEASURE_TABLES) {
    const factor = table.units[normalizedUnit];
    if (factor != null) {
      return { value: value * factor, unit: table.base };
    }
  }
  return null;
}

function physicalConstraint(
  constraint: string
): { values: number[]; baseUnit: string } | null {
  const match = constraint.match(PHYSICAL_CONSTRAINT_RE);
  if (!match) return null;
  const values = match[1]!.split("x").map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const converted = values.map((value) =>
    convertV2ToBaseUnit(value, match[2]!)
  );
  const baseUnit = converted[0]?.unit;
  if (
    !baseUnit ||
    converted.some((value) => !value || value.unit !== baseUnit)
  ) {
    return null;
  }
  return {
    values: converted.map((value) => value!.value),
    baseUnit,
  };
}

function samePhysicalConstraint(left: string, right: string): boolean {
  const expected = physicalConstraint(left);
  const candidate = physicalConstraint(right);
  if (
    !expected ||
    !candidate ||
    expected.baseUnit !== candidate.baseUnit ||
    expected.values.length !== candidate.values.length
  ) {
    return false;
  }
  return expected.values.every((value, index) => {
    const other = candidate.values[index]!;
    const tolerance = Math.max(1e-6, Math.abs(value) * 1e-6);
    return Math.abs(value - other) <= tolerance;
  });
}

function candidateHasConstraint(text: string, constraint: string): boolean {
  const expected = canonicalConstraint(constraint);
  const candidateConstraintList =
    extractTechnicalTokens(text).map(canonicalConstraint);
  const candidateConstraints = new Set(candidateConstraintList);
  if (candidateConstraints.has(expected)) return true;

  if (
    expected.match(PHYSICAL_CONSTRAINT_RE) &&
    candidateConstraintList.some((candidateConstraint) =>
      samePhysicalConstraint(expected, candidateConstraint)
    )
  ) {
    return true;
  }

  if (/^\d+(?:\.\d+)?$/u.test(expected)) {
    return new RegExp(
      String.raw`(?:^|[^\d])${escapeRegex(expected)}(?:[^\d]|$)`,
      "u"
    ).test(canonicalConstraint(text));
  }
  return compact(text).includes(compact(expected));
}

/**
 * Gruppo dimensionale: `86x54`, `60x60cm`, `2.48mm`. L'unità è opzionale
 * perché nei fogli e nei titoli cinesi le misure viaggiano spesso nude.
 */
function dimensionGroup(
  constraint: string
): { values: number[]; unit: string | null } | null {
  const match = canonicalConstraint(constraint).match(DIMENSION_GROUP_RE);
  if (!match) return null;
  const values = match[1]!.split("x").map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const unit = match[2] ?? null;
  if (!unit) return { values, unit: null };
  const converted = values.map((value) => convertV2ToBaseUnit(value, unit));
  const baseUnit = converted[0]?.unit;
  if (!baseUnit || converted.some((value) => !value || value.unit !== baseUnit)) {
    return { values, unit: null };
  }
  return { values: converted.map((value) => value!.value), unit: baseUnit };
}

function sameDimensionValues(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index]!;
    const tolerance = Math.max(1e-6, Math.abs(value) * 1e-6);
    return Math.abs(value - other) <= tolerance;
  });
}

/**
 * Una misura richiesta può essere coperta da un intervallo dichiarato dal
 * venditore: «altezza 43-64cm» soddisfa la richiesta di 50cm. Senza questo
 * riconoscimento un'inserzione regolabile finirebbe fra gli UNKNOWN e
 * pagherebbe una lettura di dettaglio inutile.
 */
function rangeCovers(text: string, constraint: string): boolean {
  const expected = dimensionGroup(constraint);
  if (!expected || expected.values.length !== 1) return false;
  const wanted = expected.values[0]!;
  for (const match of canonicalConstraint(text).matchAll(RANGE_RE)) {
    const low = Number(match[1]);
    const high = Number(match[2]);
    const unit = match[3] ?? null;
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const bounds =
      unit && expected.unit
        ? [convertV2ToBaseUnit(low, unit), convertV2ToBaseUnit(high, unit)]
        : [null, null];
    if (bounds[0] && bounds[1]) {
      if (
        bounds[0].unit === expected.unit &&
        wanted >= Math.min(bounds[0].value, bounds[1].value) &&
        wanted <= Math.max(bounds[0].value, bounds[1].value)
      ) {
        return true;
      }
      continue;
    }
    if (!unit && !expected.unit && wanted >= Math.min(low, high) && wanted <= Math.max(low, high)) {
      return true;
    }
  }
  return false;
}

/**
 * Conflitto esplicito, non semplice assenza.
 *
 * Il confronto si fa solo fra misure **confrontabili**: stessa arietà e stessa
 * unità di base. `60x60` contro un titolo che dichiara `30x60` è un conflitto;
 * `60x60` contro `30x30x60` no, perché sono grandezze diverse. Uno scalare non
 * genera mai conflitto da solo: un'inserzione può citare una misura qualsiasi
 * senza che questo escluda la variante richiesta, e distinguere i due casi è
 * esattamente il lavoro del giudizio semantico.
 */
function constraintConflicts(text: string, constraint: string): boolean {
  const expected = dimensionGroup(constraint);
  if (!expected) return false;
  // Un numero nudo non è confrontabile: in un titolo può essere una quantità,
  // un anno, una potenza. Senza unità non si dichiara mai un conflitto.
  if (expected.values.length < 2 && !expected.unit) return false;

  const comparable: number[][] = [];
  for (const token of extractTechnicalTokens(text)) {
    const candidate = dimensionGroup(token);
    if (!candidate || candidate.values.length !== expected.values.length) continue;
    if (candidate.unit !== expected.unit) continue;
    if (sameDimensionValues(expected.values, candidate.values)) return false;
    comparable.push(candidate.values);
  }
  if (comparable.length === 0) return false;
  if (expected.values.length >= 2) return true;

  // Scalare: si dichiara il conflitto solo quando la misura confrontabile è
  // una sola e quindi identifica il prodotto. Se il titolo ne espone diverse
  // non si sa quale sia quella determinante, e la riga resta da verificare.
  const distinct = new Set(comparable.map((values) => values[0]));
  return distinct.size === 1;
}

function evaluateConstraint(text: string, constraint: string): V2ConstraintVerdict {
  if (candidateHasConstraint(text, constraint)) return "match";
  if (rangeCovers(text, constraint)) return "match";
  if (constraintConflicts(text, constraint)) return "conflict";
  return "unknown";
}

/**
 * Valutazione deterministica a tre stati.
 *
 * La regola è una sola: si scarta ciò che **contraddice** la richiesta, non ciò
 * che il titolo semplicemente non dice. Un titolo di marketplace è una stringa
 * commerciale, non una scheda tecnica: la misura richiesta quasi mai vi compare,
 * e trattarla come mancante equivaleva a buttare via il prodotto giusto. Ciò che
 * resta non verificabile diventa UNKNOWN: si legge il dettaglio dell'inserzione
 * e, se ancora non basta, decide il giudizio semantico.
 */
export function evaluateV2Candidate(
  candidate: V2CandidateEvidence,
  context: V2RequirementContext
): V2CandidateEvaluation {
  const text = candidateText(candidate);
  const conflicts: string[] = [];
  const unresolved: string[] = [];

  for (const model of context.modelTokens) {
    // Un modello assente non prova nulla: molte inserzioni corrette non lo
    // citano nel titolo. Resta però un requisito da verificare a valle.
    if (!compact(text).includes(compact(model))) unresolved.push(`model:${model}`);
  }
  for (const constraint of context.immutableSearchTokens) {
    const verdict = evaluateConstraint(text, constraint);
    if (verdict === "conflict") conflicts.push(constraint);
    else if (verdict === "unknown") unresolved.push(constraint);
  }
  // Il MOQ è l'unico dato numerico sempre presente e sempre confrontabile:
  // se il minimo d'ordine supera il fabbisogno, l'inserzione è inutilizzabile.
  if (
    context.quantity.value != null &&
    candidate.moq != null &&
    candidate.moq > context.quantity.value
  ) {
    conflicts.push(`moq:${candidate.moq}>${context.quantity.value}`);
  }

  if (conflicts.length > 0) return { status: "conflict", conflicts, unresolved };
  if (unresolved.length > 0) return { status: "unknown", conflicts, unresolved };
  return { status: "match", conflicts, unresolved };
}

/**
 * Compatibilità per il piano di retry: tutto ciò che non è un conflitto
 * esplicito resta in gioco.
 */
export function isV2CandidateCompatible(
  candidate: V2CandidateEvidence,
  context: V2RequirementContext
): boolean {
  return evaluateV2Candidate(candidate, context).status !== "conflict";
}

/**
 * Esegue il piano con una callback: in produzione la callback usa il provider,
 * nei test è un fake senza rete né costi.
 *
 * Ci si ferma al primo tentativo che porta candidati non in conflitto. Ogni
 * query passa già per la scala del provider, che la accorcia per gradi fino a
 * trovare qualcosa: l'ampiezza la dà quella: insistere con sinonimi quando si
 * hanno già candidati validi moltiplicherebbe le chiamate a pagamento senza
 * aggiungere copertura. Un guasto su una query non ferma le successive.
 */
export async function executeV2RetryPlan<T>(
  queries: readonly string[],
  search: (query: string) => Promise<V2RetrySearchResult<T>>,
  compatible: (product: T) => boolean
): Promise<V2RetryOutcome<T>> {
  let calls = 0;
  let sawCandidates = false;
  const attemptedQueries: string[] = [];
  const products: T[] = [];

  for (const query of queries.slice(0, V2_MAX_RETRY_QUERIES)) {
    attemptedQueries.push(query);
    try {
      const result = await search(query);
      calls += result.calls;
      if (result.products.length > 0) sawCandidates = true;
      products.push(...result.products.filter(compatible));
    } catch {
      // Il dettaglio del provider è già nei suoi log.
    }
    if (products.length > 0) break;
  }

  return { products, calls, attemptedQueries, sawCandidates };
}

export function v2NoCompatibleReason(attemptedQueries: number): string {
  return (
    `${V2_NO_COMPATIBLE_PREFIX}: nessun risultato compatibile con i vincoli ` +
    `espliciti dopo ${attemptedQueries} tentativ${attemptedQueries === 1 ? "o" : "i"}.`
  );
}

export function isV2NoCompatibleReason(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(`${V2_NO_COMPATIBLE_PREFIX}:`));
}
