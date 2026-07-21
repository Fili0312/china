/**
 * Quando un prodotto già trovato vale ancora, e quando si ricerca da capo.
 *
 * Un link salvato mesi fa non è una risposta: la pagina può essere sparita, il
 * venditore può aver chiuso, il prezzo può essere raddoppiato, la variante che
 * serviva può non essere più a catalogo. Riusarlo senza controllare sarebbe
 * peggio che non averlo, perché sembra un dato aggiornato.
 *
 * Qui vivono solo le **regole**: prendono lo stato dei prodotti e le soglie e
 * dicono cosa fare. Nessun accesso a database, nessuna rete — così le regole si
 * possono provare tutte, comprese quelle che in produzione capitano una volta
 * ogni sei mesi.
 */

/** Soglie configurabili del riuso. */
export interface ReuseSettings {
  /** Oltre questa età la verifica è considerata scaduta. */
  maxCacheAgeHours: number;
  /** Variazione di prezzo oltre la quale il prodotto va ricercato di nuovo. */
  maxPriceChangePct: number;
  /** Sotto questo numero di prodotti validi si rifà la ricerca completa. */
  minValidCandidates: number;
  /** Se l'aggiornamento fallisce, si rifà la ricerca invece di fidarsi. */
  fullSearchOnError: boolean;
}

/** Valori predefiniti, sovrascrivibili da variabili d'ambiente. */
export const DEFAULT_REUSE_SETTINGS: ReuseSettings = {
  maxCacheAgeHours: 24 * 14,
  maxPriceChangePct: 25,
  minValidCandidates: 2,
  fullSearchOnError: true,
};

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Soglie effettive: predefinite salvo quanto indicato nell'ambiente. */
export function readReuseSettings(): ReuseSettings {
  return {
    maxCacheAgeHours: numericEnv(
      "SCOUTING_PRODUCT_CACHE_HOURS",
      DEFAULT_REUSE_SETTINGS.maxCacheAgeHours
    ),
    maxPriceChangePct: numericEnv(
      "SCOUTING_MAX_PRICE_CHANGE_PCT",
      DEFAULT_REUSE_SETTINGS.maxPriceChangePct
    ),
    minValidCandidates: numericEnv(
      "SCOUTING_MIN_VALID_CANDIDATES",
      DEFAULT_REUSE_SETTINGS.minValidCandidates
    ),
    fullSearchOnError: booleanEnv(
      "SCOUTING_FULL_SEARCH_ON_ERROR",
      DEFAULT_REUSE_SETTINGS.fullSearchOnError
    ),
  };
}

/** Stato di un prodotto già salvato, come lo vede la regola. */
export interface KnownProductState {
  candidateId: string;
  /** L'ultimo controllo non ha trovato la pagina (rimossa o irraggiungibile). */
  unavailable: boolean;
  /** L'ultimo aggiornamento è fallito per un errore, non per una rimozione. */
  refreshFailed: boolean;
  /** La variante richiesta non compare più fra quelle disponibili. */
  variantMissing: boolean;
  /** Il prodotto non rispetta più un vincolo obbligatorio. */
  requirementsFailed: boolean;
  price: number | null;
  /** Prezzo dell'ultimo controllo precedente, dallo storico. */
  previousPrice: number | null;
  vendorName: string | null;
  /** Venditore presente quando il prodotto era stato trovato. */
  hadVendor: boolean;
  lastCheckedAt: Date;
}

/** Perché un prodotto non è più utilizzabile. */
export const INVALIDATION_CODES = [
  "UNREACHABLE",
  "REFRESH_FAILED",
  "VARIANT_MISSING",
  "REQUIREMENTS_FAILED",
  "NO_PRICE",
  "STALE",
  "PRICE_JUMP",
  "VENDOR_GONE",
] as const;
export type InvalidationCode = (typeof INVALIDATION_CODES)[number];

export interface InvalidProduct {
  candidateId: string;
  code: InvalidationCode;
  /** Spiegazione in italiano, mostrata in interfaccia. */
  reason: string;
}

export interface KnownProductsEvaluation {
  valid: string[];
  invalid: InvalidProduct[];
}

/** Variazione percentuale fra due prezzi, in valore assoluto. */
export function priceChangePct(previous: number, current: number): number {
  if (!Number.isFinite(previous) || previous === 0) return 0;
  return Math.abs((current - previous) / previous) * 100;
}

/**
 * Divide i prodotti già noti fra ancora validi e da scartare.
 *
 * Ogni prodotto viene giudicato da solo, e il primo motivo che lo invalida
 * vince: all'utente serve **una** ragione chiara («la pagina non risponde più»),
 * non l'elenco di tutto ciò che non va.
 */
export function evaluateKnownProducts(
  products: readonly KnownProductState[],
  settings: ReuseSettings,
  now: Date = new Date()
): KnownProductsEvaluation {
  const valid: string[] = [];
  const invalid: InvalidProduct[] = [];
  const maxAgeMs = settings.maxCacheAgeHours * 3_600_000;

  for (const product of products) {
    const reject = (code: InvalidationCode, reason: string) => {
      invalid.push({ candidateId: product.candidateId, code, reason });
    };

    if (product.unavailable) {
      reject("UNREACHABLE", "La pagina del prodotto non è più raggiungibile.");
      continue;
    }
    if (product.refreshFailed && settings.fullSearchOnError) {
      reject("REFRESH_FAILED", "L'aggiornamento del prodotto è fallito.");
      continue;
    }
    if (product.variantMissing) {
      reject("VARIANT_MISSING", "La variante richiesta non è più disponibile.");
      continue;
    }
    if (product.requirementsFailed) {
      reject(
        "REQUIREMENTS_FAILED",
        "Il prodotto non rispetta più i requisiti obbligatori."
      );
      continue;
    }
    if (product.price == null) {
      reject("NO_PRICE", "Il prezzo non è più leggibile dalla scheda.");
      continue;
    }
    if (now.getTime() - product.lastCheckedAt.getTime() > maxAgeMs) {
      reject(
        "STALE",
        `Ultima verifica più vecchia di ${settings.maxCacheAgeHours} ore.`
      );
      continue;
    }
    if (product.previousPrice != null) {
      const change = priceChangePct(product.previousPrice, product.price);
      if (change > settings.maxPriceChangePct) {
        reject(
          "PRICE_JUMP",
          `Il prezzo è cambiato del ${change.toFixed(0)}% ` +
            `(soglia ${settings.maxPriceChangePct}%).`
        );
        continue;
      }
    }
    // Un venditore che sparisce è un segnale forte: la scheda può restare in
    // piedi mentre il negozio è chiuso. Conta solo se prima c'era.
    if (product.hadVendor && !product.vendorName) {
      reject("VENDOR_GONE", "Il venditore non è più disponibile.");
      continue;
    }

    valid.push(product.candidateId);
  }

  return { valid, invalid };
}

/** Cosa fare di una variante già conosciuta. */
export type ReuseDecision =
  | { reuse: true; validCandidates: string[]; reason: string }
  | { reuse: false; validCandidates: string[]; reason: string };

/**
 * Decide se la variante può essere servita con ciò che già abbiamo.
 *
 * La soglia è sul **numero di prodotti validi**, non sulla loro esistenza: un
 * solo superstite non è una scelta, è un ripiego, e chi confronta i prezzi ha
 * bisogno di alternative.
 */
export function decideReuse(
  evaluation: KnownProductsEvaluation,
  settings: ReuseSettings
): ReuseDecision {
  const validCandidates = evaluation.valid;

  if (validCandidates.length === 0) {
    return {
      reuse: false,
      validCandidates,
      reason:
        evaluation.invalid.length > 0
          ? `Nessun prodotto ancora valido: ${evaluation.invalid[0]!.reason}`
          : "Nessun prodotto salvato per questa variante.",
    };
  }

  if (validCandidates.length < settings.minValidCandidates) {
    return {
      reuse: false,
      validCandidates,
      reason:
        `Solo ${validCandidates.length} prodotto/i validi su un minimo di ` +
        `${settings.minValidCandidates}: si rifà la ricerca completa.`,
    };
  }

  return {
    reuse: true,
    validCandidates,
    reason:
      `${validCandidates.length} prodotti già noti ancora validi: ` +
      "aggiornati invece di ricercarli.",
  };
}
