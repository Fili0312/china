import type { Localized } from "../i18n/locale";
import {
  DEFAULT_PROCUREMENT,
  type ProcurementKind,
  type ProductAnalysis,
} from "../schemas/analysis";

/**
 * Che cosa fa il sistema con l'acquistabilità dichiarata dall'analisi.
 *
 * Il modello dice **che cos'è** la riga; qui si decide **cosa farne**. Le due
 * cose stanno separate di proposito: cambiare la politica (cercare anche i
 * pezzi su disegno, per esempio) non deve richiedere di rianalizzare nulla, e
 * la politica dev'essere leggibile in un posto solo invece di essere sparsa
 * fra job, pipeline e interfaccia.
 *
 * Due regole, entrambe prudenti:
 *
 * 1. **Si rinuncia a cercare solo ciò che nessuno può mettere a catalogo.**
 *    Un modulo che il cliente stampa e una riga amministrativa non sono merce
 *    in nessun senso: la ricerca è denaro speso per forza. Tutto il resto si
 *    cerca lo stesso, anche quando l'analisi lo etichetta.
 * 2. **La classificazione non toglie mai un risultato trovato.** Se la ricerca
 *    ha comunque prodotto un candidato coerente, la riga resta fra i
 *    confermati: l'acquistabilità spiega le righe scoperte, non le nasconde.
 *
 * Il confine fra le due liste è **misurato**, non intuito. Sulle 60 righe
 * confermate della corsa da 498 usate come gruppo di controllo, escludere
 * anche i servizi avrebbe tolto dalla ricerca la riga 238 (`校准证书`, un
 * certificato di taratura), che su Taobao esiste e che quella corsa aveva
 * confermato: i marketplace cinesi vendono anche prestazioni. Stesso discorso
 * per `CUSTOM_MADE` — la riga 209 dice `定制` ed è stata trovata lo stesso.
 * Restano fuori solo le due categorie che nessuna corsa ha mai visto
 * comprare.
 */

/**
 * Righe per cui una ricerca su marketplace non ha alcun senso.
 *
 * Lista volutamente corta: ogni voce in più è un modo di perdere prodotti
 * veri, e il costo di cercare invano una riga è una chiamata sola.
 */
const NEVER_SEARCHED: readonly ProcurementKind[] = [
  "PRINTED_DOCUMENT",
  "NOT_A_PRODUCT",
];

/** `true` se vale la pena spendere una chiamata di ricerca per questa riga. */
export function isSearchableProcurement(kind: ProcurementKind): boolean {
  return !NEVER_SEARCHED.includes(kind);
}

/** `true` se la riga è un normale articolo di catalogo. */
export function isMarketplaceProcurement(kind: ProcurementKind): boolean {
  return kind === "MARKETPLACE_ITEM";
}

/**
 * L'acquistabilità di un'analisi, con il ripiego per le analisi salvate prima
 * che il campo esistesse. Chi legge non deve ricordarsi del caso mancante.
 */
export function procurementOf(
  analysis: ProductAnalysis | null | undefined
): ProcurementKind {
  return analysis?.procurement?.kind ?? DEFAULT_PROCUREMENT.kind;
}

/** Etichette leggibili, nelle tre lingue dell'interfaccia. */
export const PROCUREMENT_KIND_LABELS: Localized<ProcurementKind> = {
  en: {
    MARKETPLACE_ITEM: "Catalogue item",
    PROPRIETARY_PART: "Manufacturer code",
    CUSTOM_MADE: "Made to drawing",
    PRINTED_DOCUMENT: "Form to print",
    SERVICE: "Service",
    NOT_A_PRODUCT: "Not a request",
  },
  zh: {
    MARKETPLACE_ITEM: "目录商品",
    PROPRIETARY_PART: "厂家专用编码",
    CUSTOM_MADE: "按图定制",
    PRINTED_DOCUMENT: "需打印的表单",
    SERVICE: "服务",
    NOT_A_PRODUCT: "非采购行",
  },
  it: {
    MARKETPLACE_ITEM: "Articolo di catalogo",
    PROPRIETARY_PART: "Codice del costruttore",
    CUSTOM_MADE: "Su disegno",
    PRINTED_DOCUMENT: "Modulo da stampare",
    SERVICE: "Servizio",
    NOT_A_PRODUCT: "Non è una richiesta",
  },
};
