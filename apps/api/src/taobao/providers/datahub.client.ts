import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { prisma, Prisma } from "@china/db";

/**
 * Trasporto verso Taobao DataHub su RapidAPI.
 *
 * Fa una cosa sola: mandare una richiesta HTTP e restituire il JSON, contando
 * quanto è costata. Non sa cosa sia un prodotto — la traduzione da JSON grezzo
 * a candidato sta in `datahub.provider.ts` — e non sa cosa sia una riga di
 * Excel. Questa separazione serve a poter cambiare fornitore di dati senza
 * toccare la logica di ricerca.
 *
 * ## La chiave
 *
 * `RAPIDAPI_KEY` vive **solo** qui, letta dall'ambiente del processo server.
 * Non compare in una risposta API, in un log o a database: `status()` dice se
 * è configurata, mai quanto vale. Il frontend non la vede mai perché non passa
 * mai da lui: il browser chiama il nostro backend, il backend chiama RapidAPI.
 *
 * ## I crediti
 *
 * Ogni chiamata costa. Per questo:
 *
 * - ogni risposta finisce in `TaobaoApiCache`, con chiave = endpoint +
 *   parametri normalizzati; entro la TTL la stessa domanda non si ripaga;
 * - la cache è a database e non in memoria, così sopravvive a un riavvio e
 *   vale per tutti i clienti (la memoria dei prodotti è condivisa: è la
 *   ragione per cui il secondo cliente che chiede lo stesso pezzo non paga);
 * - chi chiama riceve `fromCache`, e i contatori del job distinguono le
 *   chiamate vere da quelle risparmiate.
 *
 * ## Gli endpoint
 *
 * I percorsi sono **configurabili**: i fornitori RapidAPI cambiano lo schema
 * dei path fra una revisione e l'altra, e un path sbagliato cablato nel codice
 * costringerebbe a un deploy per una stringa. I valori predefiniti seguono i
 * nomi degli endpoint del prodotto («Item Search X», «Item Detail X Simple»,
 * «Item Review», «Shipping Areas»); se la sottoscrizione ne usa altri si
 * correggono nel `.env` senza ricompilare.
 */

/** Endpoint logici usati dal progetto. */
export type DataHubEndpoint = "search" | "detail" | "review" | "shipping";

interface EndpointConfig {
  path: string;
  /** Valore del parametro `api=` quando il fornitore usa un path unico. */
  api: string | null;
  /** Crediti dichiarati dal fornitore per questo endpoint. */
  credits: number;
}

function env(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

/**
 * Variabile che può essere **volutamente vuota**.
 *
 * Serve per il parametro `api=`: alcuni fornitori espongono un path unico e
 * scelgono l'endpoint con quel parametro, altri — come la sottoscrizione in
 * uso — hanno un path per endpoint e non vogliono nessun `api=`. Con il
 * semplice `env()` una stringa vuota ricadrebbe sul valore predefinito, cioè
 * sarebbe impossibile dire «non mandarlo».
 */
function optionalEnv(name: string, fallback: string | null): string | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === "" ? null : value;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function endpointConfig(endpoint: DataHubEndpoint): EndpointConfig {
  switch (endpoint) {
    case "search":
      return {
        // Percorsi verificati sulla sottoscrizione reale il 2026-07-22:
        // l'endpoint è il path stesso e non esiste nessun parametro `api=`.
        path: env("TAOBAO_DATAHUB_SEARCH_PATH", "/item_search"),
        api: optionalEnv("TAOBAO_DATAHUB_SEARCH_API", null),
        credits: numericEnv("TAOBAO_DATAHUB_SEARCH_CREDITS", 1),
      };
    case "detail":
      return {
        path: env("TAOBAO_DATAHUB_DETAIL_PATH", "/item_detail"),
        api: optionalEnv("TAOBAO_DATAHUB_DETAIL_API", null),
        credits: numericEnv("TAOBAO_DATAHUB_DETAIL_CREDITS", 1),
      };
    case "review":
      return {
        path: env("TAOBAO_DATAHUB_REVIEW_PATH", "/item_review"),
        api: optionalEnv("TAOBAO_DATAHUB_REVIEW_API", null),
        credits: numericEnv("TAOBAO_DATAHUB_REVIEW_CREDITS", 1),
      };
    case "shipping":
      return {
        // Nessun endpoint di spedizione esiste su questa sottoscrizione, e
        // non serve: provenienza e costo arrivano già dentro la ricerca.
        path: env("TAOBAO_DATAHUB_SHIPPING_PATH", "/shipping_areas"),
        api: optionalEnv("TAOBAO_DATAHUB_SHIPPING_API", null),
        credits: numericEnv("TAOBAO_DATAHUB_SHIPPING_CREDITS", 1),
      };
  }
}

/** Errore del trasporto, con l'indicazione se valga la pena riprovare. */
export class DataHubError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string
  ) {
    super(message);
    this.name = "DataHubError";
  }
}

export interface DataHubResponse {
  payload: unknown;
  /** `true` se la risposta arriva dalla cache e non ha speso crediti. */
  fromCache: boolean;
  credits: number;
}

@Injectable()
export class DataHubClient {
  private readonly logger = new Logger("TaobaoDataHub");

  /** Contatori di processo: servono alla diagnostica, non alla fatturazione. */
  private calls = 0;
  private cacheHits = 0;
  private lastError: string | null = null;

  get host(): string {
    return env("TAOBAO_DATAHUB_HOST", "taobao-datahub.p.rapidapi.com");
  }

  private get apiKey(): string {
    return (process.env.RAPIDAPI_KEY ?? "").trim();
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  get cacheTtlHours(): number {
    return numericEnv("TAOBAO_DATAHUB_CACHE_HOURS", 168);
  }

  /** Nome parametro della query di ricerca (`q` o `keyword`, secondo il piano). */
  get queryParam(): string {
    return env("TAOBAO_DATAHUB_QUERY_PARAM", "q");
  }

  /** Nome parametro dell'identificativo prodotto (`itemId` o `num_iid`). */
  get itemParam(): string {
    return env("TAOBAO_DATAHUB_ITEM_PARAM", "itemId");
  }

  status() {
    const describe = (endpoint: DataHubEndpoint) => {
      const config = endpointConfig(endpoint);
      return config.api ? `${config.path}?api=${config.api}` : config.path;
    };
    return {
      configured: this.isConfigured,
      // La fonte primaria vive in `TAOBAO_PRIMARY_SEARCH`: qui si riporta così
      // com'è, per far mostrare all'interfaccia la fonte davvero in uso.
      primarySearch:
        (process.env.TAOBAO_PRIMARY_SEARCH ?? "hwh").trim().toLowerCase() === "datahub"
          ? ("datahub" as const)
          : ("hwh" as const),
      host: this.host,
      endpoints: {
        search: describe("search"),
        detail: describe("detail"),
        review: describe("review"),
        shipping: describe("shipping"),
      },
      calls: this.calls,
      cacheHits: this.cacheHits,
      cacheTtlHours: this.cacheTtlHours,
      lastError: this.lastError,
    };
  }

  /**
   * Chiama un endpoint, passando dalla cache quando è ancora valida.
   *
   * `ttlHours: 0` forza la chiamata: è ciò che serve quando si sta
   * verificando il prezzo di un prodotto già noto, dove una risposta di ieri
   * risponderebbe alla domanda sbagliata.
   */
  async call(
    endpoint: DataHubEndpoint,
    params: Readonly<Record<string, string | number | undefined>>,
    options: { ttlHours?: number } = {}
  ): Promise<DataHubResponse> {
    const config = endpointConfig(endpoint);
    const query = new URLSearchParams();
    if (config.api) query.set("api", config.api);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      query.set(key, String(value));
    }

    const cacheKey = createHash("sha256")
      .update(`${this.host}|${config.path}|${config.api ?? ""}|${sortedQuery(query)}`)
      .digest("hex")
      .slice(0, 40);

    const ttlHours = options.ttlHours ?? this.cacheTtlHours;
    if (ttlHours > 0) {
      const cached = await prisma.taobaoApiCache.findUnique({ where: { cacheKey } });
      if (cached && Date.now() - cached.fetchedAt.getTime() < ttlHours * 3_600_000) {
        this.cacheHits += 1;
        return { payload: cached.payload, fromCache: true, credits: 0 };
      }
    }

    if (!this.isConfigured) {
      // Fermarsi qui è deliberato: senza chiave non esiste un risultato
      // «di ripiego» onesto, e inventarne uno metterebbe a database prodotti
      // che non esistono.
      throw new DataHubError(
        "RAPIDAPI_KEY non configurata: la ricerca Taobao via API non è disponibile.",
        false,
        "API_NOT_CONFIGURED"
      );
    }

    const url = `https://${this.host}${config.path}${query.toString() ? `?${query}` : ""}`;
    const timeoutMs = numericEnv("TAOBAO_DATAHUB_TIMEOUT_MS", 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
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
        ? `Taobao DataHub non ha risposto entro ${Math.round(timeoutMs / 1000)}s.`
        : `Taobao DataHub irraggiungibile: ${(error as Error).message}`;
      this.lastError = message;
      throw new DataHubError(message, true, aborted ? "API_TIMEOUT" : "API_UNREACHABLE");
    } finally {
      clearTimeout(timer);
    }

    this.calls += 1;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Il corpo può contenere l'eco dei parametri ma mai la chiave: RapidAPI
      // la riceve in un header e non la ripete nelle risposte d'errore.
      const message = describeHttpError(response.status, body);
      this.lastError = message;
      throw new DataHubError(
        message,
        response.status === 429 || response.status >= 500,
        `API_HTTP_${response.status}`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const message = "Taobao DataHub ha risposto con un corpo non JSON.";
      this.lastError = message;
      throw new DataHubError(message, true, "API_BAD_PAYLOAD");
    }

    // Taobao DataHub risponde **200 anche quando fallisce**: l'esito vero sta
    // in `result.status`. Senza questo controllo un parametro sbagliato o una
    // chiave scaduta sembrerebbero «nessun prodotto trovato», che è il modo
    // più efficace di cercare a vuoto per ore senza accorgersene.
    const upstream = readUpstreamStatus(payload);
    if (upstream) {
      this.lastError = upstream.message;
      // Un errore non si mette in cache: si ripagherebbe l'errore.
      throw new DataHubError(upstream.message, upstream.retryable, upstream.code);
    }

    this.lastError = null;
    await prisma.taobaoApiCache
      .upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          endpoint,
          payload: payload as Prisma.InputJsonValue,
          credits: config.credits,
        },
        update: {
          payload: payload as Prisma.InputJsonValue,
          credits: config.credits,
          fetchedAt: new Date(),
        },
      })
      // Una cache che non si scrive non deve far fallire una ricerca riuscita.
      .catch((error: unknown) =>
        this.logger.warn(`cache non salvata: ${(error as Error).message}`)
      );

    return { payload, fromCache: false, credits: config.credits };
  }
}

/**
 * Errore dichiarato dentro il corpo della risposta.
 *
 * `205` («request successfully formed, but no results were found») non è un
 * errore: è una ricerca senza risultati, e va trattata come tale — zero
 * prodotti, nessuna eccezione.
 */
function readUpstreamStatus(
  payload: unknown
): { message: string; code: string; retryable: boolean } | null {
  const status = (payload as { result?: { status?: Record<string, unknown> } })?.result?.status;
  if (!status || status.data !== "error") return null;

  const code = Number(status.code) || 0;
  if (code === 205) return null;

  const detail =
    typeof status.msg === "string"
      ? status.msg
      : Object.values((status.msg as Record<string, string>) ?? {}).join("; ");

  if (code === 4008) {
    return {
      message:
        `Taobao DataHub ha rifiutato i parametri (${detail}): controlla ` +
        `TAOBAO_DATAHUB_QUERY_PARAM e TAOBAO_DATAHUB_ITEM_PARAM nel .env.`,
      code: "API_BAD_PARAMS",
      retryable: false,
    };
  }
  return {
    message: `Taobao DataHub ha risposto con un errore (${code}): ${detail || "senza dettaglio"}.`,
    code: `API_UPSTREAM_${code}`,
    // 5xxx sono errori interni del fornitore: ritentare ha senso.
    retryable: code >= 5000,
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
    return "Taobao DataHub ha rifiutato la chiave: verifica RAPIDAPI_KEY e che il piano includa questo endpoint.";
  }
  if (status === 404) {
    return `Endpoint non trovato su ${status}: controlla TAOBAO_DATAHUB_*_PATH e *_API nel .env${detail ? ` (${detail})` : ""}.`;
  }
  if (status === 429) {
    return "Limite di richieste RapidAPI raggiunto: riprova più tardi o alza il piano.";
  }
  return `Taobao DataHub ha risposto ${status}${detail ? `: ${detail}` : ""}.`;
}
