/**
 * La scala delle query: dalla più precisa alla più larga.
 *
 * I marketplace cinesi combinano i termini in **AND**. Una query completa come
 * `珍珠白4层货架 加厚中型 200*40*140 300KG/层` descrive benissimo lo scaffale
 * che serve e non trova **niente**, perché nessun titolo contiene tutti e
 * quattro i gruppi. Visto sul file reale: quella riga tornava con zero
 * candidati mentre lo scaffale su Taobao c'è.
 *
 * La risposta non è cercare subito largo — si perderebbe la precisione dove
 * invece paga — ma provare in ordine: prima la query intera, poi una versione
 * accorciata, infine il solo nome prodotto. Ci si ferma **al primo tentativo
 * che trova qualcosa**, così una riga precisa costa una chiamata sola e
 * soltanto le righe difficili ne costano due o tre.
 *
 * La scala è deterministica: la stessa riga produce sempre gli stessi
 * tentativi, quindi la cache li riconosce e il secondo file che chiede lo
 * stesso pezzo non ripaga nulla.
 */

/** Tentativi massimi per una singola ricerca. */
const MAX_ATTEMPTS = 3;

/**
 * Termini della query, nell'ordine in cui sono scritti.
 *
 * Il primo è quasi sempre il nome del prodotto — la query cinese si costruisce
 * come `品名 + 规格型号` — e per questo l'accorciamento tiene i primi e butta
 * gli ultimi: sono le specifiche a restringere troppo, non il nome.
 */
function terms(query: string): string[] {
  return query
    .normalize("NFKC")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * Costruisce i tentativi per una query.
 *
 * Con uno o due termini non c'è niente da accorciare: la scala ha un gradino
 * solo, e la riga costa una chiamata.
 */
export function buildQueryLadder(query: string): string[] {
  const parts = terms(query);
  if (parts.length === 0) return [];

  const ladder = [parts.join(" ")];
  if (parts.length <= 1) return ladder;

  // Metà dei termini: si tengono i primi, che portano il nome del prodotto.
  const half = parts.slice(0, Math.max(1, Math.ceil(parts.length / 2))).join(" ");
  if (!ladder.includes(half)) ladder.push(half);

  // Ultimo gradino: il solo nome prodotto.
  const first = parts[0]!;
  if (!ladder.includes(first)) ladder.push(first);

  return ladder.slice(0, MAX_ATTEMPTS);
}
