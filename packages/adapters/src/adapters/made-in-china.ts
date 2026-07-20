import type {
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { Page } from "playwright";
import { newContext } from "../browser";
import type { MarketplaceAdapter } from "../types";
import { parseMoq, parsePrice } from "./alibaba";

const CARD_SELECTOR = ".products-item";
const CAPTCHA_SELECTOR = [
  'iframe[src*="captcha" i]',
  'iframe[src*="verify" i]',
  '[id^="captcha" i]',
  '[class~="captcha" i]',
  '[class^="captcha-" i]',
  '[class*=" captcha-" i]',
  ".nc-container",
  '[class*="slider-verify" i]',
  '[class*="verify-slider" i]',
].join(", ");
const NO_RESULTS_SELECTOR = [
  ".no-result",
  ".no-results",
  ".search-no-result",
  ".no-product",
  '[class*="empty-result" i]',
  '[data-testid*="no-result" i]',
].join(", ");

async function hasVisibleChallenge(page: Page): Promise<boolean> {
  const challenges = page.locator(CAPTCHA_SELECTOR);
  const count = Math.min(await challenges.count(), 12);
  for (let index = 0; index < count; index += 1) {
    if (await challenges.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function assertNotBlocked(page: Page, operation: string): Promise<void> {
  const challengeUrl =
    /(?:^|[./?&=_-])(?:captcha|verification|verify|challenge)(?:[./?&=_-]|$)/i.test(
      page.url()
    );
  const challengeDom = await hasVisibleChallenge(page);
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const challengeCopy = [
    /\b(?:security|human) verification\b/i,
    /\bplease (?:complete|pass) (?:the )?verification\b/i,
    /\bslide (?:the slider|to verify)\b/i,
    /\bunusual (?:network )?traffic\b/i,
    /请完成(?:安全)?验证|拖动.{0,20}滑块/,
  ].some((pattern) => pattern.test(bodyText));

  if (challengeUrl || challengeDom || challengeCopy) {
    throw new Error(
      `Made-in-China richiede una verifica captcha durante ${operation}: scraping bloccato da questo server (servono API ufficiali o una sessione/proxy autorizzati)`
    );
  }
}

async function isGenuineNoResultsPage(page: Page): Promise<boolean> {
  const emptyStates = page.locator(NO_RESULTS_SELECTOR);
  const count = Math.min(await emptyStates.count(), 8);
  for (let index = 0; index < count; index += 1) {
    if (await emptyStates.nth(index).isVisible().catch(() => false)) return true;
  }

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return [
    /\bno (?:matching )?products? (?:were )?found\b/i,
    /\bwe (?:could not|couldn't) find any (?:matching )?(?:products?|results?)\b/i,
    /\byour search (?:did not|didn't) match any products?\b/i,
    /\b0 (?:products?|results?) found\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

function canonicalMadeInChinaProductUrl(
  raw: string,
  baseUrl = "https://www.made-in-china.com"
): string | null {
  try {
    const parsed = new URL(raw, baseUrl);
    if (parsed.protocol !== "https:") return null;
    if (!/(^|\.)made-in-china\.com$/i.test(parsed.hostname)) return null;
    if (!/\/product\//i.test(parsed.pathname)) return null;
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Adapter Made-in-China.com (scraping Playwright).
 * Come per Alibaba: selettori best-effort, ma captcha e layout sconosciuti
 * vengono segnalati esplicitamente per non sembrare ricerche valide vuote.
 * productId = URL del prodotto.
 */
export class MadeInChinaAdapter implements MarketplaceAdapter {
  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const url = `https://www.made-in-china.com/products-search/hot-china-products/${encodeURIComponent(
        query.text.replace(/\s+/g, "_")
      )}.html`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2000);

      // Il captcha può essere un redirect oppure una challenge HTTP 200 nel DOM.
      await page
        .locator(`${CARD_SELECTOR}, ${CAPTCHA_SELECTOR}, ${NO_RESULTS_SELECTOR}`)
        .first()
        .waitFor({ state: "attached", timeout: 6500 })
        .catch(() => {});
      await assertNotBlocked(page, "la ricerca");

      // Selettori verificati sul sito reale il 2026-07-10 (card .products-item).
      const cards = await page.locator(CARD_SELECTOR).all();
      if (cards.length === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          "Made-in-China non ha restituito card prodotto riconoscibili: il layout potrebbe essere cambiato oppure l'accesso potrebbe essere limitato"
        );
      }

      const out: ProductCandidate[] = [];
      for (const card of cards.slice(0, (query.maxResults ?? 8) * 2)) {
        try {
          const link = card.locator('a[href*="/product/"]').first();
          let href = (await link.getAttribute("href").catch(() => null)) ?? "";
          if (!href) continue;
          const productUrl = canonicalMadeInChinaProductUrl(href, page.url());
          if (!productUrl) continue;

          const title = (
            (await card
              .locator(".product-name")
              .first()
              .innerText()
              .catch(() => "")) ||
            (await link.getAttribute("title").catch(() => null)) ||
            ""
          ).trim();
          if (!title) continue;

          const priceText = await card
            .locator(".price")
            .first()
            .innerText()
            .catch(() => "");
          const moqText = await card
            .locator('[class*="moq"]')
            .first()
            .innerText()
            .catch(() => "");
          // Le card sotto la piega hanno immagini lazy: src è un placeholder,
          // l'URL vero sta in data-src/data-original.
          const imgEl = card.locator("img").first();
          let img = await imgEl.getAttribute("src").catch(() => null);
          if (!img || img.startsWith("data:")) {
            img =
              (await imgEl.getAttribute("data-src").catch(() => null)) ||
              (await imgEl.getAttribute("data-original").catch(() => null)) ||
              null;
          }

          out.push({
            marketplace: "made-in-china",
            productId: productUrl,
            title: title.slice(0, 300),
            url: productUrl,
            imageUrl: img?.startsWith("//") ? "https:" + img : img ?? null,
            price: parsePrice(priceText),
            moq: parseMoq(moqText),
            snippet: null,
          });
          if (out.length >= (query.maxResults ?? 8)) break;
        } catch {
          // card non riconoscibile: salta
        }
      }
      if (out.length === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          `Made-in-China ha restituito ${cards.length} contenitori, ma nessuna card prodotto è normalizzabile: selettori probabilmente cambiati`
        );
      }
      return out;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async getDetails(productId: string): Promise<ProductDetails> {
    const productUrl = canonicalMadeInChinaProductUrl(productId);
    if (!productUrl) {
      throw new Error(`URL prodotto Made-in-China non valido: ${productId}`);
    }
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(1500);
      await assertNotBlocked(page, "il caricamento del prodotto");

      const title = await page
        .locator("h1")
        .first()
        .innerText()
        .catch(() => productUrl);
      const priceText = await page
        .locator('[class*="price"]')
        .first()
        .innerText()
        .catch(() => "");
      const moqText = await page
        .locator('[class*="moq"], [class*="min-order"]')
        .first()
        .innerText()
        .catch(() => "");
      const img = await page
        .locator("img")
        .first()
        .getAttribute("src")
        .catch(() => null);

      return {
        marketplace: "made-in-china",
        productId: productUrl,
        title: title.trim().slice(0, 300),
        url: productUrl,
        imageUrl: img?.startsWith("//") ? "https:" + img : img ?? null,
        price: parsePrice(priceText),
        moq: parseMoq(moqText),
        description: null,
        images: [],
        priceTiers: [],
        variants: [],
        attributes: {},
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}
