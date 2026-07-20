import type {
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { Locator, Page, Response } from "playwright";
import { newContext } from "../browser";
import type { MarketplaceAdapter } from "../types";
import { parseMoq, parsePrice } from "./alibaba";

const ORIGIN = "https://en.chinagoods.com";
const PRODUCT_LINK_SELECTOR = 'a[href*="/product/"]';
const WAIT_CARD_SELECTOR = [
  ".product-item",
  ".goods-item",
  '[class*="product-card" i]',
  '[class*="goods-card" i]',
  PRODUCT_LINK_SELECTOR,
].join(", ");
const CAPTCHA_SELECTOR = [
  'iframe[src*="captcha" i]',
  'iframe[src*="verify" i]',
  '[id*="captcha" i]',
  '[class*="captcha" i]',
  '[class*="slider-verify" i]',
  '[class*="security-check" i]',
].join(", ");
const NO_RESULTS_SELECTOR = [
  ".no-result",
  ".no-results",
  ".empty-result",
  ".empty-state",
  '[class*="no-product" i]',
  '[data-testid*="no-result" i]',
].join(", ");

interface ProductRef {
  id: string;
  url: string;
}

interface ProductScopes {
  locator: Locator;
  linkOnly: boolean;
}

/**
 * Adapter del marketplace ufficiale Yiwu Chinagoods.
 *
 * Route e markup verificati sul sito SSR reale: `/search/products?keyword=…`,
 * `.product-item > .goods-item`, link `/product/<slug>_<id>`, `.goods-img` e
 * `.goods-price .price`. I fallback servono solo a tollerare piccole variazioni:
 * captcha, pagina vuota non riconosciuta e layout cambiato restano errori
 * espliciti e non vengono trasformati in falsi "zero risultati".
 */
export class ChinagoodsAdapter implements MarketplaceAdapter {
  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const text = query.text.trim();
    if (!text) return [];

    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const response = await page.goto(
        `${ORIGIN}/search/products?keyword=${encodeURIComponent(text)}`,
        { waitUntil: "domcontentloaded", timeout: 45_000 }
      );
      assertResponseUsable(response, "la ricerca");

      await page
        .locator(`${WAIT_CARD_SELECTOR}, ${CAPTCHA_SELECTOR}, ${NO_RESULTS_SELECTOR}`)
        .first()
        .waitFor({ state: "attached", timeout: 12_000 })
        .catch(() => {});
      await assertNotBlocked(page, "la ricerca");

      const scopes = await findProductScopes(page);
      const scopeCount = await scopes.locator.count();
      if (scopeCount === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          "Chinagoods non ha restituito card prodotto riconoscibili: layout cambiato oppure accesso limitato"
        );
      }

      const requested = query.maxResults ?? 8;
      const inspectLimit = Math.min(scopeCount, Math.max(requested, 1) * 3);
      const seen = new Set<string>();
      const products: ProductCandidate[] = [];

      for (let index = 0; index < inspectLimit; index += 1) {
        const rawScope = scopes.locator.nth(index);
        try {
          const link = scopes.linkOnly
            ? rawScope
            : rawScope.locator(PRODUCT_LINK_SELECTOR).first();
          const href = await link.getAttribute("href").catch(() => null);
          const ref = href ? productRefFrom(href, page.url()) : null;
          if (!ref || seen.has(ref.id)) continue;

          // Nel fallback a soli link, il prezzo si trova normalmente nel parent.
          const contentScope = scopes.linkOnly
            ? link.locator("xpath=..")
            : rawScope;
          const title = await readProductTitle(contentScope, link);
          if (!title) continue;

          const priceText = await firstText(
            contentScope.locator(
              ".goods-price .price-amount, .price-amount, [class*=\"product-price\" i], [class~=\"price\" i]"
            )
          );
          const cardText = await contentScope.innerText().catch(() => "");
          const moqText =
            (await firstText(
              contentScope.locator(
                '[class*="moq" i], [class*="min-order" i], [class*="minimum" i]'
              )
            )) || extractMoqText(cardText);
          const imageUrl = await readFirstImage(contentScope, page.url());

          seen.add(ref.id);
          products.push({
            marketplace: "chinagoods",
            productId: ref.url,
            title: title.slice(0, 300),
            url: ref.url,
            imageUrl,
            price: parseChinagoodsPrice(priceText),
            moq: parseMoq(moqText),
            snippet: null,
          });
          if (products.length >= requested) break;
        } catch {
          // Banner, suggerimenti e card incomplete non invalidano le altre card.
        }
      }

      if (products.length === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          `Chinagoods ha restituito ${scopeCount} contenitori, ma nessuna card prodotto è normalizzabile`
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
      throw new Error(`ID o URL prodotto Chinagoods non valido: ${productId}`);
    }

    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const response = await page.goto(ref.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      assertResponseUsable(response, "il caricamento del prodotto");
      await page
        .locator(
          `h1, [class*="product-title" i], [class*="goods-title" i], ${CAPTCHA_SELECTOR}`
        )
        .first()
        .waitFor({ state: "attached", timeout: 10_000 })
        .catch(() => {});
      await assertNotBlocked(page, "il caricamento del prodotto");

      const title = await readDetailTitle(page);
      if (!title) {
        if (await isGenuineNoResultsPage(page)) {
          throw new Error(`Prodotto Chinagoods non trovato: ${ref.id}`);
        }
        throw new Error(
          "Chinagoods non espone un titolo prodotto riconoscibile: layout cambiato oppure pagina non disponibile"
        );
      }

      const priceText =
        (await firstText(
          page.locator(
            ".goods-price .price-amount, .price-amount, [class*=\"product-price\" i], [class*=\"sale-price\" i]"
          )
        )) || (await extractPriceFromBody(page));
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const moqText =
        (await firstText(
          page.locator(
            '[class*="moq" i], [class*="min-order" i], [class*="minimum" i]'
          )
        )) || extractMoqText(bodyText);
      const images = await readDetailImages(page);
      const description = await readDescription(page);
      const finalRef = productRefFrom(page.url()) ?? ref;

      return {
        marketplace: "chinagoods",
        productId: finalRef.url,
        title: title.slice(0, 300),
        url: finalRef.url,
        imageUrl: images[0] ?? null,
        price: parseChinagoodsPrice(priceText),
        moq: parseMoq(moqText),
        description,
        images,
        priceTiers: [],
        variants: [],
        attributes: {},
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

function assertResponseUsable(
  response: Response | null,
  operation: string
): void {
  const status = response?.status();
  if (status === 403 || status === 429) {
    throw new Error(
      `Chinagoods limita l'accesso durante ${operation} (HTTP ${status}): scraping temporaneamente bloccato da questo server`
    );
  }
  if (status && status >= 500) {
    throw new Error(
      `Chinagoods non è disponibile durante ${operation} (HTTP ${status})`
    );
  }
}

async function assertNotBlocked(page: Page, operation: string): Promise<void> {
  const challengeUrl =
    /(?:^|[/?&_.-])(?:captcha|verify|verification|challenge|security-check)(?:[/?&_.=-]|$)/i.test(
      page.url()
    );
  const title = await page.title().catch(() => "");
  const challenges = page.locator(CAPTCHA_SELECTOR);
  const challengeCount = Math.min(await challenges.count(), 10);
  let visibleChallenge = false;
  for (let index = 0; index < challengeCount; index += 1) {
    if (await challenges.nth(index).isVisible().catch(() => false)) {
      visibleChallenge = true;
      break;
    }
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const challengeCopy = [
    /\b(?:access denied|too many requests)\b/i,
    /\b(?:security|human) verification\b/i,
    /\bplease (?:complete|pass) (?:the )?verification\b/i,
    /\b(?:verify you are human|slide to verify|unusual traffic)\b/i,
    /请完成(?:安全)?验证|拖动.{0,20}滑块|访问过于频繁/,
  ].some((pattern) => pattern.test(bodyText));

  if (
    challengeUrl ||
    visibleChallenge ||
    challengeCopy ||
    /captcha|access denied|security verification/i.test(title)
  ) {
    throw new Error(
      `Chinagoods richiede una verifica anti-bot durante ${operation}: scraping temporaneamente bloccato da questo server`
    );
  }
}

async function isGenuineNoResultsPage(page: Page): Promise<boolean> {
  const emptyStates = page.locator(NO_RESULTS_SELECTOR);
  const count = Math.min(await emptyStates.count(), 8);
  for (let index = 0; index < count; index += 1) {
    if (await emptyStates.nth(index).isVisible().catch(() => false)) return true;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return [
    /\bno (?:matching )?(?:products?|results?) (?:were )?found\b/i,
    /\bsorry,? (?:we )?(?:could not|couldn't) find (?:any )?(?:products?|results?)\b/i,
    /\byour search (?:did not|didn't) match any products?\b/i,
    /\b0 (?:products?|results?) found\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

async function findProductScopes(page: Page): Promise<ProductScopes> {
  for (const selector of [
    `.product-item:has(${PRODUCT_LINK_SELECTOR})`,
    `.goods-item:has(${PRODUCT_LINK_SELECTOR})`,
    `[class*="product-card" i]:has(${PRODUCT_LINK_SELECTOR})`,
    `[class*="goods-card" i]:has(${PRODUCT_LINK_SELECTOR})`,
  ]) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) return { locator, linkOnly: false };
  }
  return { locator: page.locator(PRODUCT_LINK_SELECTOR), linkOnly: true };
}

function productRefFrom(value: string, base = ORIGIN): ProductRef | null {
  const trimmed = value.trim();
  const directId = trimmed.match(/^\d+$/)?.[0];
  if (directId) {
    return {
      id: directId,
      url: `${ORIGIN}/product/product_${directId}`,
    };
  }

  try {
    const parsed = new URL(trimmed, base);
    if (!/(^|\.)chinagoods\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/product\/[^/]*_(\d+)\/?$/i);
    if (!match) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return { id: match[1], url: `${ORIGIN}${path}` };
  } catch {
    return null;
  }
}

async function readProductTitle(
  scope: Locator,
  link: Locator
): Promise<string> {
  for (const locator of [
    scope.locator('.goods-img[title], img[title], [class*="product-name" i][title]'),
    scope.locator('.goods-img[alt], img[alt]'),
    scope.locator('[class*="product-name" i], [class*="goods-name" i]'),
  ]) {
    const title = await firstAttribute(locator, "title");
    if (title) return title;
    const alt = await firstAttribute(locator, "alt");
    if (alt) return alt;
    const text = await firstText(locator);
    if (text) return text;
  }

  const linkTitle = await link.getAttribute("title").catch(() => null);
  if (linkTitle?.trim()) return linkTitle.trim();
  return (await link.innerText().catch(() => "")).trim();
}

async function readDetailTitle(page: Page): Promise<string> {
  const visible = await firstText(
    page.locator(
      'h1, [class*="product-title" i], [class*="goods-title" i], [data-testid*="product-title" i]'
    )
  );
  if (visible) return visible;
  return (
    (await page
      .locator('meta[property="og:title"]')
      .getAttribute("content")
      .catch(() => null)) ?? ""
  ).trim();
}

async function readFirstImage(
  scope: Locator,
  baseUrl: string
): Promise<string | null> {
  const images = scope.locator("img");
  const count = Math.min(await images.count(), 6);
  for (let index = 0; index < count; index += 1) {
    const url = await readImageUrl(images.nth(index), baseUrl);
    if (url) return url;
  }
  return null;
}

async function readImageUrl(
  image: Locator,
  baseUrl: string
): Promise<string | null> {
  for (const attribute of [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-url",
    "src",
  ]) {
    const raw = await image.getAttribute(attribute).catch(() => null);
    const resolved = resolveImageUrl(raw, baseUrl);
    if (resolved) return resolved;
  }

  const srcset = await image.getAttribute("srcset").catch(() => null);
  const firstCandidate = srcset?.split(",")[0]?.trim().split(/\s+/)[0] ?? null;
  return resolveImageUrl(firstCandidate, baseUrl);
}

function resolveImageUrl(raw: string | null, baseUrl: string): string | null {
  if (!raw || /^(?:data|blob):/i.test(raw.trim())) return null;
  try {
    const url = new URL(raw.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readDetailImages(page: Page): Promise<string[]> {
  const images = page.locator(
    'main img, [class*="product-detail" i] img, [class*="goods-detail" i] img, [class*="gallery" i] img'
  );
  const count = Math.min(await images.count(), 80);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const url = await readImageUrl(images.nth(index), page.url());
    if (
      !url ||
      seen.has(url) ||
      !/(?:cdnimg\.)?chinagoods\.com/i.test(new URL(url).hostname)
    ) {
      continue;
    }
    seen.add(url);
    out.push(url);
    if (out.length >= 20) break;
  }

  if (out.length === 0) {
    const ogImage = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content")
      .catch(() => null);
    const resolved = resolveImageUrl(ogImage, page.url());
    if (resolved) out.push(resolved);
  }
  return out;
}

async function readDescription(page: Page): Promise<string | null> {
  const text = await firstText(
    page.locator(
      '[class*="product-description" i], [class*="goods-description" i], #description, [id*="description" i]'
    )
  );
  if (text) return text.slice(0, 10_000);
  const meta = await page
    .locator('meta[name="description"]')
    .getAttribute("content")
    .catch(() => null);
  return meta?.trim() ? meta.trim().slice(0, 10_000) : null;
}

async function extractPriceFromBody(page: Page): Promise<string> {
  const body = await page.locator("body").innerText().catch(() => "");
  return (
    body.match(
      /(?:US\$|USD|[¥￥]|CNY|RMB|€|EUR|£|GBP)\s*\d[\d\s.,]*(?:\s*[-–]\s*\d[\d\s.,]*)?/i
    )?.[0] ?? ""
  );
}

function extractMoqText(text: string): string {
  return (
    text.match(
      /(?:MOQ|min(?:imum)?\.?\s*(?:order|purchase)(?:\s*quantity)?)[^\d]{0,30}\d[\d\s,.]*/i
    )?.[0] ?? ""
  );
}

function parseChinagoodsPrice(
  text: string
): ReturnType<typeof parsePrice> {
  const parsed = parsePrice(text);
  if (!parsed || parsed.currency !== "USD") return parsed;

  // Chinagoods espone conversioni USD anche con tre decimali (es. 2.119).
  // Il parser condiviso considera normalmente tre cifre come separatore delle
  // migliaia; su questa fonte un singolo punto è invece decimale.
  const raw = text.match(/\d[\d\s\u00a0.,]*/)?.[0]
    .replace(/[\s\u00a0]/g, "");
  if (raw && !raw.includes(",") && (raw.match(/\./g)?.length ?? 0) === 1) {
    const fraction = raw.split(".")[1];
    if (fraction?.length === 3) {
      const value = Number(raw);
      if (Number.isFinite(value)) return { value, currency: "USD" };
    }
  }
  return parsed;
}

async function firstText(locator: Locator): Promise<string> {
  const count = Math.min(await locator.count(), 8);
  for (let index = 0; index < count; index += 1) {
    const text = await locator.nth(index).innerText().catch(() => "");
    if (text.trim()) return text.trim();
  }
  return "";
}

async function firstAttribute(
  locator: Locator,
  attribute: string
): Promise<string> {
  const count = Math.min(await locator.count(), 8);
  for (let index = 0; index < count; index += 1) {
    const value = await locator
      .nth(index)
      .getAttribute(attribute)
      .catch(() => null);
    if (value?.trim()) return value.trim();
  }
  return "";
}
