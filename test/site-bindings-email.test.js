// Sites send mail the way the control plane does: same Resend key and sender, with an optional site-only override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { buildSiteBindings } from '../worker/site-bindings.js';
import { encryptSecret } from '../worker/crypto.js';

async function setup(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url, status) VALUES ('t1', 'T', 't1.example.test', 'https://t1.example.test', 'active')`).run();
  const { encryptedSecret, secretIv } = await encryptSecret(env, 'hmac-secret-value');
  await db.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES ('t1', 'cred-1', ?, ?, 'active')`).bind(encryptedSecret, secretIv).run();
  await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1', 'a@example.com', 'x')`).run();
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o')`).run();
  const prod = await db.prepare(`SELECT id FROM products LIMIT 1`).first();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id) VALUES ('s1', 'o1', ?, 'S', 's', 'active', 't1')`).bind(prod.id).run();
  for (const [type, id] of [['d1', 'db-1'], ['kv', 'kv-1'], ['r2', 'bucket-1']]) {
    await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1', 'cloudflare', ?, ?, ?)`).bind(type, id, id).run();
  }
  return { env, site: { id: 's1', tenant_id: 't1' } };
}
const byName = (b, n) => b.find((x) => x.name === n);
const build = async (extra) => { const { env, site } = await setup(extra); return buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false }); };

test('a site gets the control plane\'s Resend key and sender (key as a secret)', async () => {
  const b = await build({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_platform', EMAIL_FROM: 'Lummet <no-reply@lummet.com>' });
  assert.deepEqual({ ...byName(b, 'RESEND_API_KEY') }, { type: 'secret_text', name: 'RESEND_API_KEY', text: 're_platform' });
  assert.deepEqual({ ...byName(b, 'RESEND_FROM_EMAIL') }, { type: 'plain_text', name: 'RESEND_FROM_EMAIL', text: 'Lummet <no-reply@lummet.com>' });
});

test('nothing is passed when the control plane has no complete email setup', async () => {
  for (const extra of [{}, { RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' }, { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.c' }, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' }]) {
    const b = await build(extra);
    assert.equal(byName(b, 'RESEND_API_KEY'), undefined, JSON.stringify(extra)); assert.equal(byName(b, 'RESEND_FROM_EMAIL'), undefined, JSON.stringify(extra));
  }
});

test('TENANT_RESEND_* give sites their own key and sender', async () => {
  const b = await build({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_platform', EMAIL_FROM: 'Platform <p@lummet.com>', TENANT_RESEND_API_KEY: 're_sites', TENANT_RESEND_FROM_EMAIL: 'Sites <s@lummet.com>' });
  assert.equal(byName(b, 'RESEND_API_KEY').text, 're_sites'); assert.equal(byName(b, 'RESEND_FROM_EMAIL').text, 'Sites <s@lummet.com>');
});
