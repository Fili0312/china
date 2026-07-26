/**
 * Date e numeri nella lingua scelta.
 *
 * Prima erano tutti `toLocaleString("it-IT")` scritti a mano in ogni file: con
 * tre lingue quella riga andrebbe corretta in dieci punti, e basta dimenticarne
 * uno per avere una tabella con due formati di data diversi nella stessa riga.
 */

/** Data e ora complete: per gli storici, dove conta anche il minuto. */
export function formatDateTime(value: string, intlLocale: string): string {
  return new Date(value).toLocaleString(intlLocale);
}

/** Data e ora compatte: per le tabelle, dove la colonna è stretta. */
export function formatShortDateTime(value: string, intlLocale: string): string {
  return new Date(value).toLocaleString(intlLocale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Solo la data. `fallback` è ciò che si scrive quando il valore manca. */
export function formatDate(
  value: string | null,
  intlLocale: string,
  fallback: string
): string {
  return value ? new Date(value).toLocaleDateString(intlLocale) : fallback;
}

/** Prezzo con la sua valuta; `dash` quando il prezzo non c'è. */
export function formatPrice(
  value: number | null,
  currency: string | null,
  intlLocale: string,
  dash: string
): string {
  if (value == null) return dash;
  const amount = value.toLocaleString(intlLocale, { maximumFractionDigits: 2 });
  return `${amount} ${currency ?? ""}`.trim();
}
