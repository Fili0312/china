"use client";

import { useEffect } from "react";

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
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="panel search-empty filtered">
      <h2>Qualcosa si è interrotto in questa pagina</h2>
      <p>
        Se poco fa è stato pubblicato un aggiornamento, il browser sta ancora
        usando la versione precedente: ricaricare una volta risolve. Le
        correzioni alle query cinesi restano salvate.
      </p>
      <p className="muted">{error.message}</p>
      <div className="bulk-toolbar">
        <button onClick={reset}>Riprova senza ricaricare</button>
        <button className="secondary" onClick={() => window.location.reload()}>
          Ricarica la pagina
        </button>
      </div>
    </div>
  );
}
