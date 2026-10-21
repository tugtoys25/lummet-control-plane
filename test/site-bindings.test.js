// What the control plane attaches to a site's Worker on every deploy, including the optional Turnstile settings.
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

test('a site gets its database, cache, bucket, AI, URL, deployment id and Super API credential', async () => {
  const { env, site } = await setup();
  const b = await buildSiteBindings(env, { site, deploymentId: 7, host: 's.example.test', hasAssets: true });
  assert.equal(byName(b, 'DB').id, 'db-1'); assert.equal(byName(b, 'CACHE').namespace_id, 'kv-1'); assert.equal(byName(b, 'MEDIA_BUCKET').bucket_name, 'bucket-1');
  assert.equal(byName(b, 'SITE_URL').text, 'https://s.example.test'); assert.equal(byName(b, 'DEPLOYMENT_ID').text, '7');
  assert.equal(byName(b, 'SUPER_API_CREDENTIAL_ID').text, 'cred-1'); assert.equal(byName(b, 'SUPER_API_SECRET').text, 'hmac-secret-value'); assert.equal(byName(b, 'SUPER_API_SECRET').type, 'secret_text');
  assert.ok(byName(b, 'ASSETS'));
});

test('without TENANT_TURNSTILE_* no Turnstile binding is set, so the site relies on its attempt limiter', async () => {
  const { env, site } = await setup();
  const b = await buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false });
  assert.equal(byName(b, 'TURNSTILE_SITEKEY'), undefined); assert.equal(byName(b, 'TURNSTILE_SECRET'), undefined); assert.equal(byName(b, 'ASSETS'), undefined);
});

test('with both TENANT_TURNSTILE_* set they are passed on, the secret as a secret', async () => {
  const { env, site } = await setup({ TENANT_TURNSTILE_SITEKEY: '0x4AAAAAAA', TENANT_TURNSTILE_SECRET: '0x4BBBBBBB' });
  const b = await buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false });
  assert.deepEqual({ ...byName(b, 'TURNSTILE_SITEKEY') }, { type: 'plain_text', name: 'TURNSTILE_SITEKEY', text: '0x4AAAAAAA' });
  assert.deepEqual({ ...byName(b, 'TURNSTILE_SECRET') }, { type: 'secret_text', name: 'TURNSTILE_SECRET', text: '0x4BBBBBBB' });
});

test('only one of the two is not enough: a sitekey without a secret would show a widget nothing can verify', async () => {
  for (const extra of [{ TENANT_TURNSTILE_SITEKEY: 'k' }, { TENANT_TURNSTILE_SECRET: 's' }]) {
    const { env, site } = await setup(extra);
    const b = await buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false });
    assert.equal(byName(b, 'TURNSTILE_SITEKEY'), undefined); assert.equal(byName(b, 'TURNSTILE_SECRET'), undefined);
  }
});

test('a half-provisioned site is refused with a clear reason', async () => {
  const { env, site } = await setup();
  await env.LUMMET_DB.prepare(`DELETE FROM site_resources WHERE resource_type = 'kv'`).run();
  await assert.rejects(buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false }), /missing kv/);
});
