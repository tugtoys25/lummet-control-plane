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
const DEFAULT_STRIPE_API_VERSION = "2024-06-20";
// Pinned from STRIPE_API_VERSION so upgrades are a deliberate configuration change (test, then raise the pin and the
// webhook endpoint together), never an accident of a code edit.
export function stripeApiVersion(env) {
  const v = String((env && env.STRIPE_API_VERSION) || "").trim();
  return /^\d{4}-\d{2}-\d{2}(\.[a-z_]+)?$/.test(v) ? v : DEFAULT_STRIPE_API_VERSION;
}

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

// Structured error so callers can tell "Stripe said no" (rejected: a 4xx, retrying cannot help) from
// "Stripe is unreachable" (unreachable: network failure, timeout or 5xx, safe to retry later).
export class StripeError extends Error {
  constructor(message, { kind, status = null, code = null } = {}) {
    super(message);
    this.name = "StripeError";
    this.kind = kind;          // "rejected" | "unreachable"
    this.status = status;
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Full jitter: a random wait up to base * 2^attempt, so many Workers retrying together do not collide.
const backoffMs = (env, attempt) => Math.floor(Math.random() * Number(env.STRIPE_RETRY_BASE_MS ?? 250) * 2 ** attempt);

/**
 * One Stripe call. Every POST carries an Idempotency-Key (supplied by the caller, derived from the business action),
 * so a retry can never create a second customer, session or charge. Retries happen on network errors, timeouts and
 * 5xx only, NEVER on a 4xx, with jittered backoff. A GET or DELETE is retried the same way (both are safe to repeat).
 */
export async function stripeRequest(env, method, path, params, { idempotencyKey, apiVersion } = {}) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured on this Worker");
  }
  if (method === "POST" && !idempotencyKey) {
    // A POST with no key could be applied twice by a retry. Refuse to send one rather than risk it.
    throw new Error(`stripeRequest: POST ${path} requires an idempotencyKey`);
  }

  const body = params
    ? formPairs(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : undefined;

  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": apiVersion || stripeApiVersion(env),
    ...(method === "POST" ? { "Idempotency-Key": idempotencyKey } : {})
  };

  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(env, attempt));
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      lastError = new StripeError(`Stripe unreachable: ${e?.name === "TimeoutError" ? "timed out" : e?.message || "network error"}`, { kind: "unreachable" });
      continue;                                                    // network error or timeout: retry
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const message = data?.error?.message || `Stripe API error (HTTP ${response.status})`;
    if (response.status >= 500) {
      lastError = new StripeError(message, { kind: "unreachable", status: response.status, code: data?.error?.code || null });
      continue;                                                    // 5xx: retry
    }
    throw new StripeError(message, { kind: "rejected", status: response.status, code: data?.error?.code || null });   // 4xx: never retried
  }
  throw lastError;
}

export async function createCustomer(env, { organizationId, email }) {
  // The key is derived from the organization, so two simultaneous first checkouts for one organization get the SAME
  // Stripe customer instead of leaving an orphan behind.
  const customer = await stripeRequest(env, "POST", "/customers", {
    email: email || undefined,
    metadata: { organization_id: organizationId }
  }, { idempotencyKey: `customer:${organizationId}:${email || ""}` });
  return { providerCustomerId: customer.id };
}

export async function updateCustomer(env, providerCustomerId, profile, { idempotencyKey } = {}) {
  const address = {
    line1: profile.address_line1 || "",
    line2: profile.address_line2 || "",
    city: profile.city || "",
    state: profile.region || "",
    postal_code: profile.postal_code || "",
    country: profile.country || ""
  };
  await stripeRequest(env, "POST", `/customers/${encodeURIComponent(providerCustomerId)}`, {
    name: profile.legal_name || "",
    email: profile.billing_email || "",
    address,
    tax_exempt: profile.tax_exempt ? "exempt" : "none",
    metadata: { po_number: profile.po_number || "" }
  }, { idempotencyKey: idempotencyKey || `billing-profile:${providerCustomerId}:${crypto.randomUUID()}` });
  return { ok: true };
}

export async function createCheckoutSession(
  env,
  { providerCustomerId, priceId, successUrl, cancelUrl, trialDays, trialEnd, organizationId, planId, couponProviderId, couponId, expiresAt, taxEnabled = false }
) {
  // trialEnd (unix seconds) carries the REMAINING local trial so trials never stack; trialDays is the legacy path.
  const metadata = {
    organization_id: organizationId, plan_id: planId,
    ...(couponId ? { coupon_id: couponId } : {}),
    ...(trialEnd ? { has_trial: "1", trial_end: String(trialEnd) } : {}),
    ...(!trialEnd && trialDays > 0 ? { has_trial: "1", trial_end: String(Math.floor(Date.now() / 1000) + trialDays * 86400) } : {})
  };

  const params = {
    mode: "subscription",
    customer: providerCustomerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: organizationId,
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    payment_method_collection: "always",
    ...(taxEnabled ? { automatic_tax: { enabled: true } } : {}),
    metadata,
    line_items: [{ price: priceId, quantity: 1 }],
    // Metadata is duplicated onto the subscription itself (not just
    // the checkout session) so customer.subscription.* webhooks —
    // which don't reference the checkout session at all — can still
    // resolve organization_id/plan_id directly from the event.
    subscription_data: {
      metadata,
      ...(trialEnd ? { trial_end: trialEnd } : trialDays > 0 ? { trial_period_days: trialDays } : {})
    }
  };

  if (couponProviderId) {
    params.discounts = [{ coupon: couponProviderId }];
  }
  // Stripe accepts 30 minutes to 24 hours; used only to bound a held coupon use.
  if (expiresAt) params.expires_at = expiresAt;

  const key = `checkout:${organizationId}:${planId}:${couponProviderId || ""}:${trialEnd || trialDays || 0}:${Math.floor(Date.now() / 60000)}`;
  // Checkout Sessions may use a newer API version than the rest of the integration (STRIPE_CHECKOUT_API_VERSION, unset = the
  // pinned version). Needed when the Stripe account has Managed Payments on, which 2024-06-20 refuses. The session only
  // returns a url and id, so the newer version cannot change how subscriptions or webhooks are read.
  const checkoutVersion = String((env && env.STRIPE_CHECKOUT_API_VERSION) || "").trim();
  const apiVersion = /^\d{4}-\d{2}-\d{2}(\.[a-z_]+)?$/.test(checkoutVersion) ? checkoutVersion : undefined;
  const session = await stripeRequest(env, "POST", "/checkout/sessions", params, { idempotencyKey: key, apiVersion });
  return { checkoutUrl: session.url, providerSessionId: session.id };
}

// Stripe's Customer Portal must be configured once in the Stripe dashboard
// (Settings > Billing > Customer portal) before this call succeeds; until
// then Stripe answers with an error that surfaces as portal_unavailable.
export async function createPortalSession(env, { providerCustomerId, returnUrl }) {
  const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: providerCustomerId,
    return_url: returnUrl
  }, { idempotencyKey: `portal:${providerCustomerId}:${Math.floor(Date.now() / 60000)}` });
  return { portalUrl: session.url };
}

export async function cancelSubscription(env, providerSubscriptionId, { atPeriodEnd }) {
  if (atPeriodEnd) {
    await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, { cancel_at_period_end: true }, { idempotencyKey: `cancel-at-end:${providerSubscriptionId}:${Math.floor(Date.now() / 60000)}` });
  } else {
    await stripeRequest(env, "DELETE", `/subscriptions/${providerSubscriptionId}`);
  }
  return { ok: true };
}

/**
 * The card behind a subscription, as Stripe's card fingerprint (the same physical card always has the same
 * fingerprint, across customers). Used only to hash it for the one-trial-per-card rule; never stored or logged raw.
 * Returns null when no card is on file (a trial started without one).
 */
export async function getCardFingerprint(env, providerSubscriptionId) {
  const sub = await stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}?expand%5B%5D=default_payment_method&expand%5B%5D=customer.invoice_settings.default_payment_method`);
  const fromSub = sub?.default_payment_method?.card?.fingerprint;
  if (fromSub) return fromSub;
  return sub?.customer?.invoice_settings?.default_payment_method?.card?.fingerprint || null;
}

/** Ends a trial now, so the first invoice is raised (and charged) immediately. Used when the card already had a trial. */
export async function endTrialNow(env, providerSubscriptionId) {
  await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, { trial_end: "now" }, { idempotencyKey: `end-trial-now:${providerSubscriptionId}` });
  return { ok: true };
}

export async function resumeSubscription(env, providerSubscriptionId) {
  await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, { cancel_at_period_end: false }, { idempotencyKey: `resume:${providerSubscriptionId}:${Math.floor(Date.now() / 60000)}` });
  return { ok: true };
}

/** Temporarily pause collection with an explicit provider-side resume timestamp. This is opt-in at the service layer. */
export async function pauseSubscription(env, providerSubscriptionId, { resumesAt, idempotencyKey } = {}) {
  const unix = Math.floor(new Date(resumesAt).getTime() / 1000);
  if (!Number.isSafeInteger(unix) || unix <= Math.floor(Date.now() / 1000)) throw new Error("invalid_pause_resume_time");
  await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
    "pause_collection[behavior]": "void", "pause_collection[resumes_at]": unix
  }, { idempotencyKey: idempotencyKey || `pause:${providerSubscriptionId}:${unix}` });
  return { ok: true, resumesAt: new Date(unix * 1000).toISOString() };
}

export async function resumePausedSubscription(env, providerSubscriptionId, { idempotencyKey } = {}) {
  await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
    pause_collection: ""
  }, { idempotencyKey: idempotencyKey || `unpause:${providerSubscriptionId}:${Math.floor(Date.now() / 60000)}` });
  return { ok: true };
}

export async function getSubscription(env, providerSubscriptionId) {
  return stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}?expand%5B%5D=items.data.price`);
}

export async function changeSubscriptionAddon(env, providerSubscriptionId, { priceId, quantity, subscriptionItemId, idempotencyKey } = {}) {
  if (!priceId || !Number.isInteger(quantity) || quantity < 1) throw new Error("invalid_addon_change");
  const item = subscriptionItemId
    ? { "items[0][id]": subscriptionItemId, "items[0][price]": priceId, "items[0][quantity]": quantity }
    : { "items[0][price]": priceId, "items[0][quantity]": quantity };
  const updated = await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, item, { idempotencyKey: idempotencyKey || `addon:${providerSubscriptionId}:${priceId}:${quantity}` });
  const first = updated?.items?.data?.find((x) => x.price?.id === priceId) || updated?.items?.data?.[0];
  return { ok: true, subscriptionItemId: first?.id || subscriptionItemId || null, quantity: Number(first?.quantity || quantity) };
}

/**
 * Moves a subscription to another price. `idempotencyKey` (sprint 3.2) comes from the plan-change intent, so the same
 * intent sent again, by a retry or by the sweep, is applied once by Stripe. Without one (the legacy BILLING_ENFORCE=off
 * path) the key is bucketed by minute as before.
 * A retry that finds the subscription ALREADY on the target price sends nothing: it covers the case where Stripe applied
 * the first attempt but its answer was lost, after Stripe's own 24-hour idempotency window has passed.
 */
export async function changePlan(env, providerSubscriptionId, newPriceId, { idempotencyKey, atPeriodEnd = false } = {}) {
  const subscription = await stripeRequest(env, "GET", `/subscriptions/${providerSubscriptionId}?expand%5B%5D=items.data.price`);
  const item = subscription?.items?.data?.[0];
  if (!item?.id) throw new Error(`Could not resolve a subscription item on ${providerSubscriptionId} to update`);
  if (idempotencyKey && item.price?.id === newPriceId) return { ok: true, alreadyApplied: true };
  const key = idempotencyKey || `change-plan:${providerSubscriptionId}:${newPriceId}:${Math.floor(Date.now() / 60000)}`;
  if (atPeriodEnd) {
    // Never replace an existing schedule: it may contain customer-approved phases or add-ons.
    if (subscription.schedule) throw new Error("subscription_already_scheduled; staff review required before changing its schedule");
    // Create a schedule from the existing subscription, preserve all current items, then replace only the primary
    // price in the next phase. This prevents a plan downgrade from silently dropping attached add-ons.
    if (subscription.discount || (Array.isArray(subscription.discounts) && subscription.discounts.length)) {
      throw new Error("subscription_has_discounts; staff review required to preserve discount terms during downgrade");
    }
    const initialStart = Number(subscription.current_period_start || item.current_period_start || Math.floor(Date.now() / 1000));
    const initialEnd = Number(subscription.current_period_end || item.current_period_end);
    if (!Number.isFinite(initialEnd) || initialEnd <= initialStart) throw new Error("Stripe subscription has no valid current period end; refusing to schedule downgrade");
    const currentItems = (subscription.items?.data || []).map((x) => ({
      price: x.price?.id || x.price, quantity: x.quantity || 1,
      ...(x.tax_rates?.length ? { tax_rates: x.tax_rates.map((t) => typeof t === "string" ? t : t.id) } : {}),
      ...(x.billing_thresholds ? { billing_thresholds: x.billing_thresholds } : {})
    }));
    if (!currentItems.length || !currentItems[0].price) throw new Error("Stripe subscription has no valid phase items; refusing to schedule downgrade");
    const schedule = await stripeRequest(env, "POST", "/subscription_schedules", { from_subscription: providerSubscriptionId }, { idempotencyKey: `${key}:schedule-create` });
    const start = Number(schedule.current_phase?.start_date || initialStart);
    const end = Number(schedule.current_phase?.end_date || initialEnd);
    if (!Number.isFinite(end) || end <= start) throw new Error("Stripe schedule has no valid current phase end; staff review required");
    const targetItems = currentItems.map((x, i) => i === 0 ? { ...x, price: newPriceId } : x);
    const phaseOptions = {
      proration_behavior: "none",
      ...(subscription.automatic_tax ? { automatic_tax: { enabled: !!subscription.automatic_tax.enabled } } : {}),
      ...(subscription.collection_method ? { collection_method: subscription.collection_method } : {}),
      ...(subscription.default_payment_method ? { default_payment_method: typeof subscription.default_payment_method === "string" ? subscription.default_payment_method : subscription.default_payment_method.id } : {})
    };
    await stripeRequest(env, "POST", `/subscription_schedules/${encodeURIComponent(schedule.id)}`, {
      end_behavior: "release",
      phases: [
        { ...phaseOptions, start_date: start, end_date: end, items: currentItems },
        { ...phaseOptions, start_date: end, items: targetItems }
      ]
    }, { idempotencyKey: `${key}:schedule-update` });
    return { ok: true, scheduled: true, effectiveAt: end, scheduleId: schedule.id };
  }
  await stripeRequest(env, "POST", `/subscriptions/${providerSubscriptionId}`, {
    items: [{ id: item.id, price: newPriceId }], proration_behavior: "create_prorations"
  }, { idempotencyKey: key });
  return { ok: true, scheduled: false };
}

// -----------------------------------------------------
// Internal status normalization — the ONLY place a Stripe
// status string is read anywhere in this codebase. See
// billing-provider.js's contract comment.
// -----------------------------------------------------

export function normalizeSubscriptionStatus(stripeStatus, { restrictUnpaid = false } = {}) {
  const map = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    // "unpaid" is Stripe saying every retry failed. It becomes "restricted" (a bounded state) once enforcement is on;
    // while BILLING_ENFORCE is off or shadow it keeps the legacy mapping so nothing changes for customers.
    unpaid: restrictUnpaid ? "restricted" : "past_due",
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
