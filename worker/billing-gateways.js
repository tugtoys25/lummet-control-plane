// =====================================================
// PAYMENT GATEWAY SWITCH
//
// One row per gateway in payment_gateways (migration 0074). Staff flip a gateway on or off; checkout only offers gateways that are
// enabled AND configured, in priority order. This is the failover lever: if Stripe restricts the account, switch it off and
// customers are offered crypto, with no deploy.
//
// What the switch does NOT do (on purpose): it never blocks a WEBHOOK, and it never touches existing subscriptions. A gateway that is
// switched off still delivers events for payments already in flight, and its existing customers can still be managed.
// If the table is missing (migration not yet applied) or unreadable, the legacy behaviour holds: Stripe only.
// =====================================================
import * as stripeProvider from "./billing-stripe.js";
import { billing } from "./billing.js";
import { cryptoBilling } from "./billing-nowpayments-service.js";
import * as repo from "./repositories/payment-gateways.js";

export const GATEWAY_KEYS = ["stripe", "nowpayments"];

const GATEWAYS = {
  stripe: {
    label: "Card (Stripe)",
    // Stripe is not gated on configuration here: it is the legacy path, and a missing key already fails loudly inside it.
    configured: () => true
  },
  nowpayments: {
    label: "Crypto (NOWPayments)",
    configured: (env) => !!(env && env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_IPN_SECRET)
  }
};

const FALLBACK_ROWS = [
  { gateway: "stripe", enabled: 1, priority: 10, updated_by: null, updated_at: null },
  { gateway: "nowpayments", enabled: 0, priority: 20, updated_by: null, updated_at: null }
];

async function readRows(env) {
  try {
    const rows = await repo.listRows(env);
    return rows.length ? rows : FALLBACK_ROWS;
  } catch (_) {
    return FALLBACK_ROWS;
  }
}

/** Every known gateway with its switch, its configuration state, and whether customers can use it right now. */
export async function listGateways(env) {
  const rows = await readRows(env);
  return rows
    .filter((r) => GATEWAYS[r.gateway])
    .map((r) => {
      const configured = GATEWAYS[r.gateway].configured(env);
      const enabled = Number(r.enabled) === 1;
      return { gateway: r.gateway, label: GATEWAYS[r.gateway].label, enabled, configured, available: enabled && configured, priority: r.priority, updatedBy: r.updated_by || null, updatedAt: r.updated_at || null };
    });
}

export async function availableGateways(env) {
  return (await listGateways(env)).filter((g) => g.available);
}

/**
 * Picks the gateway for a new checkout.
 *   requested given   -> that gateway if available, else 409 gateway_unavailable (with what IS available)
 *   requested omitted -> the first available by priority (Stripe, until staff change it)
 *   nothing available -> 503 no_payment_gateway_available
 */
export async function resolveGateway(env, requested) {
  const available = await availableGateways(env);
  const names = available.map((g) => g.gateway);
  if (!names.length) return { ok: false, status: 503, error: "no_payment_gateway_available", available: [] };
  if (requested === undefined || requested === null || requested === "") return { ok: true, gateway: names[0], available: names };
  const key = String(requested).trim().toLowerCase();
  if (!GATEWAYS[key]) return { ok: false, status: 422, error: "unknown_gateway", available: names };
  if (!names.includes(key)) return { ok: false, status: 409, error: "gateway_unavailable", available: names };
  return { ok: true, gateway: key, available: names };
}

/**
 * Staff switch. Refuses to switch off the LAST available gateway (that would leave nobody able to pay) and refuses to switch on a
 * gateway whose secrets are not configured. Every change is recorded with who and why.
 */
export async function setGatewayEnabled(env, { gateway, enabled, actorId, reason }) {
  const key = String(gateway || "").trim().toLowerCase();
  if (!GATEWAYS[key]) return { ok: false, status: 404, error: "unknown_gateway" };
  if (typeof enabled !== "boolean") return { ok: false, status: 422, error: "enabled_boolean_required" };
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) return { ok: false, status: 422, error: "reason_required" };
  if (!actorId) return { ok: false, status: 422, error: "actor_required" };

  const all = await listGateways(env);
  const current = all.find((g) => g.gateway === key);
  if (enabled && !GATEWAYS[key].configured(env)) return { ok: false, status: 409, error: "gateway_not_configured" };
  if (!enabled) {
    const others = all.filter((g) => g.gateway !== key && g.available);
    if (!others.length) return { ok: false, status: 409, error: "cannot_disable_last_gateway" };
  }
  if (current && current.enabled === enabled) return { ok: true, unchanged: true, gateways: all };

  await repo.upsertSwitch(env, { gateway: key, enabled, priority: current?.priority ?? 100, actorId });
  await repo.insertEvent(env, { gateway: key, enabled, reason: cleanReason, actorId });
  return { ok: true, unchanged: false, gateways: await listGateways(env) };
}

export async function listGatewayEvents(env, { limit = 50 } = {}) {
  try { return await repo.listEvents(env, Math.min(200, Math.max(1, limit))); } catch (_) { return []; }
}

/**
 * The billing service that manages an organization's EXISTING subscription: the one whose provider created it. A switched-off
 * gateway still manages the customers it already has. Anything unrecognised (or no subscription) falls back to the Stripe service.
 */
export async function billingServiceFor(env, organizationId) {
  try {
    const provider = await repo.currentSubscriptionProvider(env, organizationId);
    if (provider === "nowpayments") {
      // Prepaid crypto periods have no in-place plan change, pause, or provider portal: say so cleanly instead of failing inside a call.
      const unavailable = async () => ({ ok: false, status: 409, error: "not_available_for_crypto" });
      return { ...cryptoBilling.service, pauseSubscription: unavailable, resumePausedSubscription: unavailable,
        changePlan: async () => ({ ok: false, status: 409, error: "use_crypto_checkout_to_change_plan" }) };
    }
  } catch (_) { /* fall through to Stripe */ }
  return billing;
}

export { stripeProvider };
