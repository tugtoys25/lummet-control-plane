// test/support/fake-billing-provider.js
//
// Implements the exact same contract as worker/billing-provider.js
// (and worker/billing-stripe.js) but with no network calls — an
// in-memory stand-in so worker/billing.js's actual logic (checkout
// gating, cancel/resume/change-plan, webhook dispatch, idempotency)
// can be exercised deterministically. This is the "swap the
// provider" story master prompt section 19 asks the architecture to
// support, put to direct use in tests rather than left theoretical.
//
// Each test should call createFakeBillingProvider() fresh — state
// (customers/subscriptions created, signing secret) is NOT shared
// across instances.

export function createFakeBillingProvider() {
  let nextId = 1;
  const customers = new Map(); // providerCustomerId -> { organizationId, email }
  const checkoutSessions = new Map(); // providerSessionId -> params passed in
  const calls = []; // every call made, for assertions

  const provider = {
    PROVIDER_NAME: "fake",

    async createCustomer(env, { organizationId, email }) {
      const providerCustomerId = `fake_cus_${nextId++}`;
      customers.set(providerCustomerId, { organizationId, email });
      calls.push({ method: "createCustomer", organizationId, email });
      return { providerCustomerId };
    },

    async updateCustomer(env, providerCustomerId, profile, opts = {}) {
      calls.push({ method: "updateCustomer", providerCustomerId, profile, ...opts });
      if (provider._failUpdateCustomer) throw new Error("customer update unavailable");
      return { ok: true };
    },

    async createCheckoutSession(env, params) {
      const providerSessionId = `fake_cs_${nextId++}`;
      checkoutSessions.set(providerSessionId, params);
      calls.push({ method: "createCheckoutSession", ...params });
      return { checkoutUrl: `https://fake.test/checkout/${providerSessionId}`, providerSessionId };
    },

    async createPortalSession(env, params) {
      calls.push({ method: "createPortalSession", ...params });
      if (provider._failPortal) throw new Error("portal not configured");
      return { portalUrl: `https://fake.test/portal/${params.providerCustomerId}` };
    },

    async cancelSubscription(env, providerSubscriptionId, opts) {
      calls.push({ method: "cancelSubscription", providerSubscriptionId, ...opts });
      return { ok: true };
    },

    async resumeSubscription(env, providerSubscriptionId) {
      calls.push({ method: "resumeSubscription", providerSubscriptionId });
      return { ok: true };
    },

    async pauseSubscription(env, providerSubscriptionId, opts = {}) {
      calls.push({ method: "pauseSubscription", providerSubscriptionId, ...opts });
      if (provider._failPause) throw new Error("pause unavailable");
      return { ok: true, resumesAt: opts.resumesAt };
    },

    async resumePausedSubscription(env, providerSubscriptionId, opts = {}) {
      calls.push({ method: "resumePausedSubscription", providerSubscriptionId, ...opts });
      if (provider._failPause) throw new Error("resume pause unavailable");
      return { ok: true };
    },

    async changePlan(env, providerSubscriptionId, newPriceId, opts = {}) {
      calls.push({ method: "changePlan", providerSubscriptionId, newPriceId, ...opts });
      return { ok: true };
    },

    async getSubscription(env, providerSubscriptionId) {
      calls.push({ method: "getSubscription", providerSubscriptionId });
      return { id: providerSubscriptionId, items: { data: [] } };
    },

    async changeSubscriptionAddon(env, providerSubscriptionId, { priceId, quantity, subscriptionItemId, idempotencyKey } = {}) {
      calls.push({ method: "changeSubscriptionAddon", providerSubscriptionId, priceId, quantity, subscriptionItemId, idempotencyKey });
      if (provider._failAddon) throw new Error("addon unavailable");
      return { ok: true, subscriptionItemId: subscriptionItemId || `fake_si_${nextId++}`, quantity };
    },

    async getCardFingerprint(env, providerSubscriptionId) {
      calls.push({ method: "getCardFingerprint", providerSubscriptionId });
      if (provider._failFingerprint) throw new Error("stripe unreachable");
      return provider._cardFingerprints.get(providerSubscriptionId) || null;
    },

    async endTrialNow(env, providerSubscriptionId) {
      calls.push({ method: "endTrialNow", providerSubscriptionId });
      return { ok: true };
    },

    normalizeSubscriptionStatus(rawStatus) {
      // Deliberately identity-mapped in the fake -- tests construct
      // events using this repo's own internal status vocabulary
      // directly, since exercising Stripe's specific string mapping
      // is billing-stripe.js's own job (see test/billing-stripe.test.js).
      return rawStatus;
    },

    async verifyAndParseWebhook(request, env) {
      // The fake provider trusts whatever event object the test
      // handed to simulateWebhook() below (see _lastVerifiedEvent) --
      // real signature verification is billing-stripe.js's
      // responsibility and is tested separately against real HMAC
      // signatures (test/billing-stripe.test.js).
      const event = provider._pendingEvent;
      provider._pendingEvent = null;
      if (!event) return { valid: false, event: null, reason: "no_pending_event" };
      return { valid: true, event, reason: null };
    },

    // --- test-only helpers, not part of the provider contract ---
    _pendingEvent: null,
    _cardFingerprints: new Map(), // providerSubscriptionId -> card fingerprint (test helper)
    _calls: calls,
    _customers: customers
  };

  return provider;
}

/**
 * Queues an event for the fake provider's verifyAndParseWebhook() to
 * return on its next call, then invokes billingService.handleWebhook()
 * with a minimal fake Request carrying just enough shape for
 * billing.js to use (it never reads the body directly -- only the
 * provider does, and the fake provider ignores it in favor of the
 * queued event).
 */
export async function simulateWebhook(billingService, provider, env, event) {
  provider._pendingEvent = event;
  const fakeRequest = {
    headers: { get: () => null },
    async text() { return JSON.stringify(event); },
    async json() { return event; }
  };
  return billingService.handleWebhook(fakeRequest, env);
}
