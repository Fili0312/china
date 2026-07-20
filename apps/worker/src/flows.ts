import { FlowProducer, FlowJob } from "bullmq";
import { QUEUES } from "@china/shared";
import { bullConnection } from "./redis";

const flowProducer = new FlowProducer({ connection: bullConnection });

const RETRY = { type: "exponential" as const, delay: 3000 };

/**
 * Costruisce l'albero fan-out/fan-in per una richiesta già parsata:
 *
 *   quote-assemble (root)
 *   └─ item-select × N articoli          (ignoreDependencyOnFailure)
 *      └─ item-search × M marketplace    (ignoreDependencyOnFailure)
 *
 * `ignoreDependencyOnFailure` sui figli fa proseguire il padre anche se un
 * marketplace (o un intero articolo) fallisce dopo tutti i retry: il
 * preventivo esce comunque con ciò che è stato trovato.
 */
export async function enqueueSearchFlow(
  requestId: string,
  itemIds: string[],
  marketplaces: string[]
): Promise<void> {
  const flow: FlowJob = {
    name: "assemble",
    queueName: QUEUES.assemble,
    data: { requestId },
    opts: { attempts: 3, backoff: RETRY },
    children: itemIds.map((itemId) => ({
      name: "select",
      queueName: QUEUES.select,
      data: { requestId, itemId },
      opts: {
        attempts: 2,
        backoff: RETRY,
        ignoreDependencyOnFailure: true,
      },
      children: marketplaces.map((marketplace) => ({
        name: "search",
        queueName: QUEUES.search,
        data: { requestId, itemId, marketplace },
        opts: {
          attempts: 3,
          backoff: RETRY,
          ignoreDependencyOnFailure: true,
        },
      })),
    })),
  };

  await flowProducer.add(flow);
}
