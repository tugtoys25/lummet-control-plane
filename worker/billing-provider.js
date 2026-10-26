// =====================================================
// PAYMENT PROVIDER INTERFACE (master prompt section 14)
//
// Every provider module (billing-stripe.js today; a future
// billing-paddle.js or billing-manual.js later — section 19)
// must implement exactly this shape. worker/billing.js's
// createBillingService(provider) is written against this
// contract only — it never imports a provider module
// directly except to pick the default for production, so
// swapping providers, or substituting a fake one in tests
// (see test/support/fake-billing-provider.js), never touches
// billing.js itself.
//
// No runtime code lives here — this file is documentation,
// enforced by convention and by the tests exercising both
// billing-stripe.js and the fake provider against the same
// call shapes.
// =====================================================

/**
 * @typedef {Object} BillingProvider
 *
 * @property {string} PROVIDER_NAME
 *   Stable machine key stored in billing_customers.provider,
 *   subscriptions.provider, invoices.provider, etc. — e.g. "stripe".
 *
 * @property {(env: Object, params: {organizationId: string, email: ?string}) => Promise<{providerCustomerId: string}>} createCustomer
 *
 * @property {(env: Object, params: {
 *   providerCustomerId: string,
 *   priceId: string,
 *   successUrl: string,
 *   cancelUrl: string,
 *   trialDays: number,
 *   organizationId: string,
 *   planId: string,
 *   couponProviderId: ?string
 * }) => Promise<{checkoutUrl: string, providerSessionId: string}>} createCheckoutSession
 *
 * @property {(env: Object, providerCustomerId: string, profile: Object, opts?: {idempotencyKey?: string}) => Promise<{ok: boolean}>} updateCustomer
 *   Syncs the editable billing contact/address fields to the provider before persisting them locally.
 *
 * @property {(env: Object, params: {providerCustomerId: string, returnUrl: string}) => Promise<{portalUrl: string}>} createPortalSession
 *   A short-lived, customer-specific URL where the customer updates
 *   their payment method and views invoices on the provider's own page.
 *
 * @property {(env: Object, providerSubscriptionId: string, opts: {atPeriodEnd: boolean}) => Promise<{ok: boolean}>} cancelSubscription
 *
 * @property {(env: Object, providerSubscriptionId: string) => Promise<{ok: boolean}>} resumeSubscription
 *
 * @property {(env: Object, providerSubscriptionId: string, opts: {resumesAt: string, idempotencyKey: string}) => Promise<{ok: boolean, resumesAt: string}>} pauseSubscription
 *   Optional commercial save-flow capability. Caller must gate it behind BILLING_SAVE_FLOW and supply an explicit resume timestamp.
 *
 * @property {(env: Object, providerSubscriptionId: string, opts?: {idempotencyKey?: string}) => Promise<{ok: boolean}>} resumePausedSubscription
 *   Removes a scheduled pause; distinct from resuming cancel_at_period_end.
 *
 * @property {(env: Object, providerSubscriptionId: string, newPriceId: string, opts?: {idempotencyKey?: string}) => Promise<{ok: boolean}>} changePlan
 *   opts.idempotencyKey (sprint 3.2) comes from the plan-change intent: sending the same key again must apply the
 *   change once. A provider error carries `kind`: "rejected" (the provider said no; never retried) or "unreachable".
 *
 * @property {(providerStatus: string) => string} normalizeSubscriptionStatus
 *   Maps a provider-specific status string to one of this repo's
 *   internal statuses (migration 0006: trialing|active|past_due|
 *   paused|canceled|expired|incomplete|incomplete_expired|suspended).
 *   This is the ONLY function in the whole codebase allowed to read
 *   a provider-specific status string — everything downstream of it
 *   deals exclusively in internal statuses (rule #3).
 *
 * @property {(request: Request, env: Object) => Promise<{valid: boolean, event: ?Object, reason: ?string}>} verifyAndParseWebhook
 *   MUST read the raw request body (request.text(), never
 *   request.json() first) and verify it against the provider's
 *   signature header before returning a parsed event. Returns
 *   {valid: false, event: null, reason} for a missing/invalid/
 *   expired signature — callers must reject the request outright
 *   rather than process an unverified body (section 40: replay/
 *   forgery protection).
 */
export const CONTRACT_VERSION = 1;
