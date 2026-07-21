import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Carica le variabili d'ambiente del monorepo.
 *
 * Per ogni posizione si prova prima `.env.local` e poi `.env`: dotenv non
 * sovrascrive una variabile già impostata, quindi **il primo file che la
 * definisce vince**. È così che `.env.local` può contenere i segreti veri
 * (chiavi API, credenziali) lasciando in `.env` i valori condivisi, senza che
 * i due si pestino i piedi.
 *
 * Entrambi i file sono esclusi da git.
 */
const roots = [
  process.cwd(),
  resolve(process.cwd(), "../.."),
  resolve(__dirname, "../../.."),
];

for (const root of roots) {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(root, name);
    if (existsSync(path)) config({ path });
  }
}
