import {
  ProviderBusyError,
  ProviderConfigError,
  ProviderTimeoutError,
  ProviderUpstreamError,
} from "./provider";

/**
 * Client HTTP di Piloterr.
 *
 * Serve a raggiungere Alibaba e AliExpress, che dall'IP di questo VPS sono
 * bloccati dal captcha e quindi non sono ottenibili con Playwright.
 *
 * Due regole non negoziabili:
 *
 * 1. **La chiave non compare mai** — né nel codice, né nei log, né nei
 *    messaggi d'errore, né nell'URL (viaggia solo nell'header `x-api-key`).
 *    `redactKey()` ripulisce qualunque testo prima che venga registrato.
 * 2. **Ogni chiamata riuscita costa crediti**, quindi le risposte identiche
 *    vengono messe in cache e il consumo viene contato e reso ispezionabile.
 *    Un errore 4xx non consuma crediti (documentazione Piloterr) e infatti
 *    non viene conteggiato.
 */

const DEFAULT_BASE_URL = "https://api.piloterr.com";

/**
 * Costo in crediti per endpoint, come riportato dal pannello Piloterr.
 *
 * La ricerca Alibaba costa 1 credito, tutto il resto 2. In particolare
 * `/v2/alibaba/product` costa **2** crediti, non 1: contarlo per difetto
 * farebbe sottostimare la spesa proprio sull'endpoint che M6 chiamerà una
 * volta per candidato da aggiornare.
 */
export const PILOTERR_CREDIT_COST: Record<string, number> = {
  "/v2/alibaba/search": 1,
  "/v2/alibaba/product": 2,
  "/v2/aliexpress/search": 2,
  "/v2/aliexpress/product": 2,
};

export type PiloterrFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface PiloterrClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Tetto di chiamate a pagamento per processo; 0 = nessun limite. */
  maxCalls?: number;
  /** Iniettabile nei test: nessuna rete viene toccata. */
  fetchImpl?: PiloterrFetch;
}

export interface PiloterrUsage {
  /** Chiamate effettivamente inviate (quelle che consumano crediti). */
  calls: number;
  /** Risposte servite dalla cache: crediti risparmiati. */
  cacheHits: number;
  /** Crediti stimati in base al costo dichiarato per endpoint. */
  creditsSpent: number;
  /** Chiamate rifiutate perché il tetto di spesa era esaurito. */
  blockedByBudget: number;
  /**
   * Dettaglio per endpoint. Il client è condiviso da tutti i motori, quindi
   * i totali qui sopra sono **globali**: senza questa ripartizione una
   * spesa fatta su Alibaba sembrerebbe fatta anche su AliExpress.
   */
  byEndpoint: Record<string, { calls: number; cacheHits: number; credits: number }>;
}

interface CacheEntry {
  expiresAt: number;
  body: unknown;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class PiloterrClient {
  private readonly cache = new Map<string, CacheEntry>();
  private usage: PiloterrUsage = {
    calls: 0,
    cacheHits: 0,
    creditsSpent: 0,
    blockedByBudget: 0,
    byEndpoint: {},
  };

  private bucket(path: string) {
    return (this.usage.byEndpoint[path] ??= {
      calls: 0,
      cacheHits: 0,
      credits: 0,
    });
  }

  constructor(private readonly options: PiloterrClientOptions = {}) {}

  private get apiKey(): string {
    return (this.options.apiKey ?? process.env.PILOTERR_API_KEY ?? "").trim();
  }

  /** `false` quando la chiave non è stata configurata sul server. */
  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  getUsage(): PiloterrUsage {
    return {
      ...this.usage,
      byEndpoint: Object.fromEntries(
        Object.entries(this.usage.byEndpoint).map(([path, entry]) => [
          path,
          { ...entry },
        ])
      ),
    };
  }

  /** Consumo dei soli endpoint di un motore (`alibaba`, `aliexpress`). */
  getUsageFor(engine: string): {
    calls: number;
    cacheHits: number;
    creditsSpent: number;
  } {
    let calls = 0;
    let cacheHits = 0;
    let creditsSpent = 0;
    for (const [path, entry] of Object.entries(this.usage.byEndpoint)) {
      if (!path.startsWith(`/v2/${engine}/`)) continue;
      calls += entry.calls;
      cacheHits += entry.cacheHits;
      creditsSpent += entry.credits;
    }
    return { calls, cacheHits, creditsSpent };
  }

  /**
   * Toglie la chiave da un testo destinato a log o messaggi d'errore.
   * Piloterr rimanda indietro l'header in alcune risposte di errore: senza
   * questa pulizia la chiave finirebbe nel journal di systemd.
   */
  redactKey(text: string): string {
    const key = this.apiKey;
    if (!key) return text;
    return text.split(key).join("***");
  }

  /** Svuota la cache: usata dai test e dal riavvio manuale di un run. */
  clearCache(): void {
    this.cache.clear();
  }

  async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new ProviderConfigError(
        "Piloterr non è configurato: manca PILOTERR_API_KEY nel .env del server."
      );
    }

    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      search.set(name, String(value));
    }
    const query = search.toString();
    const cacheKey = `${path}?${query}`;

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.usage.cacheHits += 1;
      this.bucket(path).cacheHits += 1;
      return cached.body as T;
    }
    if (cached) this.cache.delete(cacheKey);

    const maxCalls = this.options.maxCalls ?? numericEnv("PILOTERR_MAX_CALLS_PER_RUN", 0);
    if (maxCalls > 0 && this.usage.calls >= maxCalls) {
      this.usage.blockedByBudget += 1;
      throw new ProviderConfigError(
        `Tetto di chiamate Piloterr raggiunto (${maxCalls}): alza ` +
          "PILOTERR_MAX_CALLS_PER_RUN o attendi il prossimo run."
      );
    }

    const baseUrl = (
      this.options.baseUrl ??
      process.env.PILOTERR_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
    const timeoutMs = this.options.timeoutMs ?? numericEnv("PILOTERR_TIMEOUT_MS", 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch: PiloterrFetch =
      this.options.fetchImpl ?? (globalThis.fetch as unknown as PiloterrFetch);

    let response: Awaited<ReturnType<PiloterrFetch>>;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: {
          // La chiave viaggia solo qui: mai in query string, che finirebbe
          // nei log di accesso di qualunque proxy attraversato.
          "x-api-key": this.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(
          `Piloterr non ha risposto entro ${timeoutMs} ms.`
        );
      }
      throw new ProviderUpstreamError(
        `Piloterr non raggiungibile: ${this.redactKey(detail)}`
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      throw this.toTypedError(response.status, raw);
    }

    // Una chiamata riuscita è una chiamata pagata: si conta anche se il corpo
    // dovesse poi risultare illeggibile.
    const cost = PILOTERR_CREDIT_COST[path] ?? 1;
    this.usage.calls += 1;
    this.usage.creditsSpent += cost;
    const bucket = this.bucket(path);
    bucket.calls += 1;
    bucket.credits += cost;

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ProviderUpstreamError(
        "Piloterr ha risposto con un corpo non JSON."
      );
    }

    const cacheTtl = this.options.cacheTtlMs ?? numericEnv("PILOTERR_CACHE_TTL_MS", 60 * 60_000);
    if (cacheTtl > 0) {
      // Cache limitata: le risposte di ricerca sono grandi e un run lungo ne
      // produrrebbe centinaia.
      if (this.cache.size >= 500) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { expiresAt: Date.now() + cacheTtl, body });
    }
    return body as T;
  }

  /**
   * Traduce lo stato HTTP negli errori già usati dal resto della ricerca, così
   * che l'aggregatore li isoli per fonte come fa con OTAPI e gli scraper.
   */
  private toTypedError(status: number, raw: string): Error {
    const detail = this.redactKey(raw).slice(0, 300);
    if (status === 401 || status === 403) {
      return new ProviderConfigError(
        "Piloterr ha rifiutato la chiave API: verifica PILOTERR_API_KEY."
      );
    }
    if (status === 402) {
      return new ProviderUpstreamError(
        "Crediti Piloterr esauriti: ricarica il piano per continuare."
      );
    }
    if (status === 429) {
      return new ProviderBusyError(
        "Limite di frequenza Piloterr raggiunto; riprova fra qualche istante."
      );
    }
    if (status === 400) {
      return new ProviderUpstreamError(
        `Richiesta rifiutata da Piloterr: ${detail || "parametri non validi"}`
      );
    }
    return new ProviderUpstreamError(
      `Piloterr ha risposto ${status}${detail ? `: ${detail}` : ""}`
    );
  }
}

/** Istanza condivisa: la cache e il conteggio crediti valgono per processo. */
export const piloterrClient = new PiloterrClient();
