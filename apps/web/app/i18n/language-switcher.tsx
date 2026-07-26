"use client";

import { useI18n } from "./context";
import { LOCALES, LOCALE_NAMES, LOCALE_SHORT_NAMES } from "./locale";

/**
 * Il selettore di lingua: tre pulsanti, non un menu a tendina.
 *
 * Con tre voci una tendina nasconde due terzi delle opzioni dietro un click e
 * non dice in che lingua si sta leggendo finché non la si apre. Qui la lingua
 * attiva è visibile sempre, e cambiarla costa un click solo.
 */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <nav className="lang-switcher" aria-label={t("lang.label")}>
      {LOCALES.map((entry) => (
        <button
          key={entry}
          type="button"
          className={`lang-option${entry === locale ? " active" : ""}`}
          // `lang` sul pulsante: il nome di ogni lingua è scritto nella lingua
          // stessa, e senza questo un lettore di schermo inglese proverebbe a
          // pronunciare «中文» con le regole dell'inglese.
          lang={entry}
          aria-current={entry === locale}
          title={LOCALE_NAMES[entry]}
          onClick={() => setLocale(entry)}
        >
          {LOCALE_SHORT_NAMES[entry]}
        </button>
      ))}
    </nav>
  );
}
