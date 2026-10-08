// test/inquiries-admin.test.js
// The dashboard side of the contact/demo forms, through worker.fetch:
// Inquiries (read-only submissions, no hand-creation), Forms, Form fields,
// Interface text, and the permission gates around them.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin } from '../worker/auth.js';
import { createAssets, post } from './support/public-env.js';

describe('dashboard: inquiries, forms, form fields, interface text', () => {
  let db, fx, env;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    env = { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test' };
  });

  async function session(key) {
    const r = await authenticateAdmin(env, `${key}@example.com`, FIXTURE_PASSWORDS[key], `ip-${key}`);
    assert.equal(r.ok, true);
    return r.sessionId;
  }
  const req = (method, path, sid, form) =>
    worker.fetch(
      new Request(`https://lummet.test${path}`, {
        method,
        redirect: 'manual',
        headers: { Cookie: `lummet_session=${sid}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined
      }),
      env,
      { waitUntil() {} }
    );
  const submit = () =>
    post(handlePublicRoute, { ...env, db }, '/contact', { f_name: 'Ada', f_email: 'ada@example.test', f_message: 'Please call me back about licensing.' });

  test('a submitted inquiry appears in the Inquiries list for a super admin; no "New" button', async () => {
    assert.equal((await submit()).status, 303);
    const res = await req('GET', '/cms/inquiries', await session('superAdmin'));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Ada/);
    assert.match(html, /ada@example\.test/);
    assert.match(html, /Please call me back/);
    assert.doesNotMatch(html, /\/cms\/inquiries\/new/);
  });

  test('inquiries cannot be created by hand: GET and POST /new are refused and nothing is inserted', async () => {
    const sid = await session('superAdmin');
    const g = await req('GET', '/cms/inquiries/new', sid);
    assert.equal(g.status, 302);
    assert.match(g.headers.get('location'), /^\/cms\/inquiries\?flash=/);
    const p = await req('POST', '/cms/inquiries/new', sid, { status: 'new', name: 'Forged', email: 'forged@x.test' });
    assert.equal(p.status, 302);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM lummet_inquiries').first();
    assert.equal(n.n, 0);
  });

  test('the edit screen shows the submission read-only; saving changes only status and notes', async () => {
    await submit();
    const sid = await session('superAdmin');
    const row = await db.prepare('SELECT id, name, email, details FROM lummet_inquiries').first();
    const page = await (await req('GET', `/cms/inquiries/${row.id}/edit`, sid)).text();
    assert.match(page, /readonly/);
    assert.match(page, /Please call me back/);

    const save = await req('POST', `/cms/inquiries/${row.id}/edit`, sid, {
      status: 'replied', admin_notes: 'Called back', name: 'FORGED', email: 'forged@x.test', details: 'FORGED'
    });
    assert.equal(save.status, 302, await save.clone().text());
    const after = await db.prepare('SELECT * FROM lummet_inquiries WHERE id = ?').bind(row.id).first();
    assert.equal(after.status, 'replied');
    assert.equal(after.admin_notes, 'Called back');
    assert.equal(after.name, row.name);
    assert.equal(after.email, row.email);
    assert.equal(after.details, row.details);
  });

  test('an inquiry can be deleted (privacy: removing a visitor\'s data)', async () => {
    await submit();
    const sid = await session('superAdmin');
    const row = await db.prepare('SELECT id FROM lummet_inquiries').first();
    const res = await req('POST', `/cms/inquiries/${row.id}/delete`, sid, {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lummet_inquiries').first()).n, 0);
  });

  test('staff without a grant get 403 on Inquiries (list, new, edit) and cannot read submissions', async () => {
    await submit();
    const sid = await session('staffA');
    const row = await db.prepare('SELECT id FROM lummet_inquiries').first();
    for (const [m, p] of [['GET', '/cms/inquiries'], ['GET', '/cms/inquiries/new'], ['GET', `/cms/inquiries/${row.id}/edit`]]) {
      const res = await req(m, p, sid);
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.doesNotMatch(await res.text(), /ada@example\.test/);
    }
  });

  test('staff with only a cms.inquiries read grant can list but not edit or delete', async () => {
    await submit();
    await db.prepare(`INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed) VALUES (?, 'cms', 'inquiries', 'read', 1)`).bind(fx.admins.staffA).run();
    const sid = await session('staffA');
    const row = await db.prepare('SELECT id FROM lummet_inquiries').first();
    assert.equal((await req('GET', '/cms/inquiries', sid)).status, 200);
    assert.equal((await req('POST', `/cms/inquiries/${row.id}/edit`, sid, { status: 'spam' })).status, 403);
    assert.equal((await req('POST', `/cms/inquiries/${row.id}/delete`, sid, {})).status, 403);
    assert.equal((await db.prepare('SELECT status FROM lummet_inquiries WHERE id = ?').bind(row.id).first()).status, 'new');
  });

  test('Forms, Form fields and Interface text screens render for a super admin', async () => {
    const sid = await session('superAdmin');
    for (const [p, needle] of [['/cms/forms', 'Request a demo'], ['/cms/form_fields', 'Work email'], ['/cms/ui_strings', 'view_profile']]) {
      const res = await req('GET', p, sid);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), new RegExp(needle), p);
    }
  });

  test('editing interface text from the dashboard changes the public site', async () => {
    const sid = await session('superAdmin');
    const row = await db.prepare(`SELECT id FROM lummet_ui_strings WHERE ui_key = 'view_profile'`).first();
    const save = await req('POST', `/cms/ui_strings/${row.id}/edit`, sid, { ui_key: 'view_profile', value: 'Open profile', group_key: 'cards' });
    assert.equal(save.status, 302, await save.clone().text());
    const page = await handlePublicRoute({
      request: new Request('https://lummet.test/brands'), env, ctx: { waitUntil() {} }
    });
    assert.match(await page.text(), /Open profile/);
  });

  test('creating a form field from the dashboard with blank numbers works (defaults apply) and shows on /contact', async () => {
    const sid = await session('superAdmin');
    const save = await req('POST', '/cms/form_fields/new', sid, {
      form_key: 'contact', field_key: 'phone', label: 'Phone number', type: 'tel', required: '', placeholder: '', help_text: '',
      options: '', max_length: '', status: 'published', sort_order: ''
    });
    assert.equal(save.status, 302, await save.clone().text());
    const page = await handlePublicRoute({
      request: new Request('https://lummet.test/contact'), env, ctx: { waitUntil() {} }
    });
    assert.match(await page.text(), /Phone number/);
  });
});
