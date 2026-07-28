/**
 * Rigiudica i candidati respinti di una corsa già chiusa e rifà il conto.
 *
 * Serve dopo una modifica alle regole di giudizio: gli stessi titoli, la
 * stessa evidenza, ma criteri nuovi. Nessuna chiamata al marketplace — i
 * candidati sono già a database. L'unico costo è il modello che giudica.
 *
 * Rigiudica solo i `incoherent`: sono gli unici che possono cambiare esito,
 * perché una riga si sblocca solo se un rifiuto torna valutabile. Chi era già
 * accettato resta accettato.
 */
import { NestFactory } from "@nestjs/core";
import { prisma } from "@china/db";
import { verifyCandidateCoherence, type CoherenceInputRow } from "@china/ai";
import type { ProductAnalysis } from "@china/shared";
import { AppModule } from "../src/app.module";
import { PipelineService } from "../src/taobao/pipeline.service";

const PIPELINE = process.env.REJUDGE_PIPELINE ?? "cms4jag2q00dv7st7jaeyxgas";
const BATCH = Number(process.env.REJUDGE_BATCH ?? 8);

function describeRequest(analysis: ProductAnalysis | null, searchQuery: string | null): string {
  if (!analysis) return `Richiesta del foglio: ${searchQuery ?? "(non indicata)"}`;
  return [
    `Prodotto richiesto: ${analysis.productFamily}`,
    analysis.productNameChinese ? `Nome cinese: ${analysis.productNameChinese}` : null,
    analysis.model ? `Modello: ${analysis.model}` : null,
    analysis.material ? `Materiale: ${analysis.material}` : null,
    analysis.color ? `Colore: ${analysis.color}` : null,
    analysis.dimensions?.length
      ? `Misure: ${analysis.dimensions
          .map((d) => `${d.label ?? ""} ${d.value ?? ""}${d.unit ?? ""}`.trim())
          .join(", ")}`
      : null,
    analysis.technicalSpecifications?.length
      ? `Specifiche: ${analysis.technicalSpecifications.join("; ")}`
      : null,
    analysis.hardRequirements?.length
      ? `Vincoli obbligatori: ${analysis.hardRequirements.join("; ")}`
      : null,
    `Query usata: ${searchQuery ?? "(non indicata)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function describeCandidate(product: {
  title: string;
  platform: string;
  price: unknown;
  promotionPrice: unknown;
  currency: string | null;
  shopName: string | null;
  titleEn: string | null;
}): string {
  const price = product.promotionPrice ?? product.price;
  return [
    `Titolo: ${product.title}`,
    product.titleEn ? `Titolo tradotto: ${product.titleEn}` : null,
    `Marketplace: ${product.platform}`,
    price != null ? `Prezzo: ${Number(price)} ${product.currency ?? "CNY"}` : null,
    product.shopName ? `Negozio: ${product.shopName}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: PIPELINE } });
  if (!pipeline.jobId) throw new Error("la pipeline non ha un job associato");

  const before = pipeline.outcome as {
    confirmedRows?: number;
    uncertainRows?: number;
    uncoveredRows?: number;
    searchCalls?: number;
  } | null;

  const rejected = await prisma.taobaoJobResult.findMany({
    where: { jobRow: { jobId: pipeline.jobId } },
    select: {
      id: true,
      coherence: true,
      jobRow: {
        select: {
          rowNumber: true,
          searchQuery: true,
          analysisRow: { select: { effectiveAnalysis: true } },
        },
      },
      product: {
        select: {
          title: true,
          titleEn: true,
          platform: true,
          price: true,
          promotionPrice: true,
          currency: true,
          shopName: true,
        },
      },
    },
  });

  const targets = rejected.filter(
    (entry) => (entry.coherence as { verdict?: string } | null)?.verdict === "incoherent"
  );
  console.log(`da rigiudicare: ${targets.length} candidati respinti`);

  let cost = 0;
  let flipped = 0;
  const tally = { coherent: 0, unsure: 0, incoherent: 0 };

  for (let start = 0; start < targets.length; start += BATCH) {
    const slice = targets.slice(start, start + BATCH);
    const rows: CoherenceInputRow[] = slice.map((entry, index) => ({
      rowIndex: index,
      request: describeRequest(
        (entry.jobRow.analysisRow?.effectiveAnalysis ?? null) as ProductAnalysis | null,
        entry.jobRow.searchQuery
      ),
      candidates: [{ candidateIndex: 0, description: describeCandidate(entry.product) }],
    }));

    let result;
    try {
      result = await verifyCandidateCoherence(rows, { timeoutMs: 120_000 });
    } catch (error) {
      console.warn(`  lotto ${start} saltato: ${(error as Error).message}`);
      continue;
    }
    cost += result.costUsd;

    for (const [index, entry] of slice.entries()) {
      const verdict = result.verdicts.get(`${index}:0`);
      if (!verdict) continue;
      tally[verdict.verdict] += 1;
      if (verdict.verdict !== "incoherent") flipped += 1;
      const previous = entry.coherence as Record<string, unknown>;
      await prisma.taobaoJobResult.update({
        where: { id: entry.id },
        data: {
          coherence: {
            ...previous,
            verdict: verdict.verdict,
            issues: verdict.issues,
            question: verdict.question,
            confidence: verdict.confidence,
            model: result.model,
            rejudgedAt: new Date().toISOString(),
          },
          coherenceCheckedAt: new Date(),
        },
      });
    }

    if ((start / BATCH) % 10 === 0) {
      console.log(
        `  ${Math.min(start + BATCH, targets.length)}/${targets.length} · recuperati ${flipped} · $${cost.toFixed(4)}`
      );
    }
  }

  console.log(`\nverdetti nuovi: coherent ${tally.coherent} · unsure ${tally.unsure} · incoherent ${tally.incoherent}`);
  console.log(`candidati recuperati: ${flipped} su ${targets.length}`);
  console.log(`costo modello: $${cost.toFixed(4)}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  // `strict: false`: PipelineService vive in TaobaoModule, non nel modulo
  // radice. Senza questo Nest ne restituisce uno senza dipendenze iniettate.
  const after = await app
    .get(PipelineService, { strict: false })
    .recomputeOutcome(PIPELINE);
  await app.close();

  console.log("\n            prima   dopo");
  console.log(`confermati   ${String(before?.confirmedRows ?? "?").padStart(5)}  ${String(after.confirmedRows).padStart(5)}`);
  console.log(`da confermare${String(before?.uncertainRows ?? "?").padStart(5)}  ${String(after.uncertainRows).padStart(5)}`);
  console.log(`non trovati  ${String(before?.uncoveredRows ?? "?").padStart(5)}  ${String(after.uncoveredRows).padStart(5)}`);

  await prisma.$disconnect();
}

void main();
