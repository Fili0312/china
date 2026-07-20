import type { SearchEngine } from "@china/shared";

export interface PlannedSearchQuery {
  original: string;
  providerQuery: string;
  changed: boolean;
}

const TRANSLATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:batteria esterna|caricabatterie portatile|caricatore portatile)\b/gi, "power bank"],
  [/\b(?:powerbank|power-bank)\b/gi, "power bank"],
  [/\b(?:custodia|cover)\s+(?:per\s+)?(?:telefono|smartphone|cellulare)\b/gi, "phone case"],
  [/\b(?:custodia|cover)\s+(?=(?:iphone|samsung|xiaomi|huawei)\b)/gi, "phone case "],
  [/\bpenna\s+a\s+sfera\b/gi, "ballpoint pen"],
  [/\b(?:borraccia|bottiglia\s+termica)\b/gi, "water bottle"],
  [/\btazza\b/gi, "mug"],
  [/\bzaino\b/gi, "backpack"],
  [/\bportachiavi\b/gi, "keychain"],
  [/\bmaglietta\b/gi, "t-shirt"],
  [/\b(?:auricolari|cuffiette)\b/gi, "earbuds"],
  [/\bcuffie\b/gi, "headphones"],
  [/\bcaricatore\b/gi, "charger"],
  [/\bcavo\b/gi, "cable"],
  [/\bombrello\b/gi, "umbrella"],
  [/\bborsa\b/gi, "bag"],
  [/\bscarpe\b/gi, "shoes"],
  [/\bpeluche\b/gi, "plush toy"],
  [/\bgiocattolo\b/gi, "toy"],
  [/\bpenna\b/gi, "pen"],
  [/\bacciaio\s+inossidabile\b/gi, "stainless steel"],
  [/\bceramica\b/gi, "ceramic"],
  [/\bsilicone\b/gi, "silicone"],
  [/\bpelle\b/gi, "leather"],
  [/\bcotone\b/gi, "cotton"],
  [/\bimpermeabil[ei]\b/gi, "waterproof"],
  [/\bpersonalizzat[oaie]\b/gi, "custom"],
  [/\bricarica\s+rapida\b/gi, "fast charging"],
  [/\bbianc[oaie]\b/gi, "white"],
  [/\bner[oaie]\b/gi, "black"],
  [/\bross[oaie]\b/gi, "red"],
  [/\bverd[ei]\b/gi, "green"],
  [/\bgiall[oaie]\b/gi, "yellow"],
  [/\bargentat[oaie]\b/gi, "silver"],
  [/\bdorat[oaie]\b/gi, "gold"],
];

/**
 * Produce una query inglese stabile per i cataloghi internazionali.
 * Non inventa attributi: traduce soltanto termini noti e rende confrontabili
 * unità/specifiche che i motori spesso indicizzano senza spazi.
 */
export function planSearchQuery(
  query: string,
  engine: SearchEngine
): PlannedSearchQuery {
  const original = query.trim().replace(/\s+/g, " ");

  // Una query già in cinese arriva ai marketplace così com'è. Tradurla verso
  // l'inglese (o passare da un'altra lingua e riconvertirla) perderebbe codici
  // prodotto, modelli, misure, tensioni e materiali, che sono esattamente ciò
  // che rende precisa una ricerca su uno store cinese.
  if (/\p{Script=Han}/u.test(original)) {
    const verbatim = original.slice(0, 200);
    return {
      original,
      providerQuery: verbatim,
      changed: verbatim !== original,
    };
  }

  let planned = original.normalize("NFKC");

  // Separatore delle migliaia davanti a unità tecniche: 10.000 mAh → 10000mAh.
  planned = planned.replace(
    /(\d)\s*[.,]\s*(\d{3})(?=\s*(?:m\s*ah|mah|w|wh|v|ml|l|gb|tb|mm|cm)\b)/gi,
    "$1$2"
  );
  planned = planned.replace(/(\d)\s+(\d{3})(?=\s*(?:m\s*ah|mah)\b)/gi, "$1$2");
  planned = planned.replace(/\b(\d+(?:[.,]\d+)?)\s*k\s*(?:m\s*ah|mah)\b/gi, (_, raw: string) => {
    const value = Number(raw.replace(",", "."));
    return Number.isFinite(value) ? `${Math.round(value * 1000)}mAh` : _;
  });
  planned = planned.replace(/\b(\d+)\s*(?:m\s*ah|mah)\b/gi, "$1mAh");

  for (const [pattern, replacement] of TRANSLATIONS) {
    planned = planned.replace(pattern, replacement);
  }

  planned = planned
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:])/g, "$1")
    .trim()
    .slice(0, 200);

  // L'indice Storage OTAPI è sensibile alla forma della keyword: nelle prove
  // live `powerbank 10000 mah` restituisce il catalogo completo, mentre
  // `power bank 10000mAh` produce soltanto pochi record storici. I cataloghi
  // internazionali, al contrario, comprendono meglio la forma inglese estesa.
  if (engine === "taobao" || engine === "tmall") {
    planned = planned
      .replace(/\bpower bank\b/gi, "powerbank")
      .replace(/\b(\d+)mAh\b/g, "$1 mah");
  }

  return {
    original,
    providerQuery: planned,
    changed: planned.toLocaleLowerCase() !== original.toLocaleLowerCase(),
  };
}
