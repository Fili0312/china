import { en } from "../i18n/messages-en";
import { ScoutingV2 } from "../scouting-v2/scouting-v2";

/**
 * Scouting v3: stessa interfaccia, motore diverso.
 *
 * Due regole cambiano rispetto alla v2, e stanno tutte nel backend:
 *
 * 1. **I prodotti che nel foglio hanno un link non si cercano.** Si apre il
 *    link, si legge l'inserzione e si prende la variante indicata nella
 *    colonna delle specifiche — con il suo prezzo, non quello di testa. Su un
 *    foglio reale sono 378 righe su 498: altrettante ricerche risparmiate.
 * 2. **Per gli altri la ricerca guarda più candidati** (quindici invece di
 *    dieci), perché il risparmio del punto 1 si rimette dove serve davvero.
 *
 * La pagina è la stessa della v2 di proposito: duplicarne mille righe per
 * cambiare una stringa avrebbe creato due interfacce destinate a divergere
 * alla prima correzione. Quale motore usare lo dice la modalità.
 */
export const metadata = {
  title: en["v3.heading"],
};

export default function ScoutingV3Page() {
  return <ScoutingV2 mode="v3" />;
}
