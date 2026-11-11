// test/aftermarket-portal.test.js — seller dashboard: claims tied to an organization, org isolation, edits, enquiries, DNS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicEnv } from './support/public-env.js';
import { handleApi, renderPage } from '../worker/aftermarket-portal.js';
import { __setAftermarketProvidersForTests } from '../worker/aftermarket-zones.js';

const roleOk = (allowed) => async (_org, min) => (allowed.includes(min) ? null : new Response('{"success":false,"error":"forbidden"}', { status: 403 }));
const viewerOnly = async (_org, min) => (min === 'viewer' ? null : new Response('{"success":false,"error":"forbidden"}', { status: 403 }));
const customer = { id: 'u1', email: 'seller@example.test' };

async function api(env, org, method, subPath, body, { guard = roleOk(['viewer', 'admin']), audits } = {}) {
  const request = new Request('https://cp.test/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi({ env, request, method, path: `/api/organizations/${org}${subPath}`, organizationId: org, customer, requireOrgRole: guard, audit: async (...a) => audits?.push(a) });
  if (!res) return null;
  return { status: res.status, json: await res.json() };
}

test('a seller lists a domain for their organization; another organization cannot see or touch it', async () => {
  const env = createPublicEnv();
  const audits = [];
  const created = await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'https://www.Seller.io/x', askingPrice: '900', description: 'Nice' }, { audits });
  assert.equal(created.status, 200);
  assert.equal(created.json.domain, 'seller.io');
  assert.equal(audits[0][0], 'claim');

  const mine = await api(env, 'orgA', 'GET', '/aftermarket/domains');
  assert.equal(mine.json.data.length, 1);
  assert.equal(mine.json.data[0].status, 'pending');
  assert.match(mine.json.data[0].verify_token, /^lummet-verify=/);
  assert.equal(mine.json.data[0].owner_email, undefined);

  assert.deepEqual((await api(env, 'orgB', 'GET', '/aftermarket/domains')).json.data, []);
  for (const [m, p, b] of [['GET', '/aftermarket/domains/seller.io'], ['POST', '/aftermarket/domains/seller.io/listing', { headline: 'x' }], ['POST', '/aftermarket/domains/seller.io/status', { status: 'unlisted' }], ['POST', '/aftermarket/domains/seller.io/verify', { method: 'txt' }], ['GET', '/aftermarket/domains/seller.io/records']]) {
    assert.equal((await api(env, 'orgB', m, p, b)).status, 404, p);
  }
  // another organization cannot claim it either
  assert.equal((await api(env, 'orgB', 'POST', '/aftermarket/domains', { domain: 'seller.io' })).status, 409);
});

test('changes need the admin role; viewers can read', async () => {
  const env = createPublicEnv();
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'v.io' }, { guard: viewerOnly })).status, 403);
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'v.io' });
  assert.equal((await api(env, 'orgA', 'GET', '/aftermarket/domains', undefined, { guard: viewerOnly })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/v.io/listing', { headline: 'x' }, { guard: viewerOnly })).status, 403);
  assert.equal(await api(env, 'orgA', 'GET', '/other', undefined), null);
});

test('claims refuse invalid, reserved and admin-listed domains', async () => {
  const env = createPublicEnv();
  env.PORTAL_BASE_URL = 'https://portal.lummet.test';
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source) VALUES ('taken.io','listed','admin')`).run();
  assert.equal((await api(env, 'o', 'POST', '/aftermarket/domains', { domain: 'nope' })).json.error, 'invalid_domain');
  assert.equal((await api(env, 'o', 'POST', '/aftermarket/domains', { domain: 'portal.lummet.test' })).json.error, 'domain_unavailable');
  assert.equal((await api(env, 'o', 'POST', '/aftermarket/domains', { domain: 'taken.io' })).json.error, 'domain_unavailable');
});

test('TXT verification lists the domain, edits and unlist/relist work, enquiries are shown without buyer contact details', async () => {
  const env = createPublicEnv();
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'sell.io' });
  const token = (await api(env, 'orgA', 'GET', '/aftermarket/domains/sell.io')).json.domain.verify_token;
  const cool = () => env.db.prepare('UPDATE lummet_aftermarket_domains SET last_check_at = NULL').run();
  __setAftermarketProvidersForTests({ dns: { lookupTXT: async () => [] } });
  try {
    let r = await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/verify', { method: 'txt' });
    assert.equal(r.json.state, 'waiting');
    assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/verify', { method: 'txt' })).status, 429);
    __setAftermarketProvidersForTests({ dns: { lookupTXT: async () => [token] } });
    await cool();
    r = await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/verify', { method: 'txt' });
    assert.equal(r.json.state, 'listed');
  } finally { __setAftermarketProvidersForTests(); }
  const row = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='sell.io'`).first();
  assert.deepEqual([row.status, row.verified_method], ['listed', 'txt']);
  assert.equal(row.organization_id, 'orgA');

  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/listing', { headline: 'Great', asking_price: '1200', description: 'D' })).status, 200);
  const d = (await api(env, 'orgA', 'GET', '/aftermarket/domains/sell.io')).json;
  assert.equal(d.domain.headline, 'Great');
  assert.equal(d.domain.asking_price, '1200');

  await env.db.prepare(`INSERT INTO lummet_inquiries (form_key, name, email, subject_ref, source, summary) VALUES ('domain-acquisition','Buyer','buyer@secret.test','sell.io','landing','sell.io - 400')`).run().catch(async () => {
    await env.db.prepare(`INSERT INTO lummet_inquiries (form_key, name, email, subject_ref, source, summary, details) VALUES ('domain-acquisition','Buyer','buyer@secret.test','sell.io','landing','sell.io - 400','')`).run();
  });
  const withEnq = await api(env, 'orgA', 'GET', '/aftermarket/domains/sell.io');
  assert.equal(withEnq.json.enquiries.length, 1);
  assert.doesNotMatch(JSON.stringify(withEnq.json), /buyer@secret\.test|Buyer/);

  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/status', { status: 'unlisted' })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/status', { status: 'listed' })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/sell.io/status', { status: 'sold' })).status, 409);
});

test('DNS records: only for nameserver-verified domains; the for-sale page records are protected', async () => {
  const env = createPublicEnv();
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'dns.io' });
  assert.equal((await api(env, 'orgA', 'GET', '/aftermarket/domains/dns.io/records')).json.error, 'dns_not_available');
  await env.db.prepare(`UPDATE lummet_aftermarket_domains SET status='listed', verified_method='ns', cf_zone_id='z1', hosted=1 WHERE domain='dns.io'`).run();
  const added = [];
  const infra = {
    listDnsRecords: async () => [{ id: 'a', type: 'A', name: 'dns.io', content: '1.1.1.1' }, { id: 'm', type: 'MX', name: 'dns.io', content: 'mx.dns.io', priority: 10 }],
    createDnsRecord: async (_e, _z, rec) => { added.push(rec); return { id: 'new', ...rec }; },
    deleteDnsRecord: async () => ({ ok: true })
  };
  __setAftermarketProvidersForTests({ infra });
  try {
    const list = await api(env, 'orgA', 'GET', '/aftermarket/domains/dns.io/records');
    assert.deepEqual(list.json.records.map((r) => [r.id, r.managed]), [['a', true], ['m', false]]);
    assert.equal((await api(env, 'orgA', 'DELETE', '/aftermarket/domains/dns.io/records/a')).json.error, 'hostname_managed_by_lummet');
    assert.equal((await api(env, 'orgA', 'DELETE', '/aftermarket/domains/dns.io/records/m')).status, 200);
    assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/dns.io/records', { type: 'A', name: '@', content: '2.2.2.2' })).json.error, 'hostname_managed_by_lummet');
    assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/domains/dns.io/records', { type: 'TXT', name: '@', content: 'v=spf1 -all' })).status, 200);
    assert.equal(added.length, 1);
    assert.equal((await api(env, 'orgB', 'GET', '/aftermarket/domains/dns.io/records')).status, 404);
  } finally { __setAftermarketProvidersForTests(); }
});

test('pages render for the active organization only and escape domain data', async () => {
  const env = createPublicEnv();
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'page.io', description: '<script>x</script>' });
  const list = await renderPage(env, { organizationId: 'orgA', path: '/app/aftermarket', canManage: true });
  assert.equal(list.status, 200);
  assert.match(list.html, /page\.io/);
  assert.match(list.html, /id="am-add"/);
  assert.equal((await renderPage(env, { organizationId: 'orgA', path: '/app/aftermarket', canManage: false })).html.includes('id="am-add"'), false);
  const detail = await renderPage(env, { organizationId: 'orgA', path: '/app/aftermarket/page.io', canManage: true });
  assert.match(detail.html, /_lummet-verify\.page\.io/);
  assert.doesNotMatch(detail.html, /<script>x<\/script>/);
  assert.equal((await renderPage(env, { organizationId: 'orgB', path: '/app/aftermarket/page.io', canManage: true })).status, 404);
  assert.doesNotMatch((await renderPage(env, { organizationId: 'orgB', path: '/app/aftermarket', canManage: true })).html, /page\.io/);
});
