// =====================================================
// STRIPE BILLING PROVIDER
//
// Real implementation of billing-provider.js's contract,
// against Stripe's stable REST API — via fetch(), never a
// third-party SDK (none are available in this Worker
// environment without a build step).
//
// HONESTY NOTE (master prompt rule #5): the outbound calls
// below (createCustomer, createCheckoutSession,
// cancelSubscription, resumeSubscription, changePlan) have
// NOT been exercised against a live Stripe account or test
// key in this environment — there is no network access here
// to do so. They are implemented against Stripe's documented,
// stable API shapes, but need a real STRIPE_SECRET_KEY and a
// staging run before they can be called production-ready.
//
// verifyAndParseWebhook() and normalizeSubscriptionStatus(),
// by contrast, are pure logic (HMAC verification, string
// mapping) that needed no network to write or test — they ARE
// covered by real unit tests (test/billing.test.js) using a
// self-generated signature in the exact format Stripe sends.
// =====================================================

export const PROVIDER_NAME = "stripe";

const API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2024-06-20";

// -----------------------------------------------------
// Minimal application/x-www-form-urlencoded encoder for
// Stripe's bracket-notation nested params (e.g.
// line_items[0][price]=... ) — no npm form-encoding library
// is available in this environment.
// -----------------------------------------------------

function formPairs(params, prefix = "") {
  const pairs = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object") {
          pairs.push(...formPairs(item, `${fullKey}[${i}]`));
        } else {
          pairs.push([`${fullKey}[${i}]`, String(item)]);
        }
      });
    } else if (typeof value === "object") {
      pairs.push(...formPairs(value, fullKey));
    } else {
      pairs.push([fullKey, String(value)]);
    }
  }
  return pairs;
}

async function stripeRequest(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured on this Worker");
  }

  const body = params
    ? formPairs(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : undefined;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Stripe API error (HTTP ${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function createCustomer(env, { organizationId, email }) {
  const customer = await stripeRequest(env, "POST", "/customers", {
    email: email || undefined,
    metadata: { organization_id: organizationId }
  });
  return { providerCustomerId: customer.id };
}

export async function createCheckoutSession(
  env,
  { providerCustomerId, priceId, successUrl, cancelUrl, trialDays, organizationId, planId, couponProviderId, couponId, expiresAt }
) {
  const metadata = { organization_id: organizationId, plan_id: planId, ...(couponId ? { coupon_id: couponId } : {}) };

  const params = {
    mode: "subscription",
    customer: providerCustomerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: organizationId,
    metadata,
    line_items: [{ price: priceId, quantity: 1 }],
    // Metadata is duplicated onto the subscription itself (not just
    // the checkout session) so customer.subscription.* webhooks —
    // which don't reference the checkout session at all — can still
    // resolve organization_id/plan_id directly from the event.
    subscription_data: {
      metadata,
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {})
    }
  };

  if (couponProviderId) {
    params.discounts = [{ coupon: couponProviderId }];
  }
  // Stripe accepts 30 minutes to 24 hours; used only to bound a held coupon use.
  if (expiresAt) params.expires_at = expiresAt;

  const session = await stripeRequest(env, "POST", "/checkout/sessions", params);
  return { checkoutUrl: session.url, providerSessionId: session.id };
}

// Stripe's Customer Portal must be configured once in the Stripe dashboard
// (Settings > Billing > Customer portal) before this call succeeds; until
// then Stripe answers with an error that surfaces as portal_unavailable.
export async function createPortalSession(env, { providerCustomerId, returnUrl }) {
  const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: providerCustomerId,
    return_url: returnUrl
  });
  return { portalUrl: session.url };
}

export async function cancelSubscription(env, providerSubscriptionId, { atPeriodEnd }) {
  if (atPeriodEnd) {
    await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, { cancel_at_period_end: true });
  } else {
    await stripeRequest(env, "DELETE", `/subscriptions/${providerSubscriptionId}`);
  }
  return { ok: true };
}

export async function resumeSubscription(env, providerSubscriptionId) {
  await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, { cancel_at_period_end: false });
  return { ok: true };
}

export async function changePlan(env, providerSubscriptionId, newPriceId) {
  const subscription = await stripeRequest(env, "GET", `/subscriptions/${providerSubscriptionId}`);
  const itemId = subscription?.items?.data?.[0]?.id;
  if (!itemId) throw new Error(`Could not resolve a subscription item on ${providerSubscriptionId} to update`);

  await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "create_prorations"
  });
  return { ok: true };
}

// -----------------------------------------------------
// Internal status normalization — the ONLY place a Stripe
// status string is read anywhere in this codebase. See
// billing-provider.js's contract comment.
// -----------------------------------------------------

export function normalizeSubscriptionStatus(stripeStatus) {
  const map = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    unpaid: "past_due",
    incomplete: "incomplete",
    incomplete_expired: "incomplete_expired",
    paused: "paused"
  };
  return map[stripeStatus] || "incomplete";
}

// -----------------------------------------------------
// Webhook verification (master prompt section 40: HMAC
// weaknesses, replay attacks, webhook forgery). Stripe signs
// each webhook with HMAC-SHA256 over "{timestamp}.{raw
// body}", sent as `Stripe-Signature: t=...,v1=...`. Verified
// here with the Workers runtime's own Web Crypto — never a
// third-party SDK, and never against a JSON-reparsed body
// (whitespace/key-order differences would break the
// signature; the raw text is what Stripe actually signed).
// -----------------------------------------------------

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // reject signatures older than 5 minutes

// While Stripe is rolling a signing secret, it sends SEVERAL v1 signatures (one
// per active secret). All of them are collected; any one that matches either
// the current or the previous secret is accepted.
function parseSignatureHeader(header) {
  let timestamp;
  const signatures = [];
  for (const kv of (header || "").split(",")) {
    const eq = kv.indexOf("=");
    if (eq < 1) continue;
    const k = kv.slice(0, eq).trim(), v = kv.slice(eq + 1).trim();
    if (!v) continue;
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  return { timestamp, signatures };
}

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

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function verifyAndParseWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return { valid: false, event: null, reason: "webhook_secret_not_configured" };
  }

  const signatureHeader = request.headers.get("Stripe-Signature");
  if (!signatureHeader) return { valid: false, event: null, reason: "missing_signature" };

  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signatures.length) return { valid: false, event: null, reason: "malformed_signature" };

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, event: null, reason: "signature_too_old" };
  }

  // Raw text, not .json() — see header comment above.
  const rawBody = await request.text();
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS].filter(Boolean);
  let matched = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
    for (const sig of signatures) if (constantTimeEqual(expected, sig)) matched = true;   // no early exit: constant work
  }

  if (!matched) {
    return { valid: false, event: null, reason: "signature_mismatch" };
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return { valid: false, event: null, reason: "invalid_json" };
  }

  return { valid: true, event, reason: null };
}
