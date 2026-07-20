import type { NormalizedProduct, ProductSearchResult } from "@china/shared";

/**
 * Deterministic, dependency-free relevance pass for marketplace search results.
 *
 * The module deliberately does not use prices, sales or vendor popularity in the
 * score: those signals say how attractive an offer is, not whether it answers
 * the buyer's query. Keeping the two concepts separate also makes the result
 * reproducible across providers.
 */

export const DEFAULT_RELEVANCE_THRESHOLD = 55;

/**
 * Copertura attribuita quando nessun termine della query è confrontabile con
 * il titolo, perché appartengono a due sistemi di scrittura diversi.
 */
const UNVERIFIABLE_COVERAGE = 0.5;

export type SpecificationDimension =
  | "battery_capacity"
  | "energy"
  | "power"
  | "voltage"
  | "current"
  | "length"
  | "volume"
  | "storage"
  | "weight"
  | "frequency"
  | "luminous_flux"
  | "pressure";

export interface NumericSpecification {
  dimension: SpecificationDimension;
  /** Value converted to the dimension's canonical unit. */
  value: number;
  unit: string;
  raw: string;
}

export type SpecificationMatchStatus = "match" | "close" | "missing" | "mismatch";

export interface SpecificationComparison {
  query: NumericSpecification;
  candidate: NumericSpecification | null;
  status: SpecificationMatchStatus;
  relativeDifference: number | null;
}

export interface RelevanceAssessment {
  score: number;
  relevant: boolean;
  reasons: string[];
  warnings: string[];
  matchedTokens: string[];
  missingTokens: string[];
  querySpecifications: NumericSpecification[];
  candidateSpecifications: NumericSpecification[];
  specificationComparisons: SpecificationComparison[];
}

export interface RelevanceOptions {
  minScore?: number;
}

export interface RankOptions extends RelevanceOptions {
  deduplicate?: boolean;
  limit?: number;
}

export interface RankedProduct {
  product: NormalizedProduct;
  relevance: RelevanceAssessment;
  /** Stable position in the unfiltered provider response. */
  index: number;
}

export interface DuplicateProduct {
  kept: RankedProduct;
  duplicate: RankedProduct;
  matchedBy: "url" | "id" | "title";
}

export interface RankedProductsResult {
  accepted: RankedProduct[];
  rejected: RankedProduct[];
  duplicates: DuplicateProduct[];
  truncatedCount: number;
}

export interface RankedSearchResult extends RankedProductsResult {
  result: ProductSearchResult;
  originalTotalCount: number | null;
}

interface SynonymGroup {
  canonical: string;
  aliases: readonly string[];
}

/**
 * Product and sourcing vocabulary seen most often in EN/IT/DE/ZH listings.
 * Canonical tokens are intentionally language-neutral internal identifiers.
 * Longer phrases are applied first, so e.g. "portable charger" becomes a
 * power bank before the generic word "charger" can become a wall charger.
 */
const SYNONYM_GROUPS: readonly SynonymGroup[] = [
  {
    canonical: "powerbank",
    aliases: [
      "power bank",
      "powerbank",
      "portable charger",
      "portable usb charger",
      "external battery",
      "caricabatterie portatile",
      "caricatore portatile",
      "batteria esterna",
      "akku powerbank",
      "mobile akku",
      "externer akku",
      "充电宝",
      "移动电源",
      "行动电源",
      "便携式充电器",
    ],
  },
  {
    canonical: "jumpstarter",
    aliases: [
      "car jump starter",
      "jump starter",
      "battery booster",
      "booster pack",
      "avviatore di emergenza",
      "avviatore auto",
      "avviatore batteria",
      "starthilfegerat",
      "starthilfegerät",
      "starthilfe gerat",
      "startbooster",
      "汽车应急启动电源",
      "应急启动电源",
      "汽车启动电源",
      "启动宝",
    ],
  },
  {
    canonical: "wallcharger",
    aliases: [
      "wall charger",
      "mains charger",
      "travel charger",
      "usb charger",
      "caricatore da muro",
      "caricabatterie da muro",
      "caricatore di rete",
      "usb ladegerat",
      "usb ladegerät",
      "netzteil",
      "充电器",
      "电源适配器",
    ],
  },
  {
    canonical: "cable",
    aliases: [
      "charging cable",
      "usb cable",
      "data cable",
      "cavo di ricarica",
      "cavo usb",
      "ladekabel",
      "usb kabel",
      "充电线",
      "数据线",
      "连接线",
      "cable",
      "cavo",
      "kabel",
    ],
  },
  {
    canonical: "case",
    aliases: [
      "protective case",
      "carrying case",
      "protective cover",
      "custodia protettiva",
      "custodia",
      "schutzhulle",
      "schutzhülle",
      "保护壳",
      "收纳包",
      "case",
      "cover",
    ],
  },
  {
    canonical: "batterycell",
    aliases: [
      "replacement battery",
      "battery cell",
      "bare battery",
      "cella batteria",
      "batteria di ricambio",
      "akkuzelle",
      "ersatzakku",
      "电芯",
      "替换电池",
    ],
  },
  {
    canonical: "waterbottle",
    aliases: [
      "water bottle",
      "drinking bottle",
      "borraccia",
      "bottiglia acqua",
      "trinkflasche",
      "wasserflasche",
      "水瓶",
      "水杯",
      "运动水壶",
    ],
  },
  {
    canonical: "phonecase",
    aliases: [
      "phone case",
      "mobile phone case",
      "custodia telefono",
      "handyhulle",
      "handyhülle",
      "手机壳",
    ],
  },
  {
    canonical: "headphones",
    aliases: [
      "wireless earbuds",
      "bluetooth earphones",
      "auricolari wireless",
      "cuffie bluetooth",
      "kabellose kopfhorer",
      "kabellose kopfhörer",
      "蓝牙耳机",
      "无线耳机",
    ],
  },
  {
    canonical: "manufacturer",
    aliases: [
      "manufacturer",
      "manufacturers",
      "maker",
      "produttore",
      "produttori",
      "fabbricante",
      "hersteller",
      "制造商",
      "生产厂家",
      "厂家",
    ],
  },
  {
    canonical: "supplier",
    aliases: [
      "supplier",
      "suppliers",
      "vendor",
      "fornitore",
      "fornitori",
      "lieferant",
      "lieferanten",
      "供应商",
      "供货商",
    ],
  },
  {
    canonical: "wholesale",
    aliases: [
      "wholesale",
      "in bulk",
      "bulk order",
      "all ingrosso",
      "ingrosso",
      "grosshandel",
      "großhandel",
      "批发",
      "大宗采购",
    ],
  },
  {
    canonical: "factory",
    aliases: ["factory", "fabbrica", "fabrik", "werk", "工厂", "源头工厂"],
  },
  {
    canonical: "privatelabel",
    aliases: [
      "private label",
      "white label",
      "marchio privato",
      "eigenmarke",
      "贴牌",
      "代工",
      "oem",
      "odm",
    ],
  },
  {
    canonical: "minimumorder",
    aliases: [
      "minimum order quantity",
      "minimum order",
      "quantita minima ordine",
      "ordine minimo",
      "mindestbestellmenge",
      "起订量",
      "最小订单量",
      "moq",
    ],
  },
] as const;

const STOP_WORDS = new Set([
  // English
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
  "new",
  "product",
  // Italian
  "al",
  "alla",
  "con",
  "da",
  "del",
  "della",
  "di",
  "e",
  "il",
  "la",
  "le",
  "lo",
  "per",
  "un",
  "una",
  "nuovo",
  // German
  "aus",
  "der",
  "die",
  "das",
  "ein",
  "eine",
  "fur",
  "für",
  "im",
  "mit",
  "und",
  "von",
  "zu",
  "neu",
  // Very common Chinese commerce particles.
  "的",
  "和",
  "新款",
  "产品",
]);

const SOURCING_TOKENS = new Set([
  "manufacturer",
  "supplier",
  "wholesale",
  "factory",
  "privatelabel",
  "minimumorder",
]);

type ProductClass =
  | "powerbank"
  | "jumpstarter"
  | "wallcharger"
  | "cable"
  | "case"
  | "batterycell"
  | "waterbottle"
  | "phonecase"
  | "headphones";

const PRODUCT_CLASSES = new Set<ProductClass>([
  "powerbank",
  "jumpstarter",
  "wallcharger",
  "cable",
  "case",
  "batterycell",
  "waterbottle",
  "phonecase",
  "headphones",
]);

interface UnitDefinition {
  dimension: SpecificationDimension;
  canonicalUnit: string;
  factor: number;
  aliases: readonly string[];
  tolerance: number;
}

const UNIT_DEFINITIONS: readonly UnitDefinition[] = [
  { dimension: "battery_capacity", canonicalUnit: "mAh", factor: 1, aliases: ["mah"], tolerance: 0.08 },
  { dimension: "battery_capacity", canonicalUnit: "mAh", factor: 1_000, aliases: ["ah"], tolerance: 0.08 },
  { dimension: "energy", canonicalUnit: "Wh", factor: 1, aliases: ["wh"], tolerance: 0.08 },
  { dimension: "energy", canonicalUnit: "Wh", factor: 1_000, aliases: ["kwh"], tolerance: 0.08 },
  { dimension: "power", canonicalUnit: "W", factor: 0.001, aliases: ["mw"], tolerance: 0.06 },
  { dimension: "power", canonicalUnit: "W", factor: 1, aliases: ["w"], tolerance: 0.06 },
  { dimension: "power", canonicalUnit: "W", factor: 1_000, aliases: ["kw"], tolerance: 0.06 },
  { dimension: "voltage", canonicalUnit: "V", factor: 0.001, aliases: ["mv"], tolerance: 0.06 },
  { dimension: "voltage", canonicalUnit: "V", factor: 1, aliases: ["v"], tolerance: 0.06 },
  { dimension: "current", canonicalUnit: "A", factor: 0.001, aliases: ["ma"], tolerance: 0.08 },
  { dimension: "current", canonicalUnit: "A", factor: 1, aliases: ["a"], tolerance: 0.08 },
  { dimension: "length", canonicalUnit: "mm", factor: 1, aliases: ["mm"], tolerance: 0.05 },
  { dimension: "length", canonicalUnit: "mm", factor: 10, aliases: ["cm"], tolerance: 0.05 },
  { dimension: "length", canonicalUnit: "mm", factor: 1_000, aliases: ["m"], tolerance: 0.05 },
  { dimension: "length", canonicalUnit: "mm", factor: 25.4, aliases: ["in", "inch", "inches"], tolerance: 0.05 },
  { dimension: "volume", canonicalUnit: "ml", factor: 1, aliases: ["ml"], tolerance: 0.05 },
  { dimension: "volume", canonicalUnit: "ml", factor: 10, aliases: ["cl"], tolerance: 0.05 },
  { dimension: "volume", canonicalUnit: "ml", factor: 1_000, aliases: ["l", "lt"], tolerance: 0.05 },
  { dimension: "storage", canonicalUnit: "GB", factor: 1 / 1_024, aliases: ["mb"], tolerance: 0.01 },
  { dimension: "storage", canonicalUnit: "GB", factor: 1, aliases: ["gb"], tolerance: 0.01 },
  { dimension: "storage", canonicalUnit: "GB", factor: 1_024, aliases: ["tb"], tolerance: 0.01 },
  { dimension: "weight", canonicalUnit: "g", factor: 0.001, aliases: ["mg"], tolerance: 0.05 },
  { dimension: "weight", canonicalUnit: "g", factor: 1, aliases: ["g", "gr"], tolerance: 0.05 },
  { dimension: "weight", canonicalUnit: "g", factor: 1_000, aliases: ["kg"], tolerance: 0.05 },
  { dimension: "frequency", canonicalUnit: "Hz", factor: 1, aliases: ["hz"], tolerance: 0.02 },
  { dimension: "frequency", canonicalUnit: "Hz", factor: 1_000, aliases: ["khz"], tolerance: 0.02 },
  { dimension: "frequency", canonicalUnit: "Hz", factor: 1_000_000, aliases: ["mhz"], tolerance: 0.02 },
  { dimension: "frequency", canonicalUnit: "Hz", factor: 1_000_000_000, aliases: ["ghz"], tolerance: 0.02 },
  { dimension: "luminous_flux", canonicalUnit: "lm", factor: 1, aliases: ["lm", "lumen", "lumens"], tolerance: 0.1 },
  { dimension: "pressure", canonicalUnit: "bar", factor: 1, aliases: ["bar"], tolerance: 0.08 },
  { dimension: "pressure", canonicalUnit: "bar", factor: 0.0689476, aliases: ["psi"], tolerance: 0.08 },
] as const;

const DIMENSION_LABELS: Record<SpecificationDimension, string> = {
  battery_capacity: "capacità batteria",
  energy: "energia",
  power: "potenza",
  voltage: "tensione",
  current: "corrente",
  length: "misura",
  volume: "volume",
  storage: "memoria",
  weight: "peso",
  frequency: "frequenza",
  luminous_flux: "flusso luminoso",
  pressure: "pressione",
};

const TRACKING_QUERY_KEYS = new Set([
  "aff_fcid",
  "aff_fsk",
  "aff_platform",
  "aff_trace_key",
  "algo_exp_id",
  "algo_pvid",
  "gps-id",
  "scm",
  "spm",
  "src",
  "source",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePlainText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’'`´]/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

interface PreparedAlias {
  alias: string;
  canonical: string;
  hasHan: boolean;
  pattern: RegExp | null;
}

const PREPARED_ALIASES: readonly PreparedAlias[] = SYNONYM_GROUPS.flatMap((group) =>
  group.aliases.map((alias) => {
    const normalizedAlias = normalizePlainText(alias);
    const hasHan = /\p{Script=Han}/u.test(normalizedAlias);
    const source = normalizedAlias
      .split(" ")
      .filter(Boolean)
      .map(escapeRegExp)
      .join("\\s+");

    return {
      alias: normalizedAlias,
      canonical: group.canonical,
      hasHan,
      pattern:
        !hasHan && normalizedAlias !== group.canonical
          ? new RegExp(`(^|[^\\p{L}\\p{N}])${source}(?=$|[^\\p{L}\\p{N}])`, "gu")
          : null,
    };
  }),
).sort((left, right) => right.alias.length - left.alias.length);

/** Unicode/case/diacritic normalization plus multilingual synonym folding. */
export function normalizeSearchText(value: string): string {
  let normalized = normalizePlainText(value);

  for (const entry of PREPARED_ALIASES) {
    if (!entry.alias || entry.alias === entry.canonical) {
      continue;
    }

    if (entry.hasHan) {
      normalized = normalized.split(entry.alias).join(` ${entry.canonical} `);
    } else if (entry.pattern) {
      normalized = normalized.replace(entry.pattern, (_match, prefix: string) => `${prefix}${entry.canonical}`);
    }
  }

  return normalized.trim().replace(/\s+/gu, " ");
}

const NUMBER_SOURCE = String.raw`(?:\d{1,3}(?:[ .,'’]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;

const UNIT_BY_ALIAS = new Map<string, UnitDefinition>();
for (const definition of UNIT_DEFINITIONS) {
  for (const alias of definition.aliases) {
    UNIT_BY_ALIAS.set(alias, definition);
  }
}

const UNIT_SOURCE = [...UNIT_BY_ALIAS.keys()]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

function createSpecificationRegExp(): RegExp {
  // The optional k supports common shorthand such as "10k mAh". With units
  // such as kg/kW it is mathematically equivalent to parsing the full unit.
  return new RegExp(`(${NUMBER_SOURCE})\\s*(k)?\\s*(${UNIT_SOURCE})(?![\\p{L}])`, "giu");
}

function prepareSpecificationText(value: string): string {
  let prepared = value
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");

  const contextualUnits: readonly [RegExp, string][] = [
    [new RegExp(`(${NUMBER_SOURCE})\\s*毫安(?:时|小时)?`, "gu"), "$1 mah "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*安时`, "gu"), "$1 ah "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*千瓦时`, "gu"), "$1 kwh "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*瓦时`, "gu"), "$1 wh "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*千瓦`, "gu"), "$1 kw "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*瓦`, "gu"), "$1 w "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*伏(?:特)?`, "gu"), "$1 v "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*毫米`, "gu"), "$1 mm "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*厘米`, "gu"), "$1 cm "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*毫升`, "gu"), "$1 ml "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*升`, "gu"), "$1 l "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*(?:公斤|千克)`, "gu"), "$1 kg "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*克`, "gu"), "$1 g "],
    [new RegExp(`(${NUMBER_SOURCE})\\s*吉(?:字节)?`, "gu"), "$1 gb "],
  ];

  for (const [pattern, replacement] of contextualUnits) {
    prepared = prepared.replace(pattern, replacement);
  }

  const spelledUnits: readonly [RegExp, string][] = [
    [/\bmilliamp(?:ere)?[ -]*(?:hour|ora|stunde)s?\b/gu, "mah"],
    [/\bamp(?:ere)?[ -]*(?:hour|ora|stunde)s?\b/gu, "ah"],
    [/\bkilowatt(?:s)?\b/gu, "kw"],
    [/\bwatt(?:s)?\b/gu, "w"],
    [/\bvolt(?:s)?\b/gu, "v"],
    [/\bmillimet(?:er|re|ro)(?:s|i)?\b/gu, "mm"],
    [/\bcentimet(?:er|re|ro)(?:s|i)?\b/gu, "cm"],
    [/\bmillilit(?:er|re|ro)(?:s|i)?\b/gu, "ml"],
    [/\blit(?:er|re|ro)(?:s|i)?\b/gu, "l"],
    [/\bkilogram(?:s|mi)?\b/gu, "kg"],
    [/\bgigabyte(?:s)?\b/gu, "gb"],
    [/\bma[ -]+h\b/gu, "mah"],
  ];

  for (const [pattern, replacement] of spelledUnits) {
    prepared = prepared.replace(pattern, replacement);
  }

  return prepared;
}

function parseLocalizedNumber(raw: string): number | null {
  let compact = raw.replace(/[\s'’]/gu, "");
  const dots = (compact.match(/\./gu) ?? []).length;
  const commas = (compact.match(/,/gu) ?? []).length;

  if (dots > 0 && commas > 0) {
    const decimalSeparator = compact.lastIndexOf(".") > compact.lastIndexOf(",") ? "." : ",";
    const thousandsSeparator = decimalSeparator === "." ? "," : ".";
    compact = compact.split(thousandsSeparator).join("");
    compact = compact.replace(decimalSeparator, ".");
  } else if (dots > 0 || commas > 0) {
    const separator = dots > 0 ? "." : ",";
    const pieces = compact.split(separator);
    const last = pieces.at(-1) ?? "";
    const looksGrouped =
      pieces.length > 2
        ? pieces.slice(1).every((piece) => piece.length === 3)
        : last.length === 3 && pieces[0] !== "0" && (pieces[0]?.length ?? 0) <= 3;

    compact = looksGrouped ? pieces.join("") : `${pieces.slice(0, -1).join("")}.${last}`;
  }

  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ExtractedSpecificationData {
  specifications: NumericSpecification[];
  remainder: string;
}

function extractSpecificationData(value: string): ExtractedSpecificationData {
  const prepared = prepareSpecificationText(value);
  const pattern = createSpecificationRegExp();
  const specifications: NumericSpecification[] = [];
  const seen = new Set<string>();

  for (const match of prepared.matchAll(pattern)) {
    const numericValue = parseLocalizedNumber(match[1] ?? "");
    const multiplier = match[2] ? 1_000 : 1;
    const unitAlias = (match[3] ?? "").toLowerCase();
    const definition = UNIT_BY_ALIAS.get(unitAlias);
    if (numericValue === null || !definition) {
      continue;
    }

    const valueInCanonicalUnit = numericValue * multiplier * definition.factor;
    const key = `${definition.dimension}:${valueInCanonicalUnit.toPrecision(12)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    specifications.push({
      dimension: definition.dimension,
      value: valueInCanonicalUnit,
      unit: definition.canonicalUnit,
      raw: match[0].trim(),
    });
  }

  return {
    specifications,
    remainder: prepared.replace(createSpecificationRegExp(), " "),
  };
}

/** Extract numeric specifications and convert compatible units to one scale. */
export function extractSpecifications(value: string): NumericSpecification[] {
  return extractSpecificationData(value).specifications;
}

interface AnalysedText {
  canonicalText: string;
  tokens: string[];
  specifications: NumericSpecification[];
}

function tokenize(canonicalText: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const segments = canonicalText.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];

  const add = (token: string): void => {
    if (!token || STOP_WORDS.has(token) || seen.has(token)) {
      return;
    }
    seen.add(token);
    tokens.push(token);
  };

  for (const segment of segments) {
    if (!/\p{Script=Han}/u.test(segment)) {
      add(segment);
      continue;
    }

    const characters = [...segment];
    if (characters.length === 2) {
      add(segment);
      continue;
    }
    // Unknown Chinese words are compared as bigrams. Known product phrases
    // have already been folded to canonical Latin tokens by the synonym pass.
    for (let index = 0; index < characters.length - 1; index += 1) {
      add(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return tokens;
}

function analyseText(value: string): AnalysedText {
  const extracted = extractSpecificationData(value);
  const canonicalText = normalizeSearchText(extracted.remainder);
  return {
    canonicalText,
    tokens: tokenize(canonicalText),
    specifications: extracted.specifications,
  };
}

function tokenWeight(token: string): number {
  if (SOURCING_TOKENS.has(token)) {
    return 0.25;
  }
  if (/^\p{Script=Han}{2}$/u.test(token)) {
    return 0.75;
  }
  return 1;
}

function damerauLevenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left.length) {
    return right.length;
  }
  if (!right.length) {
    return left.length;
  }

  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) {
    matrix[row]![0] = row;
  }
  for (let column = 0; column < columns; column += 1) {
    matrix[0]![column] = column;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        (matrix[row - 1]![column] ?? 0) + 1,
        (matrix[row]![column - 1] ?? 0) + 1,
        (matrix[row - 1]![column - 1] ?? 0) + substitutionCost,
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row]![column] = Math.min(
          matrix[row]![column] ?? Number.POSITIVE_INFINITY,
          (matrix[row - 2]![column - 2] ?? 0) + 1,
        );
      }
    }
  }

  return matrix[left.length]![right.length] ?? Math.max(left.length, right.length);
}

interface TokenMatch {
  queryToken: string;
  candidateToken: string;
  strength: number;
  fuzzy: boolean;
}

function bestTokenMatch(queryToken: string, candidateTokens: readonly string[]): TokenMatch | null {
  if (candidateTokens.includes(queryToken)) {
    return { queryToken, candidateToken: queryToken, strength: 1, fuzzy: false };
  }

  if (queryToken.length < 4 || /\p{Script=Han}/u.test(queryToken)) {
    return null;
  }

  let best: TokenMatch | null = null;
  for (const candidateToken of candidateTokens) {
    if (candidateToken.length < 4 || /\p{Script=Han}/u.test(candidateToken)) {
      continue;
    }
    const maximumLength = Math.max(queryToken.length, candidateToken.length);
    const maximumDistance = maximumLength >= 8 ? 2 : 1;
    if (Math.abs(queryToken.length - candidateToken.length) > maximumDistance) {
      continue;
    }
    const distance = damerauLevenshtein(queryToken, candidateToken);
    if (distance > maximumDistance) {
      continue;
    }
    const strength = (1 - distance / maximumLength) * 0.92;
    if (!best || strength > best.strength) {
      best = { queryToken, candidateToken, strength, fuzzy: true };
    }
  }
  return best;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function formatSpecification(specification: NumericSpecification): string {
  const rounded = Number.isInteger(specification.value)
    ? specification.value.toString()
    : Number(specification.value.toFixed(3)).toString();
  return `${rounded} ${specification.unit}`;
}

function getDefinitionForDimension(dimension: SpecificationDimension): UnitDefinition {
  const definition = UNIT_DEFINITIONS.find((candidate) => candidate.dimension === dimension);
  if (!definition) {
    throw new Error(`Unsupported specification dimension: ${dimension}`);
  }
  return definition;
}

function compareSpecifications(
  querySpecifications: readonly NumericSpecification[],
  candidateSpecifications: readonly NumericSpecification[],
  options: { titleNotComparable?: boolean } = {},
): { comparisons: SpecificationComparison[]; scoreDelta: number; reasons: string[]; warnings: string[] } {
  const comparisons: SpecificationComparison[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  let scoreDelta = 0;
  const divisor = Math.max(1, querySpecifications.length);

  for (const querySpecification of querySpecifications) {
    const compatible = candidateSpecifications.filter(
      (candidate) => candidate.dimension === querySpecification.dimension,
    );
    if (!compatible.length) {
      comparisons.push({
        query: querySpecification,
        candidate: null,
        status: "missing",
        relativeDifference: null,
      });
      // Su un titolo scritto in un'altra lingua l'assenza di una misura non
      // dimostra che il prodotto sia diverso: vale quanto una query che non
      // chiedeva specifiche. Un valore in contrasto continua a penalizzare.
      if (options.titleNotComparable) {
        scoreDelta += 15 / divisor;
        continue;
      }
      scoreDelta -= 12 / divisor;
      warnings.push(
        `Specifica non verificabile: ${DIMENSION_LABELS[querySpecification.dimension]} ${formatSpecification(querySpecification)} assente dal titolo.`,
      );
      continue;
    }

    const nearest = compatible.reduce((best, current) => {
      const bestDifference = Math.abs(best.value - querySpecification.value);
      const currentDifference = Math.abs(current.value - querySpecification.value);
      return currentDifference < bestDifference ? current : best;
    });
    const denominator = Math.max(Math.abs(querySpecification.value), Number.EPSILON);
    const relativeDifference = Math.abs(nearest.value - querySpecification.value) / denominator;
    const tolerance = getDefinitionForDimension(querySpecification.dimension).tolerance;

    if (relativeDifference <= tolerance) {
      comparisons.push({
        query: querySpecification,
        candidate: nearest,
        status: "match",
        relativeDifference,
      });
      scoreDelta += 25 / divisor;
      reasons.push(
        `Specifica corrispondente: ${DIMENSION_LABELS[querySpecification.dimension]} ${formatSpecification(nearest)}.`,
      );
      continue;
    }

    if (relativeDifference <= Math.max(0.2, tolerance * 3)) {
      comparisons.push({
        query: querySpecification,
        candidate: nearest,
        status: "close",
        relativeDifference,
      });
      scoreDelta += 10 / divisor;
      warnings.push(
        `Specifica vicina ma non identica: richiesto ${formatSpecification(querySpecification)}, trovato ${formatSpecification(nearest)}.`,
      );
      continue;
    }

    const nonZeroValues = querySpecification.value > 0 && nearest.value > 0;
    const ratio = nonZeroValues
      ? Math.max(querySpecification.value / nearest.value, nearest.value / querySpecification.value)
      : Number.POSITIVE_INFINITY;
    const penalty = ratio >= 5 ? 45 : ratio >= 2 ? 35 : 25;
    scoreDelta -= penalty / divisor;
    comparisons.push({
      query: querySpecification,
      candidate: nearest,
      status: "mismatch",
      relativeDifference,
    });
    warnings.push(
      `Specifica incompatibile: ${DIMENSION_LABELS[querySpecification.dimension]} richiesta ${formatSpecification(querySpecification)}, trovata ${formatSpecification(nearest)}.`,
    );
  }

  return { comparisons, scoreDelta, reasons, warnings };
}

function detectProductClasses(tokens: readonly string[]): Set<ProductClass> {
  const classes = new Set<ProductClass>();
  for (const token of tokens) {
    if (PRODUCT_CLASSES.has(token as ProductClass)) {
      classes.add(token as ProductClass);
    }
  }
  return classes;
}

function classConflictPenalty(
  query: AnalysedText,
  candidate: AnalysedText,
): { penalty: number; warning: string | null; reason: string | null } {
  const queryClasses = detectProductClasses(query.tokens);
  const candidateClasses = detectProductClasses(candidate.tokens);
  if (!queryClasses.size) {
    return { penalty: 0, warning: null, reason: null };
  }

  if (
    queryClasses.has("powerbank") &&
    candidateClasses.has("jumpstarter") &&
    !queryClasses.has("jumpstarter")
  ) {
    return {
      penalty: 65,
      warning: "Categoria incompatibile: il risultato è un avviatore d'emergenza per auto, non un normale power bank.",
      reason: null,
    };
  }

  const overlap = [...queryClasses].filter((productClass) => candidateClasses.has(productClass));
  if (candidateClasses.size && !overlap.length) {
    return {
      penalty: 50,
      warning: `Categoria incompatibile: richiesto ${[...queryClasses].join(", ")}, trovato ${[...candidateClasses].join(", ")}.`,
      reason: null,
    };
  }

  if (queryClasses.has("powerbank")) {
    const accessoryReference =
      /(?:cable|case|batterycell)\s+(?:(?:for|per|fur|compatible|compatibile|passend)\s+)?powerbank/u.test(
        candidate.canonicalText,
      ) || /powerbank\s+(?:cable|case|batterycell)/u.test(candidate.canonicalText);
    if (accessoryReference) {
      return {
        penalty: 45,
        warning: "Il titolo descrive un accessorio o ricambio per power bank, non il prodotto completo.",
        reason: null,
      };
    }

    const hybridCategory = [
      {
        pattern: /\b(?:wifi\s*\d*|wireless)\s*(?:router|modem|hotspot)\b|\b(?:router|modem|hotspot)\b/u,
        label: "router/modem portatile",
      },
      {
        pattern: /\b(?:earphone|earphones|earbud|earbuds|headphone|headphones)\b/u,
        label: "accessorio audio",
      },
    ].find((entry) => entry.pattern.test(candidate.canonicalText));
    if (hybridCategory) {
      return {
        penalty: 20,
        warning: `Prodotto ibrido: il titolo include anche ${hybridCategory.label}; viene classificato sotto i power bank dedicati.`,
        reason: null,
      };
    }
  }

  return {
    penalty: 0,
    warning: null,
    reason: overlap.length ? `Categoria prodotto coerente: ${overlap.join(", ")}.` : null,
  };
}

/** Score one normalized product against a buyer query. */
export function assessProductRelevance(
  query: string,
  product: NormalizedProduct,
  options: RelevanceOptions = {},
): RelevanceAssessment {
  const minimumScore = options.minScore ?? DEFAULT_RELEVANCE_THRESHOLD;
  const queryAnalysis = analyseText(query);
  const candidateText = [
    product.title,
    product.originalTitle,
    product.sourceSnippet,
  ]
    .filter(Boolean)
    .join(" ");
  const candidateAnalysis = analyseText(candidateText);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const matchedTokens: string[] = [];
  const missingTokens: string[] = [];
  const fuzzyMatches: string[] = [];
  let score = queryAnalysis.tokens.length ? 10 : 30;

  // Una query cinese su una vetrina che pubblica i titoli in inglese non è
  // confrontabile parola per parola: l'assenza dei termini non dimostra che il
  // prodotto sia sbagliato, quindi quei termini non entrano nel calcolo e il
  // risultato resta in classifica con un avviso, invece di sparire.
  const candidateHasHan = /\p{Script=Han}/u.test(candidateAnalysis.canonicalText);
  const queryHasHan = queryAnalysis.tokens.some((token) =>
    /\p{Script=Han}/u.test(token),
  );
  const crossScript = queryHasHan && !candidateHasHan;
  const unverifiableTokens: string[] = [];

  if (queryAnalysis.tokens.length) {
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const queryToken of queryAnalysis.tokens) {
      // Restano confrontabili solo i termini che sopravvivono al cambio di
      // lingua: codici e sigle latine. Un numero isolato viene da una misura
      // cinese (长200*宽40) e senza il suo contesto non prova nulla: le
      // grandezze con unità le confronta comunque il blocco specifiche.
      if (
        crossScript &&
        (/\p{Script=Han}/u.test(queryToken) || /^\d+$/u.test(queryToken))
      ) {
        unverifiableTokens.push(queryToken);
        continue;
      }
      const weight = tokenWeight(queryToken);
      totalWeight += weight;
      const match = bestTokenMatch(queryToken, candidateAnalysis.tokens);
      if (!match) {
        missingTokens.push(queryToken);
        continue;
      }
      matchedWeight += weight * match.strength;
      matchedTokens.push(queryToken);
      if (match.fuzzy) {
        fuzzyMatches.push(`${queryToken}→${match.candidateToken}`);
      }
    }

    // Senza un solo termine confrontabile la copertura non è misurabile: un
    // valore neutro tiene il risultato a metà classifica, dove lo mettono poi
    // le specifiche numeriche e i segnali commerciali.
    const coverage = totalWeight
      ? matchedWeight / totalWeight
      : unverifiableTokens.length
        ? UNVERIFIABLE_COVERAGE
        : 0;
    score += coverage * 55;
    if (unverifiableTokens.length) {
      // I termini cinesi vengono confrontati come bigrammi: elencarli qui
      // mostrerebbe frammenti che non sono parole. Conta il fatto, non i pezzi.
      warnings.push(
        "Titolo non in cinese: la corrispondenza delle parole non è verificabile su questa fonte; controlla il prodotto prima di sceglierlo."
      );
    }
    if (totalWeight) {
      reasons.push(`Copertura dei termini: ${Math.round(coverage * 100)}%.`);
    }
    if (fuzzyMatches.length) {
      reasons.push(`Corrispondenze tolleranti agli errori: ${fuzzyMatches.join(", ")}.`);
    }

    const coreQueryTokens = queryAnalysis.tokens.filter((token) => !SOURCING_TOKENS.has(token));
    const phrase = coreQueryTokens.join(" ");
    if (
      coreQueryTokens.length > 0 &&
      coreQueryTokens.length <= 4 &&
      candidateAnalysis.canonicalText.includes(phrase)
    ) {
      score += 10;
      reasons.push(`Frase prodotto presente: “${phrase}”.`);
    }

    const missingCoreTokens = missingTokens.filter((token) => !SOURCING_TOKENS.has(token));
    if (missingCoreTokens.length) {
      warnings.push(`Termini principali non trovati: ${missingCoreTokens.join(", ")}.`);
    }
  } else if (!queryAnalysis.specifications.length) {
    warnings.push("La query non contiene termini o specifiche tecniche utili.");
  }

  const specificationResult = compareSpecifications(
    queryAnalysis.specifications,
    candidateAnalysis.specifications,
    { titleNotComparable: unverifiableTokens.length > 0 },
  );
  if (queryAnalysis.specifications.length) {
    score += specificationResult.scoreDelta;
    reasons.push(...specificationResult.reasons);
    warnings.push(...specificationResult.warnings);
  } else {
    // A text-only query can still achieve a strong score without inventing a
    // specification requirement the buyer never expressed.
    score += 15;
  }

  const categoryResult = classConflictPenalty(queryAnalysis, candidateAnalysis);
  score -= categoryResult.penalty;
  if (categoryResult.warning) {
    warnings.push(categoryResult.warning);
  }
  if (categoryResult.reason) {
    reasons.push(categoryResult.reason);
  }

  const finalScore = roundScore(score);
  return {
    score: finalScore,
    relevant: finalScore >= minimumScore,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    matchedTokens: [...new Set(matchedTokens)],
    missingTokens: [...new Set(missingTokens)],
    querySpecifications: queryAnalysis.specifications,
    candidateSpecifications: candidateAnalysis.specifications,
    specificationComparisons: specificationResult.comparisons,
  };
}

function metadataRichness(product: NormalizedProduct): number {
  return [
    product.imageUrl,
    product.originalPrice,
    product.vendorName,
    product.totalSales,
    product.moq,
    product.productUrl,
    product.originalTitle,
  ].filter((value) => value !== null && value !== "").length;
}

function canonicalizeProductUrl(productUrl: string): string {
  try {
    const parsed = new URL(productUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    const pathname = parsed.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    const query = parsed.searchParams.toString();
    return `${hostname}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return productUrl
      .trim()
      .toLowerCase()
      .split("#", 1)[0]!
      .replace(/\?.*$/u, "")
      .replace(/\/+$/u, "");
  }
}

interface IdentityKey {
  value: string;
  kind: "url" | "id" | "title";
}

function productIdentityKeys(product: NormalizedProduct): IdentityKey[] {
  const provider = normalizePlainText(product.provider) || "unknown";
  const keys: IdentityKey[] = [];
  if (product.productUrl?.trim()) {
    keys.push({ kind: "url", value: `${provider}:url:${canonicalizeProductUrl(product.productUrl)}` });
  }
  if (product.id.trim()) {
    keys.push({ kind: "id", value: `${provider}:id:${product.id.trim().toLowerCase()}` });
  }
  const title = normalizePlainText(product.originalTitle || product.title);
  if (title.length >= 8) {
    keys.push({ kind: "title", value: `${provider}:title:${title}` });
  }
  return keys;
}

/** Filter, rank and deduplicate one provider's or a mixed provider item list. */
export function rankAndFilterProducts(
  query: string,
  products: readonly NormalizedProduct[],
  options: RankOptions = {},
): RankedProductsResult {
  const minimumScore = options.minScore ?? DEFAULT_RELEVANCE_THRESHOLD;
  const deduplicate = options.deduplicate ?? true;
  const requestedLimit = options.limit;
  const limit =
    requestedLimit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 0));

  const ranked = products
    .map<RankedProduct>((product, index) => ({
      product,
      index,
      relevance: assessProductRelevance(query, product, { minScore: minimumScore }),
    }))
    .sort((left, right) => {
      const byScore = right.relevance.score - left.relevance.score;
      if (byScore) {
        return byScore;
      }
      const byRichness = metadataRichness(right.product) - metadataRichness(left.product);
      return byRichness || left.index - right.index;
    });

  const unique: RankedProduct[] = [];
  const duplicates: DuplicateProduct[] = [];
  const ownerByKey = new Map<string, RankedProduct>();
  for (const rankedProduct of ranked) {
    if (!deduplicate) {
      unique.push(rankedProduct);
      continue;
    }

    const keys = productIdentityKeys(rankedProduct.product);
    const duplicateKey = keys.find((key) => ownerByKey.has(key.value));
    if (!duplicateKey) {
      unique.push(rankedProduct);
      for (const key of keys) {
        ownerByKey.set(key.value, rankedProduct);
      }
      continue;
    }

    const kept = ownerByKey.get(duplicateKey.value)!;
    duplicates.push({ kept, duplicate: rankedProduct, matchedBy: duplicateKey.kind });
    // Preserve transitive identity: if B shares A's URL and C shares B's ID,
    // all three still belong to one duplicate group represented by A.
    for (const key of keys) {
      ownerByKey.set(key.value, kept);
    }
  }

  const relevant = unique.filter((entry) => entry.relevance.relevant);
  const accepted = relevant.slice(0, limit);
  const rejected = unique.filter((entry) => !entry.relevance.relevant);

  return {
    accepted,
    rejected,
    duplicates,
    truncatedCount: Math.max(0, relevant.length - accepted.length),
  };
}

/** Apply relevance processing to a complete provider response without mutation. */
export function filterAndRankSearchResult(
  input: ProductSearchResult,
  options: RankOptions = {},
): RankedSearchResult {
  const ranking = rankAndFilterProducts(input.query, input.items, options);
  const items = ranking.accepted.map(({ product, relevance }) => ({
    ...product,
    warnings: [...new Set([...product.warnings, ...relevance.warnings])],
  }));

  return {
    ...ranking,
    originalTotalCount: input.totalCount,
    result: {
      ...input,
      totalCount: items.length,
      items,
    },
  };
}
