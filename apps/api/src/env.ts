import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Carica il .env di root del monorepo (e un eventuale .env locale dell'app).
for (const p of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(__dirname, "../../../.env"),
]) {
  if (existsSync(p)) config({ path: p });
}
