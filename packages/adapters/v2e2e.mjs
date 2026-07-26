import { chromium } from "playwright";

const SC = "/tmp/claude-0/-var-www/fd9a45cc-c6e8-408c-b58e-d14462146290/scratchpad";
const URL = "https://filippo.eventoyou.com/china/scouting-v2";
const CLIENT = "Prova v2 " + new Date().toISOString().slice(11, 19);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));

await page.goto(URL, { waitUntil: "networkidle" });
console.log("titolo:", (await page.locator("h1").innerText()).trim());

await page.getByPlaceholder(/client name|nome del cliente|客户名称/).fill(CLIENT);
await page.getByRole("button", { name: /create client/i }).click();
await page.waitForTimeout(1500);

await page.locator('input[type="file"]').setInputFiles(`${SC}/test-v2.xlsx`);
await page.waitForSelector(".v2-estimate", { timeout: 30000 });
console.log("\n--- PREVENTIVO ---");
console.log((await page.locator(".v2-estimate-list").innerText()).trim());
await page.screenshot({ path: `${SC}/v2-estimate.png` });

await page.getByRole("button", { name: /^start$/i }).click();
await page.waitForSelector(".v2-run", { timeout: 20000 });

let last = "";
const deadline = Date.now() + 7 * 60 * 1000;
let shotAsk = false, shotRun = false;
while (Date.now() < deadline) {
  const now = await page.locator(".v2-run-now").innerText().catch(() => "");
  if (now && now !== last) {
    console.log("  " + now.replace(/\n/g, " "));
    last = now;
    if (!shotRun && now.includes("%")) { await page.screenshot({ path: `${SC}/v2-run.png` }); shotRun = true; }
  }
  if (await page.locator(".v2-ask").count()) {
    if (!shotAsk) { await page.screenshot({ path: `${SC}/v2-ask.png` }); shotAsk = true; }
    const qs = await page.locator(".v2-ask-question").allInnerTexts();
    console.log("\n--- DOMANDE (" + qs.length + ") ---");
    qs.forEach((q) => console.log("  ? " + q.trim()));
    const skips = page.locator('.v2-ask-item .chip');
    for (let i = 0; i < (await skips.count()); i++) await skips.nth(i).click();
    await page.getByRole("button", { name: /answer and carry on/i }).click();
    console.log("  -> risposto, riprende\n");
    await page.waitForTimeout(3000);
  }
  if (await page.locator(".v2-done").count()) break;
  await page.waitForTimeout(2500);
}

if (await page.locator(".v2-done").count()) {
  console.log("\n--- ESITO ---");
  console.log((await page.locator(".v2-done").innerText()).trim().slice(0, 1500));
  await page.screenshot({ path: `${SC}/v2-done.png`, fullPage: true });
} else {
  console.log("\n!! non arrivato in fondo entro il limite");
  await page.screenshot({ path: `${SC}/v2-timeout.png`, fullPage: true });
}
console.log("\nerrori JS:", errs.length ? [...new Set(errs)].slice(0, 5) : "nessuno");
await browser.close();
