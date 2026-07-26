/**
 * Le lingue della piattaforma, definite una volta per tutti.
 *
 * Stanno qui e non nell'interfaccia perché non riguardano solo l'interfaccia:
 * l'API traduce i messaggi d'errore e le intestazioni dei fogli Excel con lo
 * stesso elenco. Due elenchi separati diventerebbero due elenchi diversi al
 * primo cambiamento, e il sintomo sarebbe un download in una lingua che il
 * pannello non offre.
 */
export const LOCALES = ["en", "zh", "it"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * L'inglese è il predefinito: è la lingua di chi legge i risultati senza
 * parlare né italiano né cinese, ed è quella che vede chi arriva senza aver
 * mai scelto.
 */
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Testo per ogni lingua. Le etichette tradotte hanno tutte questa forma. */
export type Localized<T extends string> = Record<Locale, Record<T, string>>;
