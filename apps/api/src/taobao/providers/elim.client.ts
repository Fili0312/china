import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { prisma, Prisma } from "@china/db";
import type { TaobaoPlatform } from "@china/shared";

/**
 * Trasporto verso ElimAPI (`openapi.elim.asia`).
 *
 * È la **seconda** fonte: DataHub resta la prima, questa interviene quando
 * quella non basta. Averne due non è ridondanza — sono due fornitori con
 * cataloghi, limiti e piani diversi, e la riga che l'uno non trova spesso
 * l'altro la trova.
 *
 * ## Cosa è stato verificato, e cosa no
 *
 * I parametri qui sotto non sono dedotti: vengono dallo Swagger ufficiale
 * (`/api-json`) e sono stati provati con chiamate reali il 2026-07-22.
 *
 * - la ricerca è **`POST /v1/products/search`**, non una GET;
 * - `platform` accetta `taobao` e **`alibaba`** — e `alibaba` è 1688:
 *   i link restituiti sono `detail.1688.com`, verificato;
 * - risponde **HTTP 201**, non 200, perché è una POST: accettare solo 200
 *   avrebbe fatto fallire ogni ricerca riuscita;
 * - `q`, `page` e `size` sono obbligatori; `lang` accetta `vi` (predefinito) e
 *   `en`; `sort` accetta sei valori, tutti maiuscoli.
 *
 * ## La chiave
 *
 * `ELI_API` viaggia nell'header `x-api-key` e vive solo in questo file. Non
 * compare in un log, in una risposta o a database: `status()` dice se è
 * configurata, mai quanto vale.
 *
 * ## Il piano
 *
 * Il piano gratuito include 200 richieste al mese. Per questo ogni risposta
 * finisce in cache (`TaobaoApiCache`, chiave = piattaforma + parametri) e i
 * contatori distinguono le chiamate vere da quelle risparmiate: senza, il
 * primo file da 500 righe esaurirebbe il mese.
 */

/** Ordinamenti accettati dall'API, verbatim dallo Swagger. */
export const ELIM_SORTS = [
  "PRICE_ASC",
  "PRICE_DESC",
  "SALE_QTY_ASC",
  "SALE_QTY_DESC",
  "RETENTION_ASC",
  "RETENTION_DESC",
] as const;
export type ElimSort = (typeof ELIM_SORTS)[number];

/**
 * Nome della piattaforma **come lo vuole ElimAPI**.
 *
 * La traduzione sta qui e in un punto solo: dentro il progetto un marketplace
 * si chiama `1688` — il nome con cui lo conosce chi compra — e `alibaba` è un
 * dettaglio di questo fornitore, non un concetto da propagare.
 */
export function elimPlatform(platform: TaobaoPlatform): "taobao" | "alibaba" {
  return platform === "1688" ? "alibaba" : "taobao";
}

export interface ElimSearchParams {
  q: string;
  platform: TaobaoPlatform;
  page?: number;
  size?: number;
  lang?: "en" | "vi";
  sort?: ElimSort;
}

/** Errore del trasporto, con l'indicazione se valga la pena riprovare. */
export class ElimApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string
  ) {
    super(message);
    this.name = "ElimApiError";
  }
}

export interface ElimResponse {
  payload: unknown;
  fromCache: boolean;
}

function env(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class ElimApiClient {
  private readonly logger = new Logger("ElimApi");

  private calls = 0;
  private cacheHits = 0;
  private lastError: string | null = null;

  get baseUrl(): string {
    return env("ELI_API_BASE_URL", "https://openapi.elim.asia/v1").replace(/\/+$/, "");
  }

  private get apiKey(): string {
    return (process.env.ELI_API ?? "").trim();
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  get cacheTtlHours(): number {
    return numericEnv("ELIM_CACHE_HOURS", 168);
  }

  status() {
    return {
      configured: this.isConfigured,
      baseUrl: this.baseUrl,
      endpoint: "POST /products/search",
      platforms: ["taobao", "1688"] as TaobaoPlatform[],
      calls: this.calls,
      cacheHits: this.cacheHits,
      cacheTtlHours: this.cacheTtlHours,
      lastError: this.lastError,
    };
  }

  /**
   * Ricerca per parola chiave.
   *
   * La chiave di cache comprende **tutti** i parametri che cambiano il
   * risultato — piattaforma, lingua, ordinamento, pagina — altrimenti una
   * ricerca su 1688 servirebbe i risultati salvati per Taobao.
   */
  /**
   * Il dettaglio di un'inserzione: titolo, prezzo e **l'elenco delle varianti**.
   *
   * È l'unica fonte configurata che sappia dire quali SKU esistono su una
   * pagina e quanto costa ciascuna — DataHub non ce l'ha proprio (`/item_sku`,
   * `/item_desc`, `/item_detail_v2` rispondono «endpoint does not exist», e
   * `item_detail` risponde 205 da sempre). Serve alla v3 per risolvere i link
   * che il cliente mette nel foglio senza spendere una ricerca.
   *
   * La cache è quella condivisa e la stessa scadenza della ricerca: il prezzo
   * di una variante non cambia da un'ora all'altra, e il piano di questa API
   * è piccolo — 200 richieste al mese sul gratuito. Una chiamata per articolo,
   * non per riga.
   */
  async detail(
    itemId: string,
    platform: TaobaoPlatform,
    options: { ttlHours?: number } = {}
  ): Promise<ElimResponse> {
    const body = { id: itemId, platform: elimPlatform(platform) };
    const cacheKey = createHash("sha256")
      .update(`elim|${this.baseUrl}|detail|${JSON.stringify(body)}`)
      .digest("hex")
      .slice(0, 40);

    const ttlHours = options.ttlHours ?? this.cacheTtlHours;
    if (ttlHours > 0) {
      const cached = await prisma.taobaoApiCache.findUnique({ where: { cacheKey } });
      if (cached && Date.now() - cached.fetchedAt.getTime() < ttlHours * 3_600_000) {
        this.cacheHits += 1;
        return { payload: cached.payload, fromCache: true };
      }
    }

    if (!this.isConfigured) {
      throw new ElimApiError(
        "ELI_API non configurata: il dettaglio prodotto non è disponibile.",
        false,
        "ELIM_NOT_CONFIGURED"
      );
    }

    const payload = await this.post("/products/detail", body);
    await prisma.taobaoApiCache
      .upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          endpoint: `elim-detail-${body.platform}`,
          payload: payload as never,
          credits: 1,
        },
        update: { payload: payload as never, fetchedAt: new Date(), credits: 1 },
      })
      .catch(() => undefined);
    this.calls += 1;
    return { payload, fromCache: false };
  }

  async search(
    params: ElimSearchParams,
    options: { ttlHours?: number } = {}
  ): Promise<ElimResponse> {
    const body = {
      q: params.q,
      platform: elimPlatform(params.platform),
      lang: params.lang ?? "en",
      page: params.page ?? 1,
      size: params.size ?? 20,
      ...(params.sort ? { sort: params.sort } : {}),
    };

    const cacheKey = createHash("sha256")
      .update(`elim|${this.baseUrl}|search|${JSON.stringify(body)}`)
      .digest("hex")
      .slice(0, 40);
    const endpoint = `elim-search-${body.platform}`;

    const ttlHours = options.ttlHours ?? this.cacheTtlHours;
    if (ttlHours > 0) {
      const cached = await prisma.taobaoApiCache.findUnique({ where: { cacheKey } });
      if (cached && Date.now() - cached.fetchedAt.getTime() < ttlHours * 3_600_000) {
        this.cacheHits += 1;
        return { payload: cached.payload, fromCache: true };
      }
    }

    if (!this.isConfigured) {
      throw new ElimApiError(
        "ELI_API non configurata: la ricerca ElimAPI non è disponibile.",
        false,
        "ELIM_NOT_CONFIGURED"
      );
    }

    const payload = await this.post("/products/search", body);

    await prisma.taobaoApiCache
      .upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          endpoint,
          payload: payload as Prisma.InputJsonValue,
          credits: 1,
        },
        update: { payload: payload as Prisma.InputJsonValue, fetchedAt: new Date() },
      })
      .catch((error: unknown) =>
        this.logger.warn(`cache non salvata: ${(error as Error).message}`)
      );

    return { payload, fromCache: false };
  }

  /**
   * Stato del piano: richieste incluse, usate e residue.
   *
   * Serve a poter dire «restano N richieste» invece di scoprirlo con un 402 a
   * metà di un file. Non passa dalla cache: è un dato che cambia a ogni
   * ricerca, e una risposta di ieri qui varrebbe zero.
   */
  async planStatus(): Promise<unknown> {
    if (!this.isConfigured) {
      throw new ElimApiError(
        "ELI_API non configurata.",
        false,
        "ELIM_NOT_CONFIGURED"
      );
    }
    return this.get("/me/plan-status");
  }

  /* ------------------------------------------------------------------ */
  /* HTTP                                                                */
  /* ------------------------------------------------------------------ */

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  /**
   * Una richiesta, con un solo nuovo tentativo sugli errori che lo meritano.
   *
   * Ritentare un 429 o un errore di rete ha senso; ritentare un 401 o un 402
   * no — la chiave sbagliata resta sbagliata e il credito esaurito non torna,
   * e ogni tentativo in più sarebbe una richiesta consumata per nulla.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const timeoutMs = numericEnv("ELIM_TIMEOUT_MS", 30_000);
    const maxAttempts = Math.max(1, numericEnv("ELIM_MAX_ATTEMPTS", 2));

    let lastError: ElimApiError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            "x-api-key": this.apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          signal: controller.signal,
        });

        // Una POST riuscita risponde 201: accettare solo 200 avrebbe fatto
        // fallire ogni ricerca andata a buon fine.
        if (response.ok) {
          this.calls += 1;
          this.lastError = null;
          return await response.json();
        }

        const detail = (await response.text().catch(() => "")).slice(0, 200);
        lastError = this.describe(response.status, detail);
        this.lastError = lastError.message;
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      } catch (error) {
        if (error instanceof ElimApiError) {
          if (!error.retryable || attempt === maxAttempts) throw error;
          lastError = error;
        } else {
          const aborted = (error as Error).name === "AbortError";
          lastError = new ElimApiError(
            aborted
              ? `ElimAPI non ha risposto entro ${Math.round(timeoutMs / 1000)}s.`
              : `ElimAPI irraggiungibile: ${(error as Error).message}`,
            true,
            aborted ? "ELIM_TIMEOUT" : "ELIM_UNREACHABLE"
          );
          this.lastError = lastError.message;
          if (attempt === maxAttempts) throw lastError;
        }
        // Attesa breve prima del secondo tentativo: un 429 servito subito
        // dopo resterebbe un 429.
        await new Promise((resolve) => setTimeout(resolve, numericEnv("ELIM_RETRY_MS", 1500)));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new ElimApiError("ElimAPI: errore imprevisto.", false, "ELIM_UNKNOWN");
  }

  /** Messaggi che dicono cosa fare, non solo cosa è successo. */
  private describe(status: number, detail: string): ElimApiError {
    const clean = detail.replace(/\s+/g, " ").trim();
    if (status === 401) {
      return new ElimApiError(
        "ElimAPI ha rifiutato la chiave (401): verifica ELI_API nel .env del server.",
        false,
        "ELIM_UNAUTHORIZED"
      );
    }
    if (status === 402) {
      return new ElimApiError(
        "Credito ElimAPI esaurito (402): il piano non copre altre richieste questo mese.",
        false,
        "ELIM_PAYMENT_REQUIRED"
      );
    }
    if (status === 429) {
      return new ElimApiError(
        "Limite di richieste ElimAPI raggiunto (429): riprova fra poco.",
        true,
        "ELIM_RATE_LIMITED"
      );
    }
    return new ElimApiError(
      `ElimAPI ha risposto ${status}${clean ? `: ${clean}` : ""}.`,
      status >= 500,
      `ELIM_HTTP_${status}`
    );
  }
}
