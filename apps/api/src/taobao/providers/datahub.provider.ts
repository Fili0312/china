import { Injectable, Logger } from "@nestjs/common";
import type { TaobaoApiStatus } from "@china/shared";
import { DataHubClient, DataHubError } from "./datahub.client";
import { buildQueryLadder } from "./query-ladder";
import {
  mapDetailPayload,
  mapReviewPayload,
  mapSearchPayload,
  type RawTaobaoProduct,
} from "./taobao-item";

/**
 * La ricerca Taobao via API, endpoint per endpoint.
 *
 * L'ordine in cui si chiamano gli endpoint è una scelta di costo, non di
 * comodità:
 *
 * 1. **Ricerca per parola chiave** — una sola chiamata per variante. È
 *    l'unica che si fa sempre.
 * 2. **Dettaglio** — solo sui primi candidati, quelli che hanno davvero una
 *    possibilità di essere proposti. Il dettaglio serve a confermare prezzo,
 *    specifiche e varianti; farlo su venti risultati per poi mostrarne tre
 *    significa pagare diciassette chiamate per niente.
 * 3. **Recensioni** — solo sui finalisti, e solo se richiesto. Sono
 *    l'informazione meno decisiva e la più costosa in proporzione.
 * 4. **Spedizione** — solo quando serve davvero saperla.
 *
 * Nessuna di queste chiamate viene simulata: senza `RAPIDAPI_KEY` il provider
 * dichiara di non essere disponibile e la riga lo registra come tale. Un
 * risultato finto finirebbe in memoria e deciderebbe il riuso di prodotti
 * veri.
 */
/**
 * Risposte di dettaglio consecutive senza un solo campo utile prima di
 * smettere di chiamare l'endpoint.
 *
 * Non è una soglia di prudenza: è la constatazione che il piano non serve
 * quell'endpoint. Cinque risposte vuote di fila non capitano per caso.
 */
const DETAIL_DEAD_AFTER = 5;

/** Dopo quanto si concede una sonda: un piano può essere stato attivato. */
const DETAIL_RETRY_AFTER_MS = 30 * 60_000;

@Injectable()
export class DataHubProvider {
  private readonly logger = new Logger("TaobaoApi");

  /**
   * Quante risposte di dettaglio di fila non hanno portato un solo campo.
   *
   * Vive sul provider, non su chi chiama: il fatto che la fonte non serva
   * schede riguarda la fonte, non la riga che sta cercando. Tenerlo nel
   * chiamante — com'era in `refreshKnown`, dove il contatore era locale e
   * quindi ripartiva da zero a ogni riga — significa ripagare l'errore una
   * volta per riga. Su un foglio da 500 righe sono state 746 chiamate a vuoto.
   */
  private deadDetailStreak = 0;

  /** Quando l'interruttore è scattato, per concedere la sonda successiva. */
  private detailDisabledAt = 0;

  constructor(private readonly client: DataHubClient) {}

  /**
   * L'endpoint di dettaglio è dato per morto in questo momento?
   *
   * Scaduta la finestra si torna a `false` una volta sola: la chiamata
   * successiva è la sonda che decide se riaprire o richiudere.
   */
  private get detailLooksDead(): boolean {
    if (this.deadDetailStreak < DETAIL_DEAD_AFTER) return false;
    if (Date.now() - this.detailDisabledAt >= DETAIL_RETRY_AFTER_MS) {
      this.deadDetailStreak = DETAIL_DEAD_AFTER - 1;
      return false;
    }
    return true;
  }

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  status(): TaobaoApiStatus {
    return this.client.status();
  }

  /**
   * Cerca i candidati di una variante.
   *
   * La query è quella cinese: su Taobao è l'unica che trovi qualcosa. Una
   * query inglese torna vuota o porta prodotti export, che non è ciò che il
   * cliente sta comprando.
   */
  async search(
    query: string,
    options: {
      limit?: number;
      page?: number;
      ttlHours?: number;
      exactQuery?: boolean;
    } = {}
  ): Promise<{
    products: RawTaobaoProduct[];
    credits: number;
    fromCache: boolean;
    /** Query che ha davvero prodotto i risultati. */
    queryUsed: string;
    /** Tentativi effettuati: 1 quando la query completa ha funzionato. */
    attempts: number;
  }> {
    // La v2 costruisce un proprio piano di retry che non perde numeri,
    // unità o modello. Senza l'opzione resta invariata la scala legacy.
    const ladder = options.exactQuery ? [query.trim()].filter(Boolean) : buildQueryLadder(query);
    let credits = 0;
    let fromCache = true;
    let attempts = 0;
    let lastQuery = query;

    // Si scende la scala solo finché non si trova nulla: una riga precisa
    // costa una chiamata, e solo le righe difficili ne costano di più.
    for (const attempt of ladder) {
      attempts += 1;
      lastQuery = attempt;
      const response = await this.client.call(
        "search",
        {
          [this.client.queryParam]: attempt,
          page: options.page ?? 1,
          // `sort` resta al valore predefinito del fornitore: ordinare per
          // vendite qui nasconderebbe i prodotti nuovi, e l'ordinamento è una
          // decisione nostra (`scoring.ts`), non della fonte.
        },
        { ttlHours: options.ttlHours }
      );
      credits += response.credits;
      fromCache = fromCache && response.fromCache;

      const products = mapSearchPayload(response.payload, "api").slice(0, options.limit ?? 20);
      if (products.length > 0) {
        if (attempts > 1) {
          this.logger.log(`«${query}» senza risultati: trovati con «${attempt}»`);
        }
        return { products, credits, fromCache, queryUsed: attempt, attempts };
      }
    }

    this.logger.warn(
      `nessun prodotto per «${query}» dopo ${attempts} tentativi: query troppo ` +
        "specifica, oppure la forma della risposta è cambiata."
    );
    return { products: [], credits, fromCache, queryUsed: lastQuery, attempts };
  }

  /**
   * Dettaglio di un prodotto: completa i campi, non li sostituisce.
   *
   * `ttlHours: 0` forza la lettura fresca — è ciò che serve per aggiornare il
   * prezzo di un prodotto già conosciuto, dove una risposta in cache
   * risponderebbe alla domanda di ieri.
   */
  async detail(
    itemId: string,
    options: { ttlHours?: number } = {}
  ): Promise<{ patch: Partial<RawTaobaoProduct>; credits: number; fromCache: boolean }> {
    // Una scheda che la fonte non serve non diventa disponibile insistendo:
    // si risponde «niente da aggiungere» senza spendere la chiamata. Chi
    // chiama vede una patch vuota, che è esattamente ciò che vedrebbe pagando.
    if (this.detailLooksDead) {
      return { patch: {}, credits: 0, fromCache: false };
    }

    const response = await this.client.call(
      "detail",
      { [this.client.itemParam]: itemId },
      { ttlHours: options.ttlHours }
    );
    const patch = mapDetailPayload(response.payload);

    if (Object.keys(patch).length > 0) {
      this.deadDetailStreak = 0;
    } else if (!response.fromCache) {
      // Solo le risposte pagate contano: una cache di risposte vuote
      // spegnerebbe l'endpoint senza che la fonte sia stata interrogata.
      this.deadDetailStreak += 1;
      if (this.deadDetailStreak === DETAIL_DEAD_AFTER) {
        this.detailDisabledAt = Date.now();
        this.logger.warn(
          `la fonte non serve schede prodotto (${DETAIL_DEAD_AFTER} risposte vuote di fila): ` +
            `endpoint di dettaglio sospeso per ${Math.round(DETAIL_RETRY_AFTER_MS / 60_000)} minuti. ` +
            "I candidati vanno al giudizio semantico con i dati della ricerca."
        );
      }
    }

    return { patch, credits: response.credits, fromCache: response.fromCache };
  }

  /** Recensioni: numero e voto medio, quando la fonte li espone. */
  async reviews(
    itemId: string,
    options: { ttlHours?: number } = {}
  ): Promise<{
    reviewCount: number | null;
    rating: number | null;
    credits: number;
    fromCache: boolean;
  }> {
    const response = await this.client.call(
      "review",
      { [this.client.itemParam]: itemId },
      { ttlHours: options.ttlHours }
    );
    const mapped = mapReviewPayload(response.payload);
    return { ...mapped, credits: response.credits, fromCache: response.fromCache };
  }

  /** Aree di spedizione: si chiama solo quando la riga lo richiede. */
  async shipping(
    itemId: string,
    options: { ttlHours?: number } = {}
  ): Promise<{ raw: unknown; credits: number; fromCache: boolean }> {
    const response = await this.client.call(
      "shipping",
      { [this.client.itemParam]: itemId },
      { ttlHours: options.ttlHours }
    );
    return { raw: response.payload, credits: response.credits, fromCache: response.fromCache };
  }

  /** `true` se vale la pena ritentare l'errore ricevuto. */
  isRetryable(error: unknown): boolean {
    return error instanceof DataHubError && error.retryable;
  }
}
