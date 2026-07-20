import { Job } from "bullmq";
import { prisma } from "@china/db";
import { generateQueries, parseRequest } from "@china/ai";
import { activeMarketplaces } from "@china/adapters";
import { ParseJobData } from "@china/shared";
import { publishEvent, setRequestStatus } from "../events";
import { enqueueSearchFlow } from "../flows";

/**
 * Passo 1: messaggio libero → lista strutturata (Claude) → query EN/ZH
 * (Claude) → creazione articoli in DB → costruzione del flow di ricerca.
 */
export async function parseProcessor(job: Job<ParseJobData>): Promise<void> {
  const { requestId } = job.data;
  const request = await prisma.quoteRequest.findUniqueOrThrow({
    where: { id: requestId },
  });

  await setRequestStatus(requestId, "PARSING");

  const parsed = await parseRequest(request.rawText);
  if (parsed.items.length === 0) {
    throw new Error("Nessun prodotto riconosciuto nel messaggio.");
  }
  await publishEvent({
    type: "log",
    requestId,
    message: `Riconosciuti ${parsed.items.length} articoli, genero le query di ricerca…`,
    ts: new Date().toISOString(),
  });

  const { queries } = await generateQueries(parsed.items);
  const queryByIndex = new Map(queries.map((q) => [q.index, q]));

  // Re-run del job dopo un fallimento a metà: riparti pulito.
  await prisma.requestItem.deleteMany({ where: { requestId } });

  const itemIds: string[] = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const it = parsed.items[i];
    const q = queryByIndex.get(i);
    const created = await prisma.requestItem.create({
      data: {
        requestId,
        position: i,
        name: it.name,
        quantity: it.quantity,
        color: it.color,
        size: it.size,
        attributes: it.attributes ?? {},
        notes: it.notes,
        queryEn: q?.queryEn ?? it.name,
        queryZh: q?.queryZh ?? null,
        status: "PENDING",
      },
    });
    itemIds.push(created.id);
  }

  await setRequestStatus(requestId, "SEARCHING");
  await enqueueSearchFlow(requestId, itemIds, activeMarketplaces());
}
