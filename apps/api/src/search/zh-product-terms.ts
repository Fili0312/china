/**
 * Traduzione dei termini prodotto dal cinese all'inglese.
 *
 * Serve a due cose diverse, ed è importante distinguerle:
 *
 * 1. **Costruire la query** per Alibaba e AliExpress, che sono cataloghi
 *    export e non indicizzano il cinese. Mandarglielo com'è non dà «zero
 *    risultati»: Piloterr risponde 500.
 * 2. **Verificare i titoli inglesi** delle fonti cinesi che traducono le
 *    schede (Chinagoods). Lì la query resta in cinese — il sito la capisce —
 *    ma i titoli tornano in inglese, e senza questi termini non c'è modo di
 *    dire se un risultato è pertinente.
 *
 * Nessuna IA: un dizionario esplicito è verificabile e dà lo stesso risultato
 * fra sei mesi. Ciò che non è nel dizionario **non viene tradotto a caso**:
 * viene dichiarato non traducibile, e il motore che richiede l'inglese viene
 * saltato con una motivazione invece di ricevere una query inventata.
 *
 * `required` elenca le parole che il titolo di un prodotto **deve** contenere
 * per essere dello stesso tipo. Sono meno di quelle di `en`: «flat panel
 * light» accetta anche «office panel light», ma non «LED strip light».
 */

export interface ProductTerm {
  /** Termine cinese, come compare nei fogli di richiesta. */
  zh: string;
  /** Resa inglese usata nella query. */
  en: string;
  /**
   * Parole che identificano il tipo di prodotto. Un titolo che non le contiene
   * tutte è un altro prodotto. Se assente vale `en` intero.
   *
   * Una voce può elencare alternative separate da `|`: `antistatic|esd|anti`
   * accetta le diverse forme con cui i cataloghi scrivono la stessa cosa.
   */
  required?: string[];
  /** `true` per aggettivi e materiali: non sono il tipo di prodotto. */
  modifier?: boolean;
}

/**
 * Dizionario dei termini incontrati nei fogli reali (richieste industriali e
 * d'ufficio). Va esteso quando compaiono prodotti nuovi: l'alternativa —
 * indovinare — produrrebbe ricerche sbagliate senza dirlo.
 */
export const PRODUCT_TERMS: readonly ProductTerm[] = [
  // --- Illuminazione ---
  { zh: "平板灯", en: "flat panel light", required: ["panel", "light"] },
  { zh: "面板灯", en: "panel light", required: ["panel", "light"] },
  { zh: "筒灯", en: "downlight", required: ["downlight"] },
  { zh: "射灯", en: "spotlight", required: ["spotlight"] },
  { zh: "灯管", en: "tube light", required: ["tube"] },
  { zh: "灯带", en: "led strip light", required: ["strip"] },
  { zh: "台灯", en: "desk lamp", required: ["desk", "lamp"] },
  { zh: "投光灯", en: "flood light", required: ["flood", "light"] },
  { zh: "灯泡", en: "light bulb", required: ["bulb"] },

  // --- Arredo tecnico e postazioni ---
  { zh: "防静电椅", en: "esd antistatic chair", required: ["chair", "antistatic|esd|antistatik|static"] },
  { zh: "防静电凳", en: "esd antistatic stool", required: ["stool", "antistatic|esd|static"] },
  { zh: "防静电台垫", en: "esd antistatic table mat", required: ["mat", "antistatic|esd|static"] },
  { zh: "台垫", en: "table mat", required: ["mat"] },
  { zh: "工作台", en: "workbench", required: ["workbench"] },
  { zh: "货架", en: "storage shelving rack", required: ["rack"] },
  { zh: "凳子", en: "stool", required: ["stool"] },
  { zh: "椅子", en: "chair", required: ["chair"] },
  { zh: "桌子", en: "table", required: ["table"] },
  { zh: "柜子", en: "cabinet", required: ["cabinet"] },
  { zh: "推车", en: "trolley cart", required: ["cart"] },

  // --- Componenti meccanici ---
  { zh: "轴承", en: "bearing", required: ["bearing"] },
  { zh: "螺丝", en: "screw", required: ["screw"] },
  { zh: "螺钉", en: "screw", required: ["screw"] },
  { zh: "螺母", en: "nut", required: ["nut"] },
  { zh: "垫圈", en: "washer", required: ["washer"] },
  { zh: "弹簧", en: "spring", required: ["spring"] },
  { zh: "拖链", en: "cable drag chain", required: ["drag", "chain"] },
  { zh: "导轨", en: "linear guide rail", required: ["rail"] },
  { zh: "皮带", en: "belt", required: ["belt"] },
  { zh: "齿轮", en: "gear", required: ["gear"] },
  { zh: "针规", en: "pin gauge", required: ["pin", "gauge"] },
  { zh: "量规", en: "gauge", required: ["gauge"] },

  // --- Pneumatica e fluidi ---
  { zh: "气动接头", en: "pneumatic fitting", required: ["pneumatic", "fitting"] },
  { zh: "快插接头", en: "quick connector fitting", required: ["fitting"] },
  { zh: "气缸", en: "pneumatic cylinder", required: ["cylinder"] },
  { zh: "电磁阀", en: "solenoid valve", required: ["solenoid", "valve"] },
  { zh: "阀门", en: "valve", required: ["valve"] },
  { zh: "水泵", en: "water pump", required: ["pump"] },
  { zh: "过滤器", en: "filter", required: ["filter"] },
  { zh: "密封圈", en: "seal ring", required: ["seal"] },
  { zh: "软管", en: "hose", required: ["hose"] },

  // --- Elettrico ed elettronico ---
  { zh: "电机", en: "electric motor", required: ["motor"] },
  { zh: "马达", en: "motor", required: ["motor"] },
  { zh: "驱动器", en: "driver", required: ["driver"] },
  { zh: "传感器", en: "sensor", required: ["sensor"] },
  { zh: "开关", en: "switch", required: ["switch"] },
  { zh: "继电器", en: "relay", required: ["relay"] },
  { zh: "断路器", en: "circuit breaker", required: ["breaker"] },
  { zh: "电源", en: "power supply", required: ["power", "supply"] },
  { zh: "变压器", en: "transformer", required: ["transformer"] },
  { zh: "工业插头", en: "industrial plug", required: ["plug"] },
  { zh: "插座", en: "socket outlet", required: ["socket"] },
  { zh: "接线端子", en: "terminal block", required: ["terminal"] },
  { zh: "电缆", en: "cable", required: ["cable"] },
  { zh: "电线", en: "wire", required: ["wire"] },
  { zh: "风扇", en: "fan", required: ["fan"] },
  { zh: "散热器", en: "heat sink", required: ["heat", "sink"] },
  { zh: "接线盒", en: "junction box", required: ["junction", "box"] },
  { zh: "防盗锁", en: "anti theft lock", required: ["lock"] },
  { zh: "电动车", en: "electric bike", required: ["bike"] },

  // --- Consumabili e protezione ---
  { zh: "手套", en: "gloves", required: ["glove"] },
  { zh: "口罩", en: "face mask", required: ["mask"] },
  { zh: "胶带", en: "adhesive tape", required: ["tape"] },
  { zh: "标签", en: "label", required: ["label"] },
  { zh: "打印机", en: "printer", required: ["printer"] },
  { zh: "显示器", en: "monitor", required: ["monitor"] },
  { zh: "键盘", en: "keyboard", required: ["keyboard"] },
  { zh: "鼠标", en: "mouse", required: ["mouse"] },
  { zh: "电池", en: "battery", required: ["battery"] },
  { zh: "充电宝", en: "power bank", required: ["power", "bank"] },

  // --- Modificatori: descrivono, non identificano ---
  { zh: "防静电", en: "antistatic esd", modifier: true },
  { zh: "不锈钢", en: "stainless steel", modifier: true },
  { zh: "碳钢", en: "carbon steel", modifier: true },
  { zh: "铝合金", en: "aluminum alloy", modifier: true },
  { zh: "塑料", en: "plastic", modifier: true },
  { zh: "橡胶", en: "rubber", modifier: true },
  { zh: "硅胶", en: "silicone", modifier: true },
  { zh: "尼龙", en: "nylon", modifier: true },
  { zh: "工业", en: "industrial", modifier: true },
  { zh: "车间", en: "workshop", modifier: true },
  { zh: "实验室", en: "laboratory", modifier: true },
  { zh: "无尘", en: "cleanroom", modifier: true },
  { zh: "升降", en: "height adjustable", modifier: true },
  { zh: "可调", en: "adjustable", modifier: true },
  { zh: "旋转", en: "swivel", modifier: true },
  { zh: "加厚", en: "thickened", modifier: true },
  { zh: "黑色", en: "black", modifier: true },
  { zh: "白色", en: "white", modifier: true },
  { zh: "红色", en: "red", modifier: true },
  { zh: "蓝色", en: "blue", modifier: true },
  { zh: "绿色", en: "green", modifier: true },
  { zh: "黄色", en: "yellow", modifier: true },
  { zh: "灰色", en: "grey", modifier: true },
  { zh: "银色", en: "silver", modifier: true },
  { zh: "防水", en: "waterproof", modifier: true },
  { zh: "户外", en: "outdoor", modifier: true },
];

/**
 * Traduzioni delle parole-tipo nelle lingue in cui i cataloghi export
 * pubblicano i titoli.
 *
 * Serve per un motivo concreto: da questo server AliExpress geolocalizza e
 * restituisce titoli in **francese** («Panneau lumineux LED 60x60»). Senza
 * queste corrispondenze il filtro sul tipo di prodotto scarterebbe risultati
 * corretti solo perché scritti in un'altra lingua.
 *
 * Non è una traduzione automatica: sono le parole-tipo del dizionario qui
 * sopra, elencate a mano. Una parola non presente resta confrontata solo in
 * inglese.
 */
const TYPE_ALIASES: Record<string, readonly string[]> = {
  panel: ["panneau", "panneaux", "painel", "panel", "pannello", "paneel"],
  light: ["lumiere", "lumineux", "luz", "luce", "licht", "luminaire"],
  lamp: ["lampe", "lampara", "lampada", "lampe"],
  bulb: ["ampoule", "bombilla", "lampadina", "gluhbirne"],
  chair: ["chaise", "silla", "sedia", "stuhl", "cadeira"],
  stool: ["tabouret", "taburete", "sgabello", "hocker"],
  mat: ["tapis", "alfombrilla", "tappetino", "matte"],
  table: ["tavolo", "mesa", "tisch"],
  rack: ["etagere", "estanteria", "scaffale", "regal"],
  cabinet: ["armoire", "armario", "armadio", "schrank"],
  cart: ["chariot", "carrito", "carrello", "wagen"],
  bearing: ["roulement", "rodamiento", "cuscinetto", "lager"],
  screw: ["vis", "tornillo", "vite", "schraube"],
  nut: ["ecrou", "tuerca", "dado", "mutter"],
  washer: ["rondelle", "arandela", "rondella", "scheibe"],
  spring: ["ressort", "resorte", "molla", "feder"],
  chain: ["chaine", "cadena", "catena", "kette"],
  rail: ["glissiere", "guia", "guida", "schiene"],
  belt: ["courroie", "correa", "cinghia", "riemen"],
  gear: ["engrenage", "engranaje", "ingranaggio", "zahnrad"],
  motor: ["moteur", "motor", "motore"],
  sensor: ["capteur", "sensor", "sensore"],
  switch: ["interrupteur", "interruptor", "interruttore", "schalter"],
  relay: ["relais", "rele", "rele"],
  valve: ["vanne", "valvula", "valvola", "ventil"],
  pump: ["pompe", "bomba", "pompa", "pumpe"],
  filter: ["filtre", "filtro", "filter"],
  hose: ["tuyau", "manguera", "tubo", "schlauch"],
  cable: ["cable", "cavo", "kabel"],
  wire: ["fil", "alambre", "filo", "draht"],
  fan: ["ventilateur", "ventilador", "ventola", "lufter"],
  plug: ["prise", "enchufe", "spina", "stecker"],
  socket: ["prise", "enchufe", "presa", "steckdose"],
  battery: ["batterie", "bateria", "batteria", "akku"],
  glove: ["gant", "guante", "guanto", "handschuh"],
  mask: ["masque", "mascarilla", "maschera", "maske"],
  tape: ["ruban", "cinta", "nastro", "klebeband"],
  printer: ["imprimante", "impresora", "stampante", "drucker"],
  monitor: ["ecran", "pantalla", "schermo", "bildschirm"],
  keyboard: ["clavier", "teclado", "tastiera", "tastatur"],
  lock: ["serrure", "cerradura", "serratura", "schloss"],
  box: ["boite", "caja", "scatola", "kasten"],
  antistatic: ["antistatique", "antiestatico", "antistatico", "antistatisch"],
};

/** Parole troppo generiche per identificare da sole un tipo di prodotto. */
const GENERIC_WORDS = new Set([
  "led",
  "light",
  "industrial",
  "electric",
  "steel",
  "plastic",
  "set",
  "kit",
  "type",
  "new",
]);

const SORTED_TERMS = [...PRODUCT_TERMS].sort(
  (left, right) => right.zh.length - left.zh.length
);

export interface TranslatedQuery {
  /** Query inglese da inviare ai cataloghi export. */
  english: string;
  /**
   * Parole che il titolo di un prodotto deve contenere tutte per essere dello
   * stesso tipo. Vuoto quando il tipo non è stato riconosciuto.
   */
  requiredTerms: string[];
  /** Termini cinesi non presenti nel dizionario. */
  untranslated: string[];
  /** `true` se è stato riconosciuto almeno un tipo di prodotto. */
  hasProductType: boolean;
}

/**
 * Estrae misure e codici, che non si traducono mai.
 *
 * `60*60` diventa `60x60`: è la stessa misura scritta come la scrivono i
 * cataloghi inglesi, non una conversione. Modelli come `NPT0-A1`, `M3*5` e
 * `2HHS57-A-5/24` restano identici.
 */
function extractLatinParts(text: string): string[] {
  const parts: string[] = [];
  const pattern = /[A-Za-z0-9]+(?:[./\-*×x+][A-Za-z0-9]+)*/gu;
  for (const match of text.match(pattern) ?? []) {
    // Un numero isolato senza contesto non aiuta la ricerca inglese.
    if (/^\d{1,2}$/.test(match)) continue;
    parts.push(match.replace(/[*×]/g, "x"));
  }
  return parts;
}

/**
 * Costruisce la query inglese e i termini di verifica a partire dal cinese.
 */
export function translateChineseQuery(query: string): TranslatedQuery {
  const text = (query ?? "").normalize("NFKC");
  const productWords: string[] = [];
  const modifierWords: string[] = [];
  const requiredTerms: string[] = [];
  const untranslated: string[] = [];

  // Scansione dal termine più lungo al più corto: 防静电台垫 prima di 台垫,
  // altrimenti «tappetino antistatico» diventerebbe un tappetino qualsiasi.
  let remaining = text;
  for (const term of SORTED_TERMS) {
    if (!remaining.includes(term.zh)) continue;
    remaining = remaining.split(term.zh).join(" ");
    if (term.modifier) {
      modifierWords.push(term.en);
      continue;
    }
    productWords.push(term.en);
    for (const word of term.required ?? term.en.split(" ")) {
      if (!requiredTerms.includes(word)) requiredTerms.push(word);
    }
  }

  // Ciò che resta in caratteri Han non è stato riconosciuto.
  for (const leftover of remaining.match(/\p{Script=Han}+/gu) ?? []) {
    untranslated.push(leftover);
  }

  const latinParts = extractLatinParts(text);
  const english = [...productWords, ...modifierWords, ...latinParts]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return {
    english,
    // I termini generici non bastano a distinguere un prodotto da un altro.
    requiredTerms: requiredTerms.filter((word) => !GENERIC_WORDS.has(word)),
    untranslated,
    hasProductType: productWords.length > 0,
  };
}

/**
 * Verifica che un titolo appartenga al tipo di prodotto richiesto.
 *
 * È il controllo che distingue «LED flat panel light 600x600» da «RGB LED
 * strip»: il secondo non contiene `panel`, quindi è un altro prodotto, non un
 * prodotto meno pertinente.
 */
export function titleMatchesProductType(
  title: string,
  requiredTerms: readonly string[]
): { matches: boolean; missing: string[] } {
  if (requiredTerms.length === 0) return { matches: true, missing: [] };

  const normalized = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const present = (word: string): boolean =>
    // Confronto su parola intera, tollerando il plurale inglese.
    normalized.includes(` ${word} `) ||
    normalized.includes(` ${word}s `) ||
    normalized.includes(` ${word}es `);

  const missing = requiredTerms.filter((term) => {
    // Le alternative valgono l'una per l'altra: basta che ce ne sia una,
    // in inglese o in una delle lingue in cui la fonte pubblica i titoli.
    const options = term
      .toLowerCase()
      .split("|")
      .filter(Boolean)
      .flatMap((word) => [word, ...(TYPE_ALIASES[word] ?? [])]);
    return !options.some(present);
  });
  return { matches: missing.length === 0, missing };
}
