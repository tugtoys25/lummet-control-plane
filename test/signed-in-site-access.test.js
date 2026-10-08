// A signed-in staff member must be able to browse the public website like anyone
// else; the dashboard has its own address (/dashboard).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin } from '../worker/auth.js';
import { createAssets } from './support/public-env.js';

describe('signed-in staff and the public site', () => {
  let env, sid;
  beforeEach(async () => {
    const db = createTestDb();
    applyMigrations(db);
    await seedFixtures(db);
    env = { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test' };
    const key = Object.keys(FIXTURE_PASSWORDS)[0];
    const r = await authenticateAdmin(env, `${key}@example.com`, FIXTURE_PASSWORDS[key], 'ip-1');
    assert.equal(r.ok, true);
    sid = r.sessionId;
  });
  const get = (path, signedIn = true) =>
    worker.fetch(
      new Request(`https://lummet.test${path}`, { redirect: 'manual', headers: signedIn ? { Cookie: `lummet_session=${sid}` } : {} }),
      env,
      { waitUntil() {} }
    );

  test('the homepage and public pages render for a signed-in admin, same as for a visitor', async () => {
    for (const path of ['/', '/brands', '/contact', '/demo', '/updates', '/insights', '/partners']) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      const html = await res.text();
      assert.match(html, /<html/, path);
      assert.doesNotMatch(html, /id="nav-toggle"/, `${path} must be the public page, not the dashboard`);
    }
  });

  test('"/" is identical for a visitor and a signed-in admin', async () => {
    assert.equal(await (await get('/', false)).text(), await (await get('/')).text());
  });

  test('the dashboard lives at /dashboard and still needs a session', async () => {
    const anon = await get('/dashboard', false);
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/login');
    const res = await get('/dashboard');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="nav-toggle"/);
  });

  test('visiting /login while signed in goes to the dashboard, and the shell links back to the site', async () => {
    const res = await get('/login');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/dashboard');
    const html = await (await get('/dashboard')).text();
    assert.match(html, /class="[^"]*view-site"[^>]*href="\/"|href="\/"[^>]*class="[^"]*view-site/);
  });
});
