// =====================================================
// RESEND WEBHOOK (Phase 2.1, gap G7)
//
// Resend signs webhooks with Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>", key = the base64 part of
// RESEND_WEBHOOK_SECRET ("whsec_..."). The signature is checked against the RAW body before anything is parsed.
//
//   email.bounced with a permanent bounce  -> the address is suppressed (reason "bounce")
//   email.complained                       -> the address is suppressed (reason "complaint")
//   anything else (delivered, delayed, transient bounce, ...) -> acknowledged and ignored
//
// A delivery id is recorded, so Resend redelivering the same webhook changes nothing. Suppression only affects billing
// notifications (verification, reset and invitation mail are never blocked by it).
// =====================================================
import { emailHash } from "./email.js";
import * as repo from "./repositories/billing-notifications.js";

const TOLERANCE_SECONDS = 300;

function b64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** true when the signature header holds a valid v1 signature for this id, timestamp and raw body. */
export async function verifySignature(secret, { id, timestamp, signature, body }, now = Date.now()) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;
  let key;
  try {
    key = await crypto.subtle.importKey("raw", b64ToBytes(String(secret).replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  } catch (_) {
    return false;
  }
  const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const part of String(signature).split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    let bytes;
    try { bytes = b64ToBytes(sig); } catch (_) { continue; }
    if (await crypto.subtle.verify("HMAC", key, bytes, data)) return true;
  }
  return false;
}

/** The suppression an event calls for: { reason, addresses } or null. */
export function suppressionFor(event) {
  const to = Array.isArray(event?.data?.to) ? event.data.to : event?.data?.to ? [event.data.to] : [];
  const addresses = to.map((a) => String(a).replace(/^.*<([^>]+)>.*$/, "$1").trim().toLowerCase()).filter(Boolean);
  if (!addresses.length) return null;
  if (event.type === "email.complained") return { reason: "complaint", addresses };
  if (event.type === "email.bounced" && String(event.data?.bounce?.type || "").toLowerCase() === "permanent") return { reason: "bounce", addresses };
  return null;
}

export async function handleResendWebhook(request, env, { now = Date.now() } = {}) {
  if (!env.RESEND_WEBHOOK_SECRET) return { ok: false, status: 503, error: "resend_webhook_not_configured" };
  const body = await request.text();
  const valid = await verifySignature(env.RESEND_WEBHOOK_SECRET, {
    id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature"), body
  }, now);
  if (!valid) return { ok: false, status: 400, error: "invalid_signature" };

  let event;
  try { event = JSON.parse(body); } catch (_) { return { ok: false, status: 400, error: "invalid_json" }; }
  const id = request.headers.get("svix-id");
  if (!(await repo.recordWebhookEvent(env, id, String(event?.type || "unknown")))) return { ok: true, duplicate: true };

  try {
    const s = suppressionFor(event);
    let added = 0;
    if (s) for (const a of s.addresses) if (await repo.addSuppression(env, await emailHash(a), s.reason)) added += 1;
    return { ok: true, suppressed: added };
  } catch (e) {
    // Let Resend redeliver: the delivery id is released so the retry is processed, not treated as a duplicate.
    await repo.forgetWebhookEvent(env, id);
    console.error(JSON.stringify({ msg: "resend_webhook_failed", type: event?.type, error: e?.message || String(e) }));
    return { ok: false, status: 500, error: "processing_failed" };
  }
}
