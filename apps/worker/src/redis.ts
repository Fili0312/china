import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/** Connessione per BullMQ (richiede maxRetriesPerRequest: null). */
export const bullConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

/** Connessione separata per il publish degli eventi di avanzamento. */
export const pubClient = new IORedis(REDIS_URL);
