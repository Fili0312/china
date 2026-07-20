import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSession,
  deriveKey,
  digestMatches,
  encryptSession,
  sessionDigest,
  SessionDecryptError,
  SessionSecretMissingError,
  summarizeCookies,
} from "./session-crypto";

const SECRET = "a".repeat(64);
const COOKIES = JSON.stringify([
  { name: "_tb_token_", value: "segretissimo", domain: ".taobao.com", expires: 1800000000 },
  { name: "cookie2", value: "altro-valore", domain: ".1688.com", expires: 1790000000 },
]);

test("una sessione cifrata si ridecifra identica", () => {
  const payload = encryptSession(COOKIES, SECRET);
  assert.equal(decryptSession(payload, SECRET), COOKIES);
});

test("il testo cifrato non contiene i valori dei cookie", () => {
  const payload = encryptSession(COOKIES, SECRET);
  const blob = `${payload.ciphertext}${payload.iv}${payload.authTag}`;
  assert.ok(!blob.includes("segretissimo"));
  assert.ok(!blob.includes("_tb_token_"));
});

test("due cifrature della stessa sessione sono diverse", () => {
  // Vettore di inizializzazione casuale: senza, due sessioni uguali sarebbero
  // riconoscibili come tali anche da chi legge solo il database.
  const first = encryptSession(COOKIES, SECRET);
  const second = encryptSession(COOKIES, SECRET);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv);
  assert.equal(decryptSession(second, SECRET), COOKIES);
});

test("un dato manomesso non si decifra affatto", () => {
  const payload = encryptSession(COOKIES, SECRET);
  const tampered = Buffer.from(payload.ciphertext, "base64");
  tampered[0] = tampered[0]! ^ 0xff;
  assert.throws(
    () =>
      decryptSession(
        { ...payload, ciphertext: tampered.toString("base64") },
        SECRET
      ),
    SessionDecryptError
  );
});

test("un tag di autenticazione alterato viene rifiutato", () => {
  const payload = encryptSession(COOKIES, SECRET);
  const tag = Buffer.from(payload.authTag, "base64");
  tag[0] = tag[0]! ^ 0xff;
  assert.throws(
    () => decryptSession({ ...payload, authTag: tag.toString("base64") }, SECRET),
    SessionDecryptError
  );
});

test("con un segreto diverso la sessione non si apre", () => {
  const payload = encryptSession(COOKIES, SECRET);
  assert.throws(
    () => decryptSession(payload, "b".repeat(64)),
    SessionDecryptError
  );
});

test("senza segreto configurato si fallisce con un messaggio chiaro", () => {
  assert.throws(() => encryptSession(COOKIES, undefined), SessionSecretMissingError);
  assert.throws(() => encryptSession(COOKIES, "   "), SessionSecretMissingError);
  assert.throws(
    () => deriveKey(""),
    /SCOUTING_SESSION_SECRET/
  );
});

test("il messaggio d'errore non rivela quale controllo è fallito", () => {
  // Distinguere «chiave sbagliata» da «dato alterato» aiuterebbe solo chi
  // sta provando ad aprire la sessione.
  const payload = encryptSession(COOKIES, SECRET);
  const wrongKey = (() => {
    try {
      decryptSession(payload, "c".repeat(64));
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  })();
  const tampered = Buffer.from(payload.ciphertext, "base64");
  tampered[1] = tampered[1]! ^ 0xff;
  const altered = (() => {
    try {
      decryptSession({ ...payload, ciphertext: tampered.toString("base64") }, SECRET);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  })();
  assert.equal(wrongKey, altered);
});

test("una passphrase qualsiasi produce comunque una chiave valida", () => {
  const payload = encryptSession(COOKIES, "la mia frase segreta");
  assert.equal(decryptSession(payload, "la mia frase segreta"), COOKIES);
  assert.equal(deriveKey("la mia frase segreta").length, 32);
});

test("l'impronta identifica la sessione senza esporla", () => {
  const digest = sessionDigest(COOKIES);
  assert.match(digest, /^[0-9a-f]{16}$/);
  assert.ok(!digest.includes("segretissimo"));
  assert.ok(digestMatches(digest, sessionDigest(COOKIES)));
  assert.ok(!digestMatches(digest, sessionDigest("altro")));
});

test("il riepilogo elenca i cookie senza i loro valori", () => {
  const summary = summarizeCookies(COOKIES);
  assert.deepEqual(
    summary.cookies.map((cookie) => cookie.name),
    ["_tb_token_", "cookie2"]
  );
  assert.ok(!JSON.stringify(summary).includes("segretissimo"));
  // La scadenza della sessione è quella del cookie che scade per primo.
  assert.equal(summary.expiresAt?.getTime(), 1790000000 * 1000);
});

test("un contenuto illeggibile non fa esplodere il riepilogo", () => {
  assert.deepEqual(summarizeCookies("non è json"), {
    cookies: [],
    expiresAt: null,
  });
  assert.deepEqual(summarizeCookies("{}"), { cookies: [], expiresAt: null });
});

test("si accetta sia l'elenco nudo sia l'oggetto con campo cookies", () => {
  const wrapped = JSON.stringify({ cookies: JSON.parse(COOKIES) });
  assert.equal(summarizeCookies(wrapped).cookies.length, 2);
});
