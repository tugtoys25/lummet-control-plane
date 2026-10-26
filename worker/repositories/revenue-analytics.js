// SQL boundary for Round 6.1C revenue analytics. Keep every D1 statement in this repository.
//
// Date handling: subscriptions.trial_ends_at is stored as ISO ("2026-03-05T09:00:00.000Z") while status events, sites,
// domains and organizations use SQLite CURRENT_TIMESTAMP ("2026-03-05 09:00:05"). Those strings do not compare correctly
// with < or > (space sorts before "T"), so every date comparison below goes through datetime()/julianday().
//
// Every statement returns aggregates or a bounded page; none ships a whole ledger table to the Worker.
// `now` arguments are SQLite-format UTC strings ("YYYY-MM-DD HH:MM:SS") so tests can fix the clock.

export async function getSetting(env, key) {
  return env.LUMMET_DB.prepare(`SELECT value FROM lummet_site_settings WHERE key = ?`).bind(key).first();
}

export async function setSetting(env, key, value) {
  return env.LUMMET_DB.prepare(`INSERT INTO lummet_site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(key, value).run();
}

// One row per (cohort month, currency). Cohort month = month of the organization's first provider-confirmed 'new' movement.
// Per organization: start = sum of that organization's movements in its cohort month, now = its current ledger MRR.
// GRR sums MIN(now, start) per organization so one customer's expansion can never hide another's churn.
// A logo is churned when it has a churn movement and its current ledger MRR is zero (a reactivated customer is retained).
export async function listCohortRows(env, { maxRows = 600 } = {}) {
  const take = Math.max(1, Math.min(2000, Number(maxRows) || 600));
  return (await env.LUMMET_DB.prepare(
    `WITH first_new AS (
       SELECT organization_id, MIN(day) AS first_day FROM subscription_movements WHERE kind = 'new' GROUP BY organization_id
     ), org_start AS (
       SELECT substr(f.first_day, 1, 7) AS cohort_month, m.organization_id AS organization_id, m.currency AS currency,
              SUM(CASE WHEN substr(m.day, 1, 7) = substr(f.first_day, 1, 7) THEN m.mrr_delta_cents ELSE 0 END) AS start_cents,
              MAX(CASE WHEN m.kind = 'churn' THEN 1 ELSE 0 END) AS had_churn
         FROM subscription_movements m JOIN first_new f ON f.organization_id = m.organization_id
        GROUP BY substr(f.first_day, 1, 7), m.organization_id, m.currency
     ), org_now AS (
       SELECT sub.organization_id AS organization_id, rs.currency AS currency, SUM(rs.mrr_cents) AS now_cents
         FROM subscription_revenue_state rs JOIN subscriptions sub ON sub.id = rs.subscription_id
        GROUP BY sub.organization_id, rs.currency
     )
     SELECT o.cohort_month AS cohort_month, o.currency AS currency,
            COUNT(DISTINCT o.organization_id) AS logos,
            SUM(o.start_cents) AS start_cents,
            SUM(COALESCE(n.now_cents, 0)) AS current_cents,
            SUM(MIN(COALESCE(n.now_cents, 0), o.start_cents)) AS retained_cents,
            SUM(CASE WHEN o.had_churn = 1 AND COALESCE(n.now_cents, 0) = 0 THEN 1 ELSE 0 END) AS churned_logos
       FROM org_start o LEFT JOIN org_now n ON n.organization_id = o.organization_id AND n.currency = o.currency
      GROUP BY o.cohort_month, o.currency
      ORDER BY o.cohort_month DESC, o.currency
      LIMIT ?`
  ).bind(take).all()).results || [];
}

// Funnel counts, all at organization level and as of `now`.
export async function funnelCounts(env, now) {
  const trialEnded = `s.trial_ends_at IS NOT NULL AND datetime(s.trial_ends_at) IS NOT NULL AND datetime(s.trial_ends_at) <= datetime(?)`;
  const [orgs, ended, inWindow, converted, signups, activated] = await Promise.all([
    env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE erased_at IS NULL`).first(),
    env.LUMMET_DB.prepare(`SELECT COUNT(DISTINCT s.organization_id) AS n FROM subscriptions s WHERE ${trialEnded}`).bind(now).first(),
    env.LUMMET_DB.prepare(`SELECT COUNT(DISTINCT s.organization_id) AS n FROM subscriptions s WHERE ${trialEnded} AND datetime(s.trial_ends_at, '+14 days') > datetime(?)`).bind(now, now).first(),
    // Paying = an 'active' transition from the subscription's start up to 14 days after the trial ended. 'past_due' is not paying.
    env.LUMMET_DB.prepare(`SELECT COUNT(DISTINCT s.organization_id) AS n FROM subscriptions s JOIN subscription_status_events e ON e.subscription_id = s.id WHERE ${trialEnded} AND e.to_status = 'active' AND datetime(e.created_at) >= datetime(s.created_at) AND datetime(e.created_at) <= datetime(s.trial_ends_at, '+14 days')`).bind(now).first(),
    env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE erased_at IS NULL AND datetime(created_at, '+14 days') <= datetime(?)`).bind(now).first(),
    // Activation = a live site and an active domain with active SSL, both created within 14 days of the organization; only organizations whose 14 days have closed.
    env.LUMMET_DB.prepare(`SELECT COUNT(DISTINCT o.id) AS n FROM organizations o JOIN sites s ON s.organization_id = o.id AND s.status = 'active' AND datetime(s.created_at) >= datetime(o.created_at) AND datetime(s.created_at) <= datetime(o.created_at, '+14 days') JOIN domains d ON d.site_id = s.id AND d.status = 'active' AND d.ssl_status = 'active' AND datetime(d.created_at) >= datetime(o.created_at) AND datetime(d.created_at) <= datetime(o.created_at, '+14 days') WHERE o.erased_at IS NULL AND datetime(o.created_at, '+14 days') <= datetime(?)`).bind(now).first()
  ]);
  return { orgs, ended, inWindow, converted, signups, activated };
}

export async function listTrialRows(env, { limit = 50, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(100, Number(limit) || 50)); const skip = Math.max(0, Number(offset) || 0);
  return (await env.LUMMET_DB.prepare(`SELECT o.id AS organization_id, o.name AS organization, s.id AS subscription_id, s.status, s.trial_ends_at, s.created_at, s.updated_at, p.name AS plan FROM subscriptions s JOIN organizations o ON o.id=s.organization_id JOIN plans p ON p.id=s.plan_id WHERE s.trial_ends_at IS NOT NULL ORDER BY s.trial_ends_at DESC, s.id LIMIT ? OFFSET ?`).bind(take, skip).all()).results || [];
}

export async function listActivationRows(env, { limit = 50, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(100, Number(limit) || 50)); const skip = Math.max(0, Number(offset) || 0);
  return (await env.LUMMET_DB.prepare(`SELECT o.id AS organization_id, o.name AS organization, o.created_at, MIN(s.created_at) AS site_created_at, MIN(d.created_at) AS domain_created_at FROM organizations o LEFT JOIN sites s ON s.organization_id=o.id AND s.status='active' AND datetime(s.created_at) >= datetime(o.created_at) AND datetime(s.created_at) <= datetime(o.created_at, '+14 days') LEFT JOIN domains d ON d.site_id=s.id AND d.status='active' AND d.ssl_status='active' AND datetime(d.created_at) >= datetime(o.created_at) AND datetime(d.created_at) <= datetime(o.created_at, '+14 days') WHERE o.erased_at IS NULL GROUP BY o.id ORDER BY o.created_at DESC, o.id LIMIT ? OFFSET ?`).bind(take, skip).all()).results || [];
}

// Deferred revenue: paid invoices whose service term is at least `minTermDays` long and still running at `now`.
// Tax is not revenue, so it is removed from the paid amount. Recognition is straight-line over the stored service period.
// Output is one aggregate row per currency. Terms are detected from the invoice's own period, not from the subscription's current plan,
// so a customer who later changed plan does not reclassify old invoices.
export async function deferredRevenueRows(env, { now, minTermDays }) {
  return (await env.LUMMET_DB.prepare(
    `SELECT currency, COUNT(*) AS invoices, SUM(net) AS prepaid_cents, SUM(CAST(ROUND(net * remaining) AS INTEGER)) AS deferred_cents FROM (
       SELECT UPPER(i.currency) AS currency,
              MAX(0, i.amount_paid_cents - COALESCE(i.tax_cents, 0)) AS net,
              MAX(0.0, MIN(1.0, (julianday(i.period_end) - julianday(?)) / (julianday(i.period_end) - julianday(i.period_start)))) AS remaining
         FROM invoices i
        WHERE i.status = 'paid' AND i.amount_paid_cents > 0
          AND julianday(i.period_start) IS NOT NULL AND julianday(i.period_end) IS NOT NULL
          AND julianday(i.period_end) - julianday(i.period_start) >= ?
          AND julianday(i.period_end) > julianday(?)
     ) GROUP BY currency ORDER BY currency`
  ).bind(now, minTermDays, now).all()).results || [];
}

export async function listArpaRows(env) {
  return (await env.LUMMET_DB.prepare(`SELECT s.currency, SUM(s.mrr_cents) AS mrr_cents, COUNT(DISTINCT sub.organization_id) AS paying_organizations FROM subscription_revenue_state s JOIN subscriptions sub ON sub.id=s.subscription_id WHERE s.mrr_cents > 0 GROUP BY s.currency ORDER BY s.currency`).all()).results || [];
}

export async function listGrossMarginRows(env) {
  return (await env.LUMMET_DB.prepare(`SELECT p.key AS tier, p.name AS plan, UPPER(p.currency) AS currency, COUNT(*) AS subscriptions, COUNT(rs.subscription_id) AS metered_subscriptions, SUM(rs.mrr_cents) AS mrr_cents FROM subscriptions s JOIN plans p ON p.id=s.plan_id LEFT JOIN subscription_revenue_state rs ON rs.subscription_id=s.id WHERE s.status IN ('active','past_due') GROUP BY p.id ORDER BY p.key`).all()).results || [];
}
