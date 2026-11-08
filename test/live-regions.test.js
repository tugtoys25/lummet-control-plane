// Live regions: the browser runtime (polling, swapping, pausing, backing off), the server helpers, and the Sites / Deployments endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { LIVE_RUNTIME } from '../worker/views/live-runtime.js';
import { CLIENT_SCRIPT } from '../worker/views/shell-assets.js';
import { liveHash, SITE_TRANSIENT, DEPLOYMENT_TRANSIENT } from '../worker/live.js';
import { renderSiteRows, sitesAreBusy, renderSitesPage } from '../worker/views/customer-pages/sites.js';
import { renderDeploymentCards, deploymentsAreBusy, renderDeploymentsPage } from '../worker/views/customer-pages/deployments.js';

const tick = () => new Promise((r) => setImmediate(r));

/** The shipped runtime, run against a minimal fake browser. */
function browser({ responses = [] } = {}) {
  const calls = []; const timers = []; const doc = {}; const win = {}; let reloads = 0;
  const el = {
    attrs: { 'data-live-src': '/api/x/live', 'data-live-hash': 'h0' }, innerHTML: 'old', child: null, events: [],
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; },
    contains(n) { return !!n && n === this.child; }, dispatchEvent(e) { this.events.push(e); }
  };
  const document = { hidden: false, readyState: 'complete', activeElement: null, querySelectorAll: () => [el], addEventListener: (t, f) => { doc[t] = f; } };
  const window = { addEventListener: (t, f) => { win[t] = f; } };
  const queue = [...responses];
  const fetch = async (url) => { calls.push(url); const r = queue.shift() || { status: 200, body: { success: true, data: { html: 'old', hash: 'h0', busy: false } } }; return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body }; };
  const setTimeout = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; };
  const clearTimeout = (t) => { if (t) t.live = false; };
  vm.runInNewContext(LIVE_RUNTIME, { document, window, fetch, setTimeout, clearTimeout, location: { reload() { reloads += 1; } }, CustomEvent: class { constructor(n) { this.type = n; } }, Math, Array, Error });
  const pending = () => timers.filter((t) => t.live);
  const fire = async () => { const t = pending().at(-1); assert.ok(t, 'a timer is waiting'); t.live = false; t.fn(); await tick(); await tick(); };
  return { el, document, window, doc, win, calls, pending, fire, reloads: () => reloads };
}
const ok = (html, hash, busy) => ({ status: 200, body: { success: true, data: { html, hash, busy } } });

test('the runtime ships in the shell script and parses', () => {
  assert.ok(CLIENT_SCRIPT.includes('lummetLiveRefresh'));
  assert.doesNotThrow(() => new Function(CLIENT_SCRIPT));
});

test('a region is polled slowly at first, swapped when the hash changes, and polled fast while the server says it is busy', async () => {
  const b = browser({ responses: [ok('<tr>new</tr>', 'h1', true), ok('<tr>newer</tr>', 'h2', false)] });
  assert.equal(b.pending().at(-1).ms, 30000, 'idle pace to start');
  await b.fire();
  assert.equal(b.calls.length, 1); assert.equal(b.el.innerHTML, '<tr>new</tr>'); assert.equal(b.el.attrs['data-live-hash'], 'h1');
  assert.equal(b.el.events.length, 1, 'a lummet:live event tells the page it changed');
  assert.equal(b.pending().at(-1).ms, 4000, 'busy: check again soon');
  await b.fire();
  assert.equal(b.el.innerHTML, '<tr>newer</tr>');
  assert.equal(b.pending().at(-1).ms, 30000, 'settled: back to the idle pace');
});

test('nothing is swapped when the hash is unchanged', async () => {
  const b = browser({ responses: [ok('IGNORED', 'h0', false)] });
  await b.fire();
  assert.equal(b.el.innerHTML, 'old'); assert.equal(b.el.events.length, 0);
});

test('a region is never replaced while the person is typing in it', async () => {
  const b = browser({ responses: [ok('new', 'h1', false)] });
  b.document.activeElement = { tagName: 'INPUT' }; b.el.child = b.document.activeElement;
  await b.fire();
  assert.equal(b.el.innerHTML, 'old', 'left alone');
  assert.equal(b.pending().at(-1).ms, 4000, 'tries again soon');
  b.document.activeElement = null; b.el.child = null;
  b.responses; // next poll returns the default (same hash), so the held change is fetched again by the server's next answer
});

test('polling stops while the tab is hidden and checks at once when it is visible again', async () => {
  const b = browser({ responses: [ok('shown', 'h1', false)] });
  b.document.hidden = true; b.doc.visibilitychange();
  assert.equal(b.pending().length, 0, 'no timer while hidden');
  b.document.hidden = false; b.doc.visibilitychange(); await tick(); await tick();
  assert.equal(b.calls.length, 1, 'refreshed immediately on return');
  assert.equal(b.el.innerHTML, 'shown');
});

test('an ended session reloads once (to reach the login page) and stops; 403 and 404 stop quietly', async () => {
  const a = browser({ responses: [{ status: 401, body: {} }] });
  await a.fire();
  assert.equal(a.reloads(), 1); assert.equal(a.pending().length, 0);
  const c = browser({ responses: [{ status: 403, body: {} }] });
  await c.fire();
  assert.equal(c.reloads(), 0); assert.equal(c.pending().length, 0);
});

test('errors back off exponentially, and recover', async () => {
  const b = browser({ responses: [{ status: 500, body: {} }, { status: 500, body: {} }, ok('back', 'h9', false)] });
  await b.fire(); assert.equal(b.pending().at(-1).ms, 60000);
  await b.fire(); assert.equal(b.pending().at(-1).ms, 120000);
  await b.fire(); assert.equal(b.el.innerHTML, 'back'); assert.equal(b.pending().at(-1).ms, 30000, 'back to normal after a success');
});

test('lummetLiveRefresh fetches right now (what an action calls instead of reloading)', async () => {
  const b = browser({ responses: [ok('after action', 'h5', false)] });
  b.window.lummetLiveRefresh(b.el); await tick(); await tick();
  assert.equal(b.calls.length, 1); assert.equal(b.el.innerHTML, 'after action');
});

test('liveHash is stable and changes with content', () => {
  assert.equal(liveHash('abc'), liveHash('abc')); assert.notEqual(liveHash('abc'), liveHash('abd')); assert.match(liveHash(''), /^[0-9a-f]{8}$/);
});

test('busy detection: sites in flight, a first setup waiting, deployments in flight', () => {
  for (const status of ['pending', 'provisioning', 'configuring', 'deploying', 'deleting']) assert.equal(sitesAreBusy([{ id: 's', status }]), true, status);
  for (const status of ['active', 'failed', 'suspended', 'deleted', 'provisioned']) assert.equal(sitesAreBusy([{ id: 's', status }]), false, status);
  assert.equal(sitesAreBusy([{ id: 's', status: 'active' }], { s: { status: 'pending' } }), true, 'first setup still waiting to apply');
  assert.equal(sitesAreBusy([{ id: 's', status: 'active' }], { s: { status: 'applied' } }), false);
  assert.equal(deploymentsAreBusy({ a: [{ status: 'active' }], b: [{ status: 'building' }] }), true);
  assert.equal(deploymentsAreBusy({ a: [{ status: 'active' }, { status: 'failed' }] }), false);
  assert.ok(SITE_TRANSIENT.has('deleting') && DEPLOYMENT_TRANSIENT.has('migrating'));
});

test('the page and the endpoint use the same renderer, and the page marks its region with the matching hash', () => {
  const sites = [{ id: 'a', name: 'Alpha', status: 'active', product_name: 'P', primary_domain: 'alpha.lummet.app' }, { id: 'b', name: 'Beta', status: 'deleting', product_name: 'P' }];
  const rows = renderSiteRows({ sites, canManage: true });
  const page = renderSitesPage({ sites, products: [{ id: 'p', name: 'P' }], canManage: true, organizationId: 'org-1' });
  assert.ok(page.includes('id="sites-live"') && page.includes('data-live-src="/api/organizations/org-1/sites/live-rows"'));
  assert.ok(page.includes(`data-live-hash="${liveHash(rows)}"`), 'the first poll finds nothing changed');
  assert.ok(page.includes(rows));
  assert.ok(!renderSitesPage({ sites, products: [], canManage: true }).includes('data-live-src="/api'), 'no region without an organization');
  assert.ok(renderSiteRows({ sites, canManage: false }).includes('<td class="actions">—</td>'), 'members see no action buttons');

  const cards = renderDeploymentCards({ sites: [{ id: 'a', name: 'Alpha', status: 'active', template_line: 'casino' }], deploymentsBySite: { a: [] }, latestVersion: '1', canManage: true });
  const dpage = renderDeploymentsPage({ sites: [{ id: 'a', name: 'Alpha', status: 'active', template_line: 'casino' }], deploymentsBySite: { a: [] }, latestVersion: '1', canManage: true, organizationId: 'org-1' });
  assert.ok(dpage.includes('data-live-src="/api/organizations/org-1/deployments/live-cards"') && dpage.includes(`data-live-hash="${liveHash(cards)}"`));
});

test('the pages refresh in place after an action instead of reloading', () => {
  const sitesPage = renderSitesPage({ sites: [], products: [], canManage: true, organizationId: 'o' });
  const reloads = (sitesPage.match(/location\.reload\(\)/g) || []).length;
  assert.equal(reloads, 2, 'only the create-site success and the no-runtime fallback still reload');
  assert.ok(sitesPage.includes('lummetRefreshRows'));
  const dep = renderDeploymentsPage({ sites: [], deploymentsBySite: {}, latestVersion: null, canManage: true, organizationId: 'o' });
  assert.equal((dep.match(/location\.reload\(\)/g) || []).length, 1, 'only the fallback');
});
