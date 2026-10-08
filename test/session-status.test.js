// Signed-in staff see "Dashboard" in place of "Sign in" in the public header.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin } from '../worker/auth.js';
import { createAssets } from './support/public-env.js';

describe('header link for signed-in staff', () => {
  let env, sid, prepared;
  beforeEach(async () => {
    const db = createTestDb();
    applyMigrations(db);
    await seedFixtures(db);
    prepared = 0;
    const real = db.prepare.bind(db);
    db.prepare = (...a) => { prepared += 1; return real(...a); };
    env = { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test' };
    const key = Object.keys(FIXTURE_PASSWORDS)[0];
    const r = await authenticateAdmin(env, `${key}@example.com`, FIXTURE_PASSWORDS[key], 'ip-1');
    sid = r.sessionId;
  });
  const get = (path, cookie) =>
    worker.fetch(new Request(`https://lummet.test${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }), env, { waitUntil() {} });

  test('/session-status says false for visitors, without touching the database', async () => {
    prepared = 0;
    const res = await get('/session-status');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { signedIn: false });
    assert.equal(prepared, 0);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('cache-control'), /private/);
  });

  test('/session-status says true for a valid session, false for a bad or expired one', async () => {
    assert.deepEqual(await (await get('/session-status', `lummet_session=${sid}`)).json(), { signedIn: true });
    assert.deepEqual(await (await get('/session-status', 'lummet_session=nope')).json(), { signedIn: false });
    await env.LUMMET_DB.prepare(`UPDATE lummet_sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    assert.deepEqual(await (await get('/session-status', `lummet_session=${sid}`)).json(), { signedIn: false });
  });

  test('/session-status exposes nothing but the flag', async () => {
    const body = await (await get('/session-status', `lummet_session=${sid}`)).json();
    assert.deepEqual(Object.keys(body), ['signedIn']);
  });

  test('the cached page is the same for everyone and carries the label from the database', async () => {
    const anon = await (await get('/')).text();
    const staff = await (await get('/', `lummet_session=${sid}`)).text();
    assert.equal(anon, staff);
    assert.match(anon, /data-signed-in-label="Dashboard"/);
    assert.match(anon, /data-signed-in-href="\/dashboard"/);
    assert.match(anon, /\/static\/js\/session\.js/);
    assert.match(anon, />Sign in</);
  });

  test('editing the label in the database changes the page', async () => {
    await env.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = 'Console' WHERE ui_key = 'signed_in_label'`).run();
    assert.match(await (await get('/brands')).text(), /data-signed-in-label="Console"/);
  });

  test('the script swaps every sign-in link and has no strings of its own', () => {
    const src = readFileSync(new URL('../public/static/js/session.js', import.meta.url), 'utf8');
    assert.match(src, /\/session-status/);
    assert.match(src, /textContent/);
    assert.doesNotMatch(src, /innerHTML|eval\(|Dashboard|Sign in/);
  });

  test('migration 0009 is safe to run twice and keeps an edited label', async () => {
    const sql = readFileSync(new URL('../migrations/0036_signed_in_header.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(sql, /DELETE|DROP|UPDATE/i);
    const db = env.LUMMET_DB;
    await db.prepare(`UPDATE lummet_ui_strings SET value = 'Console' WHERE ui_key = 'signed_in_label'`).run();
    const stmt = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;$/, '');
    await db.prepare(stmt).run();
    await db.prepare(stmt).run();
    const rows = (await db.prepare(`SELECT ui_key, value FROM lummet_ui_strings WHERE ui_key LIKE 'signed_in_%' ORDER BY ui_key`).all()).results;
    assert.deepEqual(rows.map((r) => [r.ui_key, r.value]), [['signed_in_href', '/dashboard'], ['signed_in_label', 'Console']]);
  });
});

describe('migration 0010 (flattened select options)', () => {
  const sqlFile = new URL('../migrations/0037_repair_select_options.sql', import.meta.url);
  const run = async (db) => {
    const sql = readFileSync(sqlFile, 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  };
  const opts = async (db, form, field) => (await db.prepare(`SELECT options FROM lummet_form_fields WHERE form_key=? AND field_key=?`).bind(form, field).first()).options;

  test('restores one option per line, is safe to run twice, and leaves edited lists alone', async () => {
    const db = createTestDb();
    applyMigrations(db);
    await db.prepare(`UPDATE lummet_form_fields SET options = 'Platform question Partnership opportunity Technology licensing Other' WHERE form_key='contact' AND field_key='topic'`).run();
    await db.prepare(`UPDATE lummet_form_fields SET options = '1 2 to 5 6 to 10 More than 10' WHERE form_key='demo' AND field_key='properties'`).run();
    await run(db);
    await run(db);
    assert.deepEqual((await opts(db, 'contact', 'topic')).split('\n'), ['Platform question', 'Partnership opportunity', 'Technology licensing', 'Other']);
    assert.deepEqual((await opts(db, 'demo', 'properties')).split('\n'), ['1', '2 to 5', '6 to 10', 'More than 10']);
    await db.prepare(`UPDATE lummet_form_fields SET options = 'A' || char(10) || 'B' WHERE form_key='contact' AND field_key='topic'`).run();
    await run(db);
    assert.equal(await opts(db, 'contact', 'topic'), 'A\nB');
  });

  test('the seeded lists are already correct and stay unchanged', async () => {
    const db = createTestDb();
    applyMigrations(db);
    const before = await opts(db, 'contact', 'topic');
    await run(db);
    assert.equal(await opts(db, 'contact', 'topic'), before);
    assert.equal(before.split('\n').length, 4);
  });
});
