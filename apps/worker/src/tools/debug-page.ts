/**
 * Debug: apre la pagina di ricerca di un marketplace e stampa cosa contiene
 * (titolo, eventuale captcha, conteggio link prodotto, classi più frequenti).
 *   pnpm --filter @china/worker exec tsx src/tools/debug-page.ts <url>
 */
import "../env";
import { chromium } from "playwright";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Uso: debug-page.ts <url>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  console.log("titolo pagina:", await page.title());
  console.log("url finale:", page.url());

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 400);
  console.log("\nprimi 400 caratteri visibili:\n", bodyText.replace(/\n+/g, " | "));

  const productLinks = await page
    .locator('a[href*="product-detail"], a[href*="/product/"], a[href*=".html"]')
    .count();
  console.log("\nlink 'prodotto':", productLinks);

  // classi più frequenti dei div (per trovare i selettori delle card)
  const classCount = await page.evaluate(() => {
    const counts: Record<string, number> = {};
    document.querySelectorAll("div[class]").forEach((el) => {
      el.classList.forEach((c) => {
        counts[c] = (counts[c] || 0) + 1;
      });
    });
    return Object.entries(counts)
      .filter(([, n]) => n >= 10 && n <= 60)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);
  });
  console.log("\nclassi ripetute 10-60 volte (probabili card):");
  for (const [cls, n] of classCount) console.log(`  ${n}× .${cls}`);

  await page.screenshot({
    path: "/tmp/claude-0/-var-www/84973b91-7d91-42e8-a620-496e8e44e192/scratchpad/debug-page.png",
    fullPage: false,
  });
  console.log("\nscreenshot: scratchpad/debug-page.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
