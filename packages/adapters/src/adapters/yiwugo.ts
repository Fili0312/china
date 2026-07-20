import type {
  PriceTier,
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { Locator, Page, Response } from "playwright";
import { newContext } from "../browser";
import type { MarketplaceAdapter } from "../types";
import { parseMoq, parsePrice } from "./alibaba";

const ORIGIN = "https://en.yiwugo.com";
const ORIGIN_ZH = "https://www.yiwugo.com";
const CARD_SELECTOR = ".product_inf";
const PRODUCT_LINK_SELECTOR =
  'a.producthref[href*="/product/detail/"]';

/**
 * Vetrina internazionale e vetrina cinese hanno rotta di ricerca e markup
 * diversi. Una query cinese sul sito inglese non trova nulla, quindi la
 * scelta dipende dalla scrittura della query.
 */
interface Storefront {
  origin: string;
  searchUrl(text: string): string;
  cardSelector: string;
  titleSelector: string;
  priceSelector: string;
  moqSelector: string;
  imageSelector: string;
  shopSelector: string;
  addressSelector: string;
}

const STOREFRONT_EN: Storefront = {
  origin: ORIGIN,
  searchUrl: (text) =>
    `${ORIGIN}/search/s.html?queryKey=${encodeURIComponent(text)}`,
  cardSelector: CARD_SELECTOR,
  titleSelector: ".cptitle",
  priceSelector: ".cpprice",
  moqSelector: ".minorder",
  imageSelector: ".imgsize img, a.producthref img",
  shopSelector: ".cpshopname",
  addressSelector: ".cpaddress",
};

/** Markup verificato sul sito reale il 2026-07-20. */
const STOREFRONT_ZH: Storefront = {
  origin: ORIGIN_ZH,
  searchUrl: (text) => `${ORIGIN_ZH}/search?q=${encodeURIComponent(text)}`,
  cardSelector: ".tile-item",
  titleSelector: ".product-name",
  priceSelector: ".price",
  moqSelector: ".start-number",
  imageSelector: "img.thumbnail",
  shopSelector: ".shop_name .name",
  addressSelector: ".address-info",
};

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function storefrontFor(query: SearchQuery): Storefront {
  return query.language === "zh" || hasHan(query.text)
    ? STOREFRONT_ZH
    : STOREFRONT_EN;
}
const CAPTCHA_SELECTOR = [
  'iframe[src*="captcha" i]',
  'iframe[src*="verify" i]',
  '[id*="captcha" i]',
  '[class*="captcha" i]',
  ".g-recaptcha",
  ".geetest_panel",
  ".nc-container",
  '[class*="slider-verify" i]',
  "#cf-challenge-running",
  '[class*="cf-challenge" i]',
].join(", ");
const NO_RESULTS_SELECTOR = [
  ".no-result",
  ".no-results",
  ".no-product",
  ".no-products",
  '[class*="empty-result" i]',
].join(", ");

interface ProductRef {
  id: string;
  url: string;
}

/**
 * Adapter Yiwugo, su due vetrine.
 *
 * Selettori internazionali verificati il 2026-07-19 (`.product_inf`,
 * `.producthref`, `.cpprice`, `.minorder`); vetrina cinese verificata il
 * 2026-07-20 (`.tile-item`, `.product-name`, `.price`, `.start-number`).
 * Una query cinese va sul sito cinese: quello internazionale non la indicizza
 * e restituirebbe zero risultati. In più i titoli tornano in cinese, quindi la
 * corrispondenza delle parole diventa verificabile.
 * Captcha, limitazioni di accesso e layout non riconosciuti vengono segnalati
 * esplicitamente, così una fonte guasta non appare come una ricerca vuota.
 */
export class YiwugoAdapter implements MarketplaceAdapter {
  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const text = query.text.trim();
    if (!text) throw new Error("La query Yiwugo non può essere vuota");
    const storefront = storefrontFor(query);

    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const response = await goto(
        page,
        storefront.searchUrl(text),
        "la ricerca"
      );
      await assertResponseUsable(page, response, "la ricerca");

      await page
        .locator(
          `${storefront.cardSelector}, ${CAPTCHA_SELECTOR}, ${NO_RESULTS_SELECTOR}`
        )
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});
      await assertNotBlocked(page, "la ricerca");

      const cards = page.locator(storefront.cardSelector);
      const cardCount = await cards.count();
      if (cardCount === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          "Yiwugo non ha restituito card prodotto riconoscibili: layout cambiato oppure accesso limitato"
        );
      }

      const wanted = Math.max(query.maxResults ?? 8, 1);
      const limit = Math.min(cardCount, wanted * 2);
      const products: ProductCandidate[] = [];
      const seen = new Set<string>();

      for (let index = 0; index < limit; index += 1) {
        const card = cards.nth(index);
        try {
          const link = card
            .locator(
              `${storefront.titleSelector} a[href*="/product/detail/"], a[href*="/product/detail/"], ${PRODUCT_LINK_SELECTOR}`
            )
            .first();
          const href = await link.getAttribute("href").catch(() => null);
          const ref = href
            ? productRefFrom(href, page.url(), storefront.origin)
            : null;
          if (!ref || seen.has(ref.id)) continue;

          const title = await readCardTitle(card, link, storefront);
          if (!title) continue;

          const priceText = await firstText(
            card.locator(storefront.priceSelector)
          );
          const moqText = await firstText(card.locator(storefront.moqSelector));
          const imageUrl = await readImageUrl(
            card.locator(storefront.imageSelector).first(),
            page.url()
          );
          const supplier = await firstText(
            card.locator(storefront.shopSelector)
          );
          const address = await firstText(
            card.locator(storefront.addressSelector)
          );
          const snippet = [supplier, address].filter(Boolean).join(" · ");

          seen.add(ref.id);
          products.push({
            marketplace: "yiwugo",
            productId: ref.id,
            title: title.slice(0, 300),
            url: ref.url,
            imageUrl,
            price: parsePrice(priceText),
            moq: parseMoq(moqText),
            snippet: snippet ? snippet.slice(0, 500) : null,
          });
          if (products.length >= wanted) break;
        } catch {
          // Una singola card incompleta o promozionale non invalida la pagina.
        }
      }

      if (products.length === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          `Yiwugo ha restituito ${cardCount} contenitori, ma nessuna card prodotto è normalizzabile: selettori probabilmente cambiati`
        );
      }
      return products;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async getDetails(productId: string): Promise<ProductDetails> {
    const ref = productRefFrom(productId);
    if (!ref) {
      throw new Error(`ID prodotto Yiwugo non valido: ${productId}`);
    }

    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const response = await goto(page, ref.url, "il caricamento del prodotto");
      await assertResponseUsable(
        page,
        response,
        "il caricamento del prodotto"
      );

      await page
        .locator(`h1.tit, ${CAPTCHA_SELECTOR}`)
        .first()
        .waitFor({ state: "attached", timeout: 10_000 })
        .catch(() => {});
      await assertNotBlocked(page, "il caricamento del prodotto");

      const title = await readDetailTitle(page);
      if (!title) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (/\b(?:product|page) not found\b|\bno product\b/i.test(bodyText)) {
          throw new Error(`Prodotto Yiwugo non trovato: ${ref.id}`);
        }
        throw new Error(
          "Yiwugo non ha restituito una scheda prodotto riconoscibile: layout cambiato oppure accesso limitato"
        );
      }

      const priceText = await firstText(
        page.locator(".price-one > span, .price-one span")
      );
      const moqText = await firstText(
        page.locator(
          ".price-one > div, .price-sum, .cpqdl, [class*=\"min-order\" i]"
        )
      );
      const images = await readDetailImages(page);
      const descriptionText = await firstText(page.locator("#product-detail"));

      return {
        marketplace: "yiwugo",
        productId: ref.id,
        title: title.slice(0, 300),
        url: ref.url,
        imageUrl: images[0] ?? null,
        price: parsePrice(priceText),
        moq: parseMoq(moqText),
        snippet: null,
        description: descriptionText
          ? descriptionText.slice(0, 10_000)
          : null,
        images,
        priceTiers: await readPriceTiers(page),
        variants: [],
        attributes: await readAttributes(page),
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

async function goto(
  page: Page,
  url: string,
  operation: string
): Promise<Response | null> {
  try {
    return await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Yiwugo non è raggiungibile durante ${operation}: ${detail}`);
  }
}

async function assertResponseUsable(
  page: Page,
  response: Response | null,
  operation: string
): Promise<void> {
  await assertNotBlocked(page, operation);
  const status = response?.status();
  if (status === 404) {
    throw new Error(`Yiwugo ha risposto HTTP 404 durante ${operation}`);
  }
  if (status != null && status >= 400) {
    throw new Error(
      `Yiwugo non è disponibile durante ${operation} (HTTP ${status})`
    );
  }
}

async function assertNotBlocked(page: Page, operation: string): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const challengeElements = page.locator(CAPTCHA_SELECTOR);
  const challengeCount = Math.min(await challengeElements.count(), 12);
  let visibleChallenge = false;
  for (let index = 0; index < challengeCount; index += 1) {
    if (await challengeElements.nth(index).isVisible().catch(() => false)) {
      visibleChallenge = true;
      break;
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const challengeCopy = [
    /\b(?:access denied|too many requests|unusual traffic)\b/i,
    /\b(?:security|human) verification\b/i,
    /\bplease (?:complete|pass|perform) (?:the )?verification\b/i,
    /\b(?:enter|complete) (?:the )?captcha\b/i,
    /\bslide (?:the slider|to verify)\b/i,
    /验证码|请完成.{0,20}验证|访问.{0,12}(?:频繁|受限)|系统检测到异常/,
  ].some((pattern) => pattern.test(bodyText));

  if (
    /(?:captcha|verify|challenge|punish|access[_-]?denied)/i.test(url) ||
    /(?:captcha|security verification|access denied|just a moment)/i.test(
      title
    ) ||
    visibleChallenge ||
    challengeCopy
  ) {
    throw new Error(
      `Yiwugo richiede una verifica captcha o limita l'accesso durante ${operation}: scraping bloccato da questo server`
    );
  }
}

async function isGenuineNoResultsPage(page: Page): Promise<boolean> {
  const emptyStates = page.locator(NO_RESULTS_SELECTOR);
  const emptyCount = Math.min(await emptyStates.count(), 8);
  for (let index = 0; index < emptyCount; index += 1) {
    if (await emptyStates.nth(index).isVisible().catch(() => false)) return true;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (
    [
      /(?:^|\n)\s*0 results?\s*(?:\n|$)/i,
      /(?:^|\n)\s*no products?\s*(?:\n|$)/i,
      /\bno (?:matching )?(?:products?|results?) (?:were )?found\b/i,
      /没有(?:找到|搜到).{0,12}(?:商品|产品)|暂无(?:相关)?(?:商品|产品|数据)/,
    ].some((pattern) => pattern.test(bodyText))
  ) {
    return true;
  }

  // La vetrina cinese, quando nessun prodotto corrisponde, non stampa alcun
  // messaggio: mostra soltanto l'elenco dei negozi correlati. Una pagina di
  // ricerca servita correttamente e senza card è quindi un vuoto legittimo,
  // non un layout cambiato.
  return (
    /\/search\b/.test(page.url()) &&
    (await page.locator(".shop-list, .pro_list_company_img").count()) > 0
  );
}

function productRefFrom(
  value: string,
  base = ORIGIN,
  origin = ORIGIN
): ProductRef | null {
  const trimmed = value.trim();
  const directId = trimmed.match(/^\d+$/)?.[0];
  if (directId) return productRef(directId, origin);

  try {
    const url = new URL(trimmed, base);
    const host = url.hostname.toLowerCase();
    if (
      host !== "yiwugo.com" &&
      host !== "www.yiwugo.com" &&
      host !== "en.yiwugo.com" &&
      host !== "g.yiwugo.com"
    ) {
      return null;
    }
    const id = url.pathname.match(/\/product\/detail\/(\d+)\.html/i)?.[1];
    return id ? productRef(id, origin) : null;
  } catch {
    return null;
  }
}

function productRef(id: string, origin = ORIGIN): ProductRef {
  return { id, url: `${origin}/product/detail/${id}.html` };
}

async function readCardTitle(
  card: Locator,
  link: Locator,
  storefront: Storefront = STOREFRONT_EN
): Promise<string> {
  const titleAttribute = await link.getAttribute("title").catch(() => null);
  if (titleAttribute?.trim()) return titleAttribute.trim();
  return firstText(card.locator(storefront.titleSelector));
}

async function readDetailTitle(page: Page): Promise<string> {
  const heading = await firstText(page.locator("h1.tit, h1"));
  if (heading) return heading;
  const documentTitle = (await page.title().catch(() => "")).trim();
  return /^(?:yiwugo(?: search)?|home)$/i.test(documentTitle)
    ? ""
    : documentTitle;
}

async function firstText(locator: Locator): Promise<string> {
  return (await locator.first().innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
}

async function readImageUrl(
  image: Locator,
  baseUrl: string
): Promise<string | null> {
  for (const attribute of [
    "data-large",
    "ytimg",
    "imgsrc",
    "data-url",
    "data-src",
    "data-original",
    "data-lazy-src",
    "src",
  ]) {
    const url = normalizeImageUrl(
      await image.getAttribute(attribute).catch(() => null),
      baseUrl
    );
    if (url) return url;
  }
  return null;
}

async function readDetailImages(page: Page): Promise<string[]> {
  const elements = page.locator(
    ".view_tem_bigimg img, .view_img_bord img, #product-detail img"
  );
  const count = Math.min(await elements.count(), 40);
  const images: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const imageUrl = await readImageUrl(elements.nth(index), page.url());
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    images.push(imageUrl);
    if (images.length >= 30) break;
  }
  return images;
}

function normalizeImageUrl(value: string | null, baseUrl: string): string | null {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/\/(?:blank\.gif|defaultnoimage[^/]*)$/i.test(url.pathname)) return null;

    // Le pagine HTTPS pubblicano ancora alcuni asset ufficiali come HTTP.
    if (
      url.protocol === "http:" &&
      /(?:^|\.)(?:yiwugo|yiwugou)\.com$/i.test(url.hostname)
    ) {
      url.protocol = "https:";
    }
    return url.href;
  } catch {
    return null;
  }
}

async function readPriceTiers(page: Page): Promise<PriceTier[]> {
  const rows = page.locator(".price-one");
  const count = Math.min(await rows.count(), 20);
  const tiers: PriceTier[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const price = parsePrice(await firstText(row.locator("span")));
    const minQty = parseMoq(await firstText(row.locator(":scope > div")));
    if (!price || minQty == null) continue;
    const key = `${minQty}:${price.currency}:${price.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiers.push({ minQty, price });
  }
  return tiers;
}

async function readAttributes(page: Page): Promise<Record<string, string>> {
  const attributes: Record<string, string> = {};
  const rows = page.locator(".pro-par-bord li, .pro-par-bord tr");
  const count = Math.min(await rows.count(), 50);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = row.locator("th, td");
    const cellCount = await cells.count();
    let key = "";
    let value = "";
    if (cellCount >= 2) {
      key = await firstText(cells.nth(0));
      value = await firstText(cells.nth(1));
    } else {
      const text = await firstText(row);
      const separator = text.search(/[:：]/);
      if (separator > 0) {
        key = text.slice(0, separator).trim();
        value = text.slice(separator + 1).trim();
      }
    }
    if (key && value) attributes[key.slice(0, 100)] = value.slice(0, 500);
  }
  return attributes;
}
