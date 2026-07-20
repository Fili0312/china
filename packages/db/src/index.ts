// Prisma 7: client generato in src/generated + driver adapter pg.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  return new PrismaClient({ adapter });
}

// Singleton: api e worker importano la stessa istanza per processo.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "./generated/client";
