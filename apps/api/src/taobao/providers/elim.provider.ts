import { Injectable, Logger } from "@nestjs/common";
import type { ElimApiStatus, TaobaoPlatform } from "@china/shared";
import { ElimApiClient, ElimApiError, type ElimSort } from "./elim.client";
import { mapElimSearch, readPlanStatus } from "./elim-item";
import { buildQueryLadder } from "./query-ladder";
import type { RawTaobaoProduct } from "./taobao-item";

/**
 * La ricerca via ElimAPI, per Taobao e per 1688.
 *
 * È la **riserva**: DataHub resta la prima fonte, questa interviene quando
 * quella non basta — errore, limite raggiunto, o troppi pochi risultati. Il
 * motivo non è la ridondanza ma il catalogo: sono due fornitori diversi, e la
 * riga che l'uno non trova spesso l'altro la trova.
 *
 * Riusa la stessa scala di query di DataHub (`query-ladder.ts`): anche qui una
 * ricerca lunga in AND non trova nulla, e la regola per accorciarla non ha
 * ragione di essere diversa fra due fornitori dello stesso marketplace.
 */
@Injectable()
export class ElimApiProvider {
  private readonly logger = new Logger("ElimApi");

  constructor(private readonly client: ElimApiClient) {}

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  status(): ElimApiStatus {
    return this.client.status();
  }

  /**
   * Cerca su una piattaforma.
   *
   * `lang: "en"` è il valore usato di proposito: il titolo cinese resta in
   * `title`, e in più si ottiene `titleEn`, che è ciò che rende leggibile un
   * risultato a chi non legge il cinese senza toglierne nulla alla ricerca.
   */
  async search(
    query: string,
    platform: TaobaoPlatform,
    options: { limit?: number; sort?: ElimSort; ttlHours?: number } = {}
  ): Promise<{
    products: RawTaobaoProduct[];
    calls: number;
    fromCache: boolean;
    queryUsed: string;
  }> {
    const ladder = buildQueryLadder(query);
    let calls = 0;
    let fromCache = true;
    let lastQuery = query;

    for (const attempt of ladder) {
      lastQuery = attempt;
      const response = await this.client.search(
        {
          q: attempt,
          platform,
          lang: "en",
          page: 1,
          size: options.limit ?? 20,
          ...(options.sort ? { sort: options.sort } : {}),
        },
        { ttlHours: options.ttlHours }
      );
      if (!response.fromCache) calls += 1;
      fromCache = fromCache && response.fromCache;

      const products = mapElimSearch(response.payload, platform).slice(0, options.limit ?? 20);
      if (products.length > 0) {
        return { products, calls, fromCache, queryUsed: attempt };
      }
    }

    this.logger.warn(
      `ElimAPI ${platform}: nessun prodotto per «${query}» dopo ${ladder.length} tentativi.`
    );
    return { products: [], calls, fromCache, queryUsed: lastQuery };
  }

  /**
   * Richieste residue del piano.
   *
   * Serve a poterlo dire prima, invece di scoprirlo con un 402 a metà di un
   * file da cinquecento righe.
   */
  async plan(): Promise<{
    planName: string | null;
    includedLimit: number | null;
    totalRequests: number | null;
    remaining: number | null;
  }> {
    return readPlanStatus(await this.client.planStatus());
  }

  /** `true` se vale la pena ritentare l'errore ricevuto. */
  isRetryable(error: unknown): boolean {
    return error instanceof ElimApiError && error.retryable;
  }
}
