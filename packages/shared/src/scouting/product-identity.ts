import { createHash } from "node:crypto";
import type { AnalyzedDimension, AnalyzedSpec, ProductAnalysis, ProductIdentity } from "../schemas/analysis";
import { convertToBaseUnit } from "./requirements";

/**
 * Identità di un prodotto richiesto, su tre livelli.
 *
 * L'impronta unica (`fingerprint`) rispondeva a una sola domanda — «è la stessa
 * richiesta?» — e quindi non sapeva distinguere due situazioni molto diverse:
 * una variante mai cercata di un prodotto che conosciamo bene, e un prodotto di
 * cui non sappiamo nulla. Nel primo caso i venditori, le categorie e le query
 * già usate sono un punto di partenza; nel secondo si parte da zero.
 *
 * Da qui i tre livelli:
 *
 * - **`familyKey`** — stessa famiglia di prodotto. È l'unico livello che nasce
 *   da un giudizio semantico (di Claude): che `陶瓷针规` e `ceramic pin gauge`
 *   siano la stessa cosa non si deduce da una regola sui caratteri.
 * - **`variantKey`** — configurazione tecnica precisa. È l'identità che decide
 *   il riuso: stessa `variantKey` significa che i prodotti già trovati vanno
 *   bene anche per questa riga.
 * - **`duplicateKey`** — richiesta realmente identica, vincoli obbligatori
 *   compresi. Due righe con la stessa `duplicateKey` sono la stessa domanda
 *   scritta due volte.
 *
 * Le ultime due sono **deterministiche**: si calcolano dai campi strutturati
 * con conversione in unità base, quindi `5.00mm` e `5mm` danno la stessa chiave
 * oggi, fra sei mesi e su un altro file. Il modello non le decide; il modello
 * fornisce i campi da cui si calcolano.
 *
 * Non entrano nelle chiavi: quantità richiesta, unità d'acquisto, reparto,
 * richiedente, note e prezzo obiettivo. Ordinare 10 pezzi o 500 non cambia il
 * prodotto da cercare.
 */

/** Lunghezza della parte hash delle chiavi (96 bit: collisioni trascurabili). */
const VARIANT_HASH_LENGTH = 24;
const DUPLICATE_HASH_LENGTH = 16;
/** Oltre questa lunghezza lo slug di famiglia viene troncato. */
const FAMILY_SLUG_MAX = 60;

/** Confronto per code unit: deterministico, indipendente dal locale. */
function compareStable(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function digest(payload: unknown, length: number): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, length);
}

/** Testo ridotto alla sua forma confrontabile: nessun'altra differenza conta. */
function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * Codice modello: si tengono solo i caratteri che lo identificano.
 * `DJM 050/485`, `djm-050-485` e `DJM_050/485` sono lo stesso modello.
 */
function normalizeModel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}./*+]/gu, "");
  return cleaned || null;
}

/**
 * Slug della famiglia: leggibile di proposito.
 *
 * Una chiave illeggibile a database costringe a una join per rispondere alla
 * domanda più frequente in assoluto — «di che prodotto stiamo parlando?».
 */
export function normalizeFamilyKey(value: string): string {
  const slug = value
    .normalize("NFKD")
    // Gli accenti diventano lettere semplici: `caffè` e `caffe` sono la stessa
    // famiglia. I caratteri Han restano intatti (non hanno decomposizione).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "sconosciuto").slice(0, FAMILY_SLUG_MAX).replace(/-+$/, "");
}

/** Chiave stabile di un asse di misura. */
function dimensionAxisKey(dimension: AnalyzedDimension): string {
  if (dimension.axis !== "other") return dimension.axis;
  return `other:${normalizeText(dimension.label) ?? ""}`;
}

/**
 * Misura in forma canonica: `[asse, valore, unità]`.
 *
 * Quando l'unità è nota il valore viene convertito nell'unità base, ed è ciò
 * che rende `1.5 m` e `1500 mm` la stessa variante. Quando non c'è unità il
 * valore resta grezzo, marcato con `?`: `60*60` e `30*30` restano varianti
 * diverse, ma non vengono mai confusi con una misura espressa in millimetri.
 */
function canonicalDimension(dimension: AnalyzedDimension): [string, number, string] {
  const converted = convertToBaseUnit(dimension.value, dimension.unit);
  if (converted) {
    return [dimensionAxisKey(dimension), converted.value, converted.unit];
  }
  return [dimensionAxisKey(dimension), round(dimension.value), "?"];
}

/**
 * Specifica tecnica in forma canonica.
 *
 * I valori numerici con unità nota seguono la stessa conversione delle misure —
 * `400g` e `0.4kg` sono lo stesso peso — mentre i valori testuali (`classe M1`,
 * `IP65`) vengono solo normalizzati.
 */
function canonicalSpec(spec: AnalyzedSpec): [string, string | number, string] {
  const key = normalizeText(spec.key) ?? "";
  const numeric = Number.parseFloat(String(spec.value).replace(",", "."));
  if (Number.isFinite(numeric)) {
    const converted = convertToBaseUnit(numeric, spec.unit);
    if (converted) return [key, converted.value, converted.unit];
    return [key, round(numeric), normalizeText(spec.unit) ?? "?"];
  }
  return [key, normalizeText(spec.value) ?? "", normalizeText(spec.unit) ?? ""];
}

/** Lista di testi ridotta a insieme ordinato: l'ordine di scrittura non conta. */
function canonicalList(values: readonly string[]): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => normalizeText(value)).filter((value): value is string => !!value)
    ),
  ].sort(compareStable);
}

/**
 * Forma canonica della variante.
 *
 * Esposta separatamente perché è la risposta a «perché queste due righe sono
 * la stessa variante?»: si mostra questo oggetto e la domanda è chiusa.
 */
export function canonicalVariant(
  analysis: Pick<
    ProductAnalysis,
    | "familyKey"
    | "model"
    | "material"
    | "color"
    | "dimensions"
    | "technicalSpecifications"
    | "includedAccessories"
  >
): Record<string, unknown> {
  return {
    // L'ordine delle chiavi è il contratto di serializzazione: cambiarlo
    // invaliderebbe tutte le varianti già salvate.
    family: normalizeFamilyKey(analysis.familyKey),
    model: normalizeModel(analysis.model),
    material: normalizeText(analysis.material),
    color: normalizeText(analysis.color),
    dimensions: (analysis.dimensions ?? [])
      .map(canonicalDimension)
      .sort((left, right) => compareStable(left[0], right[0]) || left[1] - right[1]),
    specs: (analysis.technicalSpecifications ?? [])
      .map(canonicalSpec)
      .sort(
        (left, right) =>
          compareStable(left[0], right[0]) || compareStable(String(left[1]), String(right[1]))
      ),
    accessories: canonicalList(analysis.includedAccessories ?? []),
    // Quantità, unità, reparto e richiedente sono deliberatamente assenti.
  };
}

/**
 * Calcola le tre chiavi di identità.
 *
 * `variantKey` e `duplicateKey` portano in testa lo slug della famiglia: a
 * database si legge subito di che prodotto si tratta, e un indice sul prefisso
 * ritrova tutta la famiglia senza una colonna in più.
 */
export function computeProductIdentity(
  analysis: Pick<
    ProductAnalysis,
    | "familyKey"
    | "model"
    | "material"
    | "color"
    | "dimensions"
    | "technicalSpecifications"
    | "includedAccessories"
    | "hardRequirements"
  >
): ProductIdentity {
  const familyKey = normalizeFamilyKey(analysis.familyKey);
  const variant = canonicalVariant(analysis);
  const variantKey = `${familyKey}:${digest(variant, VARIANT_HASH_LENGTH)}`;

  // Il duplicato aggiunge i vincoli obbligatori: due righe possono chiedere la
  // stessa configurazione tecnica e differire solo per «con certificato CE»,
  // e quella differenza rende le due richieste non intercambiabili.
  const duplicateKey = `${variantKey}:${digest(
    { variant: variantKey, hard: canonicalList(analysis.hardRequirements ?? []) },
    DUPLICATE_HASH_LENGTH
  )}`;

  return { familyKey, variantKey, duplicateKey };
}
