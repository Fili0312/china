"use client";

import { useEffect } from "react";
import { useI18n } from "./i18n/context";

/**
 * Sostituisce la schermata di errore predefinita di Next, che chiede solo di
 * ricaricare la pagina senza dire cosa è successo. Il caso più comune è un
 * deploy avvenuto mentre la pagina era aperta: il browser tiene i file della
 * versione precedente e va ricaricato una volta sola.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="panel search-empty filtered">
      <h2>{t("error.title")}</h2>
      <p>{t("error.body")}</p>
      <p className="muted">{error.message}</p>
      <div className="bulk-toolbar">
        <button onClick={reset}>{t("error.retry")}</button>
        <button className="secondary" onClick={() => window.location.reload()}>
          {t("error.reload")}
        </button>
      </div>
    </div>
  );
}
