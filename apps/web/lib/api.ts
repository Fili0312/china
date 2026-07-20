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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
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
