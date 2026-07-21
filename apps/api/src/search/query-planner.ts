import type { SearchEngine } from "@china/shared";
import { translateChineseQuery } from "./zh-product-terms";

/**
 * Motori che indicizzano **solo** l'inglese: sono cataloghi export.
 * Mandare loro una query cinese non produce «zero risultati» ma un errore
 * della fonte (Piloterr risponde 500 su Alibaba).
 */
const ENGLISH_ONLY_ENGINES = new Set<SearchEngine>(["alibaba", "aliexpress"]);

export interface PlannedSearchQuery {
  original: string;
  providerQuery: string;
  changed: boolean;
  /**
   * Parole che il titolo di un prodotto deve contenere per essere dello stesso
   * tipo. Valorizzate quando la richiesta è cinese: servono a verificare anche
   * i titoli inglesi delle fonti che traducono le schede (Chinagoods).
   */
  requiredTerms: string[];
  /**
   * Valorizzato quando il motore richiede l'inglese ma la richiesta cinese non
   * è traducibile: il chiamante deve saltare la fonte con questa motivazione,
   * invece di inviare una query che farà fallire la ricerca.
   */
  untranslatable: string | null;
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
    const translated = translateChineseQuery(original);

    if (ENGLISH_ONLY_ENGINES.has(engine)) {
      // Alibaba e AliExpress sono cataloghi export: ricevono l'inglese.
      // Modelli, codici e misure restano invariati, sono l'unico segnale che
      // sopravvive intatto al cambio di lingua.
      if (!translated.hasProductType || !translated.english) {
        return {
          original,
          providerQuery: original.slice(0, 200),
          changed: false,
          requiredTerms: translated.requiredTerms,
          untranslatable:
            `Richiesta in cinese non traducibile per questo catalogo: ` +
            `${translated.untranslated.join(", ") || original}. ` +
            "Aggiungi il termine al dizionario prodotti oppure usa le fonti cinesi.",
        };
      }
      return {
        original,
        providerQuery: translated.english,
        changed: true,
        requiredTerms: translated.requiredTerms,
        untranslatable: null,
      };
    }

    // Le fonti cinesi ricevono il testo originale: lo capiscono, e tradurlo
    // perderebbe codici, modelli e misure. I termini inglesi servono comunque
    // a verificare i titoli, che alcune di queste fonti pubblicano tradotti.
    const verbatim = original.slice(0, 200);
    return {
      original,
      providerQuery: verbatim,
      changed: verbatim !== original,
      requiredTerms: translated.requiredTerms,
      untranslatable: null,
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
    // Una richiesta già in inglese si confronta parola per parola: non serve
    // un elenco di termini obbligatori separato.
    requiredTerms: [],
    untranslatable: null,
  };
}
