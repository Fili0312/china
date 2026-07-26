import type { BrowserContext, Page } from "playwright";
import { getBrowser } from "../browser";

/**
 * Ricerca su Taobao con la sessione dell'utente.
 *
 * `s.taobao.com` non risponde a chi non ha fatto il login: senza sessione la
 * ricerca web non esiste, e il catalogo resta raggiungibile solo via API. Con
 * la sessione, invece, si vede quello che vede un compratore cinese — prezzo
 * reale, prezzo della variante, vendite, negozio.
 *
 * Tre regole, e sono vincoli di progetto, non dettagli:
 *
 * 1. **Il login lo fa l'utente.** Qui arrivano solo i cookie di una sessione
 *    già autenticata. Niente password, niente SMS, niente captcha: non c'è un
 *    parametro in cui possano entrare.
 * 2. **Nessun aggiramento delle verifiche.** Se Taobao mostra un controllo
 *    anti-bot o rimanda al login, la ricerca si ferma e lo dice. Non si tenta
 *    di risolverlo, di simularlo o di ripetere la richiesta per sfinimento.
 * 3. **I cookie non escono da qui.** Vengono usati per creare il contesto del
 *    browser e non vengono mai scritti nei log né restituiti.
 *
 * I selettori della pagina risultati cambiano spesso e sono offuscati: la
 * lettura parte dai link prodotto — che restano `item.htm?id=…` — e ricava il
 * resto dal testo della scheda che li contiene. È meno preciso di un selettore
 * dedicato ed è di proposito: sopravvive a un rinnovo del markup, che con i
 * selettori esatti azzererebbe i risultati.
 */

/** Prodotto letto dalla pagina risultati. */
export interface TaobaoBrowserProduct {
  itemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  /** Prezzo della variante quando la scheda ne mostra uno diverso. */
  variantPrice: number | null;
  shopName: string | null;
  shopUrl: string | null;
  totalSales: number | null;
  reviewCount: number | null;
  location: string | null;
  /** Spedizione interna dichiarata nella scheda (`包邮`, `运费 8`). */
  shipping: string | null;
}

export interface TaobaoBrowserResult {
  products: TaobaoBrowserProduct[];
  /** Query realmente inviata: può differire da quella richiesta. */
  queryUsed: string;
}

/** Codici d'errore che il chiamante distingue per decidere cosa fare. */
export type TaobaoBrowserErrorCode =
  | "VERIFICATION_REQUIRED"
  | "SESSION_EXPIRED"
  | "LAYOUT_UNKNOWN"
  | "NAVIGATION_FAILED";

export class TaobaoBrowserError extends Error {
  constructor(
    message: string,
    readonly code: TaobaoBrowserErrorCode
  ) {
    super(message);
    this.name = "TaobaoBrowserError";
  }
}

/** Messaggio unico per le verifiche: è quello che legge l'operatore. */
export const VERIFICATION_MESSAGE =
  "Verifica richiesta su Taobao: completa il controllo manualmente e riprendi.";

const SEARCH_ORIGIN = "https://s.taobao.com";
const DEFAULT_TIMEOUT_MS = 45_000;

/** Cookie nella forma che Playwright accetta, da qualunque esportazione. */
interface NormalizedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Normalizza i cookie esportati dal browser.
 *
 * Le estensioni esportano `expirationDate` e `sameSite: "no_restriction"`,
 * Playwright vuole `expires` e `"None"`. Un solo campo fuori posto fa
 * rifiutare l'intero elenco, e il risultato sarebbe una sessione «collegata»
 * che però non autentica nulla.
 */
export function normalizeCookies(raw: readonly unknown[]): NormalizedCookie[] {
  const cookies: NormalizedCookie[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const cookie = entry as Record<string, unknown>;
    const name = typeof cookie.name === "string" ? cookie.name : null;
    const value = typeof cookie.value === "string" ? cookie.value : null;
    if (!name || value == null) continue;

    const domain =
      typeof cookie.domain === "string" && cookie.domain ? cookie.domain : ".taobao.com";
    const path = typeof cookie.path === "string" && cookie.path ? cookie.path : "/";

    const rawExpiry = cookie.expires ?? cookie.expirationDate;
    const expires =
      typeof rawExpiry === "number" && rawExpiry > 0 ? Math.floor(rawExpiry) : undefined;

    const rawSameSite = typeof cookie.sameSite === "string" ? cookie.sameSite.toLowerCase() : "";
    const sameSite =
      rawSameSite === "strict"
        ? "Strict"
        : rawSameSite === "lax"
          ? "Lax"
          : rawSameSite === "none" || rawSameSite === "no_restriction"
            ? "None"
            : undefined;

    cookies.push({
      name,
      value,
      domain,
      path,
      ...(expires ? { expires } : {}),
      ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      // `sameSite: None` senza `secure` viene rifiutato dal browser.
      ...(sameSite ? { sameSite, ...(sameSite === "None" ? { secure: true } : {}) } : {}),
    });
  }

  return cookies;
}

/** URL della ricerca. La query cinese viaggia codificata, mai tradotta. */
export function buildSearchUrl(query: string, page = 1): string {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("s", String((page - 1) * 44));
  return `${SEARCH_ORIGIN}/search?${params}`;
}

/**
 * `true` se la pagina è una verifica anti-bot o un login.
 *
 * Riconoscerle è ciò che permette di dire «serve una verifica» invece di
 * «nessun risultato»: sono due situazioni opposte e confonderle porta a
 * rifare la stessa ricerca all'infinito.
 */
export function isVerificationUrl(url: string): boolean {
  return /login\.taobao|captcha|_____tmd_____|punish|sec\.taobao|verify/i.test(url);
}

/** Prezzo da un testo cinese (`¥12.50`, `12.50`, `12,50`). */
export function parseBrowserPrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.normalize("NFKC").replace(/[,\s]/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) ? value : null;
}

/** Vendite da `1.2万人付款`, `已售 300+`, `月销 25`. */
export function parseBrowserSales(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text.normalize("NFKC");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(万|亿)?/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === "万") return Math.round(amount * 10_000);
  if (match[2] === "亿") return Math.round(amount * 100_000_000);
  return Math.round(amount);
}

export interface TaobaoBrowserOptions {
  /** Cookie della sessione autenticata, già decifrati dal chiamante. */
  cookies: readonly unknown[];
  limit?: number;
  timeoutMs?: number;
}

/**
 * Esegue la ricerca e restituisce i prodotti trovati.
 *
 * Il contesto del browser viene chiuso sempre: una sessione autenticata
 * lasciata aperta è sia una perdita di memoria sia un cookie in vita più a
 * lungo del necessario.
 */
export async function searchTaobaoAuthenticated(
  query: string,
  options: TaobaoBrowserOptions
): Promise<TaobaoBrowserResult> {
  const cookies = normalizeCookies(options.cookies);
  if (cookies.length === 0) {
    throw new TaobaoBrowserError(
      "La sessione Taobao non contiene cookie utilizzabili: ricollegala.",
      "SESSION_EXPIRED"
    );
  }

  const browser = await getBrowser();
  const context: BrowserContext = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  try {
    await context.addCookies(cookies);
    const page = await context.newPage();
    const url = buildSearchUrl(query);

    let landedOn = url;
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      landedOn = response?.url() ?? page.url();
    } catch (error) {
      throw new TaobaoBrowserError(
        `Taobao non ha risposto: ${(error as Error).message}`,
        "NAVIGATION_FAILED"
      );
    }

    if (isVerificationUrl(landedOn) || isVerificationUrl(page.url())) {
      throw new TaobaoBrowserError(VERIFICATION_MESSAGE, "VERIFICATION_REQUIRED");
    }

    // I risultati arrivano dopo il primo render: si aspetta un link prodotto,
    // non un contenitore con classe offuscata.
    await page
      .waitForSelector('a[href*="item.htm"], a[href*="item.taobao.com"]', {
        timeout: 15_000,
      })
      .catch(() => undefined);

    if (await looksLikeVerificationPage(page)) {
      throw new TaobaoBrowserError(VERIFICATION_MESSAGE, "VERIFICATION_REQUIRED");
    }

    const products = await extractProducts(page, options.limit ?? 20);
    if (products.length === 0) {
      // Una pagina senza schede può essere «zero risultati» oppure un markup
      // che non riconosciamo più: chi chiama deve poterle distinguere.
      const hasEmptyMarker = await page
        .locator("text=/没有找到|抱歉|没有相关/")
        .first()
        .isVisible()
        .catch(() => false);
      if (!hasEmptyMarker) {
        throw new TaobaoBrowserError(
          "Nessuna scheda prodotto riconosciuta: il layout di Taobao potrebbe " +
            "essere cambiato oppure la sessione non è più valida.",
          "LAYOUT_UNKNOWN"
        );
      }
    }

    return { products, queryUsed: query };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Segnali di verifica presenti nel corpo della pagina. */
async function looksLikeVerificationPage(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const text = document.body?.innerText ?? "";
      const hasSlider = document.querySelector(
        '.nc-container, #nc_1_wrapper, [class*="captcha" i], iframe[src*="captcha" i]'
      );
      return Boolean(hasSlider) || /滑动验证|安全验证|请登录|亲，请输入验证码/.test(text);
    })
    .catch(() => false);
}

/**
 * Legge le schede prodotto.
 *
 * Si parte dai link `item.htm?id=…`, si risale al contenitore della scheda e
 * si interpreta il suo testo. È l'unico approccio che sopravvive alle classi
 * offuscate e rigenerate a ogni rilascio.
 */
async function extractProducts(page: Page, limit: number): Promise<TaobaoBrowserProduct[]> {
  const raw = await page
    .evaluate((max) => {
      /** Contenitore della scheda: si sale finché il testo non è completo. */
      function cardOf(anchor: Element): Element {
        let node: Element | null = anchor;
        for (let step = 0; step < 6 && node?.parentElement; step += 1) {
          node = node.parentElement;
          const text = (node as HTMLElement).innerText ?? "";
          if (text.length > 40) return node;
        }
        return node ?? anchor;
      }

      const seen = new Set<string>();
      const results: Array<Record<string, string | null>> = [];

      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="item.htm"]')
      );

      for (const anchor of anchors) {
        const href = anchor.href;
        const id = href.match(/[?&]id=(\d{6,20})/)?.[1] ?? null;
        if (!id || seen.has(id)) continue;

        const card = cardOf(anchor);
        const cardText = (card as HTMLElement).innerText ?? "";

        const title =
          anchor.getAttribute("title") ??
          anchor.querySelector("img")?.getAttribute("alt") ??
          ((anchor.textContent ?? "").trim() ||
            cardText.split("\n").find((line: string) => line.trim().length > 8) ||
            null);
        if (!title) continue;

        seen.add(id);

        const image =
          card.querySelector("img")?.getAttribute("src") ??
          card.querySelector("img")?.getAttribute("data-src") ??
          null;

        const shopAnchor = card.querySelector<HTMLAnchorElement>(
          'a[href*="shop"], a[href*="店铺"]'
        );

        results.push({
          id,
          href,
          title: title.trim(),
          image,
          text: cardText,
          shopName: shopAnchor?.innerText?.trim() ?? null,
          shopUrl: shopAnchor?.href ?? null,
        });

        if (results.length >= max) break;
      }

      return results;
    }, limit)
    .catch(() => [] as Array<Record<string, string | null>>);

  return raw.map((entry) => {
    const text = entry.text ?? "";
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

    // Il primo importo della scheda è il prezzo corrente; un secondo importo
    // diverso è il prezzo di una variante o il prezzo pieno barrato.
    const amounts = [...text.matchAll(/¥\s*(\d+(?:\.\d+)?)/g)]
      .map((match) => Number.parseFloat(match[1]!))
      .filter((value) => Number.isFinite(value));
    const fallbackPrice = parseBrowserPrice(
      lines.find((line) => /^\d+(\.\d+)?$/.test(line)) ?? null
    );

    const salesLine = lines.find((line) => /人付款|人收货|已售|月销/.test(line)) ?? null;
    const reviewLine = lines.find((line) => /评价|条评论/.test(line)) ?? null;
    const shippingLine = lines.find((line) => /包邮|运费|快递/.test(line)) ?? null;
    const locationLine =
      lines.find((line) => /省|市$|自治区/.test(line) && line.length <= 10) ?? null;

    return {
      itemId: entry.id!,
      title: entry.title!,
      url: entry.href ?? `https://item.taobao.com/item.htm?id=${entry.id}`,
      imageUrl: entry.image ? absolute(entry.image) : null,
      price: amounts[0] ?? fallbackPrice,
      variantPrice: amounts.length > 1 && amounts[1] !== amounts[0] ? amounts[1]! : null,
      shopName: entry.shopName ?? null,
      shopUrl: entry.shopUrl ?? null,
      totalSales: parseBrowserSales(salesLine),
      reviewCount: parseBrowserSales(reviewLine),
      location: locationLine,
      shipping: shippingLine,
    } satisfies TaobaoBrowserProduct;
  });
}

function absolute(value: string): string {
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}
