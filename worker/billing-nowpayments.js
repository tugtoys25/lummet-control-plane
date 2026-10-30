// =====================================================
// NOWPAYMENTS BILLING PROVIDER (crypto)
//
// A second gateway beside billing-stripe.js. Stripe is untouched; this file only adds.
//
// MODEL: crypto cannot be pulled from a customer, so a NOWPayments "subscription" is PREPAID PERIODS. Each checkout creates one
// NOWPayments invoice for one billing period of a plan; when the payment reaches `finished`, billing-nowpayments-service.js
// grants (or extends) the period through the same billing.js handlers Stripe uses. No payment by the end of the period
// follows the normal past_due -> restricted -> suspended path.
//
// HONESTY NOTE: outbound calls here have NOT been run against a live or sandbox NOWPayments account from this environment
// (no network). They follow NOWPayments' documented API. Run one sandbox payment (NOWPAYMENTS_SANDBOX=true) before going live.
// verifyAndParseWebhook() and normalizeSubscriptionStatus() are pure logic and ARE covered by unit tests.
// =====================================================

export const PROVIDER_NAME = "nowpayments";

const LIVE_BASE = "https://api.nowpayments.io/v1";
const SANDBOX_BASE = "https://api-sandbox.nowpayments.io/v1";
const REQUEST_TIMEOUT_MS = 10000;

export function apiBase(env) {
  return String((env && env.NOWPAYMENTS_SANDBOX) || "").trim().toLowerCase() === "true" ? SANDBOX_BASE : LIVE_BASE;
}

export class NowPaymentsError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = "NowPaymentsError";
    this.kind = kind;      // "rejected" (a 4xx, never retried) | "unreachable" (network, timeout, 5xx)
    this.status = status;
  }
}

/** One NOWPayments call. GETs are retried on network errors and 5xx; a POST is never retried (it could create a second invoice). */
export async function nowRequest(env, method, path, body) {
  if (!env || !env.NOWPAYMENTS_API_KEY) throw new Error("NOWPAYMENTS_API_KEY is not configured on this Worker");
  const attempts = method === "GET" ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetch(`${apiBase(env)}${path}`, {
        method,
        headers: { "x-api-key": env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      lastError = new NowPaymentsError(`NOWPayments unreachable: ${e?.name === "TimeoutError" ? "timed out" : e?.message || "network error"}`, { kind: "unreachable" });
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const message = data?.message || `NOWPayments API error (HTTP ${response.status})`;
    if (response.status >= 500) { lastError = new NowPaymentsError(message, { kind: "unreachable", status: response.status }); continue; }
    throw new NowPaymentsError(message, { kind: "rejected", status: response.status });
  }
  throw lastError;
}

// -----------------------------------------------------
// Contract (billing-provider.js). Customers and subscriptions are local: NOWPayments has neither.
// -----------------------------------------------------

export async function createCustomer(_env, { organizationId }) {
  return { providerCustomerId: `np_cus_${organizationId}` };
}

export async function updateCustomer() { return { ok: true }; }

/**
 * One invoice for one billing period. Unlike Stripe's version of this call, the amount comes from the plan itself
 * (amountCents + currency) because crypto checkout has no Stripe price. orderId is OUR crypto_checkouts id.
 */
export async function createCheckoutSession(env, { successUrl, cancelUrl, ipnUrl, orderId, amountCents, currency, description }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new NowPaymentsError("invalid_amount", { kind: "rejected" });
  const invoice = await nowRequest(env, "POST", "/invoice", {
    price_amount: amountCents / 100,
    price_currency: String(currency || "USD").toLowerCase(),
    order_id: orderId,
    order_description: String(description || "Lummet subscription").slice(0, 200),
    ipn_callback_url: ipnUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
    is_fixed_rate: true,
    is_fee_paid_by_user: false
  });
  if (!invoice?.invoice_url || !invoice?.id) throw new NowPaymentsError("NOWPayments returned no invoice url", { kind: "unreachable" });
  return { checkoutUrl: invoice.invoice_url, providerSessionId: String(invoice.id) };
}

/** Re-reads one payment from NOWPayments by id, so a webhook alone can never grant access. */
export async function getPayment(env, paymentId) {
  if (!/^\d{1,20}$/.test(String(paymentId))) throw new NowPaymentsError("invalid_payment_id", { kind: "rejected" });
  return nowRequest(env, "GET", `/payment/${encodeURIComponent(String(paymentId))}`);
}

const unsupported = (what) => { throw new NowPaymentsError(`${what} is not available for crypto subscriptions`, { kind: "rejected" }); };
export async function createPortalSession() { return unsupported("A billing portal"); }
export async function pauseSubscription() { return unsupported("Pausing"); }
export async function resumePausedSubscription() { return unsupported("Resuming a pause"); }
export async function changePlan() { return unsupported("An in-place plan change (pay the new plan's invoice instead)"); }

// A prepaid period is not charged again by anyone, so cancelling and resuming only change the local flag billing.js sets.
export async function cancelSubscription() { return { ok: true }; }
export async function resumeSubscription() { return { ok: true }; }

/** NOWPayments payment_status -> internal subscription status. Subscriptions here are only ever active, past_due or canceled. */
export function normalizeSubscriptionStatus(status) {
  const map = { active: "active", past_due: "past_due", canceled: "canceled", expired: "expired" };
  return map[status] || "incomplete";
}

// -----------------------------------------------------
// IPN verification. NOWPayments signs the BODY WITH ITS KEYS SORTED (recursively), as HMAC-SHA512 with the IPN secret,
// sent hex in `x-nowpayments-sig`. There is no timestamp, so replay safety comes from event-id idempotency plus the
// service's re-read of the payment (getPayment) before anything is granted.
// -----------------------------------------------------

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

async function hmacSha512Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyAndParseWebhook(request, env) {
  if (!env.NOWPAYMENTS_IPN_SECRET) return { valid: false, event: null, reason: "webhook_secret_not_configured" };
  const header = String(request.headers.get("x-nowpayments-sig") || "").trim().toLowerCase();
  if (!header) return { valid: false, event: null, reason: "missing_signature" };

  const rawBody = await request.text();
  let payload;
  try { payload = JSON.parse(rawBody); } catch (_) { return { valid: false, event: null, reason: "invalid_json" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { valid: false, event: null, reason: "invalid_json" };

  const secrets = [env.NOWPAYMENTS_IPN_SECRET, env.NOWPAYMENTS_IPN_SECRET_PREVIOUS].filter(Boolean);
  const message = JSON.stringify(sortKeysDeep(payload));
  let matched = false;
  for (const secret of secrets) if (constantTimeEqual(await hmacSha512Hex(secret, message), header)) matched = true;   // no early exit
  if (!matched) return { valid: false, event: null, reason: "signature_mismatch" };

  if (payload.payment_id === undefined || payload.payment_id === null || !payload.payment_status) {
    return { valid: false, event: null, reason: "missing_payment_fields" };
  }
  const status = String(payload.payment_status).toLowerCase().replace(/[^a-z_]/g, "");
  return {
    valid: true,
    reason: null,
    event: { id: `np_${payload.payment_id}_${status}`, type: `nowpayments.payment.${status}`, created: Math.floor(Date.now() / 1000), data: { object: payload } }
  };
}
