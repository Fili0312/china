import type { ProductAnalysis } from "../schemas/analysis";

/**
 * Pulizia deterministica delle query di ricerca.
 *
 * Il prompt lo vieta già, ma «vietato nel prompt» non è una garanzia: nel
 * confronto reale fra provider una query è arrivata con la quantità dentro
 * («... 86*54 100张»), e una query con la quantità non cerca il prodotto —
 * cerca una confezione. Questa regola non dipende da nessun modello: se
 * l'analisi dice `requestedQuantity: 100, unit: 张`, il token «100张» nella
 * query è la quantità, e si toglie.
 *
 * La regola è volutamente stretta: si rimuove SOLO la coppia esatta
 * quantità+unità dichiarata dall'analisi. Un numero da solo non si tocca mai —
 * potrebbe essere una misura — e senza unità dichiarata non si tocca niente.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unità di conteggio CJK: attaccate al numero senza spazi (100张, 50个). */
const CJK = /^[㐀-鿿]+$/;

function stripQuantity(
  query: string | null,
  quantity: number,
  unit: string
): string | null {
  if (!query) return query;
  const q = escapeRegExp(String(quantity));
  const u = escapeRegExp(unit);

  // In cinese la quantità è «100张» senza separatori; in latino serve un
  // confine, altrimenti «10 pcs» dentro un codice verrebbe mutilato.
  const pattern = CJK.test(unit)
    ? new RegExp(`${q}\\s*${u}`, "g")
    : new RegExp(`(^|\\s)${q}\\s*${u}(?=\\s|$)`, "gi");

  const cleaned = query.replace(pattern, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * Applica le pulizie deterministiche a un'analisi. Restituisce l'analisi
 * stessa quando non c'è niente da correggere: chi confronta per identità non
 * vede differenze fantasma.
 */
export function sanitizeProductAnalysis(analysis: ProductAnalysis): ProductAnalysis {
  const quantity = analysis.requestedQuantity;
  const unit = (analysis.unit ?? "").trim();
  if (quantity == null || !unit) return analysis;

  const zh = stripQuantity(analysis.searchQueryChinese, quantity, unit);
  const en = stripQuantity(analysis.searchQueryEnglish, quantity, unit);
  if (zh === analysis.searchQueryChinese && en === analysis.searchQueryEnglish) {
    return analysis;
  }
  return { ...analysis, searchQueryChinese: zh, searchQueryEnglish: en };
}
