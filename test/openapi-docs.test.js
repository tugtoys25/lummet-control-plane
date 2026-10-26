// Round 6.2B: /docs and /openapi.json. The OpenAPI document must be valid AND match what the worker really does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createPublicEnv, get } from './support/public-env.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { buildOpenApiSpec, API_V1_SCOPES, WEBHOOK_EVENT_TYPES } from '../worker/public-site/openapi.js';
import { validateOpenApi } from '../scripts/validate-openapi.mjs';
import * as apiKeys from '../worker/api-keys.js';
import * as webhooks from '../worker/webhooks.js';
import * as customerAuth from '../worker/customer-auth.js';
import worker from '../worker/index.js';

const indexSrc = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
const webhooksSrc = readFileSync(new URL('../worker/webhooks.js', import.meta.url), 'utf8');

test('OpenAPI document validates structurally, and the validator rejects broken documents', () => {
  assert.deepEqual(validateOpenApi(buildOpenApiSpec()), []);
  const broken = buildOpenApiSpec();
  broken.paths['/api/v1/sites/{siteId}'].get.parameters = [];
  broken.paths['/api/v1/usage'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Nope' };
  broken.paths['/api/v1/sites'].get.operationId = 'getUsage';
  const errors = validateOpenApi(broken).join('\n');
  assert.match(errors, /path parameter \{siteId\} is not declared/);
  assert.match(errors, /unresolved \$ref/);
  assert.match(errors, /duplicate operationId/);
});

test('every documented route, method and scope exists in the worker source, and the scopes and events match the modules', () => {
  const spec = buildOpenApiSpec();
  assert.deepEqual([...API_V1_SCOPES].sort(), apiKeys.listValidScopes().sort());
  assert.deepEqual([...WEBHOOK_EVENT_TYPES].sort(), webhooks.listValidEventTypes().sort());
  const routeLiteral = {
    '/api/v1/sites': 'path === "/api/v1/sites"',
    '/api/v1/usage': 'path === "/api/v1/usage"',
    '/api/v1/sites/{siteId}': 'rest === ""',
    '/api/v1/sites/{siteId}/domains': 'rest === "/domains"',
    '/api/v1/sites/{siteId}/domain-zones': 'rest === "/domain-zones"',
    '/api/v1/sites/{siteId}/analytics/overview': 'rest === "/analytics/overview"'
  };
  assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(routeLiteral).sort(), 'documented paths and the route table must be the same set');
  for (const [path, item] of Object.entries(spec.paths)) {
    assert.deepEqual(Object.keys(item), ['get'], `${path} is read-only`);
    assert.ok(indexSrc.includes(`method === "GET" && ${routeLiteral[path]}`), `${path} is not routed as GET in worker/index.js`);
    const scope = item.get.security[0].apiKey[0];
    const handlerAt = indexSrc.indexOf(`method === "GET" && ${routeLiteral[path]}`);
    assert.ok(indexSrc.slice(handlerAt, handlerAt + 200).includes(`hasScope(apiAuth, "${scope}")`), `${path} must require scope ${scope}`);
  }
  for (const header of ['Lummet-Signature', 'Lummet-Delivery-Id', 'Lummet-Delivery-Attempt']) {
    assert.ok(webhooksSrc.includes(`"${header}"`), `${header} is sent by worker/webhooks.js`);
    assert.ok(spec.webhooks.lummetDelivery.post.parameters.some((p) => p.name === header));
  }
  assert.ok(webhooksSrc.includes('`${timestamp}.${body}`') && webhooksSrc.includes('`t=${timestamp},v1=${signature}`'), 'signing format stated in the docs is the one implemented');
});

function apiEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
async function api(env, path, token, ip = '198.51.100.7') {
  const headers = { 'CF-Connecting-IP': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(`https://cp.example.test${path}`, { method: 'GET', headers }), env, { waitUntil() {} });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

test('documented API behavior matches the running worker: 401, 403 scope, 200 envelope, 404 unknown, 429 on repeated bad keys', async () => {
  const env = apiEnv();
  const su = await customerAuth.signUp({ async json() { return { email: 'docs@example.com', password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.70' } }, env);
  const sitesKey = await apiKeys.createApiKey(env, { organizationId: su.organizationId, name: 'k', scopes: ['sites:read'], actorUserId: su.userId });
  assert.equal(sitesKey.ok, true);

  assert.equal((await api(env, '/api/v1/sites', null)).status, 401);
  const bad = await api(env, '/api/v1/sites', 'lmk_bad_key'); assert.equal(bad.status, 401); assert.equal(bad.json.error, 'unauthorized');
  const noScope = await api(env, '/api/v1/usage', sitesKey.token); assert.equal(noScope.status, 403); assert.equal(noScope.json.error, 'insufficient_scope');
  const ok = await api(env, '/api/v1/sites', sitesKey.token); assert.equal(ok.status, 200); assert.equal(ok.json.success, true); assert.ok(Array.isArray(ok.json.data));
  const missing = await api(env, '/api/v1/sites/does-not-exist', sitesKey.token); assert.equal(missing.status, 404); assert.equal(missing.json.error, 'not_found');
  const unknown = await api(env, '/api/v1/nothing-here', sitesKey.token); assert.equal(unknown.status, 404);

  const documented = buildOpenApiSpec().paths['/api/v1/sites'].get.responses;
  for (const code of ['200', '401', '403', '429']) assert.ok(documented[code], `status ${code} is documented`);
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) { const r = await api(env, '/api/v1/sites', 'lmk_bad_key', '198.51.100.99'); if (r.status === 429) limited = r; }
  assert.ok(limited, 'repeated invalid keys from one address end in 429');
  assert.equal(limited.json.error, 'rate_limited');
});

test('/docs and /openapi.json follow PUBLIC_TRUST_PAGES: off is inert, shadow is noindex, on is live', async () => {
  const off = createPublicEnv();
  assert.equal((await get(handlePublicRoute, off, '/docs')).status, 404);
  assert.equal((await get(handlePublicRoute, off, '/openapi.json')).status, 404);

  const shadow = createPublicEnv(); shadow.PUBLIC_TRUST_PAGES = 'shadow';
  const sdoc = await get(handlePublicRoute, shadow, '/docs'); const shtml = await sdoc.text();
  assert.equal(sdoc.status, 200); assert.match(shtml, /noindex/); assert.match(shtml, /rollout is not enabled/);
  const sjson = await get(handlePublicRoute, shadow, '/openapi.json');
  assert.equal(sjson.status, 200); assert.equal(sjson.headers.get('x-robots-tag'), 'noindex'); assert.equal(sjson.headers.get('cache-control'), 'no-store');

  const on = createPublicEnv(); on.PUBLIC_TRUST_PAGES = 'on';
  const res = await get(handlePublicRoute, on, '/docs'); const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.doesNotMatch(html, /\{\{[^}]+\}\}/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/i);
  assert.match(html, /Lummet-Signature: t=/);
  assert.match(html, /href="\/openapi\.json"/);
  const spec = await get(handlePublicRoute, on, '/openapi.json');
  assert.equal(spec.status, 200); assert.match(spec.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await spec.json(), JSON.parse(JSON.stringify(buildOpenApiSpec())));
  assert.equal(spec.headers.get('x-content-type-options'), 'nosniff');
});
