// =====================================================
// AI CREDIT LEDGER (master prompt section 16)
//
// Customers see "AI credits", never provider tokens. Append-only
// ledger: balance = SUM(amount). Reservation is a single
// conditional INSERT (balance check + debit in one statement) so two
// concurrent requests cannot both spend the same credits.
// =====================================================
import * as entitlementsService from "./entitlements.js";
import { currentPeriod } from "./usage.js";

export async function getBalance(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM ai_credit_ledger WHERE organization_id = ?`).bind(organizationId).first();
  return r.b;
}

/** Grant this month's allocation once (idempotent per org+period). */
export async function grantMonthlyAllocation(env, organizationId, period = currentPeriod()) {
  const allowance = await entitlementsService.checkEntitlement(env, organizationId, "ai.credits_monthly");
  if (typeof allowance !== "number" || allowance <= 0) return { ok: true, granted: 0 };
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO ai_credit_ledger (organization_id, kind, amount, idempotency_key, note) VALUES (?, 'grant_monthly', ?, ?, ?)`
    ).bind(organizationId, allowance, `grant:${period}`, `monthly allocation ${period}`).run();
    return { ok: true, granted: allowance };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return { ok: true, granted: 0, duplicate: true };
    throw e;
  }
}

/** Purchased packs / staff adjustments. idempotencyKey should be the payment id. */
export async function addCredits(env, organizationId, amount, { kind = "purchase", idempotencyKey = null, note = null } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  if (!["purchase", "adjust"].includes(kind)) return { ok: false, error: "invalid_kind" };
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO ai_credit_ledger (organization_id, kind, amount, idempotency_key, note) VALUES (?, ?, ?, ?, ?)`
    ).bind(organizationId, kind, amount, idempotencyKey, note).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return { ok: true, duplicate: true };
    throw e;
  }
  return { ok: true };
}

/** Atomically debit `amount`; fails with insufficient_credits if balance would go negative. */
export async function reserveCredits(env, { organizationId, siteId = null, userId = null, amount, task = null }) {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  const reservationId = crypto.randomUUID();
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO ai_credit_ledger (organization_id, site_id, user_id, kind, amount, reservation_id, task)
     SELECT ?, ?, ?, 'reserve', ?, ?, ?
     WHERE (SELECT COALESCE(SUM(amount), 0) FROM ai_credit_ledger WHERE organization_id = ?) >= ?`
  ).bind(organizationId, siteId, userId, -amount, reservationId, task, organizationId, amount).run();
  if (!r.meta.changes) return { ok: false, error: "insufficient_credits" };
  return { ok: true, reservationId, reserved: amount };
}

async function reservation(env, organizationId, reservationId) {
  const rows = await env.LUMMET_DB.prepare(
    `SELECT kind, amount FROM ai_credit_ledger WHERE organization_id = ? AND reservation_id = ?`
  ).bind(organizationId, reservationId).all();
  const reserve = rows.results.find((x) => x.kind === "reserve");
  const closed = rows.results.some((x) => x.kind === "settle" || x.kind === "refund");
  return { reserved: reserve ? -reserve.amount : 0, closed };
}

/** Finalise a reservation at the actual cost (returns any unused portion). */
export async function settleCredits(env, { organizationId, reservationId, actual, provider = null, model = null, tokensIn = null, tokensOut = null, costMicros = null }) {
  const res = await reservation(env, organizationId, reservationId);
  if (!res.reserved) return { ok: false, error: "unknown_reservation" };
  if (res.closed) return { ok: true, duplicate: true };
  const used = Math.min(Math.max(0, actual), res.reserved); // never charge more than reserved
  const giveBack = res.reserved - used;
  await env.LUMMET_DB.prepare(
    `INSERT INTO ai_credit_ledger (organization_id, kind, amount, reservation_id, provider, model, provider_tokens_in, provider_tokens_out, provider_cost_micros, note)
     VALUES (?, 'settle', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(organizationId, giveBack, reservationId, provider, model, tokensIn, tokensOut, costMicros, `used ${used}`).run();
  return { ok: true, charged: used, returned: giveBack };
}

/** Full refund (provider failure). */
export async function refundCredits(env, { organizationId, reservationId, note = "provider failure" }) {
  const res = await reservation(env, organizationId, reservationId);
  if (!res.reserved) return { ok: false, error: "unknown_reservation" };
  if (res.closed) return { ok: true, duplicate: true };
  await env.LUMMET_DB.prepare(
    `INSERT INTO ai_credit_ledger (organization_id, kind, amount, reservation_id, note) VALUES (?, 'refund', ?, ?, ?)`
  ).bind(organizationId, res.reserved, reservationId, note).run();
  return { ok: true, refunded: res.reserved };
}

export async function listLedger(env, organizationId, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, kind, amount, task, model, site_id, user_id, note, created_at FROM ai_credit_ledger WHERE organization_id = ? ORDER BY id DESC LIMIT ?`
  ).bind(organizationId, Math.min(limit, 200)).all();
  return r.results;
}
