import type { ProductAnalysis } from "@china/shared";
import { convertToBaseUnit } from "@china/shared";
import type { MergedProduct } from "./merge";

/**
 * Classifica dei candidati: prima se il prodotto va bene, poi se conviene.
 *
 * L'ordine dei criteri è una decisione di merito, non un dettaglio di
 * implementazione. Un prodotto che costa metà ma ha la misura sbagliata non è
 * un affare: è un reso. Per questo la compatibilità tecnica ordina per prima,
 * e prezzo, vendite e recensioni intervengono **solo fra prodotti ugualmente
 * compatibili**.
 *
 * Nessuna IA decide qui, e nessuno viene scartato: ogni candidato arriva
 * all'operatore con l'elenco di ciò che soddisfa e di ciò che gli manca. La
 * scelta finale resta umana — è esattamente ciò che è stato chiesto, ed è
 * anche l'unica onesta: il punteggio sa cosa dice il titolo, non cosa c'è
 * nella scatola.
 */

/** Ampiezza della fascia di compatibilità (5%): dentro, decide il resto. */
const COMPATIBILITY_TIER = 0.05;

/** Peso di ogni tipo di vincolo nel calcolo della compatibilità. */
const WEIGHTS = {
  hardRequirement: 3,
  dimension: 2,
  model: 2,
  spec: 1.5,
  material: 1,
  color: 1,
  softRequirement: 0.5,
} as const;

export interface ScoreBreakdown {
  compatibility: number;
  price: number;
  sales: number;
  reviews: number;
}

export interface ScoredProduct {
  product: MergedProduct;
  score: number;
  breakdown: ScoreBreakdown;
  matchedRequirements: string[];
  missingRequirements: string[];
  warnings: string[];
}

/** Testo su cui si verificano i vincoli: titolo, specifiche, varianti. */
export function searchableText(product: MergedProduct): string {
  const parts = [product.title];
  if (product.specs) {
    for (const [key, value] of Object.entries(product.specs)) parts.push(`${key} ${value}`);
  }
  if (product.variants) {
    for (const variant of product.variants) parts.push(`${variant.name} ${variant.options.join(" ")}`);
  }
  return parts.join(" ").normalize("NFKC").toLowerCase();
}

/** Confronto insensibile a separatori: `DJM-050` sta in `djm050`. */
function compact(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_/-]+/g, "");
}

function includesTerm(haystack: string, term: string): boolean {
  const cleaned = term.normalize("NFKC").toLowerCase().trim();
  if (!cleaned) return false;
  if (haystack.includes(cleaned)) return true;
  return compact(haystack).includes(compact(cleaned));
}

/**
 * Una misura è presente nel testo?
 *
 * Si accetta la misura come scritta e le sue equivalenti nelle unità della
 * stessa grandezza: `0.5 m` e `500 mm` sono la stessa quota, e pretendere la
 * forma esatta scarterebbe prodotti giusti solo perché il venditore scrive in
 * centimetri.
 */
export function dimensionMatches(
  text: string,
  dimension: { value: number; unit: string | null }
): boolean {
  const forms = new Set<string>();
  const add = (value: number, unit: string | null) => {
    const rounded = Math.round(value * 1e4) / 1e4;
    const number = String(rounded).replace(/\.0+$/, "");
    forms.add(unit ? `${number}${unit}` : number);
    if (unit) forms.add(`${number} ${unit}`);
  };

  add(dimension.value, dimension.unit);

  const base = convertToBaseUnit(dimension.value, dimension.unit);
  if (base) {
    add(base.value, base.unit);
    // Le equivalenze più frequenti nei titoli cinesi: mm ↔ cm ↔ m.
    if (base.unit === "mm") {
      add(base.value / 10, "cm");
      add(base.value / 10, "厘米");
      add(base.value / 1000, "m");
      add(base.value / 1000, "米");
      add(base.value, "毫米");
    }
    if (base.unit === "kg") {
      add(base.value * 1000, "g");
      add(base.value * 1000, "克");
      add(base.value, "公斤");
    }
  }

  for (const form of forms) {
    if (includesTerm(text, form)) return true;
  }
  return false;
}

/** Parole significative di un vincolo scritto a mano. */
function requirementTerms(requirement: string): string[] {
  return requirement
    .normalize("NFKC")
    .split(/[\s,、；;/]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

interface Check {
  label: string;
  weight: number;
  matched: boolean;
}

/**
 * Verifica un candidato contro l'analisi della richiesta.
 *
 * Restituisce cosa è stato trovato e cosa manca, non un verdetto: la
 * compatibilità è un numero fra 0 e 1, e chi guarda vede da quali voci nasce.
 */
export function checkRequirements(
  analysis: ProductAnalysis,
  product: MergedProduct
): { compatibility: number; matched: string[]; missing: string[]; checks: Check[] } {
  const text = searchableText(product);
  const checks: Check[] = [];

  if (analysis.model) {
    checks.push({
      label: `modello ${analysis.model}`,
      weight: WEIGHTS.model,
      matched: includesTerm(text, analysis.model),
    });
  }
  if (analysis.material) {
    checks.push({
      label: `materiale ${analysis.material}`,
      weight: WEIGHTS.material,
      matched: includesTerm(text, analysis.material),
    });
  }
  if (analysis.color) {
    checks.push({
      label: `colore ${analysis.color}`,
      weight: WEIGHTS.color,
      matched: includesTerm(text, analysis.color),
    });
  }

  for (const dimension of analysis.dimensions ?? []) {
    const axis = dimension.axis === "other" ? (dimension.label ?? "misura") : dimension.axis;
    checks.push({
      label: `${axis} ${dimension.value}${dimension.unit ?? ""}`,
      weight: WEIGHTS.dimension,
      matched: dimensionMatches(text, dimension),
    });
  }

  for (const spec of analysis.technicalSpecifications ?? []) {
    checks.push({
      label: `${spec.key} ${spec.value}${spec.unit ?? ""}`,
      weight: WEIGHTS.spec,
      matched: includesTerm(text, `${spec.value}${spec.unit ?? ""}`) || includesTerm(text, spec.value),
    });
  }

  for (const requirement of analysis.hardRequirements ?? []) {
    const terms = requirementTerms(requirement);
    checks.push({
      label: requirement,
      weight: WEIGHTS.hardRequirement,
      matched: terms.length > 0 && terms.some((term) => includesTerm(text, term)),
    });
  }

  for (const requirement of analysis.softRequirements ?? []) {
    const terms = requirementTerms(requirement);
    checks.push({
      label: requirement,
      weight: WEIGHTS.softRequirement,
      matched: terms.length > 0 && terms.some((term) => includesTerm(text, term)),
    });
  }

  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.reduce((sum, check) => sum + (check.matched ? check.weight : 0), 0);

  // Nessun vincolo strutturato: si ricade sulla sovrapposizione con la query.
  // È un segnale debole e va detto — non si finge una compatibilità del 100%
  // solo perché non c'era niente da verificare.
  if (total === 0) {
    const terms = requirementTerms(analysis.searchQueryChinese ?? analysis.productFamily ?? "");
    const found = terms.filter((term) => includesTerm(text, term)).length;
    const ratio = terms.length > 0 ? found / terms.length : 0.5;
    return { compatibility: ratio, matched: [], missing: [], checks };
  }

  return {
    compatibility: earned / total,
    matched: checks.filter((check) => check.matched).map((check) => check.label),
    missing: checks.filter((check) => !check.matched).map((check) => check.label),
    checks,
  };
}

/** Normalizza un valore fra 0 e 1 rispetto all'insieme dei candidati. */
function normalize(value: number | null, values: number[], invert = false): number {
  if (value == null || values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0.5;
  const ratio = (value - min) / (max - min);
  return invert ? 1 - ratio : ratio;
}

/**
 * Ordina i candidati di una riga.
 *
 * Prezzo, vendite e recensioni sono normalizzati **dentro** l'insieme dei
 * candidati della stessa riga: confrontarli con soglie assolute non avrebbe
 * senso fra una vite e un armadio. I prezzi entrano nel confronto solo fra
 * valute uguali — su Taobao è sempre CNY, ma il controllo resta perché il
 * giorno in cui non lo fosse l'errore sarebbe invisibile.
 */
export function rankCandidates(
  analysis: ProductAnalysis,
  products: readonly MergedProduct[]
): ScoredProduct[] {
  const currency = products.find((product) => product.currency)?.currency ?? null;
  const comparablePrices = products
    .filter((product) => product.price != null && product.currency === currency)
    .map((product) => product.price!);
  const salesValues = products
    .map((product) => product.totalSales)
    .filter((value): value is number => value != null);
  const reviewValues = products
    .map((product) => product.reviewCount)
    .filter((value): value is number => value != null);

  const scored = products.map((product) => {
    const requirements = checkRequirements(analysis, product);
    const warnings: string[] = [...product.conflicts];

    if (product.price == null) {
      warnings.push("Prezzo non recuperabile da nessuna fonte.");
    } else if (product.currency !== currency) {
      warnings.push(
        `Valuta diversa dagli altri candidati (${product.currency}): prezzi non confrontabili.`
      );
    }
    if (product.unavailable) warnings.push("Prodotto risultato non disponibile all'ultimo controllo.");
    if (requirements.missing.length > 0) {
      warnings.push(`${requirements.missing.length} requisiti non verificabili dal titolo.`);
    }

    const breakdown: ScoreBreakdown = {
      compatibility: requirements.compatibility,
      price:
        product.currency === currency ? normalize(product.price, comparablePrices, true) : 0,
      sales: normalize(product.totalSales, salesValues),
      reviews: normalize(product.reviewCount, reviewValues),
    };

    // I pesi dicono la stessa cosa dell'ordinamento: la compatibilità pesa più
    // di tutto il resto messo insieme.
    const score =
      breakdown.compatibility * 0.7 +
      breakdown.price * 0.12 +
      breakdown.sales * 0.1 +
      breakdown.reviews * 0.08;

    return {
      product,
      score,
      breakdown,
      matchedRequirements: requirements.matched,
      missingRequirements: requirements.missing,
      warnings,
    } satisfies ScoredProduct;
  });

  return scored.sort((left, right) => {
    // Fascia di compatibilità: dentro la stessa fascia decidono prezzo,
    // vendite e recensioni; fra fasce diverse decide solo la compatibilità.
    const leftTier = Math.round(left.breakdown.compatibility / COMPATIBILITY_TIER);
    const rightTier = Math.round(right.breakdown.compatibility / COMPATIBILITY_TIER);
    if (leftTier !== rightTier) return rightTier - leftTier;
    return right.score - left.score;
  });
}
