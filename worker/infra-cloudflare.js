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
    throw new Error(message);
  }
  return data.result;
}

export async function createDatabase(env, { name }) {
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/d1/database`, { name });
  return { resourceId: result.uuid, metadata: { name: result.name } };
}

/**
 * Routes one hostname to one site's Worker: pattern "<host>/*" on the
 * platform zone (CF_ZONE_ID; the same zone used for custom hostnames).
 * Idempotent: if the route already exists, its id is returned instead
 * of an error. Needs a proxied DNS record covering the hostname
 * (a wildcard record, set up once; see DEPLOYMENT.md).
 */
export async function ensureWorkerRoute(env, { pattern, workerName }) {
  if (!env.CF_ZONE_ID) throw new Error(`CF_ZONE_ID is not configured on this Worker, so ${pattern} cannot be routed to the site`);
  try {
    const result = await cloudflareRequest(env, "POST", `/zones/${env.CF_ZONE_ID}/workers/routes`, { pattern, script: workerName });
    return { routeId: result.id };
  } catch (err) {
    if (!/already exists|duplicate/i.test(String(err.message))) throw err;
    const list = await cloudflareRequest(env, "GET", `/zones/${env.CF_ZONE_ID}/workers/routes`);
    const existing = (Array.isArray(list) ? list : []).find((r) => r.pattern === pattern);
    if (!existing) throw err;
    if (existing.script !== workerName) {
      // Same hostname bound to a different Worker: take it over for this site.
      await cloudflareRequest(env, "PUT", `/zones/${env.CF_ZONE_ID}/workers/routes/${existing.id}`, { pattern, script: workerName });
    }
    return { routeId: existing.id };
  }
}

export async function deleteWorkerRoute(env, routeId) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  await cloudflareRequest(env, "DELETE", `/zones/${env.CF_ZONE_ID}/workers/routes/${routeId}`);
  return { ok: true };
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

/**
 * Creates or updates a Worker (same PUT either way). Uses FormData
 * (native in the Workers runtime): a "metadata" JSON part plus one part
 * per module, per Cloudflare's module-worker upload format.
 *
 * bindings: Cloudflare binding objects (see site-bindings.js).
 * assets:   optional { manifest, readAsset }; uploaded first and attached
 *           via the completion token. run_worker_first keeps the tenant
 *           Worker in front of its static files, as in its wrangler.jsonc.
 */
export async function uploadWorkerScript(env, { workerName, scriptContent, bindings = [], assets = null }) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is not configured on this Worker");
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is not configured on this Worker");

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2024-09-23",
    compatibility_flags: ["nodejs_compat"],
    bindings
  };
  if (assets) {
    const jwt = await uploadAssets(env, { workerName, manifest: assets.manifest, readAsset: assets.readAsset });
    metadata.assets = { jwt, config: { run_worker_first: true } };
  }

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

export async function runD1Query(env, { databaseId, sql }) {
  const result = await cloudflareRequest(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/query`, { sql });
  return { ok: true, results: Array.isArray(result) ? result : [result] };
}

export async function createCustomHostname(env, { hostname }) {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured on this Worker");
  const result = await cloudflareRequest(env, "POST", `/zones/${env.CF_ZONE_ID}/custom_hostnames`, {
    hostname,
    ssl: { method: "http", type: "dv" }
  });
  return { resourceId: result.id };
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
