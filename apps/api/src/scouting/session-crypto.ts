import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Cifratura delle sessioni dei marketplace.
 *
 * I cookie di 1688 e Taobao sono credenziali a tutti gli effetti: chi li legge
 * entra nell'account. Non possono stare in chiaro a database, non devono
 * comparire nei log e non devono mai tornare indietro da un'API.
 *
 * AES-256-GCM: cifra e **autentica** insieme. Un blob manomesso non si
 * decifra affatto invece di produrre dati plausibili ma sbagliati — che con
 * dei cookie significherebbe una sessione corrotta usata a insaputa di tutti.
 *
 * La chiave viene da `SCOUTING_SESSION_SECRET` e non è mai scritta nel codice.
 * Se manca, salvare una sessione fallisce con un errore chiaro: cifrare con
 * una chiave costante di ripiego darebbe una falsa sensazione di sicurezza.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // raccomandato per GCM
const KEY_LENGTH = 32;

export class SessionSecretMissingError extends Error {
  constructor() {
    super(
      "SCOUTING_SESSION_SECRET non è configurato: senza segreto le sessioni " +
        "dei marketplace non possono essere cifrate. Genera 32 byte casuali " +
        "(openssl rand -hex 32) e mettilo nel .env del server."
    );
    this.name = "SessionSecretMissingError";
  }
}

export class SessionDecryptError extends Error {
  constructor() {
    // Nessun dettaglio tecnico: distinguere «chiave sbagliata» da «dato
    // manomesso» aiuterebbe solo chi ci sta provando.
    super(
      "Sessione non decifrabile: il segreto è cambiato oppure il dato è stato " +
        "alterato. Ricollega l'account."
    );
    this.name = "SessionDecryptError";
  }
}

/**
 * Deriva la chiave a 32 byte dal segreto configurato.
 *
 * Un segreto già esadecimale da 64 caratteri viene usato così com'è; qualsiasi
 * altra forma passa da SHA-256, così anche una passphrase produce una chiave
 * della lunghezza giusta invece di essere rifiutata o troncata.
 */
export function deriveKey(secret: string | undefined): Buffer {
  const value = (secret ?? "").trim();
  if (!value) throw new SessionSecretMissingError();

  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }
  return createHash("sha256").update(value).digest().subarray(0, KEY_LENGTH);
}

export interface EncryptedPayload {
  /** Testo cifrato in base64. */
  ciphertext: string;
  /** Vettore di inizializzazione, diverso a ogni cifratura. */
  iv: string;
  /** Tag di autenticazione GCM: è ciò che rileva le manomissioni. */
  authTag: string;
}

export function encryptSession(
  plaintext: string,
  secret: string | undefined
): EncryptedPayload {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSession(
  payload: EncryptedPayload,
  secret: string | undefined
): string {
  const key = deriveKey(secret);
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SessionDecryptError();
  }
}

/**
 * Impronta della sessione, per accorgersi che è stata sostituita senza mai
 * confrontare i cookie in chiaro. Il confronto usa `timingSafeEqual`.
 */
export function sessionDigest(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 16);
}

export function digestMatches(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Descrizione di un cookie, senza il suo valore. */
export interface CookieSummary {
  name: string;
  domain: string;
  expiresAt: string | null;
}

/**
 * Legge i cookie salvati e ne ricava un riepilogo **senza valori**, più la
 * scadenza più vicina. È ciò che l'interfaccia può mostrare: sapere che la
 * sessione contiene `_tb_token_` è utile, conoscerne il valore no.
 */
export function summarizeCookies(plaintext: string): {
  cookies: CookieSummary[];
  expiresAt: Date | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { cookies: [], expiresAt: null };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : [];

  const cookies: CookieSummary[] = [];
  let soonest: number | null = null;

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const cookie = entry as {
      name?: unknown;
      domain?: unknown;
      expires?: unknown;
      expirationDate?: unknown;
    };
    const name = typeof cookie.name === "string" ? cookie.name : null;
    if (!name) continue;

    // Playwright usa `expires` in secondi, le estensioni `expirationDate`.
    const raw = cookie.expires ?? cookie.expirationDate;
    const seconds = typeof raw === "number" && raw > 0 ? raw : null;
    if (seconds != null && (soonest == null || seconds < soonest)) {
      soonest = seconds;
    }

    cookies.push({
      name,
      domain: typeof cookie.domain === "string" ? cookie.domain : "",
      expiresAt: seconds == null ? null : new Date(seconds * 1000).toISOString(),
    });
  }

  return {
    cookies,
    expiresAt: soonest == null ? null : new Date(soonest * 1000),
  };
}
