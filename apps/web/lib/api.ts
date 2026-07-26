import { getActiveLocale } from "../app/i18n/active-locale";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3021";

export type ApiQueryValue = string | number | boolean | null | undefined;

/**
 * Costruisce query string in un solo punto: evita che parametri importanti
 * (come il profilo qualità) vengano dimenticati da una delle modalità UI.
 */
export function withApiQuery(
  path: string,
  query: Readonly<Record<string, ApiQueryValue>>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/**
 * URL assoluto di un download, con la lingua attaccata.
 *
 * I file scaricati (Excel dei risultati, report per il cliente) li genera
 * l'API, intestazioni comprese. Un `<a href>` non passa da `fetch`, quindi non
 * porta `Accept-Language`: senza `?lang=` si finirebbe per scaricare un foglio
 * in inglese mentre si guarda una pagina in cinese.
 */
export function apiDownloadUrl(
  path: string,
  query: Readonly<Record<string, ApiQueryValue>> = {}
): string {
  return `${API_URL}/api${withApiQuery(path, { ...query, lang: getActiveLocale() })}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      // La lingua dei messaggi d'errore la decide chi guarda la pagina, non il
      // server: un «cliente non trovato» in italiano dentro un'interfaccia
      // cinese è un vicolo cieco per chi lo legge.
      "Accept-Language": getActiveLocale(),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      const body = JSON.parse(raw) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
      if (Array.isArray(body.message)) detail = body.message.join(", ");
    } catch {
      // Risposta non JSON: usa il testo originale.
    }
    throw new Error(detail || `API ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
