import type {
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { Locator, Page } from "playwright";
import { newContext } from "../browser";
import type { MarketplaceAdapter } from "../types";
import { parseMoq } from "./alibaba";

const ORIGIN = "https://www.aliexpress.com";
const CARD_SELECTOR = '[class*="search-item-card-wrapper"]';
const PRODUCT_LINK_SELECTOR =
  'a.search-card-item[href*="/item/"], a[href*="/item/"]';
const PRODUCT_IMAGE_SELECTOR = [
  'img[src*="aliexpress-media"]',
  'img[src*="alicdn"]',
  'img[data-src*="aliexpress-media"]',
  'img[data-src*="alicdn"]',
  'img[data-original*="aliexpress-media"]',
  'img[data-original*="alicdn"]',
].join(", ");

interface ProductRef {
  id: string;
  url: string;
}

/**
 * Adapter AliExpress (scraping Playwright, prima pagina).
 *
 * Il sito applica un anti-bot aggressivo agli IP datacenter. L'adapter non
 * tenta di aggirarlo: riconosce la pagina `_____tmd_____/punish` e restituisce
 * un errore esplicito, così il chiamante può isolare questa fonte.
 */
export class AliExpressAdapter implements MarketplaceAdapter {
  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(buildSearchUrl(query.text), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await assertNotBlocked(page);

      // Le card vengono idratate lato client. Il timeout è intenzionalmente
      // best-effort: una pagina valida senza risultati deve produrre [].
      await page
        .locator(`${CARD_SELECTOR}, ${PRODUCT_LINK_SELECTOR}`)
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});
      await assertNotBlocked(page);

      const cards = page.locator(CARD_SELECTOR);
      const cardCount = await cards.count();
      const scopes =
        cardCount > 0 ? cards : page.locator(PRODUCT_LINK_SELECTOR);
      const scopeCount = await scopes.count();
      if (scopeCount === 0) {
        if (await isGenuineNoResultsPage(page)) return [];
        throw new Error(
          "AliExpress non ha restituito card prodotto riconoscibili: layout cambiato oppure accesso limitato"
        );
      }
      const limit = Math.min(
        scopeCount,
        Math.max(query.maxResults ?? 8, 1) * 2
      );
      const out: ProductCandidate[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < limit; i += 1) {
        const scope = scopes.nth(i);
        try {
          const link =
            cardCount > 0
              ? scope.locator(PRODUCT_LINK_SELECTOR).first()
              : scope;
          const href = await link.getAttribute("href");
          const ref = href ? productRefFrom(href, page.url()) : null;
          if (!ref || seen.has(ref.id)) continue;

          const title = await readProductTitle(scope);
          if (!title) continue;

          const imageUrl = await readImageUrl(scope);
          const cardText = await scope.innerText().catch(() => "");
          seen.add(ref.id);
          out.push({
            marketplace: "aliexpress",
            productId: ref.id,
            title: title.slice(0, 300),
            url: ref.url,
            imageUrl,
            price: parseLocalizedPrice(cardText),
            moq: null,
            snippet: null,
          });
          if (out.length >= (query.maxResults ?? 8)) break;
        } catch {
          // Una card promozionale o incompleta non deve invalidare la ricerca.
        }
      }

      if (out.length === 0 && !(await isGenuineNoResultsPage(page))) {
        throw new Error(
          `AliExpress ha restituito ${scopeCount} contenitori, ma nessuna card prodotto è normalizzabile`
        );
      }
      return out;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async getDetails(productId: string): Promise<ProductDetails> {
    const ref = productRefFrom(productId);
    if (!ref) {
      throw new Error(`ID prodotto AliExpress non valido: ${productId}`);
    }

    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(ref.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await assertNotBlocked(page);
      await page
        .locator('h1, [data-pl="product-title"], [class*="product-title"]')
        .first()
        .waitFor({ state: "attached", timeout: 10_000 })
        .catch(() => {});
      await assertNotBlocked(page);

      const title =
        (await firstText(
          page.locator(
            'h1, [data-pl="product-title"], [class*="product-title"]'
          )
        )) ||
        ref.id;
      const priceText = await firstText(
        page.locator(
          '[data-pl="product-price"], [class*="price--current"], [class*="price-current"], [class*="product-price"], [class*="price"]'
        )
      );
      const directPrice = parseLocalizedPrice(priceText);
      const bodyText = directPrice
        ? ""
        : await page.locator("body").innerText().catch(() => "");
      const moqText = await firstText(
        page.locator('[class*="moq"], [class*="min-order"]')
      );
      const images = await readDetailImages(page);
      const description = await firstText(
        page.locator(
          '[data-pl="product-description"], [class*="product-description"], [class*="description"]'
        )
      );

      return {
        marketplace: "aliexpress",
        productId: ref.id,
        title: title.trim().slice(0, 300),
        url: ref.url,
        imageUrl: images[0] ?? null,
        price: directPrice ?? parseLocalizedPrice(bodyText),
        moq: parseMoq(moqText),
        description: description ? description.slice(0, 10_000) : null,
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

function buildSearchUrl(text: string): string {
  const literal = text.trim();
  const slug = literal
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // AliExpress prende la keyword dallo slug del percorso, non da SearchText:
  // riducendo una query cinese a uno slug latino vuoto restituiva il listino
  // generico "products", cio\u00e8 prodotti scorrelati. Le keyword non latine
  // vanno quindi codificate dentro lo slug.
  const keyword = slug || encodeURIComponent(literal);
  return `${ORIGIN}/w/wholesale-${keyword}.html?SearchText=${encodeURIComponent(literal)}`;
}

function productRefFrom(value: string, base = ORIGIN): ProductRef | null {
  const trimmed = value.trim();
  const directId = trimmed.match(/^\d+$/)?.[0];
  if (directId) {
    return { id: directId, url: `${ORIGIN}/item/${directId}.html` };
  }

  try {
    const parsed = new URL(trimmed, base);
    const id = parsed.pathname.match(
      /\/item\/(?:[^/?#]+\/)?(\d+)\.html/i
    )?.[1];
    return id ? { id, url: `${ORIGIN}/item/${id}.html` } : null;
  } catch {
    return null;
  }
}

async function assertNotBlocked(page: Page): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const captchaFrameCount = await page
    .locator('iframe[src*="captcha"], iframe[src*="punish"]')
    .count()
    .catch(() => 0);
  const challengeText = await page
    .locator("body")
    .innerText()
    .then((text) => /unusual traffic|slide to verify|not a robot/i.test(text))
    .catch(() => false);
  if (
    /\/_____tmd_____\/punish|[?&]x5step=/i.test(url) ||
    /captcha interception|security verification|robot check/i.test(title) ||
    captchaFrameCount > 0 ||
    challengeText
  ) {
    throw new Error(
      "AliExpress richiede una verifica captcha da questo server: scraping temporaneamente bloccato"
    );
  }
}

async function isGenuineNoResultsPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return [
    /\bno (?:matching )?(?:products?|results?) (?:were )?found\b/i,
    /\b0 (?:products?|results?)\b/i,
    /\bnessun risultato\b/i,
    /\bkeine ergebnisse\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

async function readProductTitle(scope: Locator): Promise<string> {
  const heading = await firstText(scope.locator("h3"));
  if (heading) return heading.trim();

  const titledHeading = scope.locator('[role="heading"][title]').first();
  const titleAttribute = await titledHeading
    .getAttribute("title")
    .catch(() => null);
  if (titleAttribute?.trim()) return titleAttribute.trim();

  const imageAlt = await scope
    .locator(`${PRODUCT_IMAGE_SELECTOR}, img[alt]`)
    .first()
    .getAttribute("alt")
    .catch(() => null);
  return imageAlt?.trim() ?? "";
}

async function firstText(locator: Locator): Promise<string> {
  return (await locator.first().innerText().catch(() => "")).trim();
}

async function readImageUrl(scope: Locator): Promise<string | null> {
  const image = scope.locator(PRODUCT_IMAGE_SELECTOR).first();
  for (const attribute of [
    "src",
    "data-src",
    "data-original",
    "data-lazy-src",
  ]) {
    const normalized = normalizeImageUrl(
      await image.getAttribute(attribute).catch(() => null)
    );
    if (normalized) return normalized;
  }
  return null;
}

async function readDetailImages(page: Page): Promise<string[]> {
  const elements = page.locator(
    '[class*="image-view"] img, [class*="gallery"] img, img[src*="/kf/"], img[data-src*="/kf/"]'
  );
  const count = Math.min(await elements.count(), 30);
  const images: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const image = elements.nth(i);
    for (const attribute of [
      "src",
      "data-src",
      "data-original",
      "data-lazy-src",
    ]) {
      const normalized = normalizeImageUrl(
        await image.getAttribute(attribute).catch(() => null)
      );
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      images.push(normalized);
      break;
    }
    if (images.length >= 20) break;
  }
  return images;
}

function normalizeImageUrl(value: string | null): string | null {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const url = value.startsWith("//")
      ? `https:${value}`
      : new URL(value, ORIGIN).href;
    return /^https?:/i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Estrae il primo prezzo con valuta, gestendo sia `15,29€` sia `US $15.29`. */
export function parseLocalizedPrice(
  text: string
): { value: number; currency: string } | null {
  if (!text) return null;
  const currency =
    "(?:US\\s*\\$|CA\\s*\\$|AU\\s*\\$|R\\s*\\$|USD|EUR|CNY|RMB|GBP|CAD|AUD|JPY|KRW|RUB|BRL|TRY|INR|[€$£¥₽₩₹₺])";
  const number = "(?:\\d[\\d\\s.,'’]*\\d|\\d)";
  const before = new RegExp(`(${currency})\\s*(${number})`, "i");
  const after = new RegExp(`(${number})\\s*(${currency})`, "i");

  for (const line of text.split(/\r?\n/)) {
    const leading = line.match(before);
    if (leading) {
      const value = parseLocaleNumber(leading[2]);
      if (value != null) {
        return { value, currency: normalizeCurrency(leading[1]) };
      }
    }
    const trailing = line.match(after);
    if (trailing) {
      const value = parseLocaleNumber(trailing[1]);
      if (value != null) {
        return { value, currency: normalizeCurrency(trailing[2]) };
      }
    }
  }
  return null;
}

function parseLocaleNumber(value: string): number | null {
  let normalized = value.replace(/[\s'’]/g, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = normalized.split(separator);
    const last = parts.at(-1) ?? "";
    normalized =
      last.length > 0 && last.length <= 2
        ? `${parts.slice(0, -1).join("")}.${last}`
        : parts.join("");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(value: string): string {
  const token = value.toUpperCase().replace(/\s/g, "");
  if (token === "€" || token === "EUR") return "EUR";
  if (token === "£" || token === "GBP") return "GBP";
  if (token === "CA$" || token === "CAD") return "CAD";
  if (token === "AU$" || token === "AUD") return "AUD";
  if (token === "R$" || token === "BRL") return "BRL";
  if (token === "¥" || token === "CNY" || token === "RMB") return "CNY";
  if (token === "₩" || token === "KRW") return "KRW";
  if (token === "₽" || token === "RUB") return "RUB";
  if (token === "₹" || token === "INR") return "INR";
  if (token === "₺" || token === "TRY") return "TRY";
  if (token === "JPY") return "JPY";
  return "USD";
}
