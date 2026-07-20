import { Job } from "bullmq";
import { prisma, Prisma } from "@china/db";
import { getAdapter, getDescriptor } from "@china/adapters";
import { ProductCandidate, SearchJobData } from "@china/shared";
import { setItemStatus } from "../events";

const MAX_PER_MARKETPLACE = Number(
  process.env.MAX_CANDIDATES_PER_MARKETPLACE || 8
);

/**
 * Passo 2 (fan-out): una ricerca = un articolo × un marketplace.
 * Esegue la query nella lingua (o nelle lingue) supportate dall'adapter,
 * deduplica e salva i candidati in DB.
 */
export async function searchProcessor(job: Job<SearchJobData>): Promise<void> {
  const { requestId, itemId, marketplace } = job.data;

  const item = await prisma.requestItem.findUniqueOrThrow({
    where: { id: itemId },
  });
  if (item.status === "PENDING") {
    await setItemStatus(requestId, itemId, "SEARCHING");
  }

  const descriptor = getDescriptor(marketplace);
  const adapter = getAdapter(marketplace);

  const seen = new Set<string>();
  const results: ProductCandidate[] = [];
  for (const language of descriptor.languages) {
    const text = language === "zh" ? item.queryZh : item.queryEn;
    if (!text) continue;
    const found = await adapter.search({
      text,
      language,
      maxResults: MAX_PER_MARKETPLACE,
    });
    for (const c of found) {
      if (seen.has(c.productId)) continue;
      seen.add(c.productId);
      results.push(c);
    }
  }

  for (const c of results.slice(0, MAX_PER_MARKETPLACE)) {
    await prisma.productCandidate.upsert({
      where: {
        itemId_marketplace_externalId: {
          itemId,
          marketplace,
          externalId: c.productId,
        },
      },
      create: {
        itemId,
        marketplace,
        externalId: c.productId,
        title: c.title,
        url: c.url,
        imageUrl: c.imageUrl ?? null,
        priceValue: c.price ? new Prisma.Decimal(c.price.value) : null,
        priceCurrency: c.price?.currency ?? null,
        moq: c.moq ?? null,
        raw: c as unknown as Prisma.InputJsonValue,
      },
      update: {
        title: c.title,
        imageUrl: c.imageUrl ?? null,
        priceValue: c.price ? new Prisma.Decimal(c.price.value) : null,
        priceCurrency: c.price?.currency ?? null,
        moq: c.moq ?? null,
      },
    });
  }
}
