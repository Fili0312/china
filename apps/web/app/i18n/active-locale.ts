import { DEFAULT_LOCALE, type Locale } from "./locale";

/**
 * La lingua corrente vista da chi non è un componente React.
 *
 * `lib/api.ts` deve mettere `Accept-Language` su ogni richiesta e i link di
 * download devono portare `?lang=`, ma nessuno dei due può usare un hook. Il
 * provider tiene aggiornato questo valore a ogni cambio di lingua, così esiste
 * una sola verità e non due copie che divergono.
 */
let active: Locale = DEFAULT_LOCALE;

export function setActiveLocale(locale: Locale): void {
  active = locale;
}

export function getActiveLocale(): Locale {
  return active;
}
