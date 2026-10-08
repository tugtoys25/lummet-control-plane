// Coupons and their redemptions. (Repository: all SQL for these tables.)

export async function findActiveByCode(env, code) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM coupons WHERE UPPER(code) = UPPER(?) AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`
  ).bind(code).first();
}

export async function findById(env, couponId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(couponId).first();
}

export async function codeExists(env, upperCode) {
  return !!(await env.LUMMET_DB.prepare(`SELECT id FROM coupons WHERE UPPER(code) = ?`).bind(upperCode).first());
}

export async function hasRedeemed(env, couponId, organizationId) {
  return !!(await env.LUMMET_DB.prepare(`SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND organization_id = ?`).bind(couponId, organizationId).first());
}

/** Records a redemption once per organization. Returns true when a new row was written. */
export async function addRedemption(env, { couponId, organizationId, subscriptionId }) {
  const ins = await env.LUMMET_DB.prepare(
    `INSERT OR IGNORE INTO coupon_redemptions (id, coupon_id, organization_id, subscription_id) VALUES (?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), couponId, organizationId, subscriptionId || null).run();
  return !!(ins.meta && ins.meta.changes);
}

export async function incrementRedemptionCount(env, couponId) {
  await env.LUMMET_DB.prepare(`UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = ?`).bind(couponId).run();
}

export async function attachToSubscription(env, subscriptionId, couponId) {
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET coupon_id = ? WHERE id = ?`).bind(couponId, subscriptionId).run();
}

export async function list(env, limit = 200) {
  return (await env.LUMMET_DB.prepare(
    `SELECT c.id, c.code, c.provider_coupon_id, c.percent_off, c.amount_off_cents, c.duration, c.status, c.expires_at, c.max_redemptions, c.redemption_count, c.note, c.created_at,
            c.organization_id, o.name AS organization_name
     FROM coupons c LEFT JOIN organizations o ON o.id = c.organization_id
     ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`
  ).bind(limit).all()).results;
}

/** The organization a coupon would be scoped to (null when it does not exist). */
export async function findOrganization(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT id, name, erased_at FROM organizations WHERE id = ?`).bind(organizationId).first();
}

export async function insert(env, c) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, amount_off_cents, duration, expires_at, max_redemptions, note, organization_id)
     VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(c.id, c.code, c.providerCouponId, c.percentOff, c.amountOff, c.duration, c.expiresAt, c.maxRedemptions, c.note, c.organizationId ?? null).run();
}

export async function update(env, couponId, fields) {
  const sets = [], vals = [];
  if ("status" in fields) { sets.push("status = ?"); vals.push(fields.status); }
  if ("maxRedemptions" in fields) { sets.push("max_redemptions = ?"); vals.push(fields.maxRedemptions); }
  if (!sets.length) return;
  await env.LUMMET_DB.prepare(`UPDATE coupons SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, couponId).run();
}

// ---- Holds: a pending checkout reserves one use of a LIMITED coupon until it completes or expires ----

export async function countOtherHolds(env, couponId, organizationId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) n FROM coupon_reservations WHERE coupon_id = ? AND organization_id != ? AND expires_at > datetime('now')`
  ).bind(couponId, organizationId).first();
  return Number(r?.n || 0);
}

/** Takes the hold in ONE statement so two checkouts racing for the last use cannot both succeed (D1 serialises writes). */
export async function reserveUse(env, couponId, organizationId, holdSeconds) {
  await env.LUMMET_DB.prepare(`DELETE FROM coupon_reservations WHERE coupon_id = ? AND expires_at <= datetime('now')`).bind(couponId).run();
  // Plain ? placeholders on purpose (no ?1/?2 numbering): they behave the same on D1 and on every
  // Node/SQLite build the tests may run on, so the id and organization are simply bound each time they appear.
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO coupon_reservations (coupon_id, organization_id, expires_at)
     SELECT ?, ?, datetime('now', '+' || ? || ' seconds')
     WHERE (SELECT redemption_count FROM coupons WHERE id = ?)
         + (SELECT COUNT(*) FROM coupon_reservations WHERE coupon_id = ? AND organization_id != ? AND expires_at > datetime('now'))
         < (SELECT max_redemptions FROM coupons WHERE id = ?)
     ON CONFLICT(coupon_id, organization_id) DO UPDATE SET expires_at = excluded.expires_at`
  ).bind(couponId, organizationId, holdSeconds, couponId, couponId, organizationId, couponId).run();
  return (r?.meta?.changes || 0) > 0;
}

export async function releaseHold(env, couponId, organizationId) {
  await env.LUMMET_DB.prepare(`DELETE FROM coupon_reservations WHERE coupon_id = ? AND organization_id = ?`).bind(couponId, organizationId).run();
}
