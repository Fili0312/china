import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "./i18n/context";
import { LanguageSwitcher } from "./i18n/language-switcher";
import { DEFAULT_LOCALE } from "./i18n/locale";
import { en } from "./i18n/messages-en";

/**
 * I metadati non passano dal dizionario React: Next li rende sul server, dove
 * la preferenza salvata nel browser non è ancora nota. Restano quindi nella
 * lingua predefinita — l'inglese — che è anche quella giusta per un titolo
 * visto da un motore di ricerca o incollato in una chat.
 */
export const metadata: Metadata = {
  title: en["app.title"],
  description: en["app.description"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `lang` parte dal predefinito e viene riscritto dal provider appena legge
    // la preferenza: il server non può indovinarlo senza far divergere
    // l'idratazione.
    <html lang={DEFAULT_LOCALE}>
      <body>
        <I18nProvider>
          <LanguageSwitcher />
          <main>{children}</main>
        </I18nProvider>
      </body>
    </html>
  );
}
