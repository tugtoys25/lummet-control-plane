// The homepage must survive a failing secondary read (updates, insights, partners, banner, plans) and say why when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv } from './support/public-env.js';

const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };
const home = (env) => handlePublicRoute({ request: new Request('https://lummet.test/'), env, ctx: { waitUntil() {} } });
function failing(env, needle) {
  const real = env.LUMMET_DB.prepare.bind(env.LUMMET_DB);
  env.LUMMET_DB = { ...env.LUMMET_DB, prepare: (sql) => { if (sql.includes(needle)) throw new Error(`boom: ${needle}`); return real(sql); }, batch: env.LUMMET_DB.batch };
  return env;
}

test('a failing updates list read leaves that section out; the homepage still renders', async () => {
  const res = await quiet(() => home(failing(createPublicEnv(), 'FROM lummet_updates u')));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>/);
});

test('a failing plans read leaves the plans block out; the homepage still renders', async () => {
  const res = await quiet(() => home(failing(createPublicEnv(), 'FROM plans p')));
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /plans-teaser/);
});

test('a failing primary read is a 503 (after the router retry), with the reason in a header on staging only', async () => {
  const staging = failing(createPublicEnv(), 'FROM lummet_homepage_sections'); staging.ENVIRONMENT = 'staging';
  const r1 = await quiet(() => home(staging));
  assert.equal(r1.status, 503);
  assert.match(r1.headers.get('x-public-error') || '', /boom: FROM lummet_homepage_sections/);
  const prod = failing(createPublicEnv(), 'FROM lummet_homepage_sections'); prod.ENVIRONMENT = 'production';
  const r2 = await quiet(() => home(prod));
  assert.equal(r2.status, 503);
  assert.equal(r2.headers.get('x-public-error'), null, 'production never exposes error text');
});
