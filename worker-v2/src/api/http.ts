/** HTTP helpers. Live snapshots are `no-store` + ETag-validated (ui-report-redesign §7.4). */

export interface ErrorBody {
  error: { code: string; message: string };
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });

export const fail = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } } satisfies ErrorBody, { status });

/**
 * Live snapshot response: `Cache-Control: no-store` plus a strong ETag so a polling
 * client can cheaply learn "nothing changed" without the snapshot being cacheable by an
 * intermediary. §7.4 asks for both, and they are not contradictory: no-store governs
 * storage, If-None-Match governs revalidation on this request.
 */
export function snapshot(req: Request, body: unknown, etag: string): Response {
  const quoted = `"${etag}"`;
  if (req.headers.get("if-none-match") === quoted) {
    return new Response(null, { status: 304, headers: { etag: quoted, "cache-control": "no-store" } });
  }
  return json(body, { headers: { etag: quoted, "cache-control": "no-store" } });
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
