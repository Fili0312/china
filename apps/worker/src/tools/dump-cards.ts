/**
 * Debug: estrae dalle prime card i campi che ci servono, per tarare i selettori.
 *   pnpm --filter @china/worker exec tsx src/tools/dump-cards.ts <url> <selettore-card>
 */
import "../env";
import { chromium } from "playwright";

async function main() {
  const [url, cardSel] = process.argv.slice(2);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const cards = await page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].slice(0, 3).map((card) => {
      const links = [...card.querySelectorAll("a[href]")].map((a) => ({
        href: (a as HTMLAnchorElement).href,
        title: a.getAttribute("title"),
        text: (a.textContent || "").trim().slice(0, 60),
        cls: a.className.toString().slice(0, 60),
      }));
      const img = card.querySelector("img");
      const textByClass: Record<string, string> = {};
      for (const el of card.querySelectorAll("[class]")) {
        const cls = el.className.toString();
        const txt = (el as HTMLElement).innerText?.trim();
        if (
          txt &&
          txt.length < 80 &&
          /price|moq|order|name|title|usd|us\$/i.test(cls + " " + txt)
        ) {
          textByClass[cls.slice(0, 50)] = txt.replace(/\n/g, " | ").slice(0, 80);
        }
      }
      return {
        links: links.slice(0, 4),
        img: img ? { src: img.getAttribute("src"), dataSrc: img.getAttribute("data-src") } : null,
        textByClass,
      };
    });
  }, cardSel);

  console.log(JSON.stringify(cards, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
