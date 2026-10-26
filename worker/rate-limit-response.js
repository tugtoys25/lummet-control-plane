// Round 6.3A: Retry-After on the Worker's own 429 responses. Behind RATE_LIMIT_RETRY_AFTER (off default, on).
// The Worker's limiters count attempts in fixed windows (15 minutes for sign-in, sign-up, password, invitation,
// dashboard-password and bad-API-key attempts; 1 minute for AI calls; 1 hour for public form submissions), and none
// of them records when the oldest attempt expires, so the value sent is the window length: a safe upper bound, never
// a promise that the client is unblocked earlier. Cloudflare's own WAF rate-limit block sets its own Retry-After.

export function retryAfterMode(env) {
  return String(env?.RATE_LIMIT_RETRY_AFTER || "off").trim().toLowerCase() === "on" ? "on" : "off";
}

/** Seconds a client should wait before retrying a 429 from this path. */
export function retryAfterSeconds(pathname) {
  if (!pathname.startsWith("/api/")) return 3600;      // public form submissions: hourly per-address limit
  if (/\/ai(\/|$)/.test(pathname)) return 60;          // AI gateway: per-minute limit
  return 900;                                          // 15-minute attempt windows
}

/** Returns the response unchanged unless the flag is on, the status is 429 and no Retry-After is present. */
export function withRetryAfter(response, request, env) {
  if (retryAfterMode(env) !== "on" || response.status !== 429 || response.headers.has("Retry-After")) return response;
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(retryAfterSeconds(new URL(request.url).pathname)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
