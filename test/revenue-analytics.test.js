// Round 6.1C acceptance tests: spreadsheet-safe CSV, staff finance settings, and unknown margin costs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as analytics from '../worker/revenue-analytics.js';

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ...extra }; }
const run = (e, sql, ...args) => e.LUMMET_DB.prepare(sql).bind(...args).run();
const one = (e, sql, ...args) => e.LUMMET_DB.prepare(sql).bind(...args).first();

test('CSV cells quote delimiters and neutralize spreadsheet formula injection', () => {
  assert.equal(analytics.csvCell('=1+1'), '"\'=1+1"');
  assert.equal(analytics.csvCell('  +SUM(A1:A2)'), '"\'  +SUM(A1:A2)"');
  assert.equal(analytics.csvCell('-1'), '"\'-1"');
  assert.equal(analytics.csvCell('@cmd'), '"\'@cmd"');
  assert.equal(analytics.csvCell('a,"b"\r\nc'), '"a,""b""  c"');
  assert.equal(analytics.toCsv(['name'], [['plain']]), '"name"\r\n"plain"\r\n');
  assert.equal(analytics.csvCell('\t=HYPERLINK("x")'), '"\'\t=HYPERLINK(""x"")"');
  assert.equal(analytics.csvCell(-250), '"-250"', 'a real negative number stays numeric');
  assert.equal(analytics.csvCell(null), '""');
});

test('finance unit-cost settings accept nonnegative integer cents and reject invalid values', async () => {
  const e = env();
  assert.deepEqual(await analytics.financeUnitCosts(e), {});
  assert.deepEqual(await analytics.setFinanceUnitCosts(e, { starter: 125, agency: 0 }), { ok: true, costs: { starter: 125, agency: 0 } });
  assert.deepEqual(await analytics.financeUnitCosts(e), { starter: 125, agency: 0 });
  assert.equal((await analytics.setFinanceUnitCosts(e, { starter: -1 })).error, 'cost_must_be_nonnegative_integer_cents');
  assert.equal((await analytics.setFinanceUnitCosts(e, { 'bad key': 1 })).error, 'invalid_tier_key');
});

test('gross margin is unknown, never zero, when tier unit costs are unset', async () => {
  const e = env();
  const plan = await one(e, `SELECT id, key, product_id, price_cents, currency FROM plans WHERE id='plan_casino_news_starter'`);
  assert.ok(plan);
  await run(e, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at) VALUES ('org-analytics', 'Analytics Org', 'org-analytics', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status, created_at, updated_at) VALUES ('sub-analytics', 'org-analytics', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, plan.id);
  await run(e, `INSERT INTO subscription_revenue_state (subscription_id, seq, mrr_cents, currency, plan_id, quantity, last_event_created) VALUES ('sub-analytics', 1, 500, 'USD', ?, 1, 1)`, plan.id);
  const rows = await analytics.grossMarginByTier(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revenueCents, 500);
  assert.equal(rows[0].unitCostCents, null);
  assert.equal(rows[0].totalCostCents, null);
  assert.equal(rows[0].grossMarginCents, null);
  assert.deepEqual(await analytics.arpaByCurrency(e), [{ currency: 'USD', mrrCents: 500, payingOrganizations: 1, arpaCents: 500 }]);
});

test('revenue analytics defaults off and accepts only documented modes', () => {
  assert.equal(analytics.analyticsMode({}), 'off');
  assert.equal(analytics.analyticsMode({ REVENUE_ANALYTICS: 'shadow' }), 'shadow');
  assert.equal(analytics.analyticsMode({ REVENUE_ANALYTICS: 'on' }), 'on');
  assert.equal(analytics.analyticsMode({ REVENUE_ANALYTICS: 'unsafe' }), 'off');
});

test('staff dashboard renders, CSV export is staff-only and audited, finance updates are audited', async () => {
  const worker = (await import('../worker/index.js')).default;
  const e = env({ CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' });
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
  let ip = 20;
  const call = async (method, path, body, cookie) => {
    const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${ip++}` });
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
    return { response, text: await response.text(), cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  const anonCsv = await call('GET', '/api/platform/saas/revenue-analytics/export.csv');
  assert.equal(anonCsv.response.status, 401);
  const boot = await call('POST', '/api/auth/bootstrap', { email: 'analytics-root@example.com', password: 'Correct-Horse-Battery-9' });
  assert.equal(boot.response.status, 200, boot.text);
  const login = await call('POST', '/api/auth/login', { email: 'analytics-root@example.com', password: 'Correct-Horse-Battery-9' });
  assert.equal(login.response.status, 200, login.text);
  const page = await call('GET', '/platform/saas/revenue-analytics', undefined, login.cookie);
  assert.equal(page.response.status, 200, page.text.slice(0, 300));
  assert.match(page.text, /Revenue analytics/);
  assert.match(page.text, /unknown, never zero/);
  e.REVENUE_ANALYTICS = 'shadow';
  const enabledPage = await call('GET', '/platform/saas/revenue-analytics', undefined, login.cookie);
  assert.equal(enabledPage.response.status, 200, enabledPage.text.slice(0, 500));
  assert.match(enabledPage.text, /Monthly revenue cohorts/);
  const csv = await call('GET', '/api/platform/saas/revenue-analytics/export.csv', undefined, login.cookie);
  assert.equal(csv.response.status, 200, csv.text);
  assert.match(csv.response.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /"cohort_month"/);
  const noReason = await call('POST', '/api/platform/saas/revenue-analytics/finance-unit-costs', { costs: { starter: 123 } }, login.cookie);
  assert.equal(noReason.response.status, 422, noReason.text);
  assert.deepEqual(await analytics.financeUnitCosts(e), {}, 'a refused update stores nothing');
  const save = await call('POST', '/api/platform/saas/revenue-analytics/finance-unit-costs', { costs: { starter: 123 }, reason: 'Q4 finance sign-off' }, login.cookie);
  assert.equal(save.response.status, 200, save.text);
  assert.deepEqual(await analytics.financeUnitCosts(e), { starter: 123 });
  const audits = (await e.LUMMET_DB.prepare(`SELECT action, resource, success, reason FROM lummet_audit_logs WHERE resource IN ('revenue_analytics','finance_unit_costs') ORDER BY id`).all()).results;
  assert.deepEqual(audits.map((r) => [r.action, r.resource, r.success]), [['export_csv', 'revenue_analytics', 1], ['update', 'finance_unit_costs', 0], ['update', 'finance_unit_costs', 1]]);
  assert.equal(audits[2].reason, 'Q4 finance sign-off');
});

test('cohort NRR/GRR use all first-month movements and logo churn uses ledger churn', async () => {
  const e = env();
  const plan = await one(e, `SELECT id FROM plans WHERE id='plan_casino_news_starter'`);
  await run(e, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at) VALUES ('cohort-org', 'Cohort Org', 'cohort-org', 'active', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`);
  await run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status, created_at, updated_at) VALUES ('cohort-sub', 'cohort-org', ?, 'active', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`, plan.id);
  const movement = (id, seq, day, kind, delta, after) => run(e, `INSERT INTO subscription_movements (id, subscription_id, organization_id, seq, day, kind, mrr_delta_cents, mrr_after_cents, currency, plan_id, quantity, source) VALUES (?, 'cohort-sub', 'cohort-org', ?, ?, ?, ?, ?, 'USD', ?, 1, 'webhook')`, id, seq, day, kind, delta, after, plan.id);
  await movement('cohort-sub:1', 1, '2026-01-02', 'new', 500, 500);
  await movement('cohort-sub:2', 2, '2026-01-03', 'expansion', 200, 700);
  await run(e, `INSERT INTO subscription_revenue_state (subscription_id, seq, mrr_cents, currency, plan_id, quantity, last_event_created) VALUES ('cohort-sub', 2, 700, 'USD', ?, 1, 2)`, plan.id);
  let [cohort] = await analytics.monthlyCohorts(e);
  assert.equal(cohort.startingMrrCents, 700);
  assert.equal(cohort.currentMrrCents, 700);
  assert.equal(cohort.nrrPercent, 100);
  assert.equal(cohort.grrPercent, 100);
  await movement('cohort-sub:3', 3, '2026-02-02', 'churn', -700, 0);
  await run(e, `UPDATE subscription_revenue_state SET seq=3, mrr_cents=0 WHERE subscription_id='cohort-sub'`);
  [cohort] = await analytics.monthlyCohorts(e);
  assert.equal(cohort.currentMrrCents, 0);
  assert.equal(cohort.nrrPercent, 0);
  assert.equal(cohort.grrPercent, 0);
  assert.equal(cohort.logoChurnPercent, 100);
});


// ---- Integration review fixes (v2.6.0.3 integration): definitions proven with real rows -------------------------------------------------
async function seed() {
  const e = env();
  const plan = (await one(e, `SELECT id FROM plans WHERE id='plan_casino_news_starter'`)).id;
  const api = {
    e, plan,
    org: (id, created = '2026-01-01 00:00:00') => run(e, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`, id, id, id, created, created),
    sub: (id, org, status = 'active', trialEnd = null, created = '2026-01-01 00:00:00') => run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status, trial_ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, org, plan, status, trialEnd, created, created),
    mv: (sub, org, seq, day, kind, delta, after, cur = 'USD') => run(e, `INSERT INTO subscription_movements (id, subscription_id, organization_id, seq, day, kind, mrr_delta_cents, mrr_after_cents, currency, plan_id, quantity, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'webhook')`, `${sub}:${seq}`, sub, org, seq, day, kind, delta, after, cur, plan),
    state: (sub, mrr, cur = 'USD') => run(e, `INSERT INTO subscription_revenue_state (subscription_id, seq, mrr_cents, currency, plan_id, quantity, last_event_created) VALUES (?, 1, ?, ?, ?, 1, 1)`, sub, mrr, cur, plan),
    event: (sub, to, at) => run(e, `INSERT INTO subscription_status_events (subscription_id, to_status, created_at) VALUES (?, ?, ?)`, sub, to, at)
  };
  return api;
}

test('GRR gives no expansion credit: one customer doubling cannot hide another customer churning', async () => {
  const t = await seed();
  await t.org('a'); await t.sub('sa', 'a'); await t.mv('sa', 'a', 1, '2026-01-02', 'new', 1000, 1000); await t.mv('sa', 'a', 2, '2026-02-02', 'expansion', 1000, 2000); await t.state('sa', 2000);
  await t.org('b'); await t.sub('sb', 'b'); await t.mv('sb', 'b', 1, '2026-01-03', 'new', 1000, 1000); await t.mv('sb', 'b', 2, '2026-02-03', 'churn', -1000, 0); await t.state('sb', 0);
  const [c] = await analytics.monthlyCohorts(t.e);
  assert.equal(c.startingMrrCents, 2000);
  assert.equal(c.currentMrrCents, 2000);
  assert.equal(c.nrrPercent, 100, 'net retention counts expansion');
  assert.equal(c.grrPercent, 50, 'gross retention does not');
  assert.equal(c.logos, 2);
  assert.equal(c.churnedLogos, 1);
  assert.equal(c.logoChurnPercent, 50);
});

test('cohorts never add currencies together: one row per cohort month and currency', async () => {
  const t = await seed();
  await t.org('u'); await t.sub('su', 'u'); await t.mv('su', 'u', 1, '2026-01-02', 'new', 1000, 1000, 'USD'); await t.state('su', 1000, 'USD');
  await t.org('x'); await t.sub('sx', 'x'); await t.mv('sx', 'x', 1, '2026-01-04', 'new', 900, 900, 'EUR'); await t.state('sx', 900, 'EUR');
  const rows = await analytics.monthlyCohorts(t.e);
  assert.deepEqual(rows.map((r) => [r.cohortMonth, r.currency, r.startingMrrCents, r.currentMrrCents]), [['2026-01', 'EUR', 900, 900], ['2026-01', 'USD', 1000, 1000]]);
});

test('a churned customer who later returns is retained, and a cohort with no starting MRR reports unknown rates', async () => {
  const t = await seed();
  await t.org('r'); await t.sub('sr', 'r'); await t.mv('sr', 'r', 1, '2026-03-01', 'new', 500, 500); await t.mv('sr', 'r', 2, '2026-04-01', 'churn', -500, 0); await t.mv('sr', 'r', 3, '2026-05-01', 'new', 500, 500); await t.state('sr', 500);
  await t.org('z'); await t.sub('sz', 'z'); await t.mv('sz', 'z', 1, '2026-06-01', 'new', 300, 300); await t.mv('sz', 'z', 2, '2026-06-15', 'churn', -300, 0); await t.state('sz', 0);
  const rows = await analytics.monthlyCohorts(t.e);
  const march = rows.find((r) => r.cohortMonth === '2026-03'); const june = rows.find((r) => r.cohortMonth === '2026-06');
  assert.equal(march.churnedLogos, 0); assert.equal(march.logoChurnPercent, 0); assert.equal(march.nrrPercent, 100);
  assert.equal(june.startingMrrCents, 0); assert.equal(june.nrrPercent, null); assert.equal(june.grrPercent, null);
  assert.equal(june.churnedLogos, 1);
});

test('cohort list is bounded to the newest N months', async () => {
  const t = await seed();
  for (let m = 1; m <= 5; m++) { const id = `m${m}`; await t.org(id); await t.sub('s' + id, id); await t.mv('s' + id, id, 1, `2026-0${m}-05`, 'new', 100, 100); await t.state('s' + id, 100); }
  const two = await analytics.monthlyCohorts(t.e, { limit: 2 });
  assert.deepEqual(two.map((r) => r.cohortMonth), ['2026-05', '2026-04']);
});

test('trial-to-paid counts a same-day conversion (ISO trial end vs SQLite event time) and only trials that have ended', async () => {
  const t = await seed(); const NOW = Date.parse('2026-04-01T00:00:00Z');
  // Converted 5 seconds after the trial ended, same calendar day (the common card-on-file case).
  await t.org('t1'); await t.sub('st1', 't1', 'active', '2026-03-05T09:00:00.000Z'); await t.event('st1', 'active', '2026-03-05 09:00:05');
  // Converted mid-trial.
  await t.org('t2'); await t.sub('st2', 't2', 'active', '2026-03-10T09:00:00.000Z'); await t.event('st2', 'active', '2026-03-08 12:00:00');
  // Converted after the 14-day window: not counted.
  await t.org('t3'); await t.sub('st3', 't3', 'active', '2026-03-01T09:00:00.000Z'); await t.event('st3', 'active', '2026-03-20 09:00:00');
  // Went past_due on the first invoice: not paying.
  await t.org('t4'); await t.sub('st4', 't4', 'past_due', '2026-03-02T09:00:00.000Z'); await t.event('st4', 'past_due', '2026-03-02 09:00:01');
  // Never converted.
  await t.org('t5'); await t.sub('st5', 't5', 'expired', '2026-03-03T09:00:00.000Z');
  // Trial still running at NOW: in neither the numerator nor the denominator.
  await t.org('t6'); await t.sub('st6', 't6', 'trialing', '2026-04-10T09:00:00.000Z'); await t.event('st6', 'active', '2026-03-30 09:00:00');
  const f = await analytics.funnelSummary(t.e, { now: NOW });
  assert.equal(f.trialsEnded, 5);
  assert.equal(f.trialToPaid14Days, 2);
  assert.equal(f.trialToPaidPercent, 40);
  assert.equal(f.trialsEndedStillInWindow, 0, 'all five ended trials are more than 14 days before the clock');
});

test('funnel rates are unknown (null), not zero, when there is nothing to divide by', async () => {
  const t = await seed();
  const f = await analytics.funnelSummary(t.e, { now: Date.parse('2026-04-01T00:00:00Z') });
  assert.equal(f.trialToPaidPercent, null); assert.equal(f.activationPercent, null);
});

test('activation needs a live site and an active domain with active SSL, both inside 14 days, and only counts closed windows', async () => {
  const t = await seed(); const NOW = Date.parse('2026-06-01T00:00:00Z');
  const site = (id, org, status, at) => run(t.e, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, (SELECT id FROM products LIMIT 1), ?, ?, ?)`, id, org, id, id, status, at, at);
  const dom = (id, siteId, status, ssl, at) => run(t.e, `INSERT INTO domains (id, site_id, hostname, status, verification_token, ssl_status, created_at) VALUES (?, ?, ?, ?, 'tok', ?, ?)`, id, siteId, id + '.example.com', status, ssl, at);
  await t.org('ok', '2026-05-01 00:00:00'); await site('s-ok', 'ok', 'active', '2026-05-03 00:00:00'); await dom('d-ok', 's-ok', 'active', 'active', '2026-05-05 00:00:00');
  await t.org('late', '2026-05-01 00:00:00'); await site('s-late', 'late', 'active', '2026-05-03 00:00:00'); await dom('d-late', 's-late', 'active', 'active', '2026-05-20 00:00:00');
  await t.org('nossl', '2026-05-01 00:00:00'); await site('s-nossl', 'nossl', 'active', '2026-05-03 00:00:00'); await dom('d-nossl', 's-nossl', 'active', 'pending', '2026-05-05 00:00:00');
  await t.org('suspended', '2026-05-01 00:00:00'); await site('s-susp', 'suspended', 'suspended', '2026-05-03 00:00:00'); await dom('d-susp', 's-susp', 'active', 'active', '2026-05-05 00:00:00');
  await t.org('fresh', '2026-05-25 00:00:00'); await site('s-fresh', 'fresh', 'active', '2026-05-26 00:00:00'); await dom('d-fresh', 's-fresh', 'active', 'active', '2026-05-27 00:00:00');
  const f = await analytics.funnelSummary(t.e, { now: NOW });
  assert.equal(f.signupsMatured, 4, 'the fresh organization is still inside its 14 days');
  assert.equal(f.activated14Days, 1);
  assert.equal(f.activationPercent, 25);
});

test('deferred revenue excludes tax, recognizes straight-line, ignores ended terms and short terms, and stays per currency', async () => {
  const t = await seed(); const NOW = Date.parse('2026-07-02T00:00:00Z'); // 183 of the 365 days of the 2026-01-01 .. 2027-01-01 term are left
  await t.org('d1'); await t.sub('sd1', 'd1');
  const inv = (id, status, paid, tax, cur, start, end) => run(t.e, `INSERT INTO invoices (id, organization_id, subscription_id, provider, provider_invoice_id, status, amount_paid_cents, tax_cents, currency, period_start, period_end) VALUES (?, 'd1', 'sd1', 'x', ?, ?, ?, ?, ?, ?, ?)`, id, id, status, paid, tax, cur, start, end);
  await inv('i-annual', 'paid', 12000, 2000, 'USD', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  await inv('i-eur', 'paid', 5000, 0, 'EUR', '2026-07-02T00:00:00.000Z', '2027-07-02T00:00:00.000Z');
  await inv('i-ended', 'paid', 9999, 0, 'USD', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await inv('i-monthly', 'paid', 700, 0, 'USD', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  await inv('i-open', 'open', 8000, 0, 'USD', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  await inv('i-badperiod', 'paid', 4000, 0, 'USD', 'not-a-date', '2027-01-01T00:00:00.000Z');
  const rows = await analytics.deferredRevenueSummary(t.e, { now: NOW });
  const usd = rows.find((r) => r.currency === 'USD'); const eur = rows.find((r) => r.currency === 'EUR');
  assert.equal(usd.invoices, 1);
  assert.equal(usd.prepaidCents, 10000, 'tax of 2000 is not revenue');
  assert.equal(usd.deferredCents, 5014, '10000 x (183 days left / 365)');
  assert.equal(usd.recognizedCents, 10000 - 5014);
  assert.deepEqual([eur.prepaidCents, eur.deferredCents, eur.recognizedCents], [5000, 5000, 0]);
  assert.equal(rows.length, 2);
});

test('gross margin adds a percent only when revenue and cost are both known, and is unknown when ledger coverage is incomplete', async () => {
  const t = await seed();
  await t.org('g1'); await t.sub('sg1', 'g1'); await t.state('sg1', 1000);
  await t.org('g2'); await t.sub('sg2', 'g2'); // active but not in the revenue ledger
  await analytics.setFinanceUnitCosts(t.e, { casino_news_starter: 300 });
  let [row] = await analytics.grossMarginByTier(t.e);
  assert.equal(row.subscriptions, 2); assert.equal(row.revenueCents, null, 'a missing ledger row makes revenue unknown, not a list-price guess');
  assert.equal(row.grossMarginCents, null); assert.equal(row.grossMarginPercent, null);
  await t.state('sg2', 1000);
  [row] = await analytics.grossMarginByTier(t.e);
  assert.equal(row.revenueCents, 2000); assert.equal(row.totalCostCents, 600); assert.equal(row.grossMarginCents, 1400); assert.equal(row.grossMarginPercent, 70);
  await analytics.setFinanceUnitCosts(t.e, { casino_news_starter: 0 });
  [row] = await analytics.grossMarginByTier(t.e);
  assert.equal(row.unitCostCents, 0, 'an explicit zero cost is a real zero'); assert.equal(row.grossMarginPercent, 100);
});

test('a corrupt finance-cost setting reads as unknown, never zero', async () => {
  const t = await seed();
  await run(t.e, `INSERT INTO lummet_site_settings (key, value) VALUES ('finance_unit_costs_by_tier', '{not json')`);
  assert.deepEqual(await analytics.financeUnitCosts(t.e), {});
  await t.org('c1'); await t.sub('sc1', 'c1'); await t.state('sc1', 500);
  const [row] = await analytics.grossMarginByTier(t.e);
  assert.equal(row.unitCostCents, null); assert.equal(row.grossMarginCents, null);
});

test('analytics routes: customers and anonymous callers are refused, off mode hides the CSV, dashboard has no inline handlers and every script is nonced', async () => {
  const worker = (await import('../worker/index.js')).default;
  const e = env({ CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', REVENUE_ANALYTICS: 'shadow' });
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
  let ip = 120;
  const call = async (method, path, body, cookie) => {
    const headers = new Headers({ 'CF-Connecting-IP': `203.0.113.${ip++}` });
    if (cookie) headers.set('Cookie', cookie); if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
    return { response, text: await response.text(), cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  const signup = await call('POST', '/api/customer/signup', { email: 'cust-analytics@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Cust Org' });
  assert.ok(signup.cookie, signup.text);
  for (const [m, p, b] of [['GET', '/api/platform/saas/revenue-analytics/export.csv'], ['POST', '/api/platform/saas/revenue-analytics/finance-unit-costs', { costs: { a: 1 }, reason: 'customer attempt' }]]) {
    const r = await call(m, p, b, signup.cookie); assert.ok([401, 403].includes(r.response.status), `${p} ${r.response.status}`);
    assert.equal((await call(m, p, b)).response.status, 401);
  }
  const page = await call('GET', '/platform/saas/revenue-analytics', undefined, signup.cookie); assert.ok([301, 302, 303, 401, 403].includes(page.response.status), String(page.response.status));
  await call('POST', '/api/auth/bootstrap', { email: 'an-root@example.com', password: 'Correct-Horse-Battery-9' });
  const login = await call('POST', '/api/auth/login', { email: 'an-root@example.com', password: 'Correct-Horse-Battery-9' });
  const dash = await call('GET', '/platform/saas/revenue-analytics', undefined, login.cookie);
  assert.equal(dash.response.status, 200);
  assert.doesNotMatch(dash.text, /\son[a-z]+\s*=\s*["']/i, 'no inline event-handler attributes (CSP)');
  const scripts = [...dash.text.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scripts.length > 0); for (const [, attrs] of scripts) assert.match(attrs, /nonce="[^"]+"/, 'every inline script carries the CSP nonce');
  assert.match(dash.text, /never added across currencies/);
  e.REVENUE_ANALYTICS = 'off';
  const off = await call('GET', '/api/platform/saas/revenue-analytics/export.csv', undefined, login.cookie); assert.equal(off.response.status, 404);
  const offPage = await call('GET', '/platform/saas/revenue-analytics', undefined, login.cookie); assert.equal(offPage.response.status, 200); assert.match(offPage.text, /disabled/i);
});

test('CSV export carries a currency column and neutralizes hostile text', async () => {
  const worker = (await import('../worker/index.js')).default;
  const t = await seed(); const e = Object.assign(t.e, { CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', REVENUE_ANALYTICS: 'on' });
  await t.org('csv'); await t.sub('scsv', 'csv'); await t.mv('scsv', 'csv', 1, '2026-02-02', 'new', 700, 700, 'EUR'); await t.state('scsv', 700, 'EUR');
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } }; let ip = 160;
  const call = async (method, path, body, cookie) => {
    const headers = new Headers({ 'CF-Connecting-IP': `192.0.2.${ip++}` }); if (cookie) headers.set('Cookie', cookie); if (body !== undefined) headers.set('Content-Type', 'application/json');
    const r = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
    return { r, text: await r.text(), cookie: (r.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  await call('POST', '/api/auth/bootstrap', { email: 'csv-root@example.com', password: 'Correct-Horse-Battery-9' });
  const login = await call('POST', '/api/auth/login', { email: 'csv-root@example.com', password: 'Correct-Horse-Battery-9' });
  const csv = await call('GET', '/api/platform/saas/revenue-analytics/export.csv', undefined, login.cookie);
  assert.equal(csv.r.status, 200); assert.equal(csv.r.headers.get('cache-control'), 'no-store'); assert.match(csv.r.headers.get('content-disposition'), /attachment/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines[0], '"cohort_month","currency","logos","starting_mrr_cents","current_mrr_cents","nrr_percent","grr_percent","logo_churn_percent","churned_logos"');
  assert.equal(lines[1], '"2026-02","EUR","1","700","700","100","100","0","0"');
  const audit = await one(e, `SELECT reason FROM lummet_audit_logs WHERE action='export_csv'`);
  assert.equal(audit.reason, 'cohort rows exported: 1');
});

test('trial and activation lists are paginated 20 per page with both page positions kept in the links', async () => {
  const worker = (await import('../worker/index.js')).default;
  const t = await seed(); const e = Object.assign(t.e, { CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', REVENUE_ANALYTICS: 'shadow' });
  for (let i = 0; i < 25; i++) { const id = `p${String(i).padStart(2, '0')}`; await t.org(id, `2026-02-${String(i + 1).padStart(2, '0')} 00:00:00`); await t.sub('s' + id, id, 'trialing', `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`); }
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } }; let ip = 10;
  const call = async (method, path, body, cookie) => {
    const headers = new Headers({ 'CF-Connecting-IP': `198.18.0.${ip++}` }); if (cookie) headers.set('Cookie', cookie); if (body !== undefined) headers.set('Content-Type', 'application/json');
    const r = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
    return { r, text: await r.text(), cookie: (r.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  await call('POST', '/api/auth/bootstrap', { email: 'pg-root@example.com', password: 'Correct-Horse-Battery-9' });
  const login = await call('POST', '/api/auth/login', { email: 'pg-root@example.com', password: 'Correct-Horse-Battery-9' });
  const p1 = await call('GET', '/platform/saas/revenue-analytics', undefined, login.cookie);
  assert.match(p1.text, /trialPage=2&amp;activationPage=1|trialPage=2&activationPage=1/);
  const p2 = await call('GET', '/platform/saas/revenue-analytics?trialPage=2&activationPage=1', undefined, login.cookie);
  assert.equal(p2.r.status, 200); assert.match(p2.text, /Page 2/);
  assert.equal((p2.text.match(/Recent trial funnel records[\s\S]*?<\/table>/)[0].match(/<tr>/g) || []).length, 6, 'page 2 of 25 rows = header + 5 rows');
  const bad = await call('GET', '/platform/saas/revenue-analytics?trialPage=-5&activationPage=abc', undefined, login.cookie); assert.equal(bad.r.status, 200);
});

test('config-check validates REVENUE_ANALYTICS: unset and off|shadow|on are valid, anything else is flagged', async () => {
  const { configIssues } = await import('../worker/config-check.js');
  const flagged = (v) => configIssues({ ENVIRONMENT: 'production', ...(v === undefined ? {} : { REVENUE_ANALYTICS: v }) }).some((i) => i.key === 'REVENUE_ANALYTICS');
  assert.equal(flagged(undefined), false); assert.equal(flagged(''), false);
  for (const ok of ['off', 'shadow', 'on', ' SHADOW ']) assert.equal(flagged(ok), false, ok);
  for (const bad of ['enforce', 'banana', 'true']) assert.equal(flagged(bad), true, bad);
});
