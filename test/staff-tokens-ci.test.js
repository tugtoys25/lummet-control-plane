// Staff API tokens and the CI release API (v1.2): publish a release and run a rollout with no browser session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService, __setInfraProviderForTests } from '../worker/deployments.js';
import { hashPassword } from '../worker/auth.js';
import * as staffTokens from '../worker/staff-tokens.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { assetHash } from '../worker/asset-hash.js';

function fakeR2() {
  const m = new Map();
  return { async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return String(m.get(k)); }, async arrayBuffer() { const v = m.get(k); return v instanceof Uint8Array ? v.buffer : new TextEncoder().encode(String(v)).buffer; } } : null; } };
}
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
function makeCtx() {
  const pending = [];
  return { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); }, async settle() { await Promise.all(pending.splice(0)); } };
}
let ip = 1;
async function call(env, ctx, method, path, { body, cookie, bearer, raw, sameIp } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': sameIp || `198.51.100.${ip++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(env, ctx) {
  assert.equal((await call(env, ctx, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  return (await call(env, ctx, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.20' } });
let n = 0;
async function newSite(env, infra) {
  const s = await customerAuth.signUp(signup(`ci${++n}@example.com`), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.organizationId, name: 'Site ' + n, productId: 'prod_casino_news', actorUserId: s.userId });
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
  const start = await prov.startProvisioning(env, site.siteId);
  assert.equal((await prov.runJob(env, start.jobId)).ok, true);
  return site.siteId;
}
const mk = async (env, scopes = ['release:publish', 'rollout:run'], extra = {}) => {
  const r = await staffTokens.createStaffToken(env, { name: 'CI', scopes, createdBy: '1', ...extra });
  assert.equal(r.ok, true, JSON.stringify(r)); return r;
};
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

test('a token is shown once, only its hash is stored, and it verifies until revoked or expired', async () => {
  const env = makeEnv();
  const t = await mk(env);
  assert.match(t.token, /^lmst_[0-9a-f]{8}_[0-9a-f]{48}$/);
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM staff_api_tokens WHERE id = ?`).bind(t.tokenId).first();
  assert.equal(row.token_hash, await sha(t.token));
  assert.ok(!JSON.stringify(row).includes(t.token), 'the plaintext token is not stored anywhere in the row');
  const listed = JSON.stringify(await staffTokens.listStaffTokens(env));
  assert.ok(!listed.includes(t.token) && !listed.includes(row.token_hash), 'listing never exposes the token or its hash');

  const ok = await staffTokens.verifyStaffToken(env, t.token);
  assert.deepEqual(ok.scopes, ['release:publish', 'rollout:run']);
  assert.equal(await staffTokens.verifyStaffToken(env, t.token + 'x'), null);
  assert.equal(await staffTokens.verifyStaffToken(env, 'lmk_customer_key'), null, 'a customer API key is not a staff token');
  assert.equal(await staffTokens.verifyStaffToken(env, ''), null);
  assert.equal(await staffTokens.verifyStaffToken(env, undefined), null);

  await env.LUMMET_DB.prepare(`UPDATE staff_api_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`).bind(t.tokenId).run();
  assert.equal(await staffTokens.verifyStaffToken(env, t.token), null, 'expired');
  const t2 = await mk(env);
  assert.equal((await staffTokens.revokeStaffToken(env, t2.tokenId)).ok, true);
  assert.equal(await staffTokens.verifyStaffToken(env, t2.token), null, 'revoked takes effect at once');
  assert.equal((await staffTokens.revokeStaffToken(env, t2.tokenId)).status, 409);
  assert.equal((await staffTokens.revokeStaffToken(env, 'nope')).status, 404);
});

test('token creation validates name, scopes and expiry', async () => {
  const env = makeEnv();
  const c = (o) => staffTokens.createStaffToken(env, { createdBy: '1', ...o });
  assert.equal((await c({ name: '', scopes: ['release:publish'] })).error, 'name_required');
  assert.equal((await c({ name: 'x'.repeat(81), scopes: ['release:publish'] })).error, 'name_too_long');
  assert.equal((await c({ name: 'a', scopes: [] })).error, 'invalid_scopes');
  assert.equal((await c({ name: 'a', scopes: ['admin:everything'] })).error, 'invalid_scopes');
  assert.equal((await c({ name: 'a', scopes: ['release:publish'], expiresInDays: 0 })).error, 'invalid_expiry');
  assert.equal((await c({ name: 'a', scopes: ['release:publish'], expiresInDays: 731 })).error, 'invalid_expiry');
  const d = await c({ name: 'a', scopes: ['release:publish'] });
  const days = (Date.parse(d.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 364 && days < 366, 'defaults to a year');
});

test('the CI API refuses missing, wrong, revoked and expired tokens, and rate-limits guessing', async () => {
  const env = makeEnv(); const ctx = makeCtx();
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases')).status, 401);
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: 'lmst_deadbeef_' + '0'.repeat(48) })).status, 401);
  const t = await mk(env);
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: t.token })).status, 200);
  await staffTokens.revokeStaffToken(env, t.tokenId);
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: t.token })).status, 401);

  const same = '203.0.113.99';
  let last;
  for (let i = 0; i < 25; i++) last = await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: 'lmst_aaaaaaaa_' + String(i).padStart(48, '0'), sameIp: same });
  assert.equal(last.status, 429, 'repeated bad tokens from one address are throttled');
});

test('scopes are enforced per route, and a staff token reaches nothing else', async () => {
  const env = makeEnv(); const ctx = makeCtx();
  const pub = await mk(env, ['release:publish']); const run = await mk(env, ['rollout:run']);
  assert.equal((await call(env, ctx, 'POST', '/api/ci/tenant-release/rollouts', { bearer: pub.token, body: {} })).status, 403);
  assert.equal((await call(env, ctx, 'POST', '/api/ci/tenant-release/publish', { bearer: run.token, body: { version: '1' } })).status, 403);
  assert.equal((await call(env, ctx, 'PUT', '/api/ci/tenant-release/assets?path=/static/a.css', { bearer: run.token, raw: 'x' })).status, 403);
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/rollouts/abc', { bearer: pub.token })).status, 403);
  // Not a bridge to any staff API: those need a session.
  for (const [m, p] of [['GET', '/api/platform/saas/tenant-template'], ['POST', '/api/platform/saas/staff-tokens'], ['GET', '/api/platform/saas/rollouts'], ['POST', '/api/platform/saas/tenant-template/publish'], ['GET', '/platform/saas/releases']]) {
    const r = await call(env, ctx, m, p, { bearer: pub.token, body: m === 'POST' ? {} : undefined });
    assert.ok([401, 302].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
});

test('CI publishes a release (assets, then manifest), audited as the token; a duplicate version or a missing asset is refused', async () => {
  const env = makeEnv(); const ctx = makeCtx();
  const t = await mk(env);
  const css = new TextEncoder().encode('body{color:red}');
  const hash = await assetHash(css, '/static/app.css');
  const up = await call(env, ctx, 'PUT', '/api/ci/tenant-release/assets?path=' + encodeURIComponent('/static/app.css'), { bearer: t.token, raw: css });
  assert.equal(up.status, 200, up.text); assert.equal(up.json.hash, hash);

  const missing = await call(env, ctx, 'POST', '/api/ci/tenant-release/publish', { bearer: t.token, body: { version: '1.0.0', scriptContent: 'export default {}', migrations: [], assets: { '/static/other.css': { hash: 'f'.repeat(32), size: 1 } } } });
  assert.equal(missing.status, 422); assert.equal(missing.json.error, 'asset_files_missing'); assert.equal(missing.json.missingCount, 1);

  const body = { version: '1.0.0', scriptContent: 'export default {}', migrations: [], assets: { '/static/app.css': { hash, size: css.length } }, notes: 'from CI' };
  const pub = await call(env, ctx, 'POST', '/api/ci/tenant-release/publish', { bearer: t.token, body });
  assert.equal(pub.status, 200, pub.text); assert.equal(pub.json.success, true); assert.equal(pub.json.assetCount, 1);
  const dup = await call(env, ctx, 'POST', '/api/ci/tenant-release/publish', { bearer: t.token, body });
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'version_already_exists');

  const rel = await env.LUMMET_DB.prepare(`SELECT created_by, status FROM tenant_template_releases WHERE version = '1.0.0'`).first();
  assert.equal(rel.status, 'active'); assert.equal(rel.created_by, `token:${t.prefix}`);
  const audit = (await env.LUMMET_DB.prepare(`SELECT actor_type, initiated_by, admin_id, action, success FROM lummet_audit_logs WHERE resource = 'tenant_template_release' ORDER BY rowid`).all()).results;
  assert.deepEqual(audit.map((a) => `${a.action}:${a.success}`), ['publish:0', 'publish:1', 'publish:0']);
  assert.ok(audit.every((a) => a.actor_type === 'staff_token' && a.initiated_by === `token:${t.prefix}` && a.admin_id === null));
  assert.equal((await call(env, ctx, 'PUT', '/api/ci/tenant-release/assets?path=' + encodeURIComponent('/../etc/passwd'), { bearer: t.token, raw: 'x' })).status, 422);
});

test('CI starts a rollout and drives it to the end; one rollout at a time; the sites really are updated', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] });
  const ids = [await newSite(env, infra), await newSite(env, infra)];
  const tok = await mk(env);
  const pub = await call(env, ctx, 'POST', '/api/ci/tenant-release/publish', { bearer: tok.token, body: { version: '2.0.0', scriptContent: 'export default {/*2.0.0*/}', migrations: [] } });
  assert.equal(pub.status, 200, pub.text);
  assert.equal((await sites.getSite(env, ids[0])).app_version, '1.0.0', 'publishing alone changes no site');

  const start = await call(env, ctx, 'POST', '/api/ci/tenant-release/rollouts', { bearer: tok.token, body: { notes: 'go' } });
  assert.equal(start.status, 202, start.text);
  assert.equal(start.json.version, '2.0.0'); assert.equal(start.json.total, 2);
  const second = await call(env, ctx, 'POST', '/api/ci/tenant-release/rollouts', { bearer: tok.token, body: {} });
  assert.equal(second.status, 409); assert.equal(second.json.error, 'rollout_in_progress'); assert.equal(second.json.rolloutId, start.json.rolloutId);

  let r = start.json;
  for (let i = 0; i < 10 && !r.done; i++) {
    const a = await call(env, ctx, 'POST', `/api/ci/tenant-release/rollouts/${start.json.rolloutId}/advance`, { bearer: tok.token });
    assert.equal(a.status, 200, a.text); r = a.json;
  }
  assert.equal(r.status, 'completed');
  for (const id of ids) assert.equal((await sites.getSite(env, id)).app_version, '2.0.0');
  const got = await call(env, ctx, 'GET', `/api/ci/tenant-release/rollouts/${start.json.rolloutId}`, { bearer: tok.token });
  assert.equal(got.json.status, 'completed'); assert.equal(got.json.items.length, 2);
  const row = await env.LUMMET_DB.prepare(`SELECT started_by, notes FROM tenant_rollouts WHERE id = ?`).bind(start.json.rolloutId).first();
  assert.equal(row.started_by, `token:${tok.prefix}`); assert.equal(row.notes, 'go');
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/rollouts/nope', { bearer: tok.token })).status, 404);
  assert.equal((await call(env, ctx, 'POST', '/api/ci/tenant-release/rollouts', { bearer: tok.token, body: {} })).json.nothingToDo, true);
});

test('the staff console creates and revokes tokens (super admin only, token shown once) and runs rollouts with a session', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  const cookie = await staffLogin(env, ctx);

  const created = await call(env, ctx, 'POST', '/api/platform/saas/staff-tokens', { cookie, body: { name: 'GH <b>actions</b>', scopes: ['release:publish', 'rollout:run'], expiresInDays: 30 } });
  assert.equal(created.status, 200, created.text);
  assert.match(created.json.token, /^lmst_/);
  const page = await call(env, ctx, 'GET', '/platform/saas/releases', { cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(created.json.prefix), 'the prefix is shown');
  assert.ok(!page.text.includes(created.json.token), 'the token itself never appears again');
  assert.ok(!page.text.includes('GH <b>actions</b>'), 'the name is escaped');
  assert.ok(page.text.includes('actCreateStaffToken'));
  assert.equal((await call(env, ctx, 'POST', '/api/platform/saas/staff-tokens', { cookie, body: { name: 'x', scopes: ['nope'] } })).status, 422);

  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: created.json.token })).status, 200);
  const id = (await staffTokens.listStaffTokens(env))[0].id;
  assert.equal((await call(env, ctx, 'POST', `/api/platform/saas/staff-tokens/${id}/revoke`, { cookie, body: {} })).status, 200);
  assert.equal((await call(env, ctx, 'GET', '/api/ci/tenant-release/releases', { bearer: created.json.token })).status, 401);
  const audit = (await env.LUMMET_DB.prepare(`SELECT action FROM lummet_audit_logs WHERE resource = 'staff_api_token' ORDER BY rowid`).all()).results.map((a) => a.action);
  assert.deepEqual(audit, ['create', 'create', 'revoke']);

  // a non-super-admin staff member cannot manage tokens or rollouts
  const staffHash = await hashPassword('Staff-Passw0rd-123!');
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (email, password_hash, role, status) VALUES ('plain@example.com', ?, 'staff', 'active')`).bind(staffHash).run();
  const plain = (await call(env, ctx, 'POST', '/api/auth/login', { body: { email: 'plain@example.com', password: 'Staff-Passw0rd-123!' } })).cookie;
  assert.equal((await call(env, ctx, 'POST', '/api/platform/saas/staff-tokens', { cookie: plain, body: { name: 'x', scopes: ['release:publish'] } })).status, 403);
  assert.equal((await call(env, ctx, 'POST', '/api/platform/saas/rollouts', { cookie: plain, body: {} })).status, 403);
});

test('rollouts from the staff console: start, advance, fail, resume, cancel; the page shows progress and the right buttons', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] });
  const ids = [await newSite(env, infra), await newSite(env, infra), await newSite(env, infra)];
  const cookie = await staffLogin(env, ctx);

  assert.equal((await call(env, ctx, 'POST', '/api/platform/saas/rollouts', { cookie, body: {} })).json.nothingToDo, true, 'everyone is current');
  await template.publishRelease(env, { version: '2.0.0', scriptContent: 'export default {/*2.0.0*/}', migrations: [] });

  let page = await call(env, ctx, 'GET', '/platform/saas/deployments', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Roll out 2\.0\.0 to 3 sites/);

  const start = await call(env, ctx, 'POST', '/api/platform/saas/rollouts', { cookie, body: {} });
  assert.equal(start.status, 200, start.text); assert.equal(start.json.total, 3);
  page = await call(env, ctx, 'GET', '/platform/saas/deployments', { cookie });
  assert.match(page.text, /id="rollout-drive"/); assert.match(page.text, /Cancel rollout/); assert.doesNotMatch(page.text, /Roll out 2\.0\.0 to/);

  const adv = (id) => call(env, ctx, 'POST', `/api/platform/saas/rollouts/${id}/advance`, { cookie, body: {} });
  await adv(start.json.rolloutId);
  infra._failNextCall('uploadWorkerScript', 'edge exploded');
  await adv(start.json.rolloutId);
  const failed = await adv(start.json.rolloutId);
  assert.equal(failed.json.status, 'failed'); assert.match(failed.json.error, /edge exploded/);
  page = await call(env, ctx, 'GET', '/platform/saas/deployments', { cookie });
  assert.match(page.text, /edge exploded/); assert.match(page.text, />Resume</); assert.doesNotMatch(page.text, /id="rollout-drive"/);

  assert.equal((await call(env, ctx, 'POST', `/api/platform/saas/rollouts/${start.json.rolloutId}/resume`, { cookie, body: {} })).status, 200);
  let r; for (let i = 0; i < 10; i++) { r = (await adv(start.json.rolloutId)).json; if (r.done) break; }
  assert.equal(r.status, 'completed');
  for (const id of ids) assert.equal((await sites.getSite(env, id)).app_version, '2.0.0');
  assert.equal((await call(env, ctx, 'POST', `/api/platform/saas/rollouts/${start.json.rolloutId}/cancel`, { cookie, body: {} })).status, 409);
  assert.equal((await adv('nope')).status, 404);
  const list = await call(env, ctx, 'GET', '/api/platform/saas/rollouts', { cookie });
  assert.equal(list.json.data.outdated, 0);
  const audit = (await env.LUMMET_DB.prepare(`SELECT action FROM lummet_audit_logs WHERE resource = 'tenant_rollout' ORDER BY rowid`).all()).results.map((a) => a.action);
  assert.ok(audit.includes('start') && audit.includes('resume') && !audit.includes('advance'), 'decisions are audited, polling is not');
});

test('the maintenance tick advances a running rollout, so it finishes even with nobody watching', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv({ ALERT_CHECK_TOKEN: 'tick-token-123' }); const ctx = makeCtx();
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] });
  const ids = [await newSite(env, infra), await newSite(env, infra)];
  await template.publishRelease(env, { version: '2.0.0', scriptContent: 'export default {/*2.0.0*/}', migrations: [] });
  const cookie = await staffLogin(env, ctx);
  await call(env, ctx, 'POST', '/api/platform/saas/rollouts', { cookie, body: {} });
  for (let i = 0; i < 10; i++) {
    const tick = await call(env, ctx, 'POST', '/api/ops/alert-check', { bearer: 'tick-token-123' });
    assert.equal(tick.status, 200, tick.text); await ctx.settle();
  }
  for (const id of ids) assert.equal((await sites.getSite(env, id)).app_version, '2.0.0');
});

test('the failed-rollout alert fires for a failed latest rollout and clears when it is resumed or cancelled', async () => {
  const env = makeEnv(); const alertsRepo = await import('../worker/repositories/alert-state.js');
  const q = () => alertsRepo.countFor(env, 'failed_rollout');
  assert.equal(await q(), 0);
  await env.LUMMET_DB.prepare(`INSERT INTO tenant_rollouts (id, release_version, status) VALUES ('r1', '1', 'failed')`).run();
  assert.equal(await q(), 1);
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET status = 'cancelled' WHERE id = 'r1'`).run();
  assert.equal(await q(), 0);
});

// ---- the real publish script, run as a child process against the real Worker over HTTP ----
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withServer(env, ctx, fn) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.77' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
function runScript(argv, envVars) {
  return new Promise((resolve) => {
    const p = spawn('node', ['scripts/publish-tenant-release.mjs', ...argv], { env: { ...process.env, ...envVars } });
    let err = ''; p.stderr.on('data', (d) => { err += d; }); p.stdout.on('data', () => {});
    p.on('close', (code) => resolve({ code, err }));
  });
}
function fixture(version) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  mkdirSync(join(dir, 'en/static'), { recursive: true });
  writeFileSync(join(dir, 'en/static/app.css'), `body{/*${version}*/}`);
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ scriptContent: `export default {/*${version}*/}`, migrations: [] }));
  return dir;
}

test('script: publishes with a token, rolls out to every site and waits; exit code 0; re-running with --allow-existing is harmless', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] });
  const ids = [await newSite(env, infra), await newSite(env, infra)];
  const tok = await mk(env); const dir = fixture('2.0.0');
  await withServer(env, ctx, async (base) => {
    const common = ['--base', base, '--version', '2.0.0', '--assets-root', join(dir, 'en'), '--assets-dirs', 'static', '--release-file', join(dir, 'release.json')];
    const r = await runScript([...common, '--rollout', '--wait', '--notes', 'from ci'], { LUMMET_STAFF_TOKEN: tok.token });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Published 2\.0\.0/); assert.match(r.err, /Rollout completed/);
    for (const id of ids) assert.equal((await sites.getSite(env, id)).app_version, '2.0.0');
    const again = await runScript([...common, '--rollout', '--wait', '--allow-existing'], { LUMMET_STAFF_TOKEN: tok.token });
    assert.equal(again.code, 0, again.err); assert.match(again.err, /already published/); assert.match(again.err, /already on this release/);
    const strict = await runScript([...common], { LUMMET_STAFF_TOKEN: tok.token });
    assert.equal(strict.code, 1, 'without --allow-existing a duplicate version fails loudly');
    const none = await runScript([...common], { LUMMET_STAFF_TOKEN: 'lmst_bad' });
    assert.equal(none.code, 1); assert.match(none.err, /unauthorized/);
  });
});

test('script: publish only (no --rollout) changes no site; a failing site makes the script exit 1 and leaves the rest untouched', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] });
  const ids = [await newSite(env, infra), await newSite(env, infra), await newSite(env, infra)];
  const tok = await mk(env); const dir = fixture('3.0.0');
  await withServer(env, ctx, async (base) => {
    const common = ['--base', base, '--version', '3.0.0', '--assets-root', join(dir, 'en'), '--assets-dirs', 'static', '--release-file', join(dir, 'release.json')];
    const pubOnly = await runScript(common, { LUMMET_STAFF_TOKEN: tok.token });
    assert.equal(pubOnly.code, 0, pubOnly.err); assert.match(pubOnly.err, /No existing site was changed/); assert.match(pubOnly.err, /Not rolling out/);
    for (const id of ids) assert.equal((await sites.getSite(env, id)).app_version, '1.0.0');
    infra._failNextCall('uploadWorkerScript', 'boom'); // the first site's deployment fails
    const r = await runScript([...common, '--allow-existing', '--rollout', '--wait'], { LUMMET_STAFF_TOKEN: tok.token });
    assert.equal(r.code, 1, r.err); assert.match(r.err, /FAILED/); assert.match(r.err, /remaining sites were not touched/);
    const versions = await Promise.all(ids.map(async (id) => (await sites.getSite(env, id)).app_version));
    assert.deepEqual(versions, ['1.0.0', '1.0.0', '1.0.0'], 'the first site failed, so the rollout stopped before changing any');
  });
});
