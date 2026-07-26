import type { ProductAnalysis, ProductIdentity } from "../schemas/analysis";
import {
  canonicalTextList,
  canonicalVariant,
  identityDigest,
  normalizeFamilyKey,
} from "./product-identity";
import { residualSignature } from "./variant-signature";

/**
 * L'identità di una variante nello scouting v1.
 *
 * È la stessa idea a tre livelli dello scouting multi-marketplace — famiglia,
 * variante, duplicato — con una differenza che nasce da un errore visto sul
 * campo: la chiave non si calcola più **soltanto** dai campi che il modello ha
 * estratto, ma anche dal residuo del testo originale (`variant-signature.ts`).
 *
 * Perché conta: se l'estrazione perde una misura, l'identità basata sui soli
 * campi strutturati fonde due prodotti diversi in una sola richiesta. Con il
 * residuo, ciò che il testo dice e i campi non dicono resta nella chiave, e i
 * due prodotti restano due.
 *
 * Le chiavi di questo modulo **non** sono compatibili con quelle di
 * `computeProductIdentity`: vivono in tabelle diverse (`TaobaoRequest` contro
 * `ScoutingRequest`) proprio per questo. Lo scouting esistente continua a
 * usare le sue, invariate.
 */

/** Lunghezza della parte hash: identica a quella dello scouting classico. */
const VARIANT_HASH_LENGTH = 24;
const DUPLICATE_HASH_LENGTH = 16;

export interface VariantIdentity extends ProductIdentity {
  /**
   * Token del testo originale che i campi strutturati non coprivano e che sono
   * entrati nella chiave. Quasi sempre vuoto; quando non lo è, è la
   * spiegazione del perché due righe simili non sono la stessa variante.
   */
  residual: string[];
}

/** Campi dell'analisi che concorrono all'identità. */
type IdentityInput = Pick<
  ProductAnalysis,
  | "familyKey"
  | "model"
  | "material"
  | "color"
  | "dimensions"
  | "technicalSpecifications"
  | "includedAccessories"
  | "hardRequirements"
>;

/**
 * Calcola famiglia, variante e duplicato.
 *
 * @param sourceText testo originale della riga (nome, specifiche, utilizzo).
 *   Senza di esso il residuo è vuoto e il risultato coincide con l'identità
 *   basata sui soli campi strutturati: è il comportamento di ripiego, non
 *   quello previsto.
 */
export function computeVariantIdentity(
  analysis: IdentityInput,
  sourceText?: string | null
): VariantIdentity {
  const familyKey = normalizeFamilyKey(analysis.familyKey);
  const variant = canonicalVariant(analysis);

  const residual = residualSignature(
    sourceText,
    {
      model: analysis.model,
      material: analysis.material,
      color: analysis.color,
      dimensions: analysis.dimensions,
      technicalSpecifications: analysis.technicalSpecifications,
    },
    (analysis.dimensions ?? []).map((dimension) => dimension.value)
  );

  // L'ordine delle chiavi è il contratto di serializzazione: cambiarlo
  // invaliderebbe tutte le varianti già salvate.
  const variantKey = `${familyKey}:${identityDigest({ variant, residual }, VARIANT_HASH_LENGTH)}`;

  // Il duplicato aggiunge i vincoli obbligatori: stessa configurazione tecnica
  // ma «con certificato CE» non è la stessa richiesta.
  const duplicateKey = `${variantKey}:${identityDigest(
    { variant: variantKey, hard: canonicalTextList(analysis.hardRequirements ?? []) },
    DUPLICATE_HASH_LENGTH
  )}`;

  return { familyKey, variantKey, duplicateKey, residual };
}
