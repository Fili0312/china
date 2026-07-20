import { Job } from "bullmq";
import { prisma, Prisma } from "@china/db";
import { matchCandidates } from "@china/ai";
import { getAdapter } from "@china/adapters";
import { SelectJobData } from "@china/shared";
import { setItemStatus } from "../events";

/**
 * Passo 3 (fan-in per articolo): raccoglie i candidati di tutti i marketplace,
 * fa scegliere a Claude i 2-3 migliori, poi recupera i dettagli (prezzo
 * aggiornato, MOQ, variante, immagine) per i soli candidati scelti.
 */
export async function selectProcessor(job: Job<SelectJobData>): Promise<void> {
  const { requestId, itemId } = job.data;

  const item = await prisma.requestItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { candidates: true },
  });

  if (item.candidates.length === 0) {
    await setItemStatus(requestId, itemId, "NO_RESULTS");
    return;
  }

  await setItemStatus(requestId, itemId, "MATCHING");

  const { selections } = await matchCandidates(
    {
      name: item.name,
      quantity: item.quantity,
      color: item.color,
      size: item.size,
      attributes: (item.attributes as Record<string, string> | null) ?? {},
      notes: item.notes,
    },
    item.candidates.map((c) => ({
      id: c.id,
      marketplace: c.marketplace,
      title: c.title,
      price: c.priceValue
        ? `${c.priceValue.toString()} ${c.priceCurrency ?? "USD"}`
        : null,
      moq: c.moq,
      snippet: null,
    }))
  );

  if (selections.length === 0) {
    await setItemStatus(requestId, itemId, "NO_RESULTS");
    return;
  }

  // Azzera selezioni precedenti (re-run del job dopo retry).
  await prisma.productCandidate.updateMany({
    where: { itemId },
    data: { selectedRank: null, score: null, reason: null, variant: null },
  });

  for (let rank = 0; rank < selections.length; rank++) {
    const sel = selections[rank];
    const candidate = item.candidates.find((c) => c.id === sel.candidateId);
    if (!candidate) continue;

    // Dettagli best-effort: se lo scraping del dettaglio fallisce, restano
    // i dati della ricerca (prezzo/MOQ di lista).
    let detailsData: Prisma.ProductCandidateUpdateInput = {};
    try {
      const adapter = getAdapter(candidate.marketplace);
      const details = await adapter.getDetails(candidate.externalId);
      const tierPrice = applicableTierPrice(details.priceTiers, item.quantity);
      const price = tierPrice ?? details.price ?? null;
      detailsData = {
        title: details.title || candidate.title,
        imageUrl: details.imageUrl ?? candidate.imageUrl,
        priceValue: price ? new Prisma.Decimal(price.value) : candidate.priceValue,
        priceCurrency: price?.currency ?? candidate.priceCurrency,
        moq: details.moq ?? candidate.moq,
        raw: details as unknown as Prisma.InputJsonValue,
      };
    } catch (err) {
      console.warn(
        `getDetails fallito per ${candidate.marketplace}/${candidate.externalId}:`,
        err instanceof Error ? err.message : err
      );
    }

    await prisma.productCandidate.update({
      where: { id: candidate.id },
      data: {
        ...detailsData,
        selectedRank: rank + 1,
        score: sel.score,
        reason: sel.reason,
        variant: sel.variant,
      },
    });
  }

  await setItemStatus(requestId, itemId, "SELECTED");
}

function applicableTierPrice(
  tiers: { minQty: number; price: { value: number; currency: string } }[],
  quantity: number
): { value: number; currency: string } | null {
  const applicable = tiers
    .filter((t) => t.minQty <= quantity)
    .sort((a, b) => b.minQty - a.minQty);
  return applicable[0]?.price ?? tiers[0]?.price ?? null;
}
