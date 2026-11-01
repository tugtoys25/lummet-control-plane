// Payment gateways in the staff settings page: checkboxes, All on / All off, and the explicit "none".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as ps from '../worker/platform-settings.js';
import * as gateways from '../worker/billing-gateways.js';
import { renderPlatformSettingsPage } from '../worker/views/pages/saas-admin.js';

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's', ...extra }; }
const def = ps.SETTINGS.find((d) => d.key === 'PAYMENT_GATEWAYS');
const admin = { id: 'a1', email: 'root@example.com', role: 'super_admin' };

test('PAYMENT_GATEWAYS accepts any ticked list in offer order, and "none"; rejects mixing none with a gateway or an unknown name', () => {
  assert.equal(ps.validateValue(def, 'stripe,nowpayments').value, 'stripe,nowpayments');
  assert.equal(ps.validateValue(def, 'nowpayments').value, 'nowpayments');
  assert.deepEqual(ps.validateValue(def, 'none'), { ok: true, value: 'none' });
  assert.equal(ps.validateValue(def, 'NONE').value, 'none');
  assert.equal(ps.validateValue(def, 'none,stripe').ok, false);
  assert.equal(ps.validateValue(def, 'paypal').ok, false);
  assert.equal(ps.validateValue(def, '').ok, false);
});

test('other csv settings do not accept "none"', () => {
  const other = ps.SETTINGS.filter((d) => d.type === 'csvEnum' && d.key !== 'PAYMENT_GATEWAYS');
  for (const d of other) assert.equal(ps.validateValue(d, 'none').ok, false, d.key);
});

test('saving none from the console turns every gateway off; stripe,nowpayments turns both on; clearing hands control back to the database switch', async () => {
  const e = env();
  const a = await ps.setSetting(e, { key: 'PAYMENT_GATEWAYS', value: 'none', actorId: 'staff:t', reason: 'pause checkout' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const eff = await ps.withPlatformSettings(e, { fresh: true });
  assert.equal(eff.PAYMENT_GATEWAYS, 'none');
  assert.deepEqual((await gateways.availableGateways(eff)).map((g) => g.gateway), []);
  const r = await gateways.resolveGateway(eff);
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(r.error, 'no_payment_gateway_available');
  assert.equal((await ps.setSetting(e, { key: 'PAYMENT_GATEWAYS', value: 'stripe,nowpayments', actorId: 'staff:t', reason: 'both on' })).ok, true);
  const both = await ps.withPlatformSettings(e, { fresh: true });
  assert.deepEqual((await gateways.availableGateways(both)).map((g) => g.gateway), ['stripe', 'nowpayments']);
  assert.equal((await ps.clearSetting(e, { key: 'PAYMENT_GATEWAYS', actorId: 'staff:t', reason: 'back to the switch' })).ok, true);
  const back = await ps.withPlatformSettings(e, { fresh: true });
  assert.ok((await gateways.availableGateways(back)).some((g) => g.gateway === 'stripe'));
});

test('the existing per-gateway guard is unchanged: the database switch still refuses to disable the last gateway', async () => {
  const r = await gateways.setGatewayEnabled(env(), { gateway: 'stripe', enabled: false, actorId: 'staff:t', reason: 'test' });
  assert.equal(r.ok, false); assert.equal(r.error, 'cannot_disable_last_gateway');
});

test('page: PAYMENT_GATEWAYS shows a checkbox per gateway with All on / All off; other settings keep their normal control', async () => {
  const e = env();
  const res = await renderPlatformSettingsPage(e, admin);
  const html = typeof res === 'string' ? res : await res.text();
  assert.match(html, /data-opt="stripe"/);
  assert.match(html, /data-opt="nowpayments"/);
  assert.match(html, />All on</); assert.match(html, />All off</);
  assert.match(html, /data-onclick="gwAll"/);
  assert.match(html, /function gwAll/);
  assert.match(html, /<select name="value">/); // enum settings still use a dropdown
});

test('page: boxes reflect the value in force (none = all clear, both = both ticked, empty = the database switch)', async () => {
  const e = env();
  assert.equal((await ps.setSetting(e, { key: 'PAYMENT_GATEWAYS', value: 'none', actorId: 'staff:t', reason: 'pausing checkout' })).ok, true);
  let html = await (async () => { const r = await renderPlatformSettingsPage(e, admin); return typeof r === 'string' ? r : r.text(); })();
  assert.doesNotMatch(html, /data-opt="stripe" checked/); assert.doesNotMatch(html, /data-opt="nowpayments" checked/);
  assert.equal((await ps.setSetting(e, { key: 'PAYMENT_GATEWAYS', value: 'stripe,nowpayments', actorId: 'staff:t', reason: 'both gateways on' })).ok, true);
  html = await (async () => { const r = await renderPlatformSettingsPage(e, admin); return typeof r === 'string' ? r : r.text(); })();
  assert.match(html, /data-opt="stripe" checked/); assert.match(html, /data-opt="nowpayments" checked/);
  assert.equal((await ps.clearSetting(e, { key: 'PAYMENT_GATEWAYS', actorId: 'staff:t', reason: 'back to the switch' })).ok, true);
  html = await (async () => { const r = await renderPlatformSettingsPage(e, admin); return typeof r === 'string' ? r : r.text(); })();
  assert.match(html, /data-opt="stripe" checked/); // the database switch has Stripe on by default
});
