/**
 * Utility CLI per provare un adapter senza passare dalla pipeline:
 *   pnpm --filter @china/worker exec tsx src/tools/test-adapter.ts alibaba "ceramic mug custom logo"
 */
import "../env";
import { closeBrowser, getAdapter } from "@china/adapters";

async function main() {
  const [marketplace, ...rest] = process.argv.slice(2);
  const text = rest.join(" ");
  if (!marketplace || !text) {
    console.error("Uso: test-adapter.ts <marketplace> <query>");
    process.exit(1);
  }

  console.log(`[${marketplace}] ricerca: "${text}"`);
  const adapter = getAdapter(marketplace);
  const started = Date.now();
  const results = await adapter.search({ text, language: "en", maxResults: 5 });
  console.log(
    `→ ${results.length} candidati in ${((Date.now() - started) / 1000).toFixed(1)}s\n`
  );
  for (const r of results) {
    console.log(
      `- ${r.title.slice(0, 80)}\n  ${r.price ? `${r.price.value} ${r.price.currency}` : "prezzo n/d"}${
        r.moq ? ` | MOQ ${r.moq}` : ""
      }\n  ${r.url}`
    );
  }

  if (results[0]) {
    console.log(`\nDettagli del primo candidato…`);
    const d = await adapter.getDetails(results[0].productId);
    console.log(
      `  ${d.title.slice(0, 80)}\n  prezzo: ${d.price ? `${d.price.value} ${d.price.currency}` : "n/d"} | MOQ: ${d.moq ?? "n/d"}`
    );
  }

  await closeBrowser();
}

main().catch((err) => {
  console.error("Errore:", err);
  process.exit(1);
});
