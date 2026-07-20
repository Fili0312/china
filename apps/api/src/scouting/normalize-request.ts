import {
  computeRequirementFingerprint,
  detectLanguage,
  extractModelCode,
  extractRequirements,
  normalizedNameKey,
  MERGEABLE_DATASET_FIELDS,
  type DatasetField,
  type DatasetMapping,
  type DatasetRow,
  type NormalizedRequest,
  type ProductRequirementFingerprintInput,
} from "@china/shared";
import { buildInquiryQuery } from "../inquiry/inquiry-query";

/**
 * Trasforma una riga grezza del file nella richiesta normalizzata che alimenta
 * ricerca, impronta e vincoli.
 *
 * La costruzione della query riusa `buildInquiryQuery` di `inquiry/`: è la
 * funzione già collaudata sui fogli reali, che toglie etichette amministrative
 * e quantità di confezionamento **senza tradurre** il testo. Tradurre e
 * ritradurre perderebbe codici, modelli e misure, che sono il segnale più
 * affidabile fra lingue diverse.
 */

/** Colonne dalle quali si leggono i valori di un campo mappato. */
type FieldValues = Partial<Record<DatasetField, string>>;

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  // I fogli usano sia `1.234,56` sia `1,234.56`: si tiene l'ultimo separatore
  // come decimale e si scartano gli altri, che sono migliaia.
  const cleaned = value.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Una sola virgola con tre cifre dopo è un separatore di migliaia.
    normalized = /,\d{3}$/.test(cleaned)
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(",", ".");
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Raccoglie i valori della riga secondo la mappatura scelta dall'utente. */
export function readMappedValues(
  row: DatasetRow,
  mapping: readonly DatasetMapping[],
  columnIndexes: readonly number[]
): FieldValues {
  const values: FieldValues = {};
  // `cells` è allineato all'elenco delle colonne del dataset, non all'indice
  // Excel: la posizione va ritrovata, altrimenti una colonna vuota iniziale
  // sposterebbe tutti i valori.
  const positionByColumn = new Map(
    columnIndexes.map((columnIndex, position) => [columnIndex, position])
  );

  for (const entry of [...mapping].sort(
    (left, right) => left.columnIndex - right.columnIndex
  )) {
    if (entry.field === "ignore") continue;
    const position = positionByColumn.get(entry.columnIndex);
    if (position === undefined) continue;
    const text = (row.cells[position] ?? "").trim();
    if (!text) continue;

    const existing = values[entry.field];
    if (existing == null) {
      values[entry.field] = text;
      continue;
    }
    // Più colonne sullo stesso campo: si uniscono solo dove ha senso
    // (specifiche e note sono spesso spezzate su due colonne).
    if (MERGEABLE_DATASET_FIELDS.includes(entry.field)) {
      values[entry.field] = `${existing} ${text}`;
    }
  }
  return values;
}

/** Divide una cella di certificazioni in sigle singole. */
function splitCertifications(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[,;、/|+\s]+/)
        .map((entry) => entry.normalize("NFKC").toUpperCase().replace(/\s+/g, ""))
        .filter((entry) => entry.length >= 2)
    ),
  ];
}

/**
 * Toglie dal testo le porzioni già catturate come requisiti strutturati.
 *
 * È ciò che rende `1.5 m` e `1500 mm` la stessa richiesta: la misura vive nel
 * campo `dimensions`, non nel nome. I numeri che restano nel nome (`4 vie`)
 * sono invece informazione vera e vengono conservati.
 */
function stripRequirementSources(text: string, sources: readonly string[]): string {
  let output = text;
  // Dal più lungo al più corto: togliere `35` prima di `M8*35` spezzerebbe
  // la sorgente più specifica.
  for (const source of [...sources].sort((left, right) => right.length - left.length)) {
    if (!source) continue;
    output = output.split(source).join(" ");
  }
  return output.replace(/\s+/g, " ").trim();
}

export interface BuildNormalizedRequestOptions {
  /** Indici Excel delle colonne del dataset, nell'ordine di `row.cells`. */
  columnIndexes: readonly number[];
  mapping: readonly DatasetMapping[];
}

/** Costruisce la richiesta normalizzata di una riga. */
export function buildNormalizedRequest(
  row: DatasetRow,
  options: BuildNormalizedRequestOptions
): NormalizedRequest {
  const values = readMappedValues(row, options.mapping, options.columnIndexes);
  const issues: string[] = [];

  const name = (values.name ?? "").trim();
  const spec = (values.spec ?? "").trim();
  if (!name) {
    issues.push("Riga senza nome prodotto: nessuna ricerca possibile.");
  }

  // Il testo su cui cercare i requisiti: nome e specifiche. Le note restano
  // fuori perché contengono spesso l'uso previsto (`用途`), non il prodotto.
  const requirementText = [name, spec].filter(Boolean).join(" ");
  const extracted = extractRequirements(requirementText);

  const built = buildInquiryQuery(name, spec);
  if (name && !built.query) {
    issues.push("Dalla riga non è stato possibile costruire una query utile.");
  }

  const certifications = [
    ...new Set([
      ...splitCertifications(values.certifications),
      ...extracted.certifications,
    ]),
  ].sort();

  const model =
    values.model?.trim() || extractModelCode(requirementText) || null;
  const material = values.material?.trim() || extracted.material;
  const quantity = parseNumber(values.quantity);
  const targetPrice = parseNumber(values.targetPrice);

  const referenceUrl =
    values.referenceUrl?.trim() ||
    row.hyperlink ||
    null;

  // Nome depurato delle misure: è la base dell'identità della richiesta.
  const nameForFingerprint = stripRequirementSources(
    requirementText,
    extracted.requirements.map((requirement) => requirement.source)
  );

  const fingerprintInput: ProductRequirementFingerprintInput = {
    category: values.category?.trim() || null,
    brand: values.brand?.trim() || null,
    model,
    normalizedName: nameForFingerprint,
    requiredVariant: extracted.requiredVariant,
    dimensions: extracted.dimensions,
    material,
    power: extracted.power,
    voltage: extracted.voltage,
    capacity: extracted.capacity,
    certifications,
    requestedQuantity: quantity,
  };

  return {
    rowNumber: row.rowNumber,
    fingerprint: computeRequirementFingerprint(fingerprintInput),
    normalizedNameKey: normalizedNameKey(nameForFingerprint),
    displayName: name || spec || `Riga ${row.rowNumber}`,
    normalizedName: nameForFingerprint,
    category: fingerprintInput.category,
    brand: fingerprintInput.brand,
    model,
    material,
    power: extracted.power,
    voltage: extracted.voltage,
    capacity: extracted.capacity,
    dimensions: extracted.dimensions,
    requiredVariant: extracted.requiredVariant,
    certifications,
    requestedQuantity: quantity,
    unit: values.unit?.trim() || null,
    targetPrice,
    notes: values.notes?.trim() || null,
    referenceUrl,
    searchQuery: built.query,
    language: detectLanguage(built.query || requirementText),
    requirements: extracted.requirements,
    droppedTerms: built.dropped,
    issues,
  };
}
