// Turnstile for the staff console sign-in. STAFF_TURNSTILE_REQUIRED lives in wrangler.jsonc (like STAFF_2FA_REQUIRED), never in the
// console's settings table: a wrong value there could lock out the very people who would fix it. Break-glass: set it to "off" and deploy.
// Missing keys never lock anyone out: the check simply stays off until both keys are set.
export const staffTurnstileOn = (env) =>
  String(env?.STAFF_TURNSTILE_REQUIRED || "off").trim().toLowerCase() === "on" && Boolean(env?.TURNSTILE_SITE_KEY && env?.TURNSTILE_SECRET_KEY);

export const staffTurnstileSiteKey = (env) => (staffTurnstileOn(env) ? String(env.TURNSTILE_SITE_KEY) : "");

export async function verifyStaffTurnstile(request, env, token) {
  if (!staffTurnstileOn(env)) return { ok: true, skipped: true };
  if (!token) return { ok: false, status: 422, error: "turnstile_required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(token), remoteip: request.headers.get("CF-Connecting-IP") || "" }),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, status: 503, error: "turnstile_verification_unavailable" };
    const result = await response.json();
    const host = new URL(request.url).hostname;
    if (result.success !== true || result.hostname !== host) return { ok: false, status: 422, error: "turnstile_failed" };
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "turnstile_verification_unavailable" };
  } finally { clearTimeout(timeout); }
}
