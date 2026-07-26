import { redirect } from "next/navigation";

/**
 * La radice non ha più una pagina propria.
 *
 * Lo scouting per cliente è l'unico flusso in uso, e vive su `/scouting-v1`:
 * quello è l'indirizzo che le persone hanno salvato nei preferiti e che gira
 * nei messaggi. Spostarlo qui costerebbe la rottura di quei link in cambio di
 * un URL più corto — un cattivo affare. La radice reindirizza e basta.
 */
export default function HomePage(): never {
  redirect("/scouting-v1");
}
