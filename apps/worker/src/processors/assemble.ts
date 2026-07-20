import { Job } from "bullmq";
import { prisma, Prisma } from "@china/db";
import { AssembleJobData } from "@china/shared";
import { publishEvent, setRequestStatus } from "../events";

/**
 * Passo 4 (fan-in finale): applica il ricarico e genera il preventivo.
 * Gira quando tutti i job select sono conclusi (anche se alcuni sono
 * falliti, grazie a ignoreDependencyOnFailure).
 */
export async function assembleProcessor(
  job: Job<AssembleJobData>
): Promise<void> {
  const { requestId } = job.data;
  await setRequestStatus(requestId, "ASSEMBLING");

  const request = await prisma.quoteRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: { candidates: { where: { selectedRank: 1 } } },
      },
    },
  });

  const markupPct = request.markupPct;
  const currency = request.currency;

  let totalCost = 0;
  let totalPrice = 0;

  const lines: Prisma.QuoteLineCreateWithoutQuoteInput[] = request.items.map(
    (item) => {
      const chosen = item.candidates[0] ?? null;
      const unitCost = chosen?.priceValue ? Number(chosen.priceValue) : 0;
      const unitPrice = round4(unitCost * (1 + markupPct / 100));
      const lineTotal = round2(unitPrice * item.quantity);

      totalCost += unitCost * item.quantity;
      totalPrice += lineTotal;

      return {
        itemId: item.id,
        candidateId: chosen?.id ?? null,
        description: item.name,
        quantity: item.quantity,
        unitCost: new Prisma.Decimal(round4(unitCost)),
        unitPrice: new Prisma.Decimal(unitPrice),
        lineTotal: new Prisma.Decimal(lineTotal),
        marketplace: chosen?.marketplace ?? null,
        url: chosen?.url ?? null,
        imageUrl: chosen?.imageUrl ?? null,
        moq: chosen?.moq ?? null,
        variant: chosen?.variant ?? null,
        note: chosen
          ? null
          : "Nessun candidato adeguato trovato: da quotare manualmente.",
      };
    }
  );

  // Re-run del job: sostituisci l'eventuale preventivo precedente.
  await prisma.quote.deleteMany({ where: { requestId } });
  await prisma.quote.create({
    data: {
      requestId,
      currency,
      markupPct,
      totalCost: new Prisma.Decimal(round2(totalCost)),
      totalPrice: new Prisma.Decimal(round2(totalPrice)),
      lines: { create: lines },
    },
  });

  await setRequestStatus(requestId, "READY");
  await publishEvent({
    type: "quote_ready",
    requestId,
    ts: new Date().toISOString(),
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
