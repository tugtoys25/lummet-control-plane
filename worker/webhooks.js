// =====================================================
// WEBHOOKS (master prompt section 31)
//
// Delivery (v7D): the first attempt happens inline when the event fires. A failed attempt is retried by the
// maintenance sweep (sweepDeliveries) with exponential backoff, up to MAX_ATTEMPTS in total, then the delivery
// is marked "dead" (visible to the customer, counted by the dead_webhook_deliveries alert, and re-sendable by
// hand through redeliver). Every attempt re-sends the SAME body, including the same delivery id, so a receiver
// can recognise a repeat; each attempt is signed afresh with the current timestamp.
//
// Signing format deliberately mirrors billing-stripe.js's own
// webhook verification (HMAC-SHA256 over "{timestamp}.{body}",
// sent as a header carrying t= and v1=) — the same shape this
// codebase already asks ITS customers (via Stripe) to verify,
// so a developer integrating both feels one consistent pattern.
// =====================================================

import { checkOutboundUrlResolved } from "./url-safety.js";
import { runAutomations } from "./automations.js";
import { encryptSecret, decryptSecret, generateSecret } from "./crypto.js";
import * as deliveries from "./repositories/webhook-deliveries.js";

/** Attempts in total, including the first. */
export const MAX_ATTEMPTS = 6;
/** Wait after attempt n (n = attempts made so far) before attempt n+1. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 360];
/** A failed delivery older than this is never retried (it would only confuse the receiver). */
export const RETRY_WINDOW_DAYS = 3;
const SWEEP_LIMIT = 20;

const VALID_EVENT_TYPES = [
  "site.created",
  "site.provisioned",
  "site.deployed",
  "site.failed",
  "domain.verified",
  "subscription.changed",
  "payment.failed"
];

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function listValidEventTypes() {
  return [...VALID_EVENT_TYPES];
}

export async function createWebhook(env, { organizationId, url, eventTypes, actorUserId }) {
  const urlCheck = await checkOutboundUrlResolved(url, env);
  if (!urlCheck.ok) return { ok: false, status: 422, error: urlCheck.error };

  const requestedTypes = Array.isArray(eventTypes) ? eventTypes : [];
  const invalidTypes = requestedTypes.filter((t) => !VALID_EVENT_TYPES.includes(t));
  if (requestedTypes.length === 0 || invalidTypes.length > 0) {
    return { ok: false, status: 422, error: "invalid_event_types", invalidTypes };
  }

  const id = crypto.randomUUID();
  const secret = generateSecret();
  const { encryptedSecret, secretIv } = await encryptSecret(env, secret);

  await env.LUMMET_DB.prepare(
    `INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, organizationId, url, encryptedSecret, secretIv, JSON.stringify(requestedTypes), actorUserId || null)
    .run();

  // Shown once — same pattern as every other generated secret in
  // this codebase. Losing it means rotating (rotateSecret below),
  // not recovering it.
  return { ok: true, webhookId: id, secret };
}

export async function listWebhooks(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, url, event_types, status, created_at FROM webhooks WHERE organization_id = ? ORDER BY created_at DESC`
  )
    .bind(organizationId)
    .all();
  return (result.results || []).map((row) => ({ ...row, event_types: JSON.parse(row.event_types) }));
}

async function getWebhookForOrg(env, organizationId, webhookId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM webhooks WHERE id = ? AND organization_id = ?`)
    .bind(webhookId, organizationId)
    .first();
}

export async function deleteWebhook(env, organizationId, webhookId) {
  const webhook = await getWebhookForOrg(env, organizationId, webhookId);
  if (!webhook) return { ok: false, status: 404, error: "not_found" };
  await env.LUMMET_DB.prepare(`DELETE FROM webhooks WHERE id = ?`).bind(webhookId).run();
  return { ok: true };
}

export async function rotateSecret(env, organizationId, webhookId) {
  const webhook = await getWebhookForOrg(env, organizationId, webhookId);
  if (!webhook) return { ok: false, status: 404, error: "not_found" };

  const secret = generateSecret();
  const { encryptedSecret, secretIv } = await encryptSecret(env, secret);
  await env.LUMMET_DB.prepare(`UPDATE webhooks SET encrypted_secret = ?, secret_iv = ? WHERE id = ?`)
    .bind(encryptedSecret, secretIv, webhookId)
    .run();

  return { ok: true, secret };
}

function nextAttemptAt(row) {
  if (row.status !== "failed" || row.attempt >= MAX_ATTEMPTS || !row.last_attempt_at) return null;
  const wait = RETRY_BACKOFF_MINUTES[Math.min(Math.max(row.attempt - 1, 0), RETRY_BACKOFF_MINUTES.length - 1)];
  return new Date(parseDbTime(row.last_attempt_at) + wait * 60000).toISOString();
}

function parseDbTime(v) {
  const t = String(v);
  return Date.parse(/[TZ]/.test(t) ? t : t.replace(" ", "T") + "Z");
}

export async function listDeliveries(env, organizationId, webhookId) {
  const webhook = await getWebhookForOrg(env, organizationId, webhookId);
  if (!webhook) return { ok: false, status: 404, error: "not_found" };
  const rows = await deliveries.listForWebhook(env, webhookId, 50);
  return { ok: true, data: rows.map((r) => ({ ...r, next_attempt_at: nextAttemptAt(r) })) };
}

/**
 * Fires `eventType` for `organizationId` to every active webhook
 * subscribed to it. Never throws — a delivery failure (network
 * error, non-2xx response, even a DB error recording the attempt)
 * is caught and recorded, never allowed to break the caller, since
 * every call site is deep inside another operation (site
 * provisioning, a deployment, a billing webhook) that must complete
 * regardless of whether a customer's webhook endpoint is reachable.
 */
export async function dispatchEvent(env, organizationId, eventType, data) {
  // Automation rules (worker/automations.js) fire from the same events.
  // Automation actions never call dispatchEvent, so this cannot loop.
  await runAutomations(env, organizationId, eventType, data).catch(() => {});
  try {
    const result = await env.LUMMET_DB.prepare(
      `SELECT * FROM webhooks WHERE organization_id = ? AND status = 'active'`
    )
      .bind(organizationId)
      .all();

    const subscribed = (result.results || []).filter((webhook) =>
      JSON.parse(webhook.event_types).includes(eventType)
    );

    for (const webhook of subscribed) {
      await deliverFirst(env, webhook, eventType, data);
    }
  } catch (_) {
    // Never let a webhook-dispatch bug break the caller's own
    // operation — see this function's header comment.
  }
}

/**
 * One signed POST. Never throws. `permanent` means retrying cannot help (blocked address, no usable secret,
 * the endpoint says it is gone), so the delivery goes straight to "dead".
 */
async function sendOnce(env, webhook, deliveryId, body, attempt) {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    let secret;
    try { secret = await decryptSecret(env, webhook.encrypted_secret, webhook.secret_iv); }
    catch (_) { return { ok: false, permanent: true, error: "secret_unavailable" }; }
    const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`);

    // Re-check at delivery time (rows predating the check, or edited directly),
    // never follow redirects, and don't let a slow endpoint hold the Worker open.
    const target = await checkOutboundUrlResolved(webhook.url, env);
    if (!target.ok) {
      // A name that currently resolves to a blocked address or not at all is dead for now; a failed lookup is
      // our own problem and worth another try later, so only the first kind is final.
      return { ok: false, permanent: target.error !== "host_lookup_failed", error: target.error === "host_lookup_failed" ? "host_lookup_failed" : "url_host_not_allowed" };
    }
    const response = await fetch(webhook.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        "Lummet-Signature": `t=${timestamp},v1=${signature}`,
        "Lummet-Delivery-Id": deliveryId,
        "Lummet-Delivery-Attempt": String(attempt)
      },
      body
    });
    if (response.ok) return { ok: true, code: response.status };
    if (response.status === 410) return { ok: false, permanent: true, code: 410, error: "endpoint_gone" };
    return { ok: false, code: response.status, error: `http_${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function statusAfter(outcome, attempt) {
  if (outcome.ok) return "delivered";
  if (outcome.permanent || attempt >= MAX_ATTEMPTS) return "dead";
  return "failed";
}

async function deliverFirst(env, webhook, eventType, data) {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({ id: deliveryId, type: eventType, created: Math.floor(Date.now() / 1000), data });
  const outcome = await sendOnce(env, webhook, deliveryId, body, 1);
  await deliveries.insert(env, {
    id: deliveryId, webhookId: webhook.id, eventType, payload: body,
    status: statusAfter(outcome, 1), responseCode: outcome.code, errorMessage: outcome.ok ? null : outcome.error,
    attempt: 1, deliveredAt: outcome.ok ? new Date().toISOString() : null
  });
}

/** Re-sends an already-claimed delivery (its attempt counter was bumped by the claim). */
async function attemptClaimed(env, delivery, attempt) {
  const webhook = await deliveries.getWebhook(env, delivery.webhook_id);
  const outcome = !webhook || webhook.status !== "active"
    ? { ok: false, permanent: true, error: "webhook_disabled_or_deleted" }
    : await sendOnce(env, webhook, delivery.id, delivery.payload, attempt);
  const status = statusAfter(outcome, attempt);
  await deliveries.recordOutcome(env, delivery.id, { status, responseCode: outcome.code, errorMessage: outcome.ok ? null : outcome.error });
  return { id: delivery.id, status, attempt };
}

/**
 * The retry pass, run on every maintenance tick. Picks up failed deliveries whose backoff has elapsed
 * (and ones stuck mid-send because the Worker died), claims each atomically so two sweeps never send the
 * same attempt twice, and re-sends. Old failures beyond the retry window are marked dead instead.
 */
export async function sweepDeliveries(env, { now = Date.now(), limit = SWEEP_LIMIT } = {}) {
  const expired = await deliveries.expireStale(env, { maxAttempts: MAX_ATTEMPTS, windowDays: RETRY_WINDOW_DAYS });
  const results = [];
  for (const c of await deliveries.listRetryCandidates(env, { maxAttempts: MAX_ATTEMPTS, limit: limit * 3 })) {
    if (results.length >= limit) break;
    if (c.status === "failed") {
      const wait = RETRY_BACKOFF_MINUTES[Math.min(Math.max(c.attempt - 1, 0), RETRY_BACKOFF_MINUTES.length - 1)];
      const base = parseDbTime(c.last_attempt_at || c.created_at);
      if (!(base + wait * 60000 <= now)) continue;
    }
    if (!(await deliveries.claim(env, c.id, c.status, c.attempt))) continue;
    const delivery = await deliveries.get(env, c.id);
    try { results.push(await attemptClaimed(env, delivery, c.attempt + 1)); }
    catch (error) {
      await deliveries.recordOutcome(env, c.id, { status: "failed", errorMessage: String(error?.message || error) }).catch(() => {});
    }
  }
  return { expired, retried: results.length, results };
}

/** Customer action: send a failed or dead delivery again right now. */
export async function redeliver(env, organizationId, webhookId, deliveryId) {
  const webhook = await getWebhookForOrg(env, organizationId, webhookId);
  if (!webhook) return { ok: false, status: 404, error: "not_found" };
  const delivery = await deliveries.get(env, deliveryId);
  if (!delivery || delivery.webhook_id !== webhookId) return { ok: false, status: 404, error: "not_found" };
  if (delivery.status === "delivered") return { ok: false, status: 409, error: "already_delivered" };
  if (delivery.status === "retrying") return { ok: false, status: 409, error: "attempt_in_progress" };
  if (!(await deliveries.claim(env, delivery.id, delivery.status, delivery.attempt))) return { ok: false, status: 409, error: "attempt_in_progress" };
  // A manual send is allowed past the automatic cap, so a dead delivery can be repaired by hand; if it fails
  // again it simply stays dead.
  const attempt = delivery.attempt + 1;
  const outcome = webhook.status !== "active"
    ? { ok: false, permanent: true, error: "webhook_disabled_or_deleted" }
    : await sendOnce(env, webhook, delivery.id, delivery.payload, attempt);
  const status = outcome.ok ? "delivered" : delivery.status === "dead" || attempt >= MAX_ATTEMPTS || outcome.permanent ? "dead" : "failed";
  await deliveries.recordOutcome(env, delivery.id, { status, responseCode: outcome.code, errorMessage: outcome.ok ? null : outcome.error });
  return { ok: true, status: 200, data: { id: delivery.id, status, attempt } };
}
