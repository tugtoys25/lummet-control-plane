// =====================================================
// CLOUDFLARE INFRASTRUCTURE PROVIDER
//
// Real implementation of infra-provider.js's contract,
// against Cloudflare's documented account-level REST API —
// via fetch(), never a third-party SDK.
//
// HONESTY NOTE (master prompt rule #5), same as
// billing-stripe.js: these calls have NOT been exercised
// against a live Cloudflare account in this environment —
// there is no network access here to do so. They are
// implemented against Cloudflare's stable, documented API
// shapes, but need a real CF_API_TOKEN/CF_ACCOUNT_ID (and, for
// the custom-hostname/SSL calls added in Phase 4, CF_ZONE_ID)
// and a staging run before they're production-ready. The
// orchestration logic that calls these (provisioning.js,
// deployments.js, domains.js) IS fully unit-tested, via a fake
// provider standing in for Cloudflare
// (test/support/fake-infra-provider.js).
// =====================================================

export const PROVIDER_NAME = "cloudflare";

import { bytesToBase64, contentTypeFor } from "./asset-hash.js";
const API_BASE = "https://api.cloudflare.com/client/v4";

async function cloudflareRequest(env, method, path, body) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is not configured on this Worker");
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is not configured on this Worker");

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data?.errors?.[0]?.message || `Cloudflare API error (HTTP ${response.status})`;
    const error = new Error(message);
    error.httpStatus = response.status;                      // lets callers tell "not found" from "rejected"
    error.cfCode = data?.errors?.[0]?.code ?? null;
    throw error;
  }
  return data.result;
}

export async function createDatabase(env, { name }) {
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/d1/database`, { name });
  return { resourceId: result.uuid, metadata: { name: result.name } };
}

/**
 * Routes one hostname to one site's Worker: pattern "<host>/*" on a platform zone. `zoneId` is the zone the hostname
 * lives in (a platform domain's cf_zone_id); without it the default platform zone, CF_ZONE_ID, is used (the same zone
 * as the custom hostnames). Idempotent: if the route already exists, its id is returned instead of an error. Needs a
 * proxied DNS record covering the hostname (a wildcard record, set up once; see DEPLOYMENT.md and docs/PLATFORM_DOMAINS.md).
 */
export async function ensureWorkerRoute(env, { pattern, workerName, zoneId }) {
  const zone = zoneId || env.CF_ZONE_ID;
  if (!zone) throw new Error(`CF_ZONE_ID is not configured on this Worker, so ${pattern} cannot be routed to the site`);
  try {
    const result = await cloudflareRequest(env, "POST", `/zones/${zone}/workers/routes`, { pattern, script: workerName });
    return { routeId: result.id };
  } catch (err) {
    if (!/already exists|duplicate/i.test(String(err.message))) throw err;
    const list = await cloudflareRequest(env, "GET", `/zones/${zone}/workers/routes`);
    const existing = (Array.isArray(list) ? list : []).find((r) => r.pattern === pattern);
    if (!existing) throw err;
    if (existing.script !== workerName) {
      // Same hostname bound to a different Worker: take it over for this site.
      await cloudflareRequest(env, "PUT", `/zones/${zone}/workers/routes/${existing.id}`, { pattern, script: workerName });
    }
    return { routeId: existing.id };
  }
}

/** Route ids are zone-scoped: pass the zone the route was created in (none recorded = the default platform zone). */
export async function deleteWorkerRoute(env, routeId, { zoneId } = {}) {
  const zone = zoneId || env.CF_ZONE_ID;
  if (!zone) throw new Error("CF_ZONE_ID is not configured on this Worker");
  await cloudflareRequest(env, "DELETE", `/zones/${zone}/workers/routes/${routeId}`);
  return { ok: true };
}

// ---- Platform domains (staff "Add domain" checks). Read-mostly calls on a zone that must already exist in the platform account.

/** Finds an existing zone in the platform account by its exact name. Never creates one. Returns null when there is none. */
export async function findZoneByName(env, name) {
  const result = await cloudflareRequest(env, "GET", `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}`);
  const z = (Array.isArray(result) ? result : []).find((r) => String(r.name).toLowerCase() === String(name).toLowerCase());
  return z ? { zoneId: z.id, name: z.name, cfStatus: z.status, status: z.status === "active" ? "active" : "pending" } : null;
}

/** Harmless reads that need the same permissions routing needs (Workers Routes, DNS). Reports which one is missing. */
export async function probeZoneAccess(env, zoneId) {
  const missing = [];
  for (const [label, path] of [["Workers Routes: Edit", `/zones/${zoneId}/workers/routes`], ["DNS: Edit", `/zones/${zoneId}/dns_records?per_page=1`]]) {
    try { await cloudflareRequest(env, "GET", path); }
    catch (err) { if (err.httpStatus === 403 || err.httpStatus === 401 || /permission|authentication|not authorized/i.test(String(err.message))) missing.push(label); else throw err; }
  }
  return { ok: missing.length === 0, missing };
}

/** Whether Universal SSL is on for the zone (it covers *.domain one level down, which is what <slug>.<domain> needs). */
export async function getUniversalSsl(env, zoneId) {
  const r = await cloudflareRequest(env, "GET", `/zones/${zoneId}/ssl/universal/settings`);
  return { enabled: r?.enabled !== false };
}

export async function listWorkerRoutes(env, zoneId) {
  const list = await cloudflareRequest(env, "GET", `/zones/${zoneId}/workers/routes`);
  return (Array.isArray(list) ? list : []).map((r) => ({ id: r.id, pattern: r.pattern, script: r.script || null }));
}

/** Registers the Worker's cron triggers (replaces any existing schedule). */
export async function setWorkerSchedule(env, { workerName, crons }) {
  await cloudflareRequest(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${workerName}/schedules`, crons.map((cron) => ({ cron })));
  return { ok: true };
}

export async function deleteWorkerScript(env, workerName) {
  // force=true also removes anything that still depends on the script.
  await cloudflareRequest(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${workerName}?force=true`);
  return { ok: true };
}

/** The D1 database with exactly this name in the account, or null. Used to clean up what a failed attempt left behind. */
export async function findDatabaseByName(env, { name }) {
  const result = await cloudflareRequest(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  const hit = (Array.isArray(result) ? result : []).find((d) => d.name === name);
  return hit ? { resourceId: hit.uuid, name: hit.name } : null;
}

/** The KV namespace with exactly this title in the account, or null. */
export async function findKVNamespaceByName(env, { title }) {
  for (let page = 1; page <= 10; page++) {
    const result = await cloudflareRequest(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=100&page=${page}`);
    const rows = Array.isArray(result) ? result : [];
    const hit = rows.find((n) => n.title === title);
    if (hit) return { resourceId: hit.id, title: hit.title };
    if (rows.length < 100) break;
  }
  return null;
}

export async function deleteDatabase(env, resourceId) {
  await cloudflareRequest(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${resourceId}`);
  return { ok: true };
}

export async function createKVNamespace(env, { title }) {
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces`, { title });
  return { resourceId: result.id, metadata: { title: result.title } };
}

export async function deleteKVNamespace(env, resourceId) {
  await cloudflareRequest(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${resourceId}`);
  return { ok: true };
}

export async function createR2Bucket(env, { name }) {
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/r2/buckets`, { name });
  return { resourceId: result.name, metadata: { name: result.name, location: result.location || null } };
}

export async function deleteR2Bucket(env, resourceId) {
  await cloudflareRequest(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${resourceId}`);
  return { ok: true };
}

// -----------------------------------------------------
// Phase 4 additions: deployment + domain management
// -----------------------------------------------------

/**
 * Uses FormData (available natively in the Workers runtime) rather
 * than hand-rolling multipart encoding — Cloudflare's Worker-script
 * upload endpoint expects a multipart body with a "metadata" JSON
 * part and one part per module, matching Cloudflare's documented
 * module-worker upload format.
 */
async function cfJson(response, what) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(`${what}: ${data?.errors?.[0]?.message || `Cloudflare API error (HTTP ${response.status})`}`);
  }
  return data;
}

/**
 * Cloudflare Workers Assets upload, in three documented steps:
 *   1. open an upload session with a manifest of {path: {hash, size}};
 *      Cloudflare answers with the hashes it does NOT already hold,
 *      grouped in buckets, plus a session token;
 *   2. upload each missing file (base64, in multipart form parts named
 *      by hash) using that token; the last upload returns a completion
 *      token;
 *   3. the completion token goes into the script upload's metadata.
 * If every file is already held, the session token is the completion
 * token. NOT verified against a live account in this environment.
 *
 * manifest: { "/path": { hash, size } }
 * readAsset: async (hash) => Uint8Array
 * Returns the completion JWT.
 */
export async function uploadAssets(env, { workerName, manifest, readAsset }) {
  const base = `${API_BASE}/accounts/${env.CF_ACCOUNT_ID}`;
  const session = await cfJson(await fetch(`${base}/workers/scripts/${workerName}/assets-upload-session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ manifest })
  }), "assets upload session");

  let jwt = session.result?.jwt;
  const buckets = session.result?.buckets || [];
  if (!jwt) throw new Error("assets upload session returned no token");
  if (buckets.length === 0) return jwt; // everything already uploaded

  const pathByHash = new Map();
  for (const [path, meta] of Object.entries(manifest)) if (!pathByHash.has(meta.hash)) pathByHash.set(meta.hash, path);

  let completion = null;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const path = pathByHash.get(hash);
      if (!path) throw new Error(`Cloudflare asked for unknown asset ${hash}`);
      const bytes = await readAsset(hash);
      if (!bytes) throw new Error(`asset file for ${path} is missing from storage`);
      form.append(hash, new Blob([bytesToBase64(bytes)], { type: contentTypeFor(path) }), hash);
    }
    const res = await cfJson(await fetch(`${base}/workers/assets/upload?base64=true`, {
      method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form
    }), "assets upload");
    if (res.result?.jwt) completion = res.result.jwt;
  }
  if (!completion) throw new Error("assets upload finished without a completion token");
  return completion;
}

// Static files (/static/*: css, js, images) are answered by Cloudflare's assets layer directly: no Worker run, no database
// read, no Worker request counted per file. Everything else (pages, API, templates) still goes through the tenant Worker.
// The cache policy comes with the upload as the text of a _headers file (the same text as lummet-tenant/en/_headers).
// css/js are linked as ?v=<hash> URLs, so a release is a new URL; browsers show their copy at once and refresh it in the background.
// TENANT_STATIC_BYPASS=off restores "every request through the Worker" (the Worker then sets the same policy itself).
export const TENANT_STATIC_HEADERS = [
  "/static/css/*",
  "  Cache-Control: public, max-age=3600, stale-while-revalidate=604800",
  "  X-Content-Type-Options: nosniff",
  "/static/js/*",
  "  Cache-Control: public, max-age=3600, stale-while-revalidate=604800",
  "  X-Content-Type-Options: nosniff",
  "/static/images/*",
  "  Cache-Control: public, max-age=86400, stale-while-revalidate=604800",
  "  X-Content-Type-Options: nosniff",
  "/static/sw.js",
  "  Cache-Control: no-cache",
  ""
].join("\n");

export function tenantAssetsConfig(env, { profile = null, releaseConfig = null } = {}) {
  // A line whose application defines its own static-file rules (brokerage) carries them in the release: which paths still
  // go to the Worker first, and the text of its _headers file. Nothing else about the upload is taken from a release.
  if (profile && profile.assets === "release_defined") {
    const config = {};
    const first = releaseConfig && Array.isArray(releaseConfig.runWorkerFirst) ? releaseConfig.runWorkerFirst : null;
    config.run_worker_first = first && first.length ? first : true;
    if (releaseConfig && typeof releaseConfig.headers === "string" && releaseConfig.headers.trim()) config._headers = releaseConfig.headers;
    return config;
  }
  if (String(env?.TENANT_STATIC_BYPASS || "on").toLowerCase() === "off") return { run_worker_first: true };
  return { run_worker_first: ["/*", "!/static/*"], _headers: TENANT_STATIC_HEADERS };
}

/**
 * Creates or updates a Worker (same PUT either way). Uses FormData
 * (native in the Workers runtime): a "metadata" JSON part plus one part
 * per module, per Cloudflare's module-worker upload format.
 *
 * bindings: Cloudflare binding objects (see site-bindings.js).
 * assets:   optional { manifest, readAsset }; uploaded first and attached
 *           via the completion token. The tenant Worker stays in front of
 *           everything except /static/* (see tenantAssetsConfig), as in its wrangler.jsonc.
 */
export async function uploadWorkerScript(env, { workerName, scriptContent, bindings = [], assets = null, profile = null, assetsConfig = null }) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is not configured on this Worker");
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is not configured on this Worker");

  const metadata = {
    main_module: "index.js",
    // Match the tenant repo (lummet-tenant/wrangler.jsonc). Override with TENANT_COMPAT_DATE if a release needs another date.
    compatibility_date: (profile && profile.compatibilityDate) || env.TENANT_COMPAT_DATE || "2026-01-01",
    compatibility_flags: profile && profile.compatibilityFlags ? [...profile.compatibilityFlags] : ["nodejs_compat"],
    bindings
  };
  if (assets) {
    const jwt = await uploadAssets(env, { workerName, manifest: assets.manifest, readAsset: assets.readAsset });
    metadata.assets = { jwt, config: tenantAssetsConfig(env, { profile, releaseConfig: assetsConfig }) };
  }
  // Smart Placement runs the tenant Worker near its D1 database, so the ~15 sequential queries of a page render are
  // not each a long round trip. Cloudflare keeps it only where it measures an improvement. TENANT_SMART_PLACEMENT=off removes it.
  if (String(env.TENANT_SMART_PLACEMENT || "on").toLowerCase() !== "off") metadata.placement = { mode: "smart" };

  const formData = new FormData();
  formData.append("metadata", JSON.stringify(metadata));
  formData.append(
    "index.js",
    new Blob([scriptContent], { type: "application/javascript+module" }),
    "index.js"
  );

  const response = await fetch(`${API_BASE}/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: formData
  });
  await cfJson(response, "worker upload");
  return { ok: true };
}

export async function runD1Query(env, { databaseId, sql, params }) {
  // With params the statement must be a single one using ? placeholders; values are bound by D1, never spliced into SQL.
  const body = Array.isArray(params) ? { sql, params } : { sql };
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/query`, body);
  return { ok: true, results: Array.isArray(result) ? result : [result] };
}

/** DNS records Cloudflare still wants for a custom hostname: ownership TXT and certificate validation records. */
function customHostnameRecords(result) {
  const out = [];
  const own = result?.ownership_verification;
  if (own && own.type && own.name && own.value) out.push({ type: String(own.type).toUpperCase(), name: own.name, value: own.value });
  for (const v of Array.isArray(result?.ssl?.validation_records) ? result.ssl.validation_records : []) {
    if (v.txt_name && v.txt_value) out.push({ type: "TXT", name: v.txt_name, value: v.txt_value });
  }
  return out;
}

export async function createCustomHostname(env, { hostname }) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  const result = await cloudflareRequest(env, "POST", `/zones/${env.CF_ZONE_ID}/custom_hostnames`, {
    hostname,
    ssl: { method: "http", type: "dv" }
  });
  return { resourceId: result.id, records: customHostnameRecords(result) };
}

/** Status plus the records Cloudflare is still waiting for. */
export async function getCustomHostnameDetail(env, resourceId) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  const result = await cloudflareRequest(env, "GET", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${resourceId}`);
  let status = normalizeCustomHostnameStatus(result?.ssl?.status);
  // A hostname Cloudflare itself calls blocked/deleted/moved will never become active.
  if (["blocked", "deleted", "moved"].includes(String(result?.status))) status = "failed";
  return { status, hostnameStatus: String(result?.status || ""), records: customHostnameRecords(result) };
}

/** Cloudflare for SaaS needs a fallback origin on the SaaS zone before any custom hostname can be served. */
export async function getFallbackOrigin(env) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  const result = await cloudflareRequest(env, "GET", `/zones/${env.CF_ZONE_ID}/custom_hostnames/fallback_origin`);
  return { origin: result?.origin || null, status: String(result?.status || "") };
}

export async function setFallbackOrigin(env, { origin }) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  await cloudflareRequest(env, "PUT", `/zones/${env.CF_ZONE_ID}/custom_hostnames/fallback_origin`, { origin });
  return { ok: true };
}

// The ONLY place a Cloudflare-specific custom-hostname SSL status
// string is read — see infra-provider.js's contract comment.
function normalizeCustomHostnameStatus(cfSslStatus) {
  if (cfSslStatus === "active") return "active";
  if (["initializing", "pending_validation", "pending_issuance", "pending_deployment"].includes(cfSslStatus)) {
    return "pending";
  }
  return "failed";
}

export async function getCustomHostnameStatus(env, resourceId) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  const result = await cloudflareRequest(env, "GET", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${resourceId}`);
  return { status: normalizeCustomHostnameStatus(result?.ssl?.status) };
}

export async function deleteCustomHostname(env, resourceId) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  await cloudflareRequest(env, "DELETE", `/zones/${env.CF_ZONE_ID}/custom_hostnames/${resourceId}`);
  return { ok: true };
}

export async function checkHealth(env, { url }) {
  try {
    const response = await fetch(url, { method: "GET" });
    return { ok: response.ok, statusCode: response.status };
  } catch (error) {
    return { ok: false, statusCode: null };
  }
}


// -----------------------------------------------------
// v1: custom domains by nameserver delegation.
//
// The customer's root domain becomes a Cloudflare zone (type "full") in the platform account; the customer sets the
// two nameservers Cloudflare assigns at their registrar. Once the zone is ACTIVE the hostnames are attached to the
// site's Worker with Workers Custom Domains (Cloudflare then creates the DNS record and the certificate itself).
//
// Token permissions needed (see docs/CUSTOM_DOMAINS.md): Account > Workers Scripts: Edit, Zone > Zone: Edit,
// Zone > DNS: Edit, Zone > Workers Routes: Edit, all for the platform account and "All zones".
// HONESTY NOTE: written against Cloudflare's documented API; not exercised against a live account here. The
// staging checklist in docs/CUSTOM_DOMAINS.md says exactly what to run.
// -----------------------------------------------------

/** Cloudflare zone status -> the three states the control plane cares about. */
export function normalizeZoneStatus(cfStatus) {
  if (cfStatus === "active") return "active";
  if (cfStatus === "pending" || cfStatus === "initializing") return "pending";
  return "gone";                                             // moved | deleted | deactivated | anything unexpected
}

function zoneResult(result) {
  return {
    zoneId: result.id,
    nameServers: Array.isArray(result.name_servers) ? result.name_servers : [],
    originalNameServers: Array.isArray(result.original_name_servers) ? result.original_name_servers : [],
    cfStatus: result.status,
    status: normalizeZoneStatus(result.status)
  };
}

/**
 * Adds a root domain as a full-setup zone. Idempotent for OUR account: if the zone is already ours (a retry after a
 * half-finished attempt) it is returned instead of an error. A domain that is active in someone else's Cloudflare
 * account is refused by Cloudflare and surfaces as an error the caller turns into "domain_unavailable".
 */
export async function createZone(env, { name }) {
  try {
    const result = await cloudflareRequest(env, "POST", "/zones", { account: { id: env.CF_ACCOUNT_ID }, name, type: "full" });
    return zoneResult(result);
  } catch (err) {
    if (!/already exists|duplicate/i.test(String(err.message))) throw err;
    const found = await cloudflareRequest(env, "GET", `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}`);
    const mine = (Array.isArray(found) ? found : []).find((z) => z.name === name);
    if (!mine) throw err;
    return zoneResult(mine);
  }
}

export async function getZone(env, zoneId) {
  try {
    return zoneResult(await cloudflareRequest(env, "GET", `/zones/${zoneId}`));
  } catch (err) {
    if (err.httpStatus === 404 || /not found|does not exist|invalid zone/i.test(String(err.message))) {
      return { zoneId, nameServers: [], originalNameServers: [], cfStatus: "deleted", status: "gone" };
    }
    throw err;
  }
}

/** Asks Cloudflare to re-check delegation now. Cloudflare rate-limits this; callers treat a refusal as non-fatal. */
export async function requestActivationCheck(env, zoneId) {
  await cloudflareRequest(env, "PUT", `/zones/${zoneId}/activation_check`);
  return { ok: true };
}

export async function deleteZone(env, zoneId) {
  await cloudflareRequest(env, "DELETE", `/zones/${zoneId}`);
  return { ok: true };
}

/** Starts Cloudflare's asynchronous scan for the domain's existing records (results are reviewed, not auto-added). */
export async function triggerDnsScan(env, zoneId) {
  await cloudflareRequest(env, "POST", `/zones/${zoneId}/dns_records/scan/trigger`);
  return { ok: true };
}

export async function listScannedRecords(env, zoneId) {
  const result = await cloudflareRequest(env, "GET", `/zones/${zoneId}/dns_records/scan/review`);
  return (Array.isArray(result) ? result : []).map(dnsRecord);
}

/** Accepts the scanned records with the given ids (all of them when ids is omitted). */
export async function acceptScannedRecords(env, zoneId, ids) {
  const list = Array.isArray(ids) ? ids : (await listScannedRecords(env, zoneId)).map((r) => r.id);
  if (!list.length) return { ok: true, accepted: 0 };
  await cloudflareRequest(env, "POST", `/zones/${zoneId}/dns_records/scan/review`, { accepts: list.map((id) => ({ id })), rejects: [] });
  return { ok: true, accepted: list.length };
}

function dnsRecord(r) {
  return { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: !!r.proxied, priority: r.priority ?? null };
}

export async function listDnsRecords(env, zoneId) {
  const out = [];
  for (let page = 1; page <= 5; page++) {                     // 500 records is far beyond a normal site
    const result = await cloudflareRequest(env, "GET", `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    const rows = Array.isArray(result) ? result : [];
    out.push(...rows.map(dnsRecord));
    if (rows.length < 100) break;
  }
  return out;
}

export async function createDnsRecord(env, zoneId, { type, name, content, ttl = 1, priority, proxied = false }) {
  const body = { type, name, content, ttl, proxied };
  if (priority !== undefined && priority !== null) body.priority = priority;
  return dnsRecord(await cloudflareRequest(env, "POST", `/zones/${zoneId}/dns_records`, body));
}

export async function deleteDnsRecord(env, zoneId, recordId) {
  await cloudflareRequest(env, "DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  return { ok: true };
}

/**
 * Serves one hostname of a delegated zone from the site's Worker (Workers Custom Domain). Cloudflare creates the
 * proxied DNS record and issues the certificate. Idempotent: the same PUT updates an existing attachment.
 */
export async function attachWorkerDomain(env, { hostname, workerName, zoneId, zoneName }) {
  const result = await cloudflareRequest(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, {
    hostname, service: workerName, environment: "production", zone_id: zoneId, zone_name: zoneName
  });
  return { customDomainId: result?.id || null, certId: result?.cert_id || null };
}

export async function detachWorkerDomain(env, customDomainId) {
  await cloudflareRequest(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/workers/domains/${customDomainId}`);
  return { ok: true };
}


// -----------------------------------------------------
// Customer-owned Cloudflare hosting (docs/CUSTOM_CLOUDFLARE_HOSTING.md).
//
// Everything above works for ANY account: it reads env.CF_API_TOKEN / env.CF_ACCOUNT_ID, and for a site hosted in the
// customer's own account the caller passes a scoped env carrying that account's token and id (custom-hosting.js
// cloudflareEnvFor). The calls below are the extra operations that feature needs: checking a token and its
// permissions, the account's workers.dev subdomain, zones in the account, Turnstile widgets, and the data copy used
// when an existing site moves (D1 export / import, KV keys, R2 objects). Tokens never appear in an error message.
// -----------------------------------------------------

/** One call that also returns result_info (pagination) and, for a raw body, the Response itself. */
async function cloudflareCall(env, method, path, { body, raw = false, rawBody, contentType } = {}) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is not configured on this Worker");
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is not configured on this Worker");
  const headers = { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  if (rawBody !== undefined) headers["Content-Type"] = contentType || "application/octet-stream";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_BASE}${path}`, { method, headers, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined });
  if (raw && response.ok) return response;
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const error = new Error(data?.errors?.[0]?.message || `Cloudflare API error (HTTP ${response.status})`);
    error.httpStatus = response.status;
    error.cfCode = data?.errors?.[0]?.code ?? null;
    throw error;
  }
  return { result: data.result, resultInfo: data.result_info || null };
}

/** Is the token valid and active? Account-owned tokens verify on the account, user tokens on /user. */
export async function verifyApiToken(env) {
  for (const path of [`/accounts/${env.CF_ACCOUNT_ID}/tokens/verify`, "/user/tokens/verify"]) {
    try {
      const { result } = await cloudflareCall(env, "GET", path);
      return { ok: result?.status === "active", status: result?.status || "unknown", expiresOn: result?.expires_on || null };
    } catch (err) {
      if (err.httpStatus && err.httpStatus >= 500) throw err;
      // An account token does not verify on /user and vice versa: try the other form before giving up.
    }
  }
  return { ok: false, status: "invalid", expiresOn: null };
}

export async function getAccountDetails(env) {
  const { result } = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}`);
  return { id: result?.id || env.CF_ACCOUNT_ID, name: result?.name || null };
}

/**
 * Read-only probes, one per capability a site needs. Each entry: { key, ok, code?, message? }. Nothing is created.
 * r2 reports code "r2_not_enabled" when the account has not subscribed to R2 (Cloudflare error 10042).
 */
export async function probeAccountPermissions(env) {
  const a = `/accounts/${env.CF_ACCOUNT_ID}`;
  const probes = [
    ["workers_scripts", `${a}/workers/scripts`],
    ["d1", `${a}/d1/database?per_page=1`],
    ["kv", `${a}/storage/kv/namespaces?per_page=1`],
    ["r2", `${a}/r2/buckets?per_page=1`],
    ["turnstile", `${a}/challenges/widgets?per_page=1`],
    ["workers_subdomain", `${a}/workers/subdomain`],
    ["zones", `/zones?per_page=5&account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}`]
  ];
  const out = [];
  for (const [key, path] of probes) {
    try { await cloudflareCall(env, "GET", path); out.push({ key, ok: true }); }
    catch (err) {
      let code = err.httpStatus === 401 || err.httpStatus === 403 ? "forbidden" : "error";
      if (key === "r2" && (err.cfCode === 10042 || /enable r2|r2 .*not enabled|purchase/i.test(String(err.message)))) code = "r2_not_enabled";
      // An account that has never claimed a workers.dev subdomain answers 404 here: the permission is fine.
      if (key === "workers_subdomain" && err.httpStatus === 404) { out.push({ key, ok: true, code: "no_subdomain" }); continue; }
      out.push({ key, ok: false, code, message: String(err.message || "").slice(0, 200) });
    }
  }
  return out;
}

/** The account's <name>.workers.dev subdomain, or null when it has none yet. */
export async function getWorkersSubdomain(env) {
  try {
    const { result } = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/workers/subdomain`);
    return result?.subdomain || null;
  } catch (err) {
    if (err.httpStatus === 404 || /not found|no subdomain/i.test(String(err.message))) return null;
    throw err;
  }
}

export async function createWorkersSubdomain(env, { subdomain }) {
  const { result } = await cloudflareCall(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/workers/subdomain`, { body: { subdomain } });
  return result?.subdomain || subdomain;
}

/** Serves (or stops serving) a script on its workers.dev address (worker name, then the account subdomain). */
export async function setWorkersDevEnabled(env, { workerName, enabled }) {
  await cloudflareCall(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${workerName}/subdomain`, { body: { enabled: !!enabled, previews_enabled: false } });
  return { ok: true };
}

/** Zones of the account (all pages, capped). Each: { id, name, status, nameServers, plan }. */
export async function listAccountZones(env, { maxPages = 10 } = {}) {
  const zones = [];
  for (let page = 1; page <= maxPages; page++) {
    const { result, resultInfo } = await cloudflareCall(env, "GET", `/zones?account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}&per_page=50&page=${page}`);
    for (const z of result || []) zones.push({ id: z.id, name: z.name, status: z.status, nameServers: Array.isArray(z.name_servers) ? z.name_servers : [], plan: z.plan?.name || null });
    if (!resultInfo || page >= (resultInfo.total_pages || 1)) break;
  }
  return zones;
}

export async function listWorkerDomains(env, { hostname } = {}) {
  const q = hostname ? `?hostname=${encodeURIComponent(hostname)}` : "";
  const { result } = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/workers/domains${q}`);
  return (result || []).map((d) => ({ id: d.id, hostname: d.hostname, service: d.service, zoneId: d.zone_id }));
}

/** Turnstile widget for one site. Returns { sitekey, secret } (the secret is only returned on create). */
export async function createTurnstileWidget(env, { name, domains, mode = "managed" }) {
  const { result } = await cloudflareCall(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/challenges/widgets`, { body: { name, domains: domains.slice(0, 10), mode } });
  return { sitekey: result.sitekey, secret: result.secret };
}

export async function updateTurnstileWidget(env, { sitekey, name, domains, mode = "managed" }) {
  await cloudflareCall(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/challenges/widgets/${sitekey}`, { body: { name, domains: domains.slice(0, 10), mode } });
  return { ok: true };
}

export async function deleteTurnstileWidget(env, sitekey) {
  await cloudflareCall(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/challenges/widgets/${sitekey}`);
  return { ok: true };
}

// ---- data copy (moving an existing site) --------------------------------------------------------------------

/**
 * Starts or continues a D1 SQL export. Returns { status: "complete", signedUrl } or { status: "active", bookmark }.
 * The database is unavailable to other queries while an export runs, so callers keep polling until it completes.
 */
export async function exportD1Database(env, { databaseId, bookmark = null }) {
  const body = { output_format: "polling" };
  if (bookmark) body.current_bookmark = bookmark;
  const { result } = await cloudflareCall(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/export`, { body });
  if (result?.status === "error") throw new Error(`D1 export failed: ${result.error || "unknown error"}`);
  if (result?.status === "complete") return { status: "complete", signedUrl: result.result?.signed_url || null };
  return { status: "active", bookmark: result?.at_bookmark || bookmark };
}

/** Downloads a finished D1 export (its signed URL) as bytes, refusing anything over maxBytes. */
export async function downloadD1Export(env, { signedUrl, maxBytes }) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`could not download the database export (HTTP ${res.status})`);
  const size = Number(res.headers.get("content-length") || 0);
  if (maxBytes && size > maxBytes) throw Object.assign(new Error("export too large"), { tooLarge: true, size });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (maxBytes && bytes.length > maxBytes) throw Object.assign(new Error("export too large"), { tooLarge: true, size: bytes.length });
  return bytes;
}

/**
 * Starts importing a SQL dump into an (empty) D1 database: init -> upload -> ingest. Returns { status, bookmark }; while the status
 * is "active" the caller keeps calling pollD1Import with the bookmark (resumable across runs: nothing is imported twice).
 */
export async function importD1Sql(env, { databaseId, sql }) {
  const bytes = typeof sql === "string" ? new TextEncoder().encode(sql) : new Uint8Array(sql);
  const etag = await md5Hex(bytes);
  const path = `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/import`;
  const init = (await cloudflareCall(env, "POST", path, { body: { action: "init", etag } })).result || {};
  if (init.upload_url) {
    const put = await fetch(init.upload_url, { method: "PUT", body: bytes });
    if (!put.ok) throw new Error(`D1 import upload failed (HTTP ${put.status})`);
    const r2Etag = String(put.headers.get("etag") || "").replace(/"/g, "");
    if (r2Etag && r2Etag !== etag) throw new Error("D1 import upload was corrupted in transit (checksum mismatch)");
  }
  const state = (await cloudflareCall(env, "POST", path, { body: { action: "ingest", etag, filename: init.filename } })).result || {};
  return d1ImportState(state);
}

export async function pollD1Import(env, { databaseId, bookmark }) {
  const path = `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/import`;
  const state = (await cloudflareCall(env, "POST", path, { body: { action: "poll", current_bookmark: bookmark } })).result || {};
  return d1ImportState(state, bookmark);
}

function d1ImportState(state, bookmark = null) {
  if (state.status === "error" || state.success === false) throw new Error(`D1 import failed: ${state.error || "unknown error"}`);
  if (state.status === "complete") return { status: "complete", numQueries: state.result?.num_queries ?? null };
  return { status: "active", bookmark: state.at_bookmark || bookmark };
}

export async function listKvKeys(env, { namespaceId, cursor = null, limit = 1000 }) {
  const q = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const { result, resultInfo } = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/keys${q}`);
  return { keys: (result || []).map((k) => ({ name: k.name, expiration: k.expiration || null, metadata: k.metadata ?? null })), cursor: resultInfo?.cursor || null };
}

export async function getKvValue(env, { namespaceId, key }) {
  const res = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, { raw: true });
  return new Uint8Array(await res.arrayBuffer());
}

/** entries: [{ key, value (base64), base64: true, expiration?, metadata? }] — at most 10,000 per call. */
export async function putKvBulk(env, { namespaceId, entries }) {
  await cloudflareCall(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/bulk`, { body: entries });
  return { ok: true };
}

export async function listR2Objects(env, { bucket, cursor = null, perPage = 1000 }) {
  const q = `?per_page=${perPage}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const { result, resultInfo } = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects${q}`);
  return {
    objects: (result || []).map((o) => ({ key: o.key, size: o.size || 0, contentType: o.http_metadata?.contentType || null, lastModified: o.last_modified || null })),
    cursor: resultInfo?.is_truncated ? resultInfo.cursor : null
  };
}

export async function getR2Object(env, { bucket, key }) {
  const res = await cloudflareCall(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeR2Key(key)}`, { raw: true });
  return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || null };
}

export async function putR2Object(env, { bucket, key, body, contentType }) {
  await cloudflareCall(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeR2Key(key)}`, { rawBody: body, contentType });
  return { ok: true };
}

function encodeR2Key(key) { return String(key).split("/").map(encodeURIComponent).join("/"); }

/**
 * Checks an R2 S3-compatible access key pair against the account (signed ListBuckets, AWS Signature V4, region "auto").
 * Returns { ok, status }. Only the key id appears in requests; the secret is used to sign and is never sent.
 */
export async function verifyR2S3Credentials(env, { accessKeyId, secretAccessKey, jurisdiction = "default" }) {
  const host = `${env.CF_ACCOUNT_ID}.${jurisdiction === "eu" ? "eu." : jurisdiction === "fedramp" ? "fedramp." : ""}r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex("");
  const query = "max-buckets=1";
  const canonical = ["GET", "/", query, `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, "", "host;x-amz-content-sha256;x-amz-date", payloadHash].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let k = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), date);
  for (const part of ["auto", "s3", "aws4_request"]) k = await hmac(k, part);
  const signature = [...new Uint8Array(await hmac(k, toSign))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;
  try {
    const res = await fetch(`https://${host}/?${query}`, { headers: { Authorization: auth, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash } });
    return { ok: res.ok, status: res.status };
  } catch (_) {
    return { ok: false, status: null };
  }
}

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
async function sha256Hex(s) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** MD5 (hex) of bytes — D1's import API identifies the upload by it. Workers support MD5 in crypto.subtle.digest. */
async function md5Hex(bytes) {
  try {
    return [...new Uint8Array(await crypto.subtle.digest("MD5", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    return md5Fallback(bytes);
  }
}

// Plain MD5 for runtimes without MD5 in WebCrypto (Node, used by the tests). RFC 1321.
function md5Fallback(bytes) {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes); padded[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0].map((w) => [0, 8, 16, 24].map((sh) => ((w >>> sh) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}
export const __md5ForTests = md5Fallback;
