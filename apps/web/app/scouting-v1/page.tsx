import { en } from "../i18n/messages-en";
import { ScoutingV1 } from "./scouting-v1";

/**
 * Il titolo lo rende il server, prima che la lingua scelta sia nota: resta in
 * inglese, come i metadati del layout.
 */
export const metadata = {
  title: en["app.title"],
};

export default function ScoutingV1Page() {
  return <ScoutingV1 />;
}
