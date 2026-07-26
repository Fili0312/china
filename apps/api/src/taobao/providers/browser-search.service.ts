import { Injectable, Logger } from "@nestjs/common";
import {
  TaobaoBrowserError,
  searchTaobaoAuthenticated,
  type TaobaoBrowserProduct,
} from "@china/adapters";
import { TaobaoSessionService } from "../taobao-session.service";
import { canonicalItemUrl, type RawTaobaoProduct } from "./taobao-item";

/**
 * La ricerca Taobao con l'account collegato.
 *
 * Aggiunge a quella via API ciò che solo una sessione autenticata vede: il
 * prezzo effettivo, il prezzo della variante, le vendite recenti, il negozio.
 * Non la sostituisce — è un secondo punto di vista sullo stesso catalogo, e i
 * due si fondono in `merge.ts`.
 *
 * Due vincoli governano tutto il file:
 *
 * - **Un errore qui non annulla i risultati dell'API.** Chi chiama riceve un
 *   esito separato per trasporto; un captcha su Playwright lascia intatti i
 *   prodotti già trovati.
 * - **Le verifiche anti-bot non si aggirano.** Quando Taobao ne mostra una, la
 *   ricerca si ferma e il messaggio dice all'operatore cosa fare. Non si
 *   ritenta a raffica: insistere è esattamente ciò che trasforma un controllo
 *   occasionale in un blocco dell'account.
 */

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BrowserSearchOutcome {
  products: RawTaobaoProduct[];
  queryUsed: string;
}

@Injectable()
export class TaobaoBrowserService {
  private readonly logger = new Logger("TaobaoBrowser");

  /**
   * Una ricerca alla volta, per impostazione predefinita.
   *
   * È una sessione sola, di una persona sola: due ricerche in parallelo con
   * gli stessi cookie sono il modo più rapido per far comparire una verifica.
   */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Fino a quando non riprovare dopo una verifica.
   *
   * Dopo un controllo anti-bot le richieste successive lo incontrerebbero
   * comunque: fermarsi per qualche minuto è più utile che collezionare errori.
   */
  private blockedUntil = 0;

  constructor(private readonly session: TaobaoSessionService) {}

  /** `true` se esiste una sessione utilizzabile adesso. */
  async isAvailable(): Promise<boolean> {
    if (Date.now() < this.blockedUntil) return false;
    const status = await this.session.status();
    return status.connected;
  }

  /** Motivo per cui la ricerca browser non è disponibile, se non lo è. */
  async unavailableReason(): Promise<string | null> {
    if (Date.now() < this.blockedUntil) {
      const seconds = Math.ceil((this.blockedUntil - Date.now()) / 1000);
      return `Verifica Taobao in corso: nuova ricerca browser fra ${seconds}s.`;
    }
    const status = await this.session.status();
    if (!status.connected) {
      return "Collega Taobao per aggiungere i risultati della ricerca browser";
    }
    return null;
  }

  /**
   * Cerca con la sessione dell'utente.
   *
   * La query è quella cinese, inviata così com'è: è ciò che un compratore
   * digiterebbe, ed è l'unica che Taobao capisca davvero.
   */
  async search(query: string, limit: number): Promise<BrowserSearchOutcome> {
    const cookies = await this.session.loadCookies();
    if (!cookies || cookies.length === 0) {
      throw new TaobaoBrowserError(
        "Nessuna sessione Taobao collegata: la ricerca browser non è disponibile.",
        "SESSION_EXPIRED"
      );
    }

    // Le ricerche si mettono in fila: la sessione è una sola.
    const run = this.chain.then(
      () =>
        searchTaobaoAuthenticated(query, {
          cookies,
          limit,
          timeoutMs: numericEnv("TAOBAO_BROWSER_TIMEOUT_MS", 45_000),
        }),
      () =>
        searchTaobaoAuthenticated(query, {
          cookies,
          limit,
          timeoutMs: numericEnv("TAOBAO_BROWSER_TIMEOUT_MS", 45_000),
        })
    );
    this.chain = run.catch(() => undefined);

    try {
      const result = await run;
      return {
        products: result.products.map((product) => toRawProduct(product)),
        queryUsed: result.queryUsed,
      };
    } catch (error) {
      if (error instanceof TaobaoBrowserError) {
        if (error.code === "VERIFICATION_REQUIRED") {
          this.blockedUntil =
            Date.now() + numericEnv("TAOBAO_BROWSER_COOLDOWN_MS", 15 * 60_000);
          await this.session.markFailure(error.message);
        }
        if (error.code === "SESSION_EXPIRED") {
          await this.session.markFailure(error.message);
        }
        // Nel log finisce il codice, non i cookie né l'URL con la sessione.
        this.logger.warn(`ricerca browser fallita (${error.code})`);
      }
      throw error;
    }
  }
}

/** Prodotto del browser nella forma comune ai due trasporti. */
function toRawProduct(product: TaobaoBrowserProduct): RawTaobaoProduct {
  return {
    platform: "taobao",
    itemId: product.itemId,
    title: product.title,
    titleEn: null,
    url: product.url || canonicalItemUrl(product.itemId),
    imageUrl: product.imageUrl,
    price: product.price,
    currency: "CNY",
    variantPrice: product.variantPrice,
    promotionPrice: null,
    moq: null,
    sku: null,
    shopName: product.shopName,
    shopUrl: product.shopUrl,
    sellerId: null,
    totalSales: product.totalSales,
    reviewCount: product.reviewCount,
    rating: null,
    specs: product.location ? { 发货地: product.location } : null,
    variants: null,
    availability: null,
    shipping: product.shipping,
    source: "playwright",
  };
}
