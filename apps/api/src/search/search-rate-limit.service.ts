import { createHash } from "node:crypto";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";

interface LocalWindow {
  windowStartedAt: number;
  requests: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Rate limit condiviso tra processi tramite Redis, con fallback locale se Redis
 * è momentaneamente indisponibile. L'IP viene hashato prima di diventare key.
 */
@Injectable()
export class SearchRateLimitService implements OnModuleDestroy {
  private readonly redis = new IORedis(
    process.env.REDIS_URL || "redis://localhost:6379",
    {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
    }
  );
  private connectPromise: Promise<void> | null = null;
  private readonly fallback = new Map<string, LocalWindow>();

  async consume(client: string): Promise<RateLimitDecision> {
    const limit = Math.max(
      1,
      Number.parseInt(
        process.env.SEARCH_RATE_LIMIT_PER_MINUTE || "120",
        10
      ) || 120
    );
    const now = Date.now();
    const bucket = Math.floor(now / 60_000);
    const identity = createHash("sha256").update(client).digest("hex").slice(0, 24);
    const key = `china:search:rate:${identity}:${bucket}`;
    const retryAfterSeconds = Math.max(
      1,
      60 - Math.floor((now % 60_000) / 1_000)
    );

    try {
      await this.ensureConnected();
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 120);
      return { allowed: count <= limit, retryAfterSeconds };
    } catch {
      return this.consumeFallback(identity, limit, now);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === "ready") return;
    if (!this.connectPromise) {
      this.connectPromise = this.redis
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectPromise = null;
        });
    }
    await this.connectPromise;
  }

  private consumeFallback(
    identity: string,
    limit: number,
    now: number
  ): RateLimitDecision {
    const current = this.fallback.get(identity);
    if (!current || now - current.windowStartedAt >= 60_000) {
      this.fallback.set(identity, { windowStartedAt: now, requests: 1 });
      return { allowed: true, retryAfterSeconds: 60 };
    }
    current.requests += 1;
    if (this.fallback.size > 2_000) {
      for (const [key, entry] of this.fallback) {
        if (now - entry.windowStartedAt >= 60_000) this.fallback.delete(key);
      }
    }
    return {
      allowed: current.requests <= limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((60_000 - (now - current.windowStartedAt)) / 1_000)
      ),
    };
  }

  async onModuleDestroy() {
    if (this.redis.status !== "end") this.redis.disconnect();
  }
}
