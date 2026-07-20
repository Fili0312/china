import { prisma, ItemStatus, RequestStatus } from "@china/db";
import { eventsChannel, QuoteEvent } from "@china/shared";
import { pubClient } from "./redis";

export async function publishEvent(event: QuoteEvent): Promise<void> {
  await pubClient
    .publish(eventsChannel(event.requestId), JSON.stringify(event))
    .catch((err) => console.error("publishEvent:", err));
}

/** Aggiorna lo stato della richiesta in DB e notifica via pub/sub. */
export async function setRequestStatus(
  requestId: string,
  status: RequestStatus,
  error?: string
): Promise<void> {
  await prisma.quoteRequest.update({
    where: { id: requestId },
    data: { status, error: error ?? null },
  });
  await publishEvent({
    type: "request_status",
    requestId,
    status,
    error,
    ts: new Date().toISOString(),
  });
}

/** Aggiorna lo stato di un articolo in DB e notifica via pub/sub. */
export async function setItemStatus(
  requestId: string,
  itemId: string,
  status: ItemStatus,
  error?: string
): Promise<void> {
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status, error: error ?? null },
  });
  await publishEvent({
    type: "item_status",
    requestId,
    itemId,
    status,
    error,
    ts: new Date().toISOString(),
  });
}
