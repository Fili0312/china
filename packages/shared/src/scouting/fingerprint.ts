import { createHash } from "node:crypto";
import type { ProductRequirementFingerprintInput } from "../schemas/scouting";

/**
 * Impronta stabile di una richiesta prodotto.
 *
 * Serve a rispondere a una sola domanda: «questa richiesta l'abbiamo già
 * elaborata?». Il numero di riga non basta, perché la stessa richiesta può
 * trovarsi in un altro file, in un'altra posizione, scritta con le parole in
 * ordine diverso o con unità di misura equivalenti.
 *
 * Quattro scelte rendono l'impronta insensibile a queste differenze:
 *
 * 1. il nome viene ridotto a un insieme **ordinato** di token, quindi
 *    «sedia antistatica nera» e «nera sedia antistatica» coincidono;
 * 2. i numeri arrivano già convertiti in unità base (mm, W, V, l): `1.5 m` e
 *    `1500 mm` producono la stessa impronta;
 * 3. le chiavi dei dizionari vengono ordinate prima della serializzazione,
 *    perché l'ordine di inserimento di un oggetto JS non è informazione;
 * 4. la quantità richiesta **non** entra nell'hash: ordinare 10 pezzi o 500
 *    non cambia il prodotto da cercare. Resta sul record perché serve ai
 *    vincoli di MOQ e ai prezzi per quantità.
 */

/** Lunghezza dell'impronta esadecimale (128 bit: collisioni trascurabili). */
const FINGERPRINT_LENGTH = 32;

/**
 * Riempitivi che non identificano il prodotto. Volutamente pochissimi: ogni
 * termine tolto qui è un termine che non distingue più due richieste diverse.
 */
const NAME_STOPWORDS = new Set([
  "circa",
  "about",
  "approx",
  "cad",
  "cadauno",
  "pz",
  "pcs",
  "pezzi",
  "unita",
  "unità",
  "n",
  "nr",
  "no",
  "the",
  "di",
  "da",
  "de",
  "del",
  "della",
  "per",
  "con",
  "e",
  "a",
  "il",
  "la",
  "lo",
  "un",
  "una",
  "of",
  "for",
  "with",
  "and",
]);

/**
 * Token del nome prodotto.
 *
 * Le sequenze di caratteri Han restano intere (`防静电椅`): spezzarle per
 * carattere e riordinarle farebbe collidere parole diverse composte dagli
 * stessi ideogrammi. I codici latini conservano i separatori interni
 * (`djm-050-485`, `2hhs57-a-5/24`) perché sono parte del modello.
 */
const TOKEN_PATTERN =
  /[\p{Script=Han}]+|[\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9]+(?:[./\-*+×][a-z0-9]+)*/gu;

/** Confronto per code unit: deterministico, indipendente dal locale. */
function compareStable(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Riduce un testo prodotto ai suoi token significativi, ordinati e deduplicati.
 * È la parte dell'impronta che assorbe l'ordine delle parole e la formattazione.
 */
export interface NormalizeProductNameOptions {
  /**
   * Conserva i numeri isolati (`4 ruote`, `3 vie`).
   *
   * Va usato **solo** dopo aver tolto dal testo le misure già estratte come
   * requisiti: altrimenti `1.5 m` e `1500 mm` resterebbero due nomi diversi e
   * l'equivalenza fra unità andrebbe persa. Chi normalizza testo grezzo lascia
   * il valore predefinito.
   */
  keepBareNumbers?: boolean;
}

export function normalizeProductName(
  raw: string,
  options: NormalizeProductNameOptions = {}
): string {
  const lowered = (raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    // Le decorazioni copiate dai titoli dei marketplace non sono contenuto.
    .replace(/[\p{Extended_Pictographic}]/gu, " ");

  const tokens = lowered.match(TOKEN_PATTERN) ?? [];
  const kept = new Set<string>();
  for (const token of tokens) {
    // Un token puramente numerico isolato non identifica un prodotto: viene
    // da misure già estratte come dimensioni (`长200*宽40` → 200, 40).
    if (!options.keepBareNumbers && /^\d+(?:[.,]\d+)?$/.test(token)) continue;
    if (NAME_STOPWORDS.has(token)) continue;
    kept.add(token);
  }
  return [...kept].sort(compareStable).join(" ");
}

/**
 * Identità debole: solo i token alfabetici/ideografici, senza codici e misure.
 * Non identifica la richiesta, ma permette di proporre richieste **simili**
 * già elaborate quando l'impronta forte non trova nulla.
 */
export function normalizedNameKey(raw: string): string {
  const tokens = normalizeProductName(raw)
    .split(" ")
    .filter((token) => token && !/\d/.test(token));
  return tokens.join(" ");
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1e4) / 1e4;
  // `-0` e `0` sono lo stesso valore ma serializzano diversamente.
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeText(value: string | null): string | null {
  if (value == null) return null;
  const cleaned = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/** Codice modello: si conservano solo i caratteri che lo identificano. */
function normalizeModel(value: string | null): string | null {
  if (value == null) return null;
  const cleaned = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, "")
    .replace(/[^\p{L}\p{N}./\-*+]/gu, "");
  return cleaned || null;
}

function sortedRecord<T>(
  record: Record<string, T>,
  mapValue: (value: T) => unknown
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record ?? {}).sort(compareStable)) {
    const normalizedKey = key.normalize("NFKC").toLowerCase().trim();
    if (!normalizedKey) continue;
    output[normalizedKey] = mapValue(record[key]!);
  }
  return output;
}

/**
 * Forma canonica dell'input: stessa richiesta → stesso oggetto, sempre.
 * Esposta separatamente perché è ciò che va mostrato quando si spiega
 * all'utente **perché** due righe sono state considerate la stessa richiesta.
 */
export function canonicalizeFingerprintInput(
  input: ProductRequirementFingerprintInput
): Record<string, unknown> {
  return {
    // L'ordine delle chiavi qui è il contratto di serializzazione: cambiarlo
    // invaliderebbe tutte le impronte già salvate.
    // `normalizedName` arriva già privato delle misure estratte come requisiti
    // (vedi `buildNormalizedRequest`): qui i numeri rimasti sono informazione
    // vera — `4 ruote` non è `5 ruote` — e vanno conservati.
    name: normalizeProductName(input.normalizedName, { keepBareNumbers: true }),
    category: normalizeText(input.category),
    brand: normalizeText(input.brand),
    model: normalizeModel(input.model),
    material: normalizeText(input.material),
    power: input.power == null ? null : roundNumber(input.power),
    voltage: input.voltage == null ? null : roundNumber(input.voltage),
    capacity: input.capacity == null ? null : roundNumber(input.capacity),
    dimensions: sortedRecord(input.dimensions ?? {}, (value) =>
      roundNumber(Number(value))
    ),
    variant: sortedRecord(input.requiredVariant ?? {}, (value) =>
      typeof value === "number" ? roundNumber(value) : normalizeText(String(value))
    ),
    certifications: [
      ...new Set(
        (input.certifications ?? [])
          .map((certification) =>
            certification.normalize("NFKC").toUpperCase().replace(/\s+/g, "")
          )
          .filter(Boolean)
      ),
    ].sort(compareStable),
    // `requestedQuantity` è deliberatamente assente: vedi intestazione.
  };
}

/** Impronta esadecimale a 32 caratteri della richiesta. */
export function computeRequirementFingerprint(
  input: ProductRequirementFingerprintInput
): string {
  const canonical = canonicalizeFingerprintInput(input);
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}
