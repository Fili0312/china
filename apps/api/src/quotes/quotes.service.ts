import { Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@china/db";
import { CreateQuoteRequest, QUEUES } from "@china/shared";

@Injectable()
export class QuotesService implements OnModuleDestroy {
  private readonly connection = new IORedis(
    process.env.REDIS_URL || "redis://localhost:6379",
    { maxRetriesPerRequest: null }
  );
  private readonly parseQueue = new Queue(QUEUES.parse, {
    connection: this.connection,
  });

  async create(input: CreateQuoteRequest) {
    const request = await prisma.quoteRequest.create({
      data: {
        rawText: input.text,
        markupPct:
          input.markupPct ?? Number(process.env.MARKUP_DEFAULT_PCT || 30),
        currency: process.env.QUOTE_CURRENCY || "USD",
      },
    });

    await this.parseQueue.add(
      "parse",
      { requestId: request.id },
      { attempts: 3, backoff: { type: "exponential", delay: 3000 } }
    );

    return { id: request.id, status: request.status };
  }

  async list() {
    return prisma.quoteRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        markupPct: true,
        createdAt: true,
        error: true,
        rawText: true,
        _count: { select: { items: true } },
      },
    });
  }

  async get(id: string) {
    const request = await prisma.quoteRequest.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { position: "asc" },
          include: {
            candidates: {
              where: { selectedRank: { not: null } },
              orderBy: { selectedRank: "asc" },
            },
          },
        },
        quote: { include: { lines: true } },
      },
    });
    if (!request) throw new NotFoundException("Richiesta non trovata");
    return request;
  }

  async onModuleDestroy() {
    await this.parseQueue.close();
    await this.connection.quit().catch(() => {});
  }
}
