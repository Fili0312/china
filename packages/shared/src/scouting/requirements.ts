import type { ProductRequirement } from "../schemas/scouting";

/**
 * Estrazione deterministica dei requisiti da una richiesta scritta a mano.
 *
 * Non c'è IA in questo modulo, e non deve entrarci: il risultato alimenta
 * l'impronta della richiesta, che deve restare identica a distanza di mesi e
 * fra file diversi. Un modello linguistico non offre questa garanzia.
 *
 * Ogni valore numerico viene convertito in **unità base** (mm, W, V, l/Ah, kg)
 * così che `1.5 m` e `1500 mm` finiscano nella stessa impronta. L'unità
 * predefinita dei numeri senza unità è il **millimetro**: è la convenzione dei
 * fogli di richiesta industriali cinesi da cui nasce questa piattaforma
 * (`长200*宽40` significa 200 mm × 40 mm).
 */

/* -------------------------------------------------------------------------- */
/* Tabelle di conversione                                                      */
/* -------------------------------------------------------------------------- */

/** Unità di lunghezza → millimetri. */
const LENGTH_UNITS: Record<string, number> = {
  mm: 1,
  millimetri: 1,
  毫米: 1,
  cm: 10,
  centimetri: 10,
  厘米: 10,
  公分: 10,
  dm: 100,
  分米: 100,
  m: 1000,
  metri: 1000,
  metro: 1000,
  米: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  英寸: 25.4,
};

/** Unità di potenza → watt. */
const POWER_UNITS: Record<string, number> = {
  w: 1,
  watt: 1,
  瓦: 1,
  瓦特: 1,
  kw: 1000,
  千瓦: 1000,
  mw: 0.001,
  hp: 735.49875,
  马力: 735.49875,
};

/** Unità di tensione → volt. */
const VOLTAGE_UNITS: Record<string, number> = {
  v: 1,
  volt: 1,
  伏: 1,
  伏特: 1,
  kv: 1000,
  千伏: 1000,
  mv: 0.001,
};

/** Unità di volume → litri. */
const VOLUME_UNITS: Record<string, number> = {
  l: 1,
  lt: 1,
  litri: 1,
  litro: 1,
  升: 1,
  ml: 0.001,
  毫升: 0.001,
  cl: 0.01,
  dl: 0.1,
  cc: 0.001,
};

/** Unità di capacità elettrica → amperora. */
const CHARGE_UNITS: Record<string, number> = {
  ah: 1,
  安时: 1,
  mah: 0.001,
  毫安时: 0.001,
};

/** Unità di massa → chilogrammi. */
const WEIGHT_UNITS: Record<string, number> = {
  kg: 1,
  kilogrammi: 1,
  公斤: 1,
  千克: 1,
  g: 0.001,
  grammi: 0.001,
  克: 0.001,
  mg: 0.000001,
  t: 1000,
  吨: 1000,
};

/** Etichetta di dimensione → chiave canonica. */
const DIMENSION_LABELS: Record<string, string> = {
  长: "length",
  长度: "length",
  lunghezza: "length",
  length: "length",
  l: "length",
  宽: "width",
  宽度: "width",
  larghezza: "width",
  width: "width",
  w: "width",
  高: "height",
  高度: "height",
  altezza: "height",
  height: "height",
  h: "height",
  厚: "thickness",
  厚度: "thickness",
  spessore: "thickness",
  thickness: "thickness",
  深: "depth",
  深度: "depth",
  profondita: "depth",
  profondità: "depth",
  depth: "depth",
  直径: "diameter",
  外径: "outerDiameter",
  内径: "innerDiameter",
  径: "diameter",
  diametro: "diameter",
  diameter: "diameter",
  "ø": "diameter",
  "φ": "diameter",
  "Φ": "diameter",
};

/** Ordine dei valori in una misura composta senza etichette (`200*40*30`). */
const POSITIONAL_DIMENSIONS = ["length", "width", "height"] as const;

const MATERIALS: Array<[RegExp, string]> = [
  [/不锈钢|stainless|inox|acciaio inox/iu, "acciaio inox"],
  [/碳钢|carbon steel|acciaio al carbonio/iu, "acciaio al carbonio"],
  [/(?:^|[^a-z])(?:钢|steel|acciaio)(?:$|[^a-z])/iu, "acciaio"],
  [/铝合金|铝|aluminium|aluminum|alluminio/iu, "alluminio"],
  [/黄铜|brass|ottone/iu, "ottone"],
  [/紫铜|铜|copper|rame/iu, "rame"],
  [/铁|iron|ferro/iu, "ferro"],
  [/ptfe|teflon|聚四氟乙烯/iu, "ptfe"],
  [/pom|聚甲醛/iu, "pom"],
  [/abs树脂|(?:^|[^a-z])abs(?:$|[^a-z])/iu, "abs"],
  [/pvc|聚氯乙烯/iu, "pvc"],
  [/(?:^|[^a-z])pp(?:$|[^a-z])|聚丙烯/iu, "pp"],
  [/(?:^|[^a-z])pe(?:$|[^a-z])|聚乙烯/iu, "pe"],
  [/(?:^|[^a-z])pc(?:$|[^a-z])|聚碳酸酯/iu, "policarbonato"],
  [/尼龙|nylon|poliammide/iu, "nylon"],
  [/硅胶|silicone|silicon rubber/iu, "silicone"],
  [/橡胶|rubber|gomma/iu, "gomma"],
  [/玻璃|glass|vetro/iu, "vetro"],
  [/陶瓷|ceramic|ceramica/iu, "ceramica"],
  [/木|wood|legno/iu, "legno"],
  [/塑料|plastic|plastica/iu, "plastica"],
];

const COLORS: Array<[RegExp, string]> = [
  [/黑色|(?:^|[^a-z])black(?:$|[^a-z])|nero/iu, "nero"],
  [/白色|(?:^|[^a-z])white(?:$|[^a-z])|bianco/iu, "bianco"],
  [/红色|(?:^|[^a-z])red(?:$|[^a-z])|rosso/iu, "rosso"],
  [/蓝色|(?:^|[^a-z])blue(?:$|[^a-z])|(?:^|[^a-z])blu(?:$|[^a-z])/iu, "blu"],
  [/绿色|(?:^|[^a-z])green(?:$|[^a-z])|verde/iu, "verde"],
  [/黄色|(?:^|[^a-z])yellow(?:$|[^a-z])|giallo/iu, "giallo"],
  [/灰色|(?:^|[^a-z])gr[ae]y(?:$|[^a-z])|grigio/iu, "grigio"],
  [/银色|(?:^|[^a-z])silver(?:$|[^a-z])|argento/iu, "argento"],
  [/金色|(?:^|[^a-z])gold(?:$|[^a-z])|(?:^|[^a-z])oro(?:$|[^a-z])/iu, "oro"],
  [/透明|transparent|trasparente/iu, "trasparente"],
];

/**
 * Certificazioni e marchi di conformità richiesti nei fogli d'acquisto.
 * Sono requisiti obbligatori: un prodotto senza la certificazione richiesta
 * non è un'alternativa più economica, è un prodotto diverso.
 */
const CERTIFICATIONS: Array<[RegExp, string]> = [
  [/\bce\b(?!\s*ntr)/iu, "CE"],
  [/\brohs\b/iu, "ROHS"],
  [/\breach\b/iu, "REACH"],
  [/\bul\b/iu, "UL"],
  [/\bcsa\b/iu, "CSA"],
  [/\bfcc\b/iu, "FCC"],
  [/\batex\b/iu, "ATEX"],
  [/\bccc\b|3c认证/iu, "CCC"],
  [/\bgs\b/iu, "GS"],
  [/\btuv\b|\btüv\b/iu, "TUV"],
  [/\bfda\b/iu, "FDA"],
  [/\bsgs\b/iu, "SGS"],
  [/\bisо?\s*9001\b|\biso\s*9001\b/iu, "ISO9001"],
  [/\biso\s*14001\b/iu, "ISO14001"],
  [/\ben\s*71\b/iu, "EN71"],
];

/* -------------------------------------------------------------------------- */
/* Utilità                                                                     */
/* -------------------------------------------------------------------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Alternation delle unità, dalla più lunga alla più corta: senza questo
 * ordine `mm` verrebbe riconosciuto come `m` seguito da una `m` di troppo.
 */
function unitPattern(units: Record<string, number>): string {
  return Object.keys(units)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
}

function parseDecimal(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Trova la prima misura espressa con una delle unità date e la converte
 * nell'unità base. Le unità latine devono essere seguite da un confine: in
 * `220vac` la `v` è una tensione, in `variante` no.
 */
function findMeasure(
  text: string,
  units: Record<string, number>
): { value: number; source: string } | null {
  const pattern = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern(units)})(?![\\p{L}\\p{N}])`,
    "iu"
  );
  const match = text.match(pattern);
  if (!match) return null;
  const amount = parseDecimal(match[1]!);
  if (amount == null) return null;
  const factor = units[match[2]!.toLowerCase()];
  if (factor == null) return null;
  return { value: round(amount * factor), source: match[0].trim() };
}

/** `true` se il testo è prevalentemente in caratteri cinesi. */
export function detectLanguage(text: string): "zh" | "en" {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/giu)?.length ?? 0;
  return han > 0 && han * 2 >= latin ? "zh" : "en";
}

/* -------------------------------------------------------------------------- */
/* Estrazione                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExtractedRequirements {
  dimensions: Record<string, number>;
  power: number | null;
  voltage: number | null;
  capacity: number | null;
  material: string | null;
  certifications: string[];
  requiredVariant: Record<string, string | number>;
  requirements: ProductRequirement[];
}

/** Tolleranze ammesse per tipo di grandezza, in frazione del valore. */
const TOLERANCE = {
  dimension: 0.02,
  power: 0.05,
  voltage: 0.02,
  capacity: 0.05,
  weight: 0.05,
} as const;

function pushRequirement(
  requirements: ProductRequirement[],
  requirement: ProductRequirement
): void {
  if (requirements.some((existing) => existing.key === requirement.key)) return;
  requirements.push(requirement);
}

/**
 * Dimensioni etichettate: `长200*宽40`, `lunghezza 200mm`, `Ø50`, `H=30cm`.
 * L'etichetta vince sempre sulla posizione.
 */
function extractLabelledDimensions(
  text: string,
  dimensions: Record<string, number>,
  requirements: ProductRequirement[]
): void {
  const labels = Object.keys(DIMENSION_LABELS)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(
    `(${labels})\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern(LENGTH_UNITS)})?(?![\\p{L}\\p{N}])`,
    "giu"
  );

  for (const match of text.matchAll(pattern)) {
    const rawLabel = match[1]!;
    // Le etichette latine di una lettera (`l`, `w`, `h`) sono ambigue: `l 5`
    // può essere una lunghezza, ma `l` da sola in un titolo cinese no. Le
    // accettiamo solo quando il numero ha un'unità esplicita.
    if (/^[a-z]$/i.test(rawLabel) && !match[3]) continue;

    const key = DIMENSION_LABELS[rawLabel] ?? DIMENSION_LABELS[rawLabel.toLowerCase()];
    if (!key || dimensions[key] != null) continue;

    const amount = parseDecimal(match[2]!);
    if (amount == null) continue;
    const factor = match[3] ? (LENGTH_UNITS[match[3].toLowerCase()] ?? 1) : 1;
    dimensions[key] = round(amount * factor);
    pushRequirement(requirements, {
      key: `dimension.${key}`,
      kind: "hard",
      label: `Dimensione ${key}: ${dimensions[key]} mm`,
      value: dimensions[key]!,
      unit: "mm",
      tolerance: TOLERANCE.dimension,
      source: match[0].trim(),
    });
  }
}

/**
 * Misure composte senza etichette: `200*40*30`, `200x40`, `1200×600 mm`.
 * I valori vengono assegnati per posizione (lunghezza, larghezza, altezza),
 * che è l'ordine usato nei fogli reali.
 */
function extractPositionalDimensions(
  text: string,
  dimensions: Record<string, number>,
  requirements: ProductRequirement[]
): void {
  const pattern = new RegExp(
    `(\\d+(?:[.,]\\d+)?)(?:\\s*[*x×]\\s*(\\d+(?:[.,]\\d+)?))+\\s*(${unitPattern(LENGTH_UNITS)})?(?![\\p{L}\\p{N}])`,
    "giu"
  );

  for (const match of text.matchAll(pattern)) {
    const numbers = (match[0].match(/\d+(?:[.,]\d+)?/g) ?? [])
      .map(parseDecimal)
      .filter((value): value is number => value != null);
    if (numbers.length < 2) continue;

    const factor = match[3] ? (LENGTH_UNITS[match[3].toLowerCase()] ?? 1) : 1;
    numbers.slice(0, POSITIONAL_DIMENSIONS.length).forEach((amount, index) => {
      const key = POSITIONAL_DIMENSIONS[index]!;
      if (dimensions[key] != null) return;
      dimensions[key] = round(amount * factor);
      pushRequirement(requirements, {
        key: `dimension.${key}`,
        kind: "hard",
        label: `Dimensione ${key}: ${dimensions[key]} mm`,
        value: dimensions[key]!,
        unit: "mm",
        tolerance: TOLERANCE.dimension,
        source: match[0].trim(),
      });
    });
    // Una sola misura composta per richiesta: le successive sono in genere
    // dettagli di componenti secondari (imballo, staffe).
    break;
  }
}

/**
 * Filettature metriche: `M8*35` è una vite M8 lunga 35 mm, non una misura
 * 8 × 35. Va riconosciuta prima delle dimensioni posizionali.
 */
function extractThread(
  text: string,
  variant: Record<string, string | number>,
  dimensions: Record<string, number>,
  requirements: ProductRequirement[]
): string {
  const pattern = /(?:^|[^\p{L}\p{N}])(m\d+(?:[.,]\d+)?)(?:\s*[*x×]\s*(\d+(?:[.,]\d+)?))?(?![\p{L}\p{N}])/iu;
  const match = text.match(pattern);
  if (!match) return text;

  variant.thread = match[1]!.toLowerCase().replace(",", ".");
  pushRequirement(requirements, {
    key: "variant.thread",
    kind: "hard",
    label: `Filettatura ${variant.thread}`,
    value: variant.thread,
    unit: null,
    tolerance: null,
    source: match[0].trim(),
  });

  const length = match[2] ? parseDecimal(match[2]) : null;
  if (length != null && dimensions.length == null) {
    dimensions.length = round(length);
    pushRequirement(requirements, {
      key: "dimension.length",
      kind: "hard",
      label: `Dimensione length: ${dimensions.length} mm`,
      value: dimensions.length,
      unit: "mm",
      tolerance: TOLERANCE.dimension,
      source: match[0].trim(),
    });
  }
  // Il testo consumato viene tolto per non farlo rileggere come dimensione.
  return text.replace(match[0], " ");
}

/** Grado di protezione IP: requisito obbligatorio quando indicato. */
function extractProtection(
  text: string,
  variant: Record<string, string | number>,
  requirements: ProductRequirement[]
): void {
  const match = text.match(/\bip\s?(\d{2})\b/iu);
  if (!match) return;
  variant.protection = `ip${match[1]}`;
  pushRequirement(requirements, {
    key: "variant.protection",
    kind: "hard",
    label: `Grado di protezione IP${match[1]}`,
    value: variant.protection,
    unit: null,
    tolerance: null,
    source: match[0].trim(),
  });
}

/**
 * Estrae requisiti obbligatori e preferenze dal testo completo di una riga.
 *
 * @param text testo su cui cercare (nome + specifiche + note)
 */
export function extractRequirements(text: string): ExtractedRequirements {
  const normalized = (text ?? "").normalize("NFKC");
  const dimensions: Record<string, number> = {};
  const requiredVariant: Record<string, string | number> = {};
  const requirements: ProductRequirement[] = [];

  // La filettatura consuma il proprio testo: `M8*35` non deve poi diventare
  // una misura 8 × 35.
  const remaining = extractThread(
    normalized,
    requiredVariant,
    dimensions,
    requirements
  );

  extractLabelledDimensions(remaining, dimensions, requirements);
  extractPositionalDimensions(remaining, dimensions, requirements);

  const powerMeasure = findMeasure(remaining, POWER_UNITS);
  const power = powerMeasure?.value ?? null;
  if (powerMeasure) {
    pushRequirement(requirements, {
      key: "power",
      kind: "hard",
      label: `Potenza ${powerMeasure.value} W`,
      value: powerMeasure.value,
      unit: "W",
      tolerance: TOLERANCE.power,
      source: powerMeasure.source,
    });
  }

  const voltageMeasure = findMeasure(remaining, VOLTAGE_UNITS);
  const voltage = voltageMeasure?.value ?? null;
  if (voltageMeasure) {
    pushRequirement(requirements, {
      key: "voltage",
      kind: "hard",
      label: `Tensione ${voltageMeasure.value} V`,
      value: voltageMeasure.value,
      unit: "V",
      tolerance: TOLERANCE.voltage,
      source: voltageMeasure.source,
    });
  }

  // La capacità è un volume oppure una carica: l'unità va conservata, altrimenti
  // `5 l` e `5 Ah` finirebbero nella stessa impronta.
  const volumeMeasure = findMeasure(remaining, VOLUME_UNITS);
  const chargeMeasure = volumeMeasure
    ? null
    : findMeasure(remaining, CHARGE_UNITS);
  const capacityMeasure = volumeMeasure ?? chargeMeasure;
  const capacityUnit = volumeMeasure ? "l" : chargeMeasure ? "Ah" : null;
  if (capacityMeasure && capacityUnit) {
    requiredVariant.capacityUnit = capacityUnit;
    pushRequirement(requirements, {
      key: "capacity",
      kind: "hard",
      label: `Capacità ${capacityMeasure.value} ${capacityUnit}`,
      value: capacityMeasure.value,
      unit: capacityUnit,
      tolerance: TOLERANCE.capacity,
      source: capacityMeasure.source,
    });
  }

  const weightMeasure = findMeasure(remaining, WEIGHT_UNITS);
  if (weightMeasure) {
    requiredVariant.weightKg = weightMeasure.value;
    pushRequirement(requirements, {
      key: "variant.weightKg",
      kind: "soft",
      label: `Peso ${weightMeasure.value} kg`,
      value: weightMeasure.value,
      unit: "kg",
      tolerance: TOLERANCE.weight,
      source: weightMeasure.source,
    });
  }

  extractProtection(remaining, requiredVariant, requirements);

  let material: string | null = null;
  for (const [pattern, name] of MATERIALS) {
    const match = remaining.match(pattern);
    if (!match) continue;
    material = name;
    pushRequirement(requirements, {
      key: "material",
      kind: "hard",
      label: `Materiale ${name}`,
      value: name,
      unit: null,
      tolerance: null,
      source: match[0].trim(),
    });
    break;
  }

  for (const [pattern, name] of COLORS) {
    const match = remaining.match(pattern);
    if (!match) continue;
    requiredVariant.color = name;
    // Il colore è una preferenza: un prodotto giusto in un colore diverso
    // resta un candidato valido, spesso con variante selezionabile.
    pushRequirement(requirements, {
      key: "variant.color",
      kind: "soft",
      label: `Colore ${name}`,
      value: name,
      unit: null,
      tolerance: null,
      source: match[0].trim(),
    });
    break;
  }

  const certifications: string[] = [];
  for (const [pattern, name] of CERTIFICATIONS) {
    const match = remaining.match(pattern);
    if (!match || certifications.includes(name)) continue;
    certifications.push(name);
    pushRequirement(requirements, {
      key: `certification.${name}`,
      kind: "hard",
      label: `Certificazione ${name}`,
      value: name,
      unit: null,
      tolerance: null,
      source: match[0].trim(),
    });
  }

  return {
    dimensions,
    power,
    voltage,
    capacity: capacityMeasure?.value ?? null,
    material,
    certifications,
    requiredVariant,
    requirements,
  };
}

/**
 * Codice modello latino (`DJM-050-485`, `2HHS57-A-5/24`).
 *
 * È il segnale più affidabile fra lingue diverse — un codice non si traduce —
 * quindi vale la pena riconoscerlo anche dentro un testo cinese.
 */
export function extractModelCode(text: string): string | null {
  // Il codice può cominciare con una cifra (`2HHS57-A-5/24`) o con lettere
  // (`DJM-050-485`): si raccolgono i token misti e si scartano dopo quelli
  // che sono in realtà misure, filettature o sigle di certificazione.
  const candidates =
    (text ?? "")
      .normalize("NFKC")
      .match(/[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*/gu) ?? [];

  const measurePattern = new RegExp(
    `^\\d+(?:[.,]\\d+)?\\s*(?:${unitPattern({
      ...LENGTH_UNITS,
      ...POWER_UNITS,
      ...VOLTAGE_UNITS,
      ...VOLUME_UNITS,
      ...CHARGE_UNITS,
      ...WEIGHT_UNITS,
    })})$`,
    "iu"
  );

  for (const candidate of candidates) {
    if (candidate.length < 4) continue;
    // Un modello mescola lettere e cifre: senza entrambe è una parola o un
    // numero, non un codice.
    if (!/[A-Za-z]/.test(candidate) || !/\d/.test(candidate)) continue;
    if (measurePattern.test(candidate)) continue;
    if (/^m\d+$/i.test(candidate)) continue; // filettatura, già estratta
    // Sigle normative: sono certificazioni e gradi di protezione, non modelli.
    if (/^(?:ip\d{2}|iso\d+|en\d+|din\d+|ansi\d+)$/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}
