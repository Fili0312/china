/**
 * Il testo che Taobao mette negli appunti quando si condivide un prodotto.
 *
 * Nei fogli reali qualcuno incolla quel blocco al posto del nome, spesso in
 * una colonna qualsiasi:
 *
 * ```
 * 淘宝】https://e.tb.cn/h.RJsv…?tk=RYKTg7tY5yz CZ009
 * 「欧普护眼灯LED专业学习灯书桌学生宿舍充电便携台灯官方正品」
 * 点击链接直接打开 或者 淘宝搜索直接打开
 * ```
 *
 * Letto con la mappatura delle colonne, quella riga risulta **senza nome
 * prodotto** e viene saltata. È il peggior tipo di riga da perdere: contiene
 * il nome esatto del prodotto e il link a quello che il cliente ha già visto.
 *
 * Qui il blocco viene riconosciuto e ridotto alle due cose che contano: il
 * titolo fra le virgolette angolari e il link. Tutto il resto — l'invito ad
 * aprire il link, il codice di tracciamento `tk=`, la parola `淘宝】` —
 * sparisce, perché non descrive la merce.
 */

export interface TaobaoShareText {
  /** Titolo del prodotto, come lo scrive Taobao. */
  title: string | null;
  /** Link di condivisione (`e.tb.cn/…`) o link prodotto diretto. */
  url: string | null;
}

/** Domini che compaiono nei testi di condivisione Taobao. */
const TAOBAO_HOST = /(^|\/\/|\.)((e|m|s|item|detail)\.)?(tb\.cn|taobao\.com|tmall\.com)/i;

/**
 * Frasi di contorno del blocco di condivisione: non descrivono il prodotto e
 * finirebbero nella query.
 */
const NOISE = [
  /点击链接直接打开/g,
  /复制这条信息/g,
  /打开手机淘宝/g,
  /或者\s*淘宝搜索直接打开/g,
  /淘宝搜索直接打开/g,
  /^淘宝】/,
  /^【淘宝】/,
];

/**
 * Estrae titolo e link, oppure `null` se il testo non è una condivisione
 * Taobao.
 *
 * Deliberatamente prudente: senza un dominio Taobao **e** senza un titolo fra
 * virgolette angolari non si restituisce nulla. Meglio lasciare la riga
 * segnalata come «senza nome» che inventarle un prodotto partendo da una
 * frase qualsiasi.
 */
export function parseTaobaoShareText(value: string | null | undefined): TaobaoShareText | null {
  const text = (value ?? "").normalize("NFKC").trim();
  if (!text) return null;

  const looksLikeShare = TAOBAO_HOST.test(text) || text.includes("淘宝");
  if (!looksLikeShare) return null;

  const url = text.match(/https?:\/\/[^\s，,、）)】」』]+/i)?.[0] ?? null;
  if (url && !TAOBAO_HOST.test(url)) return null;

  // Il titolo sta fra virgolette angolari: 「…」 o 『…』. Taobao usa le prime.
  const quoted =
    text.match(/[「『]([^」』]{4,120})[」』]/)?.[1] ??
    // Alcune condivisioni usano le parentesi quadre piene dopo il link.
    text.match(/】\s*([^【】\n]{6,120}?)\s*(?:点击链接|https?:\/\/|$)/)?.[1] ??
    null;

  let title = quoted?.trim() ?? null;
  if (title) {
    for (const pattern of NOISE) title = title.replace(pattern, "").trim();
    // Un titolo che contiene un URL non è un titolo: è il ripiego che ha
    // agganciato il link invece del nome. Meglio nessun nome che un nome
    // fatto di indirizzo e codice di tracciamento.
    if (/https?:\/\/|:\/\//.test(title) || title.length < 4) title = null;
  }

  if (!title && !url) return null;
  return { title, url };
}

/**
 * Cerca una condivisione Taobao fra le celle di una riga.
 *
 * Si guarda in **tutte** le celle e non solo in quelle mappate: il blocco
 * viene incollato dove capita — nelle note, nel nome, in una colonna senza
 * intestazione — ed è proprio il caso in cui la mappatura non aiuta.
 */
export function findShareInRow(cells: readonly string[]): TaobaoShareText | null {
  for (const cell of cells) {
    const parsed = parseTaobaoShareText(cell);
    if (parsed?.title) return parsed;
  }
  // Nessun titolo: si accetta almeno il link, che resta un candidato valido.
  for (const cell of cells) {
    const parsed = parseTaobaoShareText(cell);
    if (parsed?.url) return parsed;
  }
  return null;
}
