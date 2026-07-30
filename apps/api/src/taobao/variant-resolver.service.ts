import { Injectable, Logger } from "@nestjs/common";
import { pickVariantWithAi } from "@china/ai";
import { ElimApiProvider } from "./providers/elim.provider";
import {
  elimDetailToProduct,
  pickElimSku,
  type ElimDetail,
  type ElimSku,
} from "./providers/elim-detail";
import type { ScoredProduct } from "./scoring";

/**
 * Quale prodotto si compra, fra quelli che la ricerca ha trovato.
 *
 * Serve un passaggio a sé perché la ricerca lascia una classifica costruita su
 * **prezzi di testa**, che su un'inserzione a varianti è il minimo fra tutte —
 * il prezzo della fascia più piccola, del pezzo più corto, del colore in
 * saldo. Ordinare su quelli significa premiare l'inserzione che ha la variante
 * più economica, non quella che vende ciò che il foglio chiede.
 *
 * Qui si prendono i primi candidati, si chiede a Elim che cosa vendono davvero,
 * e si sceglie **fra prezzi veri**. Costa una chiamata per candidato: per
 * questo si guardano i primi e non tutti e quindici.
 *
 * Il difetto che questo modulo esiste per non ripetere: la risoluzione stava
 * dentro la ricerca, il refine riordinava da capo senza rifarla, e il prodotto
 * appena corretto — ora più caro perché il suo prezzo era diventato quello
 * vero — veniva superato da un cofanetto il cui prezzo di testa era rimasto
 * finto. Ricerca e refine chiamano lo stesso pezzo, così non possono divergere.
 */

/** Quanti candidati interrogare: oltre, la spesa cresce più della precisione. */
export const VARIANT_RESOLVE_TOP_N = 3;

/**
 * L'interruttore della risoluzione varianti, **spento** finché non lo si accende.
 *
 * Non è una preferenza, è il conto delle chiamate: ogni riga cercata ne consuma
 * tre e il piano è a duecento al mese. Fino a che trovare il **prodotto** giusto
 * non è affidabile, spendere per sapere quale sua variante comprare è spendere
 * per raffinare una risposta sbagliata.
 *
 * Si riaccende con `V3_VARIANT_RESOLUTION=on`; le righe con il link restano
 * risolte comunque, perché lì il prodotto non è in discussione — l'ha scelto il
 * cliente — e la chiamata è una sola.
 */
export function variantResolutionEnabled(): boolean {
  return /^(on|1|true|yes)$/i.test((process.env.V3_VARIANT_RESOLUTION ?? "").trim());
}

/**
 * Sotto questa confidenza la scelta del modello non vale: la riga torna a
 * essere una domanda per una persona. Una variante sbagliata scelta con
 * sicurezza è peggio di una casella vuota, perché nessuno la ricontrolla.
 */
const VARIANT_AI_MIN_CONFIDENCE = 0.7;

/**
 * Oltre questo numero di varianti non si chiede al modello: un'inserzione con
 * settanta SKU che il confronto testuale non ha saputo restringere non è una
 * scelta difficile, è una riga che non combacia.
 */
const VARIANT_AI_MAX_CHOICES = 30;

/**
 * Le parole con cui un'inserzione dice «questo è un assortimento».
 *
 * Non è un elenco di prodotti del foglio di prova: è il vocabolario con cui i
 * venditori cinesi distinguono il pezzo dalla scatola che ne contiene cento.
 * «套装» è il set, «共101支» sono centouno pezzi, «一套» è una serie.
 */
const PAROLE_DA_COFANETTO = ["套装", "一套", "整套", "组套", "套餐", "全套"];
const QUANTITA_DA_COFANETTO = /共\s*\d+\s*[支只件]|\d+\s*[支只件]\s*装|\d+\s*件套/u;

export interface VariantResolveInput {
  /** La classifica come l'ha lasciata la ricerca, migliore per primo. */
  ranked: ScoredProduct[];
  /** La colonna delle specifiche del foglio: è questa che deve combaciare. */
  spec: string | null;
  /** Il nome della riga, per il modello e per i log. */
  displayName: string;
  /** Quanti candidati interrogare. */
  topN?: number;
}

export interface VariantResolveOutcome {
  /** La classifica, con il prodotto scelto in testa. */
  ranked: ScoredProduct[];
  /** Chiamate Elim spese: chi chiama le somma ai totali del job. */
  elimCalls: number;
  /** Quanto è costato far scegliere al modello. */
  aiCostUsd: number;
  /** Quante scelte ha fatto il modello invece del confronto testuale. */
  aiPicks: number;
  /** `true` se il prodotto in testa ha una variante scelta e un prezzo vero. */
  resolved: boolean;
}

/** Un'inserzione che vende un assortimento, non il pezzo. */
function sembraCofanetto(testo: string): boolean {
  return (
    PAROLE_DA_COFANETTO.some((parola) => testo.includes(parola)) ||
    QUANTITA_DA_COFANETTO.test(testo)
  );
}

@Injectable()
export class VariantResolverService {
  private readonly logger = new Logger(VariantResolverService.name);

  constructor(private readonly elim: ElimApiProvider) {}

  get isConfigured(): boolean {
    return this.elim.isConfigured;
  }

  /**
   * Risolve le varianti dei primi candidati e mette in testa quello da comprare.
   *
   * Chi vince: fra i candidati di cui si è capito **che cosa** vendono, il più
   * economico — con i cofanetti in fondo se il foglio non ne chiede uno. Se non
   * se ne risolve nemmeno uno, la classifica resta quella della ricerca: senza
   * prezzi veri non c'è niente da confrontare, e inventare un ordine sarebbe
   * peggio che lasciare quello di prima.
   */
  async resolveAndPick(input: VariantResolveInput): Promise<VariantResolveOutcome> {
    const esito: VariantResolveOutcome = {
      ranked: input.ranked,
      elimCalls: 0,
      aiCostUsd: 0,
      aiPicks: 0,
      resolved: false,
    };
    if (!variantResolutionEnabled()) return esito;
    if (!this.elim.isConfigured || input.ranked.length === 0) return esito;

    const spec = input.spec?.trim() || null;
    const topN = input.topN ?? VARIANT_RESOLVE_TOP_N;
    // Il foglio che chiede un assortimento non deve vederselo penalizzare.
    const vuoleCofanetto = spec ? sembraCofanetto(spec) : false;

    interface Risolto {
      entry: ScoredProduct;
      prezzo: number;
      cofanetto: boolean;
      posizione: number;
    }
    const risolti: Risolto[] = [];

    for (const [posizione, entry] of input.ranked.slice(0, topN).entries()) {
      const prodotto = entry.product;
      try {
        const { detail, calls } = await this.elim.detail(
          prodotto.itemId,
          prodotto.platform
        );
        esito.elimCalls += calls;
        if (!detail) continue;

        let choice = pickElimSku(detail, { spec });
        if (!choice.sku && choice.match === "ambiguous") {
          const candidati =
            choice.candidates.length > 0 ? choice.candidates : detail.skus;
          const scelta = await this.chiediAlModello(
            detail,
            candidati,
            spec,
            input.displayName,
            esito
          );
          if (scelta) choice = { sku: scelta, match: "from_spec", candidates: [] };
        }
        if (!choice.sku) continue;

        Object.assign(
          prodotto,
          elimDetailToProduct(detail, choice, prodotto.url)
        );
        if (prodotto.price == null) continue;
        risolti.push({
          entry,
          prezzo: prodotto.price,
          cofanetto: sembraCofanetto(`${detail.title} ${choice.sku.label}`),
          posizione,
        });
      } catch (error) {
        // Un candidato non interrogabile resta con i dati della ricerca e non
        // partecipa alla scelta: non è un motivo per fermare la riga.
        const message = error instanceof Error ? error.message : "errore";
        this.logger.warn(
          `${input.displayName}: dettaglio di ${prodotto.itemId} non letto (${message})`
        );
      }
    }

    if (risolti.length === 0) return esito;

    // I cofanetti in coda quando il foglio chiede un pezzo; poi il più
    // economico; a pari prezzo vince chi la ricerca aveva messo più in alto.
    const ordinati = [...risolti].sort((a, b) => {
      if (!vuoleCofanetto && a.cofanetto !== b.cofanetto) {
        return a.cofanetto ? 1 : -1;
      }
      if (a.prezzo !== b.prezzo) return a.prezzo - b.prezzo;
      return a.posizione - b.posizione;
    });

    const vincitore = ordinati[0]!;
    esito.resolved = true;
    if (vincitore.posizione !== 0) {
      esito.ranked = [
        vincitore.entry,
        ...input.ranked.filter((entry) => entry !== vincitore.entry),
      ];
      this.logger.log(
        `${input.displayName}: vince il candidato #${vincitore.posizione + 1} a ${vincitore.prezzo} ` +
          `(era primo un prodotto a prezzo di testa)`
      );
    }
    return esito;
  }

  /**
   * Il modello sulle varianti ambigue di un prodotto già scelto.
   *
   * Lo usa il ramo dei link, dove il prodotto non è in discussione — l'ha
   * indicato il cliente — e a mancare è solo quale delle sue varianti.
   */
  async chooseAmbiguous(
    detail: ElimDetail,
    candidati: readonly ElimSku[],
    spec: string | null,
    displayName: string,
    totals: { variantAiCostUsd?: number; variantAiPicks?: number }
  ): Promise<ElimSku | null> {
    const esito: VariantResolveOutcome = {
      ranked: [],
      elimCalls: 0,
      aiCostUsd: 0,
      aiPicks: 0,
      resolved: false,
    };
    const scelta = await this.chiediAlModello(
      detail,
      candidati,
      spec?.trim() || null,
      displayName,
      esito
    );
    totals.variantAiCostUsd = (totals.variantAiCostUsd ?? 0) + esito.aiCostUsd;
    totals.variantAiPicks = (totals.variantAiPicks ?? 0) + esito.aiPicks;
    return scelta;
  }

  /**
   * Chiede al modello quale variante comprare, quando il confronto non decide.
   *
   * Si arriva qui solo dopo che uguaglianza, contenimento, numeri e fasce hanno
   * fallito: il modello non sostituisce quel lavoro, lo raccoglie quando si
   * ferma. Serve perché certe differenze non stanno nei numeri —
   * «110CM平板拖把 蓝色» combacia sia con il mocio completo sia con il solo
   * panno di ricambio, e a separarli è il significato.
   */
  private async chiediAlModello(
    detail: ElimDetail,
    candidati: readonly ElimSku[],
    spec: string | null,
    displayName: string,
    esito: VariantResolveOutcome
  ): Promise<ElimSku | null> {
    if (!spec || candidati.length < 2) return null;
    if (candidati.length > VARIANT_AI_MAX_CHOICES) return null;

    const result = await pickVariantWithAi({
      productName: displayName,
      spec,
      listingTitle: detail.title,
      variants: candidati.map((sku) => ({ label: sku.label, price: sku.price })),
    });
    esito.aiCostUsd += result.costUsd;

    const choice = result.choice;
    if (!choice || choice.index == null) return null;
    if (choice.confidence < VARIANT_AI_MIN_CONFIDENCE) {
      this.logger.log(
        `${displayName}: variante proposta dal modello scartata, confidenza ${choice.confidence}`
      );
      return null;
    }
    const scelta = candidati[choice.index];
    if (!scelta) return null;
    esito.aiPicks += 1;
    this.logger.log(
      `${displayName}: variante «${scelta.label}» scelta dal modello fra ${candidati.length}`
    );
    return scelta;
  }
}
