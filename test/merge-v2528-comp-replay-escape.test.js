// v2.5.2.8: coverage the v2.5.2.7 merge left open (see OPEN_ITEMS_v2.5.2.7.md): four-eyes dunning comp,
// staff failed-webhook replay, and escaping on the staff operations pages. Real in-memory SQLite, all migrations applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as commercial from '../worker/commercial.js';
import * as customerAuth from '../worker/customer-auth.js';

function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), STRIPE_SECRET_KEY: 'sk_test_x', ...extra }; }
const one = (env, sql, ...b) => env.LUMMET_DB.prepare(sql).bind(...b).first();
const run = (env, sql, ...b) => env.LUMMET_DB.prepare(sql).bind(...b).run();
let n = 0;
async function signup(env) {
  const r = await customerAuth.signUp({ async json() { return { email: `m528${n++}@example.com`, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, env);
  return r.organizationId;
}
async function dunningSub(env, orgId, { invoices = 1 } = {}) {
  const sub = crypto.randomUUID();
  await run(env, `INSERT INTO subscriptions (id, organization_id, plan_id, status, grace_ends_at) VALUES (?,?,?,?,?)`, sub, orgId, 'plan_casino_news_starter', 'past_due', null);
  const ids = [];
  for (let i = 0; i < invoices; i++) {
    const id = crypto.randomUUID(); ids.push(id);
    await run(env, `INSERT INTO invoices (id, organization_id, subscription_id, provider, provider_invoice_id, status, amount_due_cents, currency) VALUES (?,?,?,?,?,?,?,?)`, id, orgId, sub, 'stripe', `in_test_${n++}`, 'open', 4900, 'usd');
  }
  return { sub, ids };
}
async function withFetch(fn) {
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), method: init?.method, headers: init?.headers }); return new Response(JSON.stringify({ id: 'in_x', status: 'void' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { return { result: await fn(), calls }; } finally { globalThis.fetch = orig; }
}

test('dunning comp: needs a reason, a dunning subscription and one identifiable open invoice', async () => {
  const env = makeEnv(); const org = await signup(env);
  assert.equal((await commercial.requestCompApproval(env, 'nope', { reason: '', staffId: 'a' })).error, 'reason_required');
  assert.equal((await commercial.requestCompApproval(env, 'nope', { reason: 'x', staffId: 'a' })).error, 'subscription_not_found');
  const active = crypto.randomUUID();
  await run(env, `INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES (?,?,?,?)`, active, org, 'plan_casino_news_starter', 'active');
  assert.equal((await commercial.requestCompApproval(env, active, { reason: 'x', staffId: 'a' })).error, 'subscription_not_in_dunning');
  const { sub } = await dunningSub(env, org, { invoices: 2 });
  assert.equal((await commercial.requestCompApproval(env, sub, { reason: 'x', staffId: 'a' })).error, 'invoice_id_required');
});

test('dunning comp: always needs a second staff member, voids exactly once, and never repeats', async () => {
  const env = makeEnv({ FOUR_EYES_THRESHOLD_CENTS: '999999' }); // threshold must NOT waive the second approver for a comp
  const org = await signup(env); const { sub, ids } = await dunningSub(env, org);
  const req = await commercial.requestCompApproval(env, sub, { reason: 'goodwill after outage', staffId: 'a' });
  assert.equal(req.ok, true); assert.equal(req.needsSecondApprover, true);
  assert.equal((await commercial.requestCompApproval(env, sub, { reason: 'again', staffId: 'a' })).error, 'comp_already_requested');
  const { result: self, calls: c0 } = await withFetch(() => commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'a', reason: 'me' }));
  assert.equal(self.error, 'self_approval_forbidden'); assert.equal(c0.length, 0, 'self approval must not reach Stripe');
  const { result: [x, y], calls } = await withFetch(() => Promise.all([
    commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: 'ok' }),
    commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'c', reason: 'ok' })
  ]));
  assert.equal([x, y].filter((r) => r.ok).length, 1, 'exactly one approver wins');
  assert.equal(calls.filter((c) => /\/invoices\/.+\/void$/.test(c.url)).length, 1, 'exactly one Stripe void');
  assert.equal((await one(env, `SELECT status FROM staff_approval_requests WHERE id=?`, req.requestId)).status, 'executed');
  assert.ok(ids.length === 1);
});

test('dunning comp: a Stripe failure marks the request failed and leaves no comp claim behind', async () => {
  const env = makeEnv(); const org = await signup(env); const { sub } = await dunningSub(env, org);
  const req = await commercial.requestCompApproval(env, sub, { reason: 'goodwill', staffId: 'a' });
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response('{"error":{"message":"sk_test_SECRET boom"}}', { status: 500 });
  let r; try { r = await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: 'ok' }); } finally { globalThis.fetch = orig; }
  assert.equal(r.ok, false);
  const row = await one(env, `SELECT status, failure_code FROM staff_approval_requests WHERE id=?`, req.requestId);
  assert.equal(row.status, 'failed');
  assert.ok(!JSON.stringify(row).includes('sk_test_SECRET'), 'no secret in stored error');
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM dunning_actions WHERE action='comp' AND subscription_id=?`, sub)).c, 0);
});

function replayService(event) {
  const provider = createFakeBillingProvider(); provider.retrieveEvent = async () => event;
  return createBillingService(provider);
}
async function seedEvent(env, id, status, type = 'plan.created') {
  await run(env, `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, status) VALUES (?,?,?,?)`, 'fake', id, type, status);
}

test('webhook replay: needs a reason, refuses unknown and processed events, and logs each refusal', async () => {
  const env = makeEnv(); const id = 'evt_test_000001';
  const svc = replayService({ id, type: 'plan.created', livemode: false, data: { object: {} } });
  assert.equal((await svc.replayWebhookEvent(env, id, { reason: '', staffId: 's1' })).error, 'reason_required');
  assert.equal((await svc.replayWebhookEvent(env, id, { reason: 'retry', staffId: 's1' })).error, 'event_not_found');
  await seedEvent(env, id, 'processed');
  assert.equal((await svc.replayWebhookEvent(env, id, { reason: 'retry', staffId: 's1' })).error, 'event_already_processed');
  const logs = await env.LUMMET_DB.prepare(`SELECT outcome FROM billing_webhook_replays ORDER BY rowid`).all();
  assert.deepEqual(logs.results.map((l) => l.outcome), ['not_found', 'not_claimable']);
});

test('webhook replay: a failed event replays once; concurrent replays cannot both run; list shows only failed/stuck', async () => {
  const env = makeEnv(); const id = 'evt_test_000002';
  await seedEvent(env, id, 'failed'); await seedEvent(env, 'evt_test_000003', 'processed');
  const svc = replayService({ id, type: 'plan.created', livemode: false, data: { object: {} } });
  assert.deepEqual((await svc.listFailedWebhookEvents(env, {})).map((e) => e.provider_event_id), [id]);
  const [a, b] = await Promise.all([svc.replayWebhookEvent(env, id, { reason: 'fixed bug', staffId: 's1' }), svc.replayWebhookEvent(env, id, { reason: 'fixed bug', staffId: 's2' })]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one replay runs');
  assert.equal((await one(env, `SELECT status FROM billing_webhook_events WHERE provider_event_id=?`, id)).status, 'processed');
  assert.equal((await svc.listFailedWebhookEvents(env, {})).length, 0);
});

test('webhook replay: a provider event with a different id is refused', async () => {
  const env = makeEnv(); const id = 'evt_test_000004'; await seedEvent(env, id, 'failed');
  const svc = replayService({ id: 'evt_other_999999', type: 'plan.created', livemode: false, data: { object: {} } });
  assert.equal((await svc.replayWebhookEvent(env, id, { reason: 'retry', staffId: 's1' })).error, 'provider_event_mismatch');
});

test('staff operations pages never write unescaped JSON into innerHTML', () => {
  const src = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  const raw = src.match(/innerHTML='<pre>'\+JSON\.stringify\([^)]*\)\+'<\/pre>'/g) || [];
  assert.equal(raw.length, 0, 'every staff page must escape JSON before innerHTML');
  assert.ok((src.match(/__esc\(JSON\.stringify/g) || []).length >= 4);
});
