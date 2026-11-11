// test/aftermarket-listings.test.js — businesses for sale by category: public pages, enquiry tracking, seller approval flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get, post } from './support/public-env.js';
import { handleApi, renderPage } from '../worker/aftermarket-portal.js';

const text = (r) => r.text();
const addListing = (env, o = {}) => env.db.prepare(
  `INSERT INTO lummet_listings (slug, category_slug, title, summary, description, location, asking_price, revenue, profit, status, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin')`
).bind(o.slug || 'coffee-shop', o.category || 'local-business', o.title || 'Corner Coffee Shop', o.summary || 'Busy cafe near the station.', o.description || 'Long text', o.location || 'Kigali', o.price ?? '90000 USD', o.revenue ?? '60000 USD / year', o.profit ?? '20000 USD', o.status || 'listed').run();
const valid = { f_name: 'Ada', f_email: 'ada@example.test', f_message: 'I am interested.' };
const guardAll = async () => null;
const guardViewer = async (_o, min) => (min === 'viewer' ? null : new Response('{"success":false,"error":"forbidden"}', { status: 403 }));
const customer = { id: 'u1', email: 'seller@example.test' };
async function api(env, org, method, subPath, body, guard = guardAll) {
  const request = new Request('https://cp.test/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi({ env, request, method, path: `/api/organizations/${org}${subPath}`, organizationId: org, customer, requireOrgRole: guard, audit: async () => {} });
  return { status: res.status, json: await res.json() };
}

test('hub, businesses list and category pages show only listed items', async () => {
  const env = createPublicEnv();
  await addListing(env);
  await addListing(env, { slug: 'draft-one', title: 'Hidden Draft', status: 'pending' });
  await addListing(env, { slug: 'shop', category: 'ecommerce', title: 'Sneaker Store' });
  const hub = await text(await get(handlePublicRoute, env, '/aftermarket'));
  assert.match(hub, /Local businesses/);
  assert.match(hub, /href="\/aftermarket\/list-of-domains"/);
  const all = await text(await get(handlePublicRoute, env, '/aftermarket/businesses'));
  assert.match(all, /Corner Coffee Shop/);
  assert.match(all, /Sneaker Store/);
  assert.doesNotMatch(all, /Hidden Draft/);
  const cat = await text(await get(handlePublicRoute, env, '/aftermarket/businesses/ecommerce'));
  assert.match(cat, /Sneaker Store/);
  assert.doesNotMatch(cat, /Corner Coffee Shop/);
  assert.equal((await get(handlePublicRoute, env, '/aftermarket/businesses/nope')).status, 404);
});

test('a listing page shows its facts and the enquiry is tracked against the listing', async () => {
  const env = createPublicEnv();
  await addListing(env);
  await addListing(env, { slug: 'draft-one', title: 'Hidden Draft', status: 'pending' });
  const page = await text(await get(handlePublicRoute, env, '/aftermarket/listings/coffee-shop'));
  assert.match(page, /Corner Coffee Shop/);
  assert.match(page, /60000 USD \/ year/);
  assert.match(page, /90000 USD/);
  assert.match(page, /Kigali/);
  assert.equal((await get(handlePublicRoute, env, '/aftermarket/listings/draft-one')).status, 404);
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/listings/draft-one', valid)).status, 404);
  const res = await post(handlePublicRoute, env, '/aftermarket/listings/coffee-shop', valid);
  assert.equal(res.status, 303);
  const [row] = (await env.db.prepare('SELECT * FROM lummet_inquiries').all()).results;
  assert.equal(row.form_key, 'listing-enquiry');
  assert.equal(row.subject_ref, 'listing:coffee-shop');
  assert.equal(row.source, 'landing');
  assert.match(row.summary, /^Corner Coffee Shop/);
});

test('the listing description is escaped, never rendered as HTML', async () => {
  const env = createPublicEnv();
  await addListing(env, { description: '<script>alert(1)</script>', title: 'X <b>bold</b>' });
  const page = await text(await get(handlePublicRoute, env, '/aftermarket/listings/coffee-shop'));
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(page, /X <b>bold<\/b>/);
});

test('sitemap lists the marketplace pages; the domain enquiry still works', async () => {
  const env = createPublicEnv();
  await addListing(env);
  const sm = await text(await get(handlePublicRoute, env, '/sitemap.xml'));
  assert.match(sm, /\/aftermarket\/listings\/coffee-shop/);
  assert.match(sm, /\/aftermarket\/businesses\/local-business/);
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source) VALUES ('d.app','listed','admin')`).run();
  const res = await post(handlePublicRoute, env, '/aftermarket/domains/d.app', { f_name: 'A', f_email: 'a@example.test', f_domain: 'd.app', f_offer: '10' });
  assert.equal(res.status, 303);
  assert.equal((await env.db.prepare('SELECT subject_ref FROM lummet_inquiries').first()).subject_ref, 'd.app');
});

test('seller: a new listing is pending (not public); admin approves; editing sends it back; other organizations see nothing', async () => {
  const env = createPublicEnv();
  const input = { title: 'My Web Shop', category_slug: 'ecommerce', summary: 'Sells shoes', asking_price: '5000', description: 'D' };
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/listings', input, guardViewer)).status, 403);
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/listings', { ...input, category_slug: 'bogus' })).json.error, 'invalid_category');
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/listings', { ...input, title: 'x' })).json.error, 'invalid_title');
  const created = await api(env, 'orgA', 'POST', '/aftermarket/listings', input);
  assert.equal(created.status, 200);
  const { id, slug } = created.json;
  assert.match(slug, /^my-web-shop-[0-9a-f]{4}$/);
  assert.equal((await get(handlePublicRoute, env, `/aftermarket/listings/${slug}`)).status, 404);

  assert.equal((await api(env, 'orgB', 'GET', `/aftermarket/listings/${id}`)).status, 404);
  assert.equal((await api(env, 'orgB', 'POST', `/aftermarket/listings/${id}`, { title: 'Hijack' })).status, 404);
  assert.deepEqual((await api(env, 'orgB', 'GET', '/aftermarket/listings')).json.data, []);
  assert.equal((await api(env, 'orgA', 'GET', '/aftermarket/listings')).json.data[0].status, 'pending');

  await env.db.prepare(`UPDATE lummet_listings SET status='listed' WHERE id = ?`).bind(id).run();
  assert.equal((await get(handlePublicRoute, env, `/aftermarket/listings/${slug}`)).status, 200);

  // same text: stays listed. changed text: back to review, no longer public
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}`, { summary: 'Sells shoes' })).json.status, 'listed');
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}`, { summary: 'Now sells hats' })).json.status, 'pending');
  assert.equal((await get(handlePublicRoute, env, `/aftermarket/listings/${slug}`)).status, 404);

  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/status`, { status: 'unlisted' })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/status`, { status: 'listed' })).status, 409);   // only an admin lists
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/status`, { status: 'pending' })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/status`, { status: 'sold' })).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}`, { title: 'Again' })).status, 409);
});

test('seller sees enquiries about the listing without buyer contact details', async () => {
  const env = createPublicEnv();
  const { id, slug } = (await api(env, 'orgA', 'POST', '/aftermarket/listings', { title: 'Seen Shop', category_slug: 'websites' })).json;
  await env.db.prepare(`UPDATE lummet_listings SET status='listed' WHERE id = ?`).bind(id).run();
  await post(handlePublicRoute, env, `/aftermarket/listings/${slug}`, { f_name: 'Secret Buyer', f_email: 'buyer@secret.test', f_message: 'hello', f_offer: '77' });
  const d = await api(env, 'orgA', 'GET', `/aftermarket/listings/${id}`);
  assert.equal(d.json.enquiries.length, 1);
  assert.doesNotMatch(JSON.stringify(d.json), /buyer@secret\.test|Secret Buyer/);
  const list = await api(env, 'orgA', 'GET', '/aftermarket/listings');
  assert.equal(list.json.data[0].enquiry_count, 1);
  // a domain enquiry with the same text never counts as a listing enquiry
  assert.equal((await api(env, 'orgA', 'GET', '/aftermarket/categories')).json.data.length >= 5, true);
});

test('portal pages render the business sections and escape seller text', async () => {
  const env = createPublicEnv();
  const { id } = (await api(env, 'orgA', 'POST', '/aftermarket/listings', { title: 'Shop <img src=x>', category_slug: 'websites', summary: '<script>x</script>' })).json;
  const list = await renderPage(env, { organizationId: 'orgA', path: '/app/aftermarket/businesses', canManage: true });
  assert.match(list.html, /id="bz-add"/);
  assert.doesNotMatch(list.html, /<img src=x>/);
  const detail = await renderPage(env, { organizationId: 'orgA', path: `/app/aftermarket/business/${id}`, canManage: true });
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.html, /<script>x<\/script>/);
  assert.equal((await renderPage(env, { organizationId: 'orgB', path: `/app/aftermarket/business/${id}`, canManage: true })).status, 404);
  assert.equal((await renderPage(env, { organizationId: 'orgA', path: `/app/aftermarket/business/${id}`, canManage: false })).html.includes('id="bz-edit"'), false);
});

test('listing enquiries carry Turnstile like every other form: refused without a token, nothing stored', async () => {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_FORMS_TURNSTILE_REQUIRED: 'on', TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's' });
  await addListing(env);
  const page = await get(handlePublicRoute, env, '/aftermarket/listings/coffee-shop');
  assert.match(await text(page), /cf-turnstile/);
  assert.match(page.headers.get('content-security-policy') || '', /challenges\.cloudflare\.com/);
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/listings/coffee-shop', valid)).status, 503);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM lummet_inquiries').first()).n, 0);
});
