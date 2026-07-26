import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { prisma, Prisma } from "@china/db";
import { buildQueryLadder } from "./query-ladder";
import { mapSearchPayload, type RawTaobaoProduct } from "./taobao-item";

/**
 * «Taobao API by H-W-H» su RapidAPI: la ricerca primaria.
 *
 * Un solo endpoint fisico (`GET /api`) che seleziona l'operazione con il
 * parametro `api=`; qui si usa **solo** `item_search` («Items Search, Simple
 * Details»). Dettagli, SKU e spedizioni restano su DataHub: si pagano solo sui
 * primi candidati, e solo quando servono — spostarli qui non cambierebbe il
 * conto, cambierebbe solo il fornitore a cui lo si paga.
 *
 * La chiave è la **stessa** `RAPIDAPI_KEY` di DataHub (RapidAPI usa una chiave
 * per account, non per API) e vive solo in questo processo: mai nei log, mai
 * nelle risposte, mai a database. I piani però sono separati: per questo le
 * chiamate H-W-H si contano a parte (`hwhCalls`), e un limite raggiunto qui
 * non dice nulla sul piano DataHub — è esattamente il caso in cui il runner
 * passa al fallback.
 *
 * Due particolarità osservate dal vivo (2026-07-24):
 *
 * - il fornitore risponde **HTTP 200 anche in errore**: l'esito vero sta in
 *   `result.status` (`{"msg":"error","code":500,"sub_code":"api.temporarily.
 *   unavailable"}`). Senza quel controllo un guasto upstream sembrerebbe una
 *   ricerca senza risultati;
 * - un `api=` sconosciuto risponde `invalid-parameter:api.<nome>.does.not.
 *   exist` — utile per capire se un errore è di configurazione o del
 *   fornitore.
 */

function env(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Errore del trasporto, con l'indicazione se valga la pena riprovare. */
export class HwhError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string
  ) {
    super(message);
    this.name = "HwhError";
  }
}

/**
 * Errore dichiarato dentro il corpo di una risposta 200.
 *
 * Esportata per i test: la fixture è la risposta vera osservata dal
 * fornitore, e questa funzione è l'unica difesa contro il suo «200 ma
 * errore».
 */
export function readHwhUpstreamError(
  payload: unknown
): { message: string; code: string; retryable: boolean } | null {
  const status = (payload as { result?: { status?: Record<string, unknown> } })?.result
    ?.status;
  if (!status || status.msg !== "error") return null;

  const subCode = typeof status.sub_code === "string" ? status.sub_code : "";
  const code = Number(status.code) || 0;

  if (subCode.startsWith("invalid-parameter")) {
    return {
      message:
        `Taobao API (H-W-H) ha rifiutato i parametri (${subCode}): ` +
        `controlla HWH_API_NAME e HWH_SEARCH_PATH nel .env.`,
      code: "HWH_BAD_PARAMS",
      retryable: false,
    };
  }
  return {
    message: `Taobao API (H-W-H) in errore (${code}${subCode ? `, ${subCode}` : ""}).`,
    code: `HWH_UPSTREAM_${code}`,
    // «temporarily unavailable» e i 5xx del fornitore passano: il fallback
    // DataHub è fatto apposta.
    retryable: subCode.includes("temporarily") || code >= 500,
  };
}

/** Query ordinata: la stessa domanda deve produrre la stessa chiave di cache. */
function sortedQuery(query: URLSearchParams): string {
  return [...query.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** Messaggi che dicono cosa fare, non solo cosa è successo. */
function describeHttpError(status: number, body: string): string {
  const detail = body.slice(0, 200).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) {
    return (
      "Taobao API (H-W-H) ha rifiutato la chiave: verifica RAPIDAPI_KEY e la " +
      "sottoscrizione a questa API su RapidAPI."
    );
  }
  if (status === 429) {
    return "Limite del piano Taobao API (H-W-H) raggiunto: si passa a DataHub.";
  }
  return `Taobao API (H-W-H) ha risposto ${status}${detail ? `: ${detail}` : ""}.`;
}

@Injectable()
export class HwhProvider {
  private readonly logger = new Logger("TaobaoHwh");

  /** Contatori di processo: diagnostica, non fatturazione. */
  private calls = 0;
  private cacheHits = 0;
  private lastError: string | null = null;

  get host(): string {
    return env("HWH_HOST", "taobao-api.p.rapidapi.com");
  }

  private get path(): string {
    return env("HWH_SEARCH_PATH", "/api");
  }

  private get apiName(): string {
    return env("HWH_API_NAME", "item_search");
  }

  private get apiKey(): string {
    return (process.env.RAPIDAPI_KEY ?? "").trim();
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  get cacheTtlHours(): number {
    return numericEnv("HWH_CACHE_HOURS", 168);
  }

  status() {
    return {
      configured: this.isConfigured,
      host: this.host,
      endpoint: `${this.path}?api=${this.apiName}`,
      calls: this.calls,
      cacheHits: this.cacheHits,
      cacheTtlHours: this.cacheTtlHours,
      lastError: this.lastError,
    };
  }

  /**
   * Cerca i candidati di una variante. Stesso contratto di DataHub: il runner
   * deve poter scambiare i due provider senza sapere quale sta usando.
   */
  async search(
    query: string,
    options: { limit?: number; ttlHours?: number; exactQuery?: boolean } = {}
  ): Promise<{
    products: RawTaobaoProduct[];
    fromCache: boolean;
    queryUsed: string;
    attempts: number;
  }> {
    // La v2 protegge i vincoli espliciti e gestisce da sé i retry corretti.
    // Il default conserva esattamente la scala storica usata dalla v1.
    const ladder = options.exactQuery ? [query.trim()].filter(Boolean) : buildQueryLadder(query);
    let fromCache = true;
    let attempts = 0;

    for (const attempt of ladder) {
      attempts += 1;
      const response = await this.call(attempt, options.ttlHours);
      fromCache = fromCache && response.fromCache;

      const products = mapSearchPayload(response.payload, "hwh").slice(
        0,
        options.limit ?? 20
      );
      if (products.length > 0) {
        if (attempts > 1) {
          this.logger.log(`«${query}» senza risultati: trovati con «${attempt}»`);
        }
        return { products, fromCache, queryUsed: attempt, attempts };
      }
    }

    this.logger.warn(`nessun prodotto H-W-H per «${query}» dopo ${attempts} tentativi`);
    return { products: [], fromCache, queryUsed: query, attempts };
  }

  private async call(
    query: string,
    ttlOverride?: number
  ): Promise<{ payload: unknown; fromCache: boolean }> {
    const params = new URLSearchParams({
      api: this.apiName,
      q: query,
      page_size: String(numericEnv("HWH_PAGE_SIZE", 20)),
      sort: env("HWH_SORT", "default"),
    });

    const cacheKey = createHash("sha256")
      .update(`${this.host}|${this.path}|${sortedQuery(params)}`)
      .digest("hex")
      .slice(0, 40);

    const ttlHours = ttlOverride ?? this.cacheTtlHours;
    if (ttlHours > 0) {
      const cached = await prisma.taobaoApiCache.findUnique({ where: { cacheKey } });
      if (cached && Date.now() - cached.fetchedAt.getTime() < ttlHours * 3_600_000) {
        this.cacheHits += 1;
        return { payload: cached.payload, fromCache: true };
      }
    }

    if (!this.isConfigured) {
      throw new HwhError(
        "RAPIDAPI_KEY non configurata: la ricerca Taobao API (H-W-H) non è disponibile.",
        false,
        "HWH_NOT_CONFIGURED"
      );
    }

    const timeoutMs = numericEnv("HWH_TIMEOUT_MS", 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`https://${this.host}${this.path}?${params}`, {
        headers: {
          "x-rapidapi-key": this.apiKey,
          "x-rapidapi-host": this.host,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error).name === "AbortError";
      const message = aborted
        ? `Taobao API (H-W-H) non ha risposto entro ${Math.round(timeoutMs / 1000)}s.`
        : `Taobao API (H-W-H) irraggiungibile: ${(error as Error).message}`;
      this.lastError = message;
      throw new HwhError(message, true, aborted ? "HWH_TIMEOUT" : "HWH_UNREACHABLE");
    } finally {
      clearTimeout(timer);
    }

    this.calls += 1;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = describeHttpError(response.status, body);
      this.lastError = message;
      throw new HwhError(
        message,
        response.status === 429 || response.status >= 500,
        `HWH_HTTP_${response.status}`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const message = "Taobao API (H-W-H) ha risposto con un corpo non JSON.";
      this.lastError = message;
      throw new HwhError(message, true, "HWH_BAD_PAYLOAD");
    }

    const upstream = readHwhUpstreamError(payload);
    if (upstream) {
      this.lastError = upstream.message;
      // Un errore non si mette in cache: si ripagherebbe l'errore.
      throw new HwhError(upstream.message, upstream.retryable, upstream.code);
    }

    this.lastError = null;
    await prisma.taobaoApiCache
      .upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          endpoint: "hwh_search",
          payload: payload as Prisma.InputJsonValue,
          credits: 1,
        },
        update: {
          payload: payload as Prisma.InputJsonValue,
          fetchedAt: new Date(),
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(`cache non salvata: ${(error as Error).message}`)
      );

    return { payload, fromCache: false };
  }
}
