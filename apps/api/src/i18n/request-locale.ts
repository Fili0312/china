import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@china/shared";

/**
 * La lingua della richiesta in corso, leggibile da qualsiasi profondità.
 *
 * L'alternativa era passare `locale` come parametro: dal controller al
 * servizio, dal servizio al generatore di fogli Excel, e da lì al pezzo che
 * scrive le intestazioni. Sono decine di firme cambiate per un valore che
 * nessuno di quei livelli usa davvero — e ne basta una dimenticata perché un
 * messaggio esca nella lingua sbagliata senza che niente si rompa.
 *
 * `AsyncLocalStorage` è il meccanismo di Node per questo: il middleware apre
 * un contesto per richiesta e tutto ciò che parte da lì, `await` compresi, lo
 * vede. Fuori da una richiesta — nei job di ricerca, che girano per conto loro
 * dopo che la risposta HTTP è già partita — non c'è contesto, e si torna alla
 * lingua predefinita: quei testi finiscono nel database, dove una lingua fissa
 * è l'unica scelta onesta.
 */
const storage = new AsyncLocalStorage<Locale>();

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return storage.run(locale, fn);
}

export function currentLocale(): Locale {
  return storage.getStore() ?? DEFAULT_LOCALE;
}

/**
 * Ricava la lingua da una richiesta HTTP.
 *
 * `?lang=` vince su `Accept-Language` perché è esplicito: lo mette il link di
 * download, dove l'header non arriva. Di `Accept-Language` si guarda solo la
 * prima preferenza e solo la sottostringa iniziale, così `zh-CN` e `zh-Hans`
 * finiscono entrambi su `zh`.
 */
export function resolveLocale(
  queryLang: unknown,
  acceptLanguage: string | undefined
): Locale {
  if (isLocale(queryLang)) return queryLang;

  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
