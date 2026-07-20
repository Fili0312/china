import type {
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { Locator, Page } from "playwright";
import { newContext } from "../browser";
import type { MarketplaceAdapter } from "../types";

const CARD_SELECTOR =
  '[class*="search-card"], [data-spm*="offer"], .organic-list-offer-outter';
const CAPTCHA_SELECTOR =
  'punish-component, #nocaptcha, script[src*="sufei-punish"], script[src*="punishpage"]';
const NO_RESULTS_SELECTOR =
  '[class*="no-result"], [class*="noResult"], [class*="empty-result"], [data-testid*="no-result"]';

async function assertNotBlocked(page: Page, operation: string): Promise<void> {
  const challengeUrl = /\/(?:punish|verify)(?:[/?]|$)/i.test(page.url());
  const challengeDom = (await page.locator(CAPTCHA_SELECTOR).count()) > 0;
  if (challengeUrl || challengeDom) {
    throw new Error(
      `Alibaba richiede una verifica captcha durante ${operation}: scraping bloccato da questo server (servono API ufficiali o una sessione/proxy autorizzati)`
    );
  }
}

async function isGenuineNoResultsPage(page: Page): Promise<boolean> {
  if (
    await page
      .locator(NO_RESULTS_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return true;
  }

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return [
    /\bno (?:matching )?products? (?:were )?found\b/i,
    /\bwe (?:could not|couldn't) find any (?:matching )?(?:products?|results?)\b/i,
    /\byour search (?:did not|didn't) match any products?\b/i,
    /\b0 products? found\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

function resolveHttpUrl(raw: string | null, baseUrl: string): string | null {
  if (!raw?.trim()) return null;
  try {
    const resolved = new URL(raw.trim(), baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

function withoutTracking(url: string): string {
  const clean = new URL(url);
  clean.search = "";
  clean.hash = "";
  return clean.href;
}

function canonicalAlibabaProductUrl(
  raw: string | null,
  baseUrl = "https://www.alibaba.com"
): string | null {
  const resolved = resolveHttpUrl(raw, baseUrl);
  if (!resolved) return null;
  const parsed = new URL(resolved);
  if (!/(^|\.)alibaba\.com$/i.test(parsed.hostname)) return null;
  if (!/\/product-detail\//i.test(parsed.pathname)) return null;
  return withoutTracking(parsed.href);
}

async function readImageUrl(
  image: Locator,
  baseUrl: string
): Promise<string | null> {
  // Alibaba usa attributi diversi per le immagini sotto la piega.
  for (const attribute of [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-lazyload-src",
    "src",
  ]) {
    const value = await image.getAttribute(attribute).catch(() => null);
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
      continue;
    }
    const resolved = resolveHttpUrl(value, baseUrl);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Adapter Alibaba.com (scraping Playwright).
 *
 * ⚠️ I selettori CSS di Alibaba cambiano spesso e il sito applica anti-bot
 * (captcha/slider) sotto carico. Questo adapter estrae in modo difensivo e
 * segnala esplicitamente captcha e layout non riconosciuti, così non vengono
 * scambiati per una ricerca valida senza risultati.
 * productId = URL del prodotto.
 */
export class AlibabaAdapter implements MarketplaceAdapter {
  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      const url = `https://www.alibaba.com/trade/search?fsb=y&IndexArea=product_en&SearchText=${encodeURIComponent(
        query.text
      )}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1500); // prima idratazione client-side

      // Attendi uno stato riconoscibile. Il captcha Alibaba risponde HTTP 200 e
      // spesso conserva la URL della ricerca, quindi va rilevato anche nel DOM.
      await page
        .locator(`${CARD_SELECTOR}, ${CAPTCHA_SELECTOR}, ${NO_RESULTS_SELECTOR}`)
        .first()
        .waitFor({ state: "attached", timeout: 6500 })
        .catch(() => {});
      await assertNotBlocked(page, "la ricerca");

      // TODO: selettori da verificare periodicamente — Alibaba li ruota.
      const cards = await page.locator(CARD_SELECTOR).all();
      if (cards.length === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          "Alibaba non ha restituito card prodotto riconoscibili: il layout potrebbe essere cambiato oppure l'accesso potrebbe essere limitato"
        );
      }

      const out: ProductCandidate[] = [];
      for (const card of cards.slice(0, (query.maxResults ?? 8) * 2)) {
        try {
          const link = card
            .locator('a[href*="/product-detail/"], a[href*=".html"]')
            .first();
          const productUrl = canonicalAlibabaProductUrl(
            await link.getAttribute("href").catch(() => null),
            page.url()
          );
          if (!productUrl) continue;

          const linkTitle = (
            (await link.getAttribute("title").catch(() => null)) ?? ""
          ).trim();
          const fallbackTitle = await card
            .locator('h2, [class*="title"]')
            .first()
            .innerText()
            .catch(() => "");
          const title = linkTitle || fallbackTitle.trim();
          if (!title) continue;

          const priceText = await card
            .locator('[class*="price"]')
            .first()
            .innerText()
            .catch(() => "");
          const moqText = await card
            .locator('[class*="moq"], [class*="min-order"]')
            .first()
            .innerText()
            .catch(() => "");
          const imageUrl = await readImageUrl(
            card.locator("img").first(),
            page.url()
          );

          out.push({
            marketplace: "alibaba",
            productId: productUrl,
            title: title.trim().slice(0, 300),
            url: productUrl,
            imageUrl,
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
          `Alibaba ha restituito ${cards.length} contenitori, ma nessuna card prodotto è normalizzabile: selettori probabilmente cambiati`
        );
      }
      return out;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async getDetails(productId: string): Promise<ProductDetails> {
    const productUrl = canonicalAlibabaProductUrl(productId);
    if (!productUrl) {
      throw new Error(`URL prodotto Alibaba non valido: ${productId}`);
    }
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(2000);
      await assertNotBlocked(page, "il caricamento del prodotto");

      const extractedTitle = await page
        .locator("h1")
        .first()
        .innerText()
        .catch(() => "");
      const title = extractedTitle.trim() || productUrl;
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
      const imageUrl = await readImageUrl(
        page
          .locator(
            'img[src*="alicdn"], img[data-src*="alicdn"], img[data-original*="alicdn"], img[data-lazy-src*="alicdn"]'
          )
          .first(),
        page.url()
      );

      return {
        marketplace: "alibaba",
        productId: productUrl,
        title: title.slice(0, 300),
        url: productUrl,
        imageUrl,
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

/** "US$ 1.20 - 2.50" → prende il prezzo minimo. */
export function parsePrice(
  text: string
): { value: number; currency: string } | null {
  if (!text) return null;
  const m = text.match(/\d[\d\s\u00a0.,]*/);
  if (!m) return null;
  let numeric = m[0].replace(/[\s\u00a0]/g, "");
  const comma = numeric.lastIndexOf(",");
  const dot = numeric.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    // L'ultimo separatore è quello decimale: 1,234.56 / 1.234,56.
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    numeric = numeric.replace(thousands, "");
    if (decimal === ",") numeric = numeric.replace(",", ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const occurrences = numeric.split(separator).length - 1;
    const trailingDigits =
      numeric.length - numeric.lastIndexOf(separator) - 1;
    if (occurrences > 1 || trailingDigits === 3) {
      numeric = numeric.split(separator).join("");
    } else if (separator === ",") {
      numeric = numeric.replace(",", ".");
    }
  }

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;
  let currency = "USD";
  if (/€|EUR/i.test(text)) currency = "EUR";
  // 元 e 人民币 compaiono sulle vetrine cinesi al posto del simbolo ¥.
  else if (/[¥￥]|CNY|RMB|元|人民币/i.test(text)) currency = "CNY";
  else if (/£|GBP/i.test(text)) currency = "GBP";
  else if (/HK\$|HKD/i.test(text)) currency = "HKD";
  return { value, currency };
}

/** "Min. order: 100 pieces" → 100 */
export function parseMoq(text: string): number | null {
  if (!text) return null;
  const m = text.replace(/[.,](?=\d{3})/g, "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
