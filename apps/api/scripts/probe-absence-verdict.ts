/**
 * Sonda controllata sul nuovo giudizio: quanti rifiuti «per silenzio» cadono?
 *
 * Rigiudica un campione di candidati già respinti nella corsa del 28/07,
 * separando quelli respinti solo per assenza di menzione (che dovrebbero
 * diventare `unsure`) da quelli respinti perché il prodotto era di un'altra
 * famiglia (che devono restare `incoherent`). Il secondo gruppo è il
 * controllo: serve a dimostrare che il prompt non è diventato permissivo.
 *
 * Usa DeepSeek reale. Costo misurato e stampato in fondo.
 */
import { prisma } from "@china/db";
import { verifyCandidateCoherence, type CoherenceInputRow } from "@china/ai";
import type { ProductAnalysis } from "@china/shared";

/** La richiesta come la vede il giudice vero: famiglia, modello, misure, vincoli. */
function describeRequest(analysis: ProductAnalysis | null, searchQuery: string | null): string {
  if (!analysis) return `Richiesta del foglio: ${searchQuery ?? "(non indicata)"}`;
  const lines = [
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
  ];
  return lines.filter(Boolean).join("\n");
}

const JOB = process.env.PROBE_JOB ?? "cms4jrq3101h87st7xik3qy5e";
const PER_GROUP = Number(process.env.PROBE_PER_GROUP ?? 20);

const ABSENCE =
  /non menziona|non specifica|non è specificat|non viene indicat|non riporta|non è indicat/i;

async function main() {
  const rejected = await prisma.taobaoJobResult.findMany({
    where: { jobRow: { jobId: JOB }, NOT: { coherence: { equals: null } } },
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
          price: true,
          promotionPrice: true,
          currency: true,
          shopName: true,
          platform: true,
        },
      },
    },
  });

  const absence: typeof rejected = [];
  const family: typeof rejected = [];
  for (const entry of rejected) {
    const coherence = entry.coherence as { verdict?: string; issues?: string[] } | null;
    if (coherence?.verdict !== "incoherent") continue;
    const issues = coherence.issues ?? [];
    if (issues.length === 0) continue;
    if (issues.every((issue) => ABSENCE.test(issue))) absence.push(entry);
    else family.push(entry);
  }

  const sample = [...absence.slice(0, PER_GROUP), ...family.slice(0, PER_GROUP)];
  const group = new Map<number, "assenza" | "famiglia">();

  const rows: CoherenceInputRow[] = sample.map((entry, index) => {
    group.set(index, index < Math.min(PER_GROUP, absence.length) ? "assenza" : "famiglia");
    const price = entry.product.promotionPrice ?? entry.product.price;
    return {
      rowIndex: index,
      request: describeRequest(
        (entry.jobRow.analysisRow?.effectiveAnalysis ?? null) as ProductAnalysis | null,
        entry.jobRow.searchQuery
      ),
      candidates: [
        {
          candidateIndex: 0,
          description: [
            `Titolo: ${entry.product.title}`,
            `Marketplace: ${entry.product.platform}`,
            price != null ? `Prezzo: ${Number(price)} ${entry.product.currency ?? "CNY"}` : null,
            entry.product.shopName ? `Negozio: ${entry.product.shopName}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  });

  console.log(`campione: ${rows.length} candidati (assenza ${Math.min(PER_GROUP, absence.length)}, famiglia ${Math.min(PER_GROUP, family.length)})`);
  console.log(`disponibili in totale: assenza ${absence.length}, famiglia ${family.length}\n`);

  const tally = { assenza: { unsure: 0, incoherent: 0, coherent: 0 }, famiglia: { unsure: 0, incoherent: 0, coherent: 0 } };
  let cost = 0;

  for (let start = 0; start < rows.length; start += 10) {
    const batch = rows.slice(start, start + 10);
    const result = await verifyCandidateCoherence(batch, { timeoutMs: 120_000 });
    cost += result.costUsd;
    for (const row of batch) {
      const verdict = result.verdicts.get(`${row.rowIndex}:0`)?.verdict;
      const bucket = group.get(row.rowIndex)!;
      if (verdict === "unsure") tally[bucket].unsure += 1;
      else if (verdict === "coherent") tally[bucket].coherent += 1;
      else tally[bucket].incoherent += 1;
      if (bucket === "famiglia" && verdict !== "incoherent") {
        const entry = sample[row.rowIndex]!;
        const before = (entry.coherence as { issues?: string[] }).issues?.[0] ?? "";
        const after = result.verdicts.get(`${row.rowIndex}:0`)?.issues?.[0] ?? "";
        console.log(`  [ammorbidito → ${verdict}] riga ${entry.jobRow.rowNumber} · ${entry.jobRow.searchQuery}`);
        console.log(`     titolo: ${entry.product.title.slice(0, 70)}`);
        console.log(`     prima : ${before.slice(0, 110)}`);
        console.log(`     dopo  : ${after.slice(0, 110)}`);
      }
    }
  }

  console.log("respinti SOLO per assenza di menzione (attesi: non più respinti)");
  console.log(`  unsure ${tally.assenza.unsure} · coherent ${tally.assenza.coherent} · incoherent ${tally.assenza.incoherent}`);
  console.log("respinti per famiglia/misura sbagliata (controllo: devono restare respinti)");
  console.log(`  unsure ${tally.famiglia.unsure} · coherent ${tally.famiglia.coherent} · incoherent ${tally.famiglia.incoherent}`);
  console.log(`\ncosto DeepSeek: $${cost.toFixed(5)}`);
  await prisma.$disconnect();
}

void main();
