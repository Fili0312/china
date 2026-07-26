import type { Locale } from "@china/shared";

/**
 * Ciò che serve solo all'interfaccia per parlare tre lingue.
 *
 * L'elenco delle lingue vive in `@china/shared` perché lo usa anche l'API: da
 * lì arrivano `LOCALES`, `Locale`, `DEFAULT_LOCALE` e `isLocale`, ri-esportati
 * qui sotto perché i componenti abbiano un unico posto da importare. Nomi,
 * formati e chiave di `localStorage` restano invece qui: sono decisioni
 * dell'interfaccia, e il server non ne sa nulla.
 */
export { LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from "@china/shared";

/** Chiave in `localStorage`: la scelta della lingua sopravvive al reload. */
export const LOCALE_STORAGE_KEY = "china.locale";

/** Come si chiama ogni lingua nella lingua stessa: mai tradurre questi nomi. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  it: "Italiano",
};

/** Etichetta corta per il selettore, dove lo spazio è poco. */
export const LOCALE_SHORT_NAMES: Record<Locale, string> = {
  en: "EN",
  zh: "中文",
  it: "IT",
};

/**
 * Locale BCP 47 per date e numeri.
 *
 * Per l'inglese si usa `en-GB` e non `en-US`: le date del pannello sono
 * giorno/mese, come nel file Excel di partenza e come le legge chi lavora qui.
 * Con `en-US` la stessa data cambierebbe significato senza avvisare.
 */
export const INTL_LOCALES: Record<Locale, string> = {
  en: "en-GB",
  zh: "zh-CN",
  it: "it-IT",
};
