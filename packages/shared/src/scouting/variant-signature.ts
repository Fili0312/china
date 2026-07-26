import { convertToBaseUnit } from "./requirements";

/**
 * La rete di sicurezza contro i falsi duplicati.
 *
 * L'identità di una variante si calcola dai campi strutturati che Claude
 * estrae (misure, specifiche, modello, materiale, colore). Finché l'estrazione
 * è completa funziona: `5 mm` e `5.00 mm` danno la stessa chiave, `5 mm` e
 * `6 mm` no.
 *
 * Il guaio è cosa succede quando l'estrazione **non** è completa. Se una riga
 * dice `陶瓷针规 5mm` e il modello lascia `dimensions` vuoto — perché la misura
 * era attaccata al nome, perché la riga era scritta male, perché quel giorno
 * ha risposto in modo più povero — allora `陶瓷针规 5mm` e `陶瓷针规 6mm`
 * producono **la stessa** chiave di variante. Due prodotti diversi diventano
 * la stessa richiesta: si cerca solo il primo e si consegnano al cliente i
 * prodotti sbagliati per il secondo. È il falso duplicato, ed è un errore
 * silenzioso: nessuno se ne accorge finché non arriva la merce.
 *
 * La correzione non è chiedere al modello di sbagliare meno. È non dipendere
 * più solo da lui: dal testo originale della riga si estraggono in modo
 * deterministico i **numeri con unità**, i **gruppi di misure** (`60*60`) e i
 * **codici** (`M8*35`, `DJM-050-485`), e quelli che i campi strutturati non
 * hanno già catturato entrano nella chiave come residuo.
 *
 * Le proprietà che ne derivano, in ordine di importanza:
 *
 * 1. **Ciò che distingue due prodotti non può sparire.** Se la misura non è
 *    finita nei campi strutturati, è ancora nel testo, e dal testo entra nella
 *    chiave.
 * 2. **Le differenze di scrittura continuano a non contare.** I numeri con
 *    unità nota passano dall'unità base — `400 g` e `0.4 kg` sono lo stesso
 *    token, `5mm` e `5.00 mm` pure.
 * 3. **La quantità resta fuori.** `20个` non è una caratteristica del
 *    prodotto: le unità di conteggio vengono riconosciute e scartate, non
 *    convertite.
 * 4. **Quando l'estrazione è completa il residuo è vuoto**, e l'identità è
 *    esattamente quella di prima. La rete non cambia il comportamento buono:
 *    interviene solo dove prima si perdeva un'informazione.
 */

/**
 * Unità di conteggio: dicono **quanti**, non **com'è fatto**.
 *
 * Vanno riconosciute per poterle scartare. Senza questo elenco `20个` finirebbe
 * nella firma e due richieste dello stesso identico prodotto in quantità
 * diverse diventerebbero due varianti — l'errore opposto, altrettanto costoso.
 */
const QUANTITY_UNITS = new Set([
  "个",
  "件",
  "只",
  "支",
  "条",
  "张",
  "包",
  "盒",
  "箱",
  "双",
  "副",
  "付",
  "套",
  "台",
  "把",
  "卷",
  "袋",
  "瓶",
  "桶",
  "组",
  "批",
  "块",
  "根",
  "片",
  "台份",
  "pcs",
  "pc",
  "piece",
  "pieces",
  "set",
  "sets",
  "box",
  "boxes",
  "pack",
  "packs",
  "unit",
  "units",
  "nr",
  "pz",
]);

/** Lunghezza massima di una sigla d'unità, in caratteri. */
const MAX_UNIT_LENGTH = 4;

/** Numero in forma stabile: niente `-0`, niente code di virgola mobile. */
function round(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseNumber(raw: string): number | null {
  const parsed = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Riconosce l'unità che segue un numero.
 *
 * Si prova dalla sigla più lunga alla più corta perché il testo cinese non
 * separa le parole: in `400g的` la sigla è `g`, non `g的`. La prima che una
 * tabella di conversione riconosce vince; se nessuna la riconosce si guarda se
 * è un'unità di conteggio, per poterla scartare invece di ignorarla.
 */
function readUnit(
  value: number,
  raw: string
): { kind: "measure"; token: string } | { kind: "quantity" } | null {
  const cleaned = raw.normalize("NFKC").trim().toLowerCase();
  for (let length = Math.min(MAX_UNIT_LENGTH, cleaned.length); length > 0; length -= 1) {
    const candidate = cleaned.slice(0, length);
    const converted = convertToBaseUnit(value, candidate);
    if (converted) {
      return { kind: "measure", token: `${round(converted.value)}${converted.unit}` };
    }
    if (QUANTITY_UNITS.has(candidate)) return { kind: "quantity" };
  }
  return null;
}

/** Numeri seguiti da un'unità riconosciuta: `5mm`, `400 g`, `220V`, `1.5米`. */
function measureTokens(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*([A-Za-z一-鿿]{1,4})/gu;
  for (const match of text.matchAll(pattern)) {
    const value = parseNumber(match[1]!);
    if (value == null) continue;
    const unit = readUnit(value, match[2]!);
    // Nessuna unità riconosciuta: il numero resta fuori. Includere i numeri
    // nudi trascinerebbe dentro numeri di linea, note e riferimenti interni,
    // e spaccherebbe in due varianti richieste identiche.
    if (unit?.kind === "measure") tokens.push(`m:${unit.token}`);
  }
  return tokens;
}

/**
 * Gruppi di misure senza unità: `60*60`, `30x30`, `100×200×50`.
 *
 * L'ordine dei fattori si conserva come scritto: `长200*宽40` è una piastra
 * diversa da `长40*宽200`, e normalizzare l'ordine le confonderebbe.
 */
function dimensionGroupTokens(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /\d+(?:[.,]\d+)?(?:\s*[*x×]\s*\d+(?:[.,]\d+)?)+/giu;
  for (const match of text.matchAll(pattern)) {
    const numbers = match[0]
      .split(/[*x×]/iu)
      .map((part) => parseNumber(part.trim()))
      .filter((value): value is number => value != null)
      .map(round);
    if (numbers.length >= 2) tokens.push(`g:${numbers.join("x")}`);
  }
  return tokens;
}

/**
 * Codici: modelli, filettature, sigle di classe (`M8*35`, `DJM-050-485`, `M1`).
 *
 * Un codice non si traduce ed è il segnale più affidabile che due righe
 * parlano dello stesso pezzo — o di due pezzi diversi. Si scartano i token che
 * sono in realtà misure (`400g`), già coperte dai token di misura: tenerli
 * entrambi renderebbe `400g` e `0.4kg` due varianti diverse.
 */
function codeTokens(text: string): string[] {
  const tokens: string[] = [];
  const candidates =
    text.normalize("NFKC").match(/[A-Za-z0-9]+(?:[-/*×][A-Za-z0-9]+)*/gu) ?? [];

  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    // Un codice mescola lettere e cifre: senza entrambe è una parola o un
    // numero, e come tale è già trattato altrove.
    if (!/[A-Za-z]/.test(candidate) || !/\d/.test(candidate)) continue;

    // `400g`, `220v`, `1.5m`: sono misure, non codici.
    const asMeasure = candidate.match(/^(\d+(?:[.,]\d+)?)([A-Za-z]{1,4})$/u);
    if (asMeasure) {
      const value = parseNumber(asMeasure[1]!);
      if (value != null && readUnit(value, asMeasure[2]!)) continue;
    }

    const normalized = candidate
      .toLowerCase()
      .replace(/[\s_-]+/g, "")
      .replace(/[×]/g, "*");
    if (normalized) tokens.push(`c:${normalized}`);
  }
  return tokens;
}

/**
 * Firma completa del testo: misure, gruppi e codici, senza duplicati.
 *
 * Esposta a parte perché è la risposta alla domanda «che cosa ha visto il
 * sistema in questa riga?», e perché i test la usano direttamente.
 */
export function extractVariantSignature(text: string | null | undefined): string[] {
  const source = (text ?? "").normalize("NFKC");
  if (!source.trim()) return [];
  return [
    ...new Set([
      ...measureTokens(source),
      ...dimensionGroupTokens(source),
      ...codeTokens(source),
    ]),
  ].sort();
}

/**
 * Ciò che i campi strutturati hanno già catturato, nella stessa forma della
 * firma. È il metro con cui si decide che cosa resta «residuo».
 */
export function coveredSignature(input: {
  model?: string | null;
  material?: string | null;
  color?: string | null;
  dimensions?: ReadonlyArray<{ value: number; unit: string | null }>;
  technicalSpecifications?: ReadonlyArray<{ value: string; unit: string | null }>;
}): Set<string> {
  const covered = new Set<string>();

  for (const dimension of input.dimensions ?? []) {
    const converted = convertToBaseUnit(dimension.value, dimension.unit);
    if (converted) covered.add(`m:${round(converted.value)}${converted.unit}`);
  }

  for (const spec of input.technicalSpecifications ?? []) {
    const value = parseNumber(String(spec.value));
    if (value == null) continue;
    const converted = convertToBaseUnit(value, spec.unit);
    if (converted) covered.add(`m:${round(converted.value)}${converted.unit}`);
  }

  // Modello, materiale e colore possono contenere a loro volta codici e
  // misure: ciò che è già dentro un campo strutturato non è un residuo.
  for (const field of [input.model, input.material, input.color]) {
    for (const token of extractVariantSignature(field)) covered.add(token);
  }

  // I gruppi di misure sono coperti quando **tutti** i loro numeri lo sono:
  // `60*60` non conta come residuo se le due quote sono già fra le dimensioni.
  return covered;
}

/**
 * Il residuo: ciò che il testo dice e i campi strutturati non dicono.
 *
 * Vuoto quando l'estrazione è completa — ed è il caso normale. Quando non lo
 * è, questi token sono l'unica cosa che tiene separate due varianti che
 * altrimenti collasserebbero in una.
 */
export function residualSignature(
  text: string | null | undefined,
  structured: Parameters<typeof coveredSignature>[0],
  dimensionValues: ReadonlyArray<number> = []
): string[] {
  const covered = coveredSignature(structured);
  const knownNumbers = new Set(dimensionValues.map((value) => round(value)));

  return extractVariantSignature(text).filter((token) => {
    if (covered.has(token)) return false;

    // Un gruppo `60*60` è già rappresentato se le sue quote sono fra le
    // dimensioni estratte, anche senza unità: è il caso di `平板灯 60*60`
    // analizzato bene, dove length=60 e width=60 hanno unit null.
    if (token.startsWith("g:")) {
      const numbers = token
        .slice(2)
        .split("x")
        .map((part) => Number.parseFloat(part));
      if (numbers.every((value) => Number.isFinite(value) && knownNumbers.has(round(value)))) {
        return false;
      }
    }
    return true;
  });
}
