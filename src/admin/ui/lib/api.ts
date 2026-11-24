/** Error from the admin API: the server's message, and the HTTP status for callers that branch on it. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** JSON call to the admin API (same origin, session cookie). POST always sends a JSON body: the server requires it. */
export async function api<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, { method, ...(method === 'POST' && { body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || j.message || `HTTP ${r.status}`, r.status);
  return j as T;
}
