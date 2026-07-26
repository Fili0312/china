"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setActiveLocale } from "./active-locale";
import { en, type MessageKey } from "./messages-en";
import { it } from "./messages-it";
import { zh } from "./messages-zh";
import {
  DEFAULT_LOCALE,
  INTL_LOCALES,
  isLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
} from "./locale";

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, zh, it };

export type MessageParams = Readonly<Record<string, string | number>>;

/** Sostituisce i segnaposto `{nome}`; quelli senza valore restano visibili. */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole
  );
}

/**
 * Rende `<strong>…</strong>` senza `dangerouslySetInnerHTML`.
 *
 * I testi del dizionario sono nostri, ma i valori interpolati arrivano dai
 * file dei clienti e dalle risposte dei marketplace: se passassero per
 * `innerHTML`, un titolo prodotto con un tag dentro diventerebbe markup
 * eseguito. Qui il grassetto è l'unico tag riconosciuto, e viene cercato
 * **prima** dell'interpolazione — così nessun valore può introdurne uno.
 */
function renderStrong(template: string, params?: MessageParams): ReactNode {
  const parts = template.split(/<strong>|<\/strong>/);
  if (parts.length === 1) return interpolate(template, params);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index}>{interpolate(part, params)}</strong>
    ) : (
      <span key={index}>{interpolate(part, params)}</span>
    )
  );
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Testo semplice: sempre una stringa, usabile in `title` e `placeholder`. */
  t: (key: MessageKey, params?: MessageParams) => string;
  /** Testo con `<strong>`: da usare solo dove si può inserire un nodo React. */
  tr: (key: MessageKey, params?: MessageParams) => ReactNode;
  /** Locale BCP 47 per `toLocaleString` di date e numeri. */
  intlLocale: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Il primo render è sempre nella lingua predefinita: è ciò che il server ha
  // prodotto, e cambiarlo prima dell'idratazione farebbe divergere i due
  // alberi. La preferenza salvata si applica subito dopo.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) setLocaleState(stored);
  }, []);

  // Allineata durante il render, non in un effetto: gli effetti dei figli —
  // quelli che fanno le prime chiamate all'API — girano *prima* di quelli del
  // genitore, quindi da un `useEffect` qui la lingua arriverebbe in ritardo di
  // una richiesta. Assegnare un valore a un modulo è idempotente: ripeterlo a
  // ogni render non costa niente.
  setActiveLocale(locale);

  // `lang` sul documento non è cosmetico: decide la sillabazione, le
  // virgolette e — su un testo cinese — quale famiglia di caratteri il browser
  // sceglie fra le varianti han.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dictionary = DICTIONARIES[locale];
    return {
      locale,
      setLocale,
      t: (key, params) => interpolate(dictionary[key] ?? en[key] ?? key, params),
      tr: (key, params) => renderStrong(dictionary[key] ?? en[key] ?? key, params),
      intlLocale: INTL_LOCALES[locale],
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n richiede <I18nProvider> più in alto nell'albero.");
  return value;
}
