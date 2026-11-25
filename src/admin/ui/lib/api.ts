/** Error from the admin API: the server's message, and the HTTP status for callers that branch on it. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const hooks: { stepUp?: () => Promise<boolean>; signedOut?: () => void } = {};
/** stepUp asks for a 2FA code when a sensitive call needs a fresh second factor (the confirm dialog).
 *  signedOut runs when a call finds the session gone. */
export const setApiHooks = (h: typeof hooks) => Object.assign(hooks, h);

/** JSON call to the admin API (same origin, session cookie). POST always sends a JSON body: the server requires it.
 *  A sensitive call refused for a stale second factor asks for a code once, then is retried. */
export async function api<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, { method, ...(method === 'POST' && { body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.stepUp && path !== '/api/step-up') {
    if (!await hooks.stepUp?.()) throw new ApiError('Cancelled: this action needs a 2FA code', 0);
    return api(path, method, body);
  }
  // Sign-in, invitation, password reset and step-up answer 401 for a wrong password or code: the session (if any) is still there.
  if (r.status === 401 && !j.stepUp && !/^\/api\/(auth|invite|password)\//.test(path)) hooks.signedOut?.();
  if (!r.ok) throw new ApiError(j.error || j.message || `HTTP ${r.status}`, r.status);
  return j as T;
}
