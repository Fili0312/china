import type { TaobaoPlatform } from "@china/shared";
import type { RawTaobaoProduct } from "./taobao-item";

/**
 * Il dettaglio di un'inserzione ElimAPI, letto con le sue varianti.
 *
 * È il pezzo che la v3 usa al posto della ricerca quando il foglio contiene
 * già il link: la pagina la si apre e si prende **la variante che il cliente
 * ha indicato**, invece di andare a cercare un prodotto simile.
 *
 * Due cose che questo modulo non fa, di proposito:
 *
 * 1. **Non sceglie.** Restituisce l'elenco delle varianti così com'è; quale
 *    sia quella giusta lo decide `pickElimSku`, che si può leggere e provare
 *    senza chiamare nessuna API.
 * 2. **Non inventa un prezzo.** Se la variante scelta non ha prezzo, il campo
 *    resta nullo e la riga lo dirà: una cella vuota è un problema visibile,
 *    un prezzo preso da un'altra variante è un problema invisibile.
 */

/** Una variante come la restituisce ElimAPI. */
export interface ElimSku {
  /** Identificativo della SKU: è quello che compare come `skuId` nei link. */
  id: string;
  price: number | null;
  promotionPrice: number | null;
  quantity: number | null;
  imageUrl: string | null;
  /** Le opzioni che la descrivono: «颜色分类: 牙签3包(升级款)». */
  options: Array<{ name: string; value: string }>;
  /** Le stesse opzioni in una riga sola, per leggerle e confrontarle. */
  label: string;
}

export interface ElimDetail {
  itemId: string;
  title: string;
  titleEn: string | null;
  url: string | null;
  imageUrl: string | null;
  /** Prezzo di testa dell'inserzione: con `by_sku` è il minimo, non «il» prezzo. */
  price: number | null;
  currency: string;
  shopName: string | null;
  quantity: number | null;
  moq: number | null;
  skus: ElimSku[];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Legge la risposta di `POST /products/detail`; `null` se non è utilizzabile. */
export function mapElimDetail(
  payload: unknown,
  platform: TaobaoPlatform
): ElimDetail | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.success === false) return null;
  const itemId = text(body.id);
  const title = text(body.title);
  if (!itemId || !title) return null;

  const rawSkus = Array.isArray(body.skus) ? body.skus : [];
  const skus: ElimSku[] = rawSkus.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const sku = entry as Record<string, unknown>;
    const id = text(sku.id);
    if (!id) return [];
    const rawOptions = Array.isArray(sku.options) ? sku.options : [];
    const options = rawOptions.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const entry = option as Record<string, unknown>;
      const name = text(entry.name) ?? text(entry.nameEn) ?? "";
      const value = text(entry.value) ?? text(entry.valueEn);
      return value ? [{ name, value }] : [];
    });
    return [
      {
        id,
        price: number(sku.price),
        promotionPrice: number(sku.promotion_price),
        quantity: number(sku.quantity),
        imageUrl: text(sku.img_url),
        options,
        label: options.map((option) => option.value).join(" / "),
      },
    ];
  });

  return {
    itemId,
    title,
    titleEn: text(body.titleEn),
    url: text(body.url),
    imageUrl: text(body.main_image) ?? skus.find((sku) => sku.imageUrl)?.imageUrl ?? null,
    price: number(body.price),
    currency: text(body.currency) ?? (platform === "1688" ? "CNY" : "CNY"),
    shopName: text(body.shop_name),
    quantity: number(body.quantity),
    moq: number(body.moq),
    skus,
  };
}

/* -------------------------------------------------------------------------- */
/* Scegliere la variante                                                       */
/* -------------------------------------------------------------------------- */

/** Come è stata scelta la variante: serve a dirlo in interfaccia. */
export type ElimSkuMatch =
  /** Lo `skuId` era scritto nel link del foglio: nessuna interpretazione. */
  | "from_link"
  /** Il testo della colonna specifiche corrisponde a una variante sola. */
  | "from_spec"
  /** Più varianti plausibili, o nessuna: decide una persona. */
  | "ambiguous"
  /** L'inserzione non ha varianti: c'è un prezzo solo ed è quello. */
  | "single";

export interface ElimSkuChoice {
  sku: ElimSku | null;
  match: ElimSkuMatch;
  /** Le alternative plausibili quando la scelta non è univoca. */
  candidates: ElimSku[];
}

/**
 * Normalizza per il confronto: via spazi, punteggiatura e maiuscole.
 *
 * Il cinese non usa spazi e le schede scrivono la stessa cosa in dieci modi
 * («牙签3包(升级款)», «牙签 3 包（升级款）»): confrontare le stringhe grezze
 * fallirebbe su differenze che per una persona non esistono.
 */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（）()【】\[\]{}·・,，、;；:：/／\\|"'`~!！?？*＊\s-]/gu, "")
    .replace(/：/gu, "");
}

/**
 * La misura chiesta dal foglio, quando la specifica **è** una misura.
 *
 * «2.48», «10.00mm», «Ø5» sono un numero solo con contorno; «60*60» e «50MM宽
 * *50米长» sono due numeri e non vanno letti come una misura sola — per quelli
 * decide il confronto testuale, non l'intervallo.
 */
function singleMeasure(spec: string): number | null {
  const numeri = spec.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (numeri.length !== 1) return null;
  const valore = Number(numeri[0]!.replace(",", "."));
  return Number.isFinite(valore) ? valore : null;
}

/** Gli intervalli scritti in un'etichetta: «2.00-5.99», «5.0~5.99», «6.00至9.99». */
function ranges(label: string): Array<{ from: number; to: number }> {
  const trovati: Array<{ from: number; to: number }> = [];
  const regex = /(\d+(?:\.\d+)?)\s*[-~～至]\s*(\d+(?:\.\d+)?)/gu;
  for (const match of label.matchAll(regex)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) {
      trovati.push({ from, to });
    }
  }
  return trovati;
}

/**
 * Sceglie la variante da usare per la quotazione.
 *
 * **Comanda la colonna delle specifiche del foglio**, non lo `skuId` del link.
 * Sembra controintuitivo — l'id è un dato esatto, il testo no — ma l'id nel
 * link è quello che il cliente stava guardando quando ha copiato l'indirizzo,
 * e invecchia: sulla riga 5 del foglio reale il link puntava a «0.51-1.99»
 * mentre la riga chiedeva 2.48, che sta in «2.00-5.99». Fidarsi dell'id
 * avrebbe quotato la variante sbagliata con la sicurezza di un dato esatto.
 * Lo `skuId` resta come ripiego quando il testo non decide.
 *
 * Tre modi di far combaciare il testo, dal più stretto al più largo:
 * uguaglianza, contenimento, e **intervallo numerico** — che su questo foglio
 * serve di continuo, perché i calibri si vendono a fasce di diametro.
 */
export function pickElimSku(
  detail: ElimDetail,
  wanted: { skuId?: string | null; spec?: string | null }
): ElimSkuChoice {
  if (detail.skus.length === 0) {
    return { sku: null, match: "single", candidates: [] };
  }
  if (detail.skus.length === 1) {
    return { sku: detail.skus[0]!, match: "single", candidates: [] };
  }

  const specGrezza = (wanted.spec ?? "").trim();
  const spec = fold(specGrezza);
  if (spec) {
    const exact = detail.skus.filter((sku) => fold(sku.label) === spec);
    if (exact.length === 1) {
      return { sku: exact[0]!, match: "from_spec", candidates: [] };
    }
    const contained = detail.skus.filter(
      (sku) => fold(sku.label).includes(spec) || spec.includes(fold(sku.label))
    );
    if (contained.length === 1) {
      return { sku: contained[0]!, match: "from_spec", candidates: [] };
    }

    // La misura dentro la fascia: «2.48» sta in «2.00-5.99».
    const misura = singleMeasure(specGrezza);
    if (misura != null) {
      const dentro = detail.skus
        .map((sku) => {
          const contenenti = ranges(sku.label).filter(
            (range) => misura >= range.from && misura <= range.to
          );
          if (contenenti.length === 0) return null;
          // L'ampiezza minima fra le fasce che contengono la misura.
          const ampiezza = Math.min(
            ...contenenti.map((range) => range.to - range.from)
          );
          return { sku, ampiezza };
        })
        .filter((voce): voce is { sku: ElimSku; ampiezza: number } => voce != null);

      if (dentro.length === 1) {
        return { sku: dentro[0]!.sku, match: "from_spec", candidates: [] };
      }
      if (dentro.length > 1) {
        // Vince la fascia **più stretta**: «10.0-10.99» è il calibro da 10 mm,
        // «Φ0.3-10 共971支» è un cofanetto da 971 pezzi che quel diametro lo
        // contiene per caso. Senza questa regola le righe dei calibri — otto,
        // sul foglio reale — finivano tutte a decidere a mano.
        const minima = Math.min(...dentro.map((voce) => voce.ampiezza));
        const strette = dentro.filter((voce) => voce.ampiezza === minima);
        if (strette.length === 1) {
          return { sku: strette[0]!.sku, match: "from_spec", candidates: [] };
        }
        return {
          sku: null,
          match: "ambiguous",
          candidates: strette.map((voce) => voce.sku),
        };
      }
    }

    if (contained.length > 1) {
      return { sku: null, match: "ambiguous", candidates: contained };
    }
  }

  // Il testo non ha deciso: meglio la variante che il cliente aveva davanti
  // quando ha copiato il link che nessuna variante.
  const skuId = wanted.skuId?.trim();
  const fromLink = skuId ? detail.skus.find((sku) => sku.id === skuId) : undefined;
  if (fromLink) return { sku: fromLink, match: "from_link", candidates: [] };

  return { sku: null, match: "ambiguous", candidates: detail.skus };
}

/**
 * Il prodotto come lo vede il resto della pipeline, con la variante scelta.
 *
 * Il prezzo è quello **della variante**: è tutto il punto dell'operazione.
 *
 * Se la variante non si è lasciata scegliere il prezzo resta **vuoto**, e non
 * si ripiega su quello di testa: su un'inserzione `by_sku` quello è il minimo
 * fra tutte le varianti — 3,50 su un calibro il cui pezzo giusto ne costa 25,
 * 1,86 su un set di pesi che arriva a 8.999. Sarebbe la stessa cifra
 * plausibile e falsa della «promozione» che ci ha già ingannati una volta. Una
 * cella vuota manda la riga in «da controllare» con il link da aprire; un
 * numero sbagliato arriva al cliente.
 *
 * Fa eccezione l'inserzione che di varianti non ne ha: lì il prezzo di testa
 * è il prezzo, e basta.
 */
export function elimDetailToProduct(
  detail: ElimDetail,
  choice: ElimSkuChoice,
  fallbackUrl: string | null
): RawTaobaoProduct {
  const sku = choice.sku;
  const prezzo = sku?.price ?? (choice.match === "single" ? detail.price : null);
  return {
    platform: "taobao",
    itemId: detail.itemId,
    title: detail.title,
    titleEn: detail.titleEn,
    url: detail.url ?? fallbackUrl,
    imageUrl: sku?.imageUrl ?? detail.imageUrl,
    price: prezzo,
    currency: detail.currency,
    variantPrice: sku?.price ?? null,
    promotionPrice: sku?.promotionPrice ?? null,
    moq: detail.moq,
    sku: sku ? sku.label || sku.id : null,
    shopName: detail.shopName,
    shopUrl: null,
    sellerId: null,
    totalSales: null,
    reviewCount: null,
    rating: null,
    specs: null,
    variants:
      detail.skus.length > 0
        ? [
            {
              name: detail.skus[0]?.options[0]?.name ?? "变体",
              options: detail.skus.map((entry) => entry.label || entry.id),
            },
          ]
        : null,
    availability: detail.quantity != null && detail.quantity <= 0 ? "out of stock" : null,
    shipping: null,
    source: "excel",
  };
}
