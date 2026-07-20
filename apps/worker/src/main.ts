import "./env";
import { Job, Worker } from "bullmq";
import { closeBrowser } from "@china/adapters";
import { prisma } from "@china/db";
import {
  ParseJobData,
  QUEUES,
  SearchJobData,
  SelectJobData,
} from "@china/shared";
import { setItemStatus, setRequestStatus } from "./events";
import { bullConnection } from "./redis";
import { assembleProcessor } from "./processors/assemble";
import { parseProcessor } from "./processors/parse";
import { searchProcessor } from "./processors/search";
import { selectProcessor } from "./processors/select";

const connection = bullConnection;

const isFinalFailure = (job: Job | undefined) =>
  job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);

const workers = [
  new Worker<ParseJobData>(QUEUES.parse, parseProcessor, {
    connection,
    concurrency: 2,
  }),
  new Worker<SearchJobData>(QUEUES.search, searchProcessor, {
    connection,
    concurrency: Number(process.env.SEARCH_CONCURRENCY || 3),
  }),
  new Worker<SelectJobData>(QUEUES.select, selectProcessor, {
    connection,
    concurrency: 2,
  }),
  new Worker(QUEUES.assemble, assembleProcessor, {
    connection,
    concurrency: 2,
  }),
];

// Errori: dopo l'ultimo retry marca lo stato in DB e notifica la dashboard.
for (const w of workers) {
  w.on("failed", async (job, err) => {
    const message = err?.message ?? "Errore sconosciuto";
    console.error(`[${w.name}] job ${job?.id} fallito:`, message);
    if (!job || !isFinalFailure(job)) return;

    const data = job.data as { requestId?: string; itemId?: string };
    if (!data.requestId) return;

    try {
      if (w.name === QUEUES.parse || w.name === QUEUES.assemble) {
        await setRequestStatus(data.requestId, "FAILED", message);
      } else if (data.itemId) {
        await setItemStatus(data.requestId, data.itemId, "FAILED", message);
      }
    } catch (e) {
      console.error("Impossibile registrare il fallimento:", e);
    }
  });

  w.on("error", (err) => console.error(`[${w.name}] worker error:`, err));
}

console.log(
  `Worker avviato. Code: ${workers.map((w) => w.name).join(", ")} | ` +
    `marketplace: ${process.env.MARKETPLACES || "mock"} | AI_MOCK=${process.env.AI_MOCK || "0"}`
);

async function shutdown() {
  console.log("Arresto worker…");
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeBrowser();
  await prisma.$disconnect();
  await connection.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
