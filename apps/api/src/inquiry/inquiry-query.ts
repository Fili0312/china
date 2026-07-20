/**
 * Costruisce la query di ricerca a partire dal testo cinese originale della
 * richiesta (品名 + 规格型号).
 *
 * Il principio è di non tradurre: il nome prodotto, il modello, le misure, le
 * tensioni e i materiali restano esattamente come li ha scritti chi compila il
 * foglio. Una traduzione in italiano seguita da una riconversione in cinese
 * perderebbe proprio i codici e le specifiche che rendono la ricerca precisa.
 *
 * Vengono tolte solo le parole amministrative (reparto, richiedente, centro di
 * costo) e le quantità di confezionamento: quantità richiesta, fornitore e
 * data non entrano mai nella query perché arrivano da colonne che questo
 * modulo non legge.
 */

/** Lunghezza massima accettata da ProductSearchQuerySchema. */
const MAX_QUERY_LENGTH = 200;

/**
 * Etichette amministrative dei fogli di richiesta. Se il testo incollato le
 * contiene ancora (`申请部门：物流部`) vanno tolte con il loro valore.
 */
const ADMIN_LABELS = [
  "申请部门",
  "申请人",
  "成本中心",
  "部门经理签字",
  "采购类型",
  "采购日期",
  "申请日期",
  "供应商",
  "申请数量",
  "现有库存",
  "含税总金额",
  "含税单价",
  "部门",
  "序号",
  "用途",
  "备注",
] as const;

/** Etichette di campo che introducono il contenuto utile: si tolgono da sole. */
const CONTENT_LABELS = ["品名", "规格型号", "规格", "型号", "名称"] as const;

/**
 * Quantificatori cinesi usati per il confezionamento (`M8*35-20个`).
 * Deliberatamente esclusi 层/米/mm/KG e simili: sono misure, non quantità.
 */
const COUNT_UNITS = "个|套|只|张|片|卷|条|支|把|件|双|盒|包|袋|组|对|付|台|根";

const CHINESE_DIGITS = "零一二三四五六七八九十百千万两";

const COUNT_TOKEN = new RegExp(
  `^(?:\\d+(?:[.,]\\d+)?|[${CHINESE_DIGITS}]+)\\s*(?:${COUNT_UNITS})$`,
  "u"
);

const COUNT_SUFFIX = new RegExp(
  `[-/]\\s*(?:\\d+(?:[.,]\\d+)?|[${CHINESE_DIGITS}]+)\\s*(?:${COUNT_UNITS})$`,
  "u"
);

export interface BuiltInquiryQuery {
  /** Query cinese finale, usata così com'è sui marketplace. */
  query: string;
  /** Pezzi uniti per comporre la query, nell'ordine originale. */
  parts: string[];
  /** Termini amministrativi o di quantità rimossi, mostrati in interfaccia. */
  dropped: string[];
}

/**
 * Riduce a spazio la punteggiatura che separa le specifiche, conservando i
 * caratteri che fanno parte di codici e misure (`-`, `*`, `/`, `.`, `+`, `×`).
 *
 * `NN100-200（不带电机）` → `NN100-200 不带电机`
 * `2HHS57-A-5/24` resta intatto: la barra è parte del modello.
 */
function normalizeSeparators(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\r\n\t]+/g, " ")
    // Virgole, punti e virgola, due punti e parentesi di ogni larghezza.
    .replace(/[,;:、，；：]/g, " ")
    .replace(/[()（）[\]【】{}｛｝「」『』〈〉《》"'“”‘’]/g, " ")
    // Decorazioni copiate dai titoli dei marketplace (⭐, emoji): non sono
    // codici né specifiche e restringono la ricerca senza motivo.
    .replace(/[\p{Extended_Pictographic}←-⇿☀-➿️]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Toglie `etichetta：valore` per le etichette amministrative. */
function stripAdminLabels(value: string, dropped: string[]): string {
  let output = value;
  for (const label of ADMIN_LABELS) {
    const labelled = new RegExp(`${label}\\s*[:：]\\s*\\S*`, "gu");
    output = output.replace(labelled, (match) => {
      dropped.push(match.trim());
      return " ";
    });
  }
  return output;
}

/** Toglie `品名：` e simili lasciando il valore che introducono. */
function stripContentLabels(value: string): string {
  let output = value;
  for (const label of CONTENT_LABELS) {
    output = output.replace(new RegExp(`${label}\\s*[:：]\\s*`, "gu"), " ");
  }
  return output;
}

/**
 * Toglie le quantità di confezionamento: `20个` da solo, oppure il suffisso
 * `-20个` / `/一千个` attaccato a un codice. Le misure restano intatte perché
 * la loro unità non compare fra i quantificatori.
 */
function stripPackagingCount(token: string, dropped: string[]): string | null {
  if (COUNT_TOKEN.test(token)) {
    dropped.push(token);
    return null;
  }
  const suffix = token.match(COUNT_SUFFIX);
  if (suffix) {
    const stripped = token.slice(0, token.length - suffix[0].length);
    // Uno scarto che svuota il token significa che era solo una quantità.
    if (!stripped) {
      dropped.push(token);
      return null;
    }
    dropped.push(suffix[0].replace(/^[-/]\s*/u, ""));
    return stripped;
  }
  return token;
}

/** Trasforma un campo del foglio nei suoi token di ricerca. */
function tokenizeField(value: string, dropped: string[]): string[] {
  if (!value) return [];
  const cleaned = normalizeSeparators(
    stripContentLabels(stripAdminLabels(value, dropped))
  );
  if (!cleaned) return [];

  const tokens: string[] = [];
  for (const raw of cleaned.split(" ")) {
    const token = raw.trim();
    if (!token) continue;
    if ((ADMIN_LABELS as readonly string[]).includes(token)) {
      dropped.push(token);
      continue;
    }
    const kept = stripPackagingCount(token, dropped);
    if (kept) tokens.push(kept);
  }
  return tokens;
}

/**
 * Compone la query cinese di una riga di richiesta.
 *
 * L'ordine è quello che un venditore cinese si aspetta: prima il nome
 * prodotto, poi specifiche, modello, misure e materiale così come sono scritti
 * nella colonna 规格型号.
 */
export function buildInquiryQuery(
  name: string,
  spec: string
): BuiltInquiryQuery {
  const dropped: string[] = [];
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const token of [
    ...tokenizeField(name, dropped),
    ...tokenizeField(spec, dropped),
  ]) {
    // Un termine ripetuto fra 品名 e 规格型号 non aggiunge informazione, ma
    // restringe inutilmente la ricerca su alcuni motori.
    const key = token.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(token);
  }

  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const addition = kept.length ? part.length + 1 : part.length;
    if (length + addition > MAX_QUERY_LENGTH) break;
    kept.push(part);
    length += addition;
  }

  return {
    query: kept.join(" "),
    parts: kept,
    dropped: [...new Set(dropped)],
  };
}

/**
 * Ripulisce il titolo del prodotto di riferimento riportato nel file, che
 * arriva con il suffisso del marketplace (`…-tmall.com天猫`, `…-淘宝网`).
 */
export function cleanReferenceTitle(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s*-\s*(?:tmall\.com天猫|tmall\.com|天猫|淘宝网|taobao\.com|阿里巴巴|1688\.com|京东|jd\.com)\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}
