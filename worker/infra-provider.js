// =====================================================
// INFRASTRUCTURE PROVIDER INTERFACE (master prompt
// sections 18-19)
//
// Every provider module (infra-cloudflare.js today; a future
// infra-gcp.js or infra-aws.js later) must implement exactly
// this shape. worker/provisioning.js's
// createProvisioningService(infraProvider) is written against
// this contract only, the same pattern already used for
// billing-provider.js/billing.js — swap the provider, or
// substitute a fake one in tests, without touching the
// orchestration logic.
//
// Deliberately small: only the resource types Phase 3 actually
// provisions (D1, KV, R2), plus the additions Phase 4 needed
// for deployment and domain management (Worker script upload,
// remote D1 queries, custom-hostname SSL, health checks) — see
// the "Phase 4 additions" section below.
//
// No runtime code lives here — documentation only, same as
// billing-provider.js.
// =====================================================

/**
 * @typedef {Object} InfrastructureProvider
 *
 * @property {string} PROVIDER_NAME
 *   Stable machine key stored in site_resources.provider — e.g. "cloudflare".
 *
 * @property {(env: Object, params: {name: string}) => Promise<{resourceId: string, metadata: ?Object}>} createDatabase
 * @property {(env: Object, params: {pattern: string, workerName: string}) => Promise<{routeId: string}>} ensureWorkerRoute
 * @property {(env: Object, routeId: string) => Promise<{ok: boolean}>} deleteWorkerRoute
 * @property {(env: Object, params: {workerName: string, crons: string[]}) => Promise<{ok: boolean}>} setWorkerSchedule
 * @property {(env: Object, workerName: string) => Promise<{ok: boolean}>} deleteWorkerScript
 * @property {(env: Object, resourceId: string) => Promise<{ok: boolean}>} deleteDatabase
 *
 * @property {(env: Object, params: {title: string}) => Promise<{resourceId: string, metadata: ?Object}>} createKVNamespace
 * @property {(env: Object, resourceId: string) => Promise<{ok: boolean}>} deleteKVNamespace
 *
 * @property {(env: Object, params: {name: string}) => Promise<{resourceId: string, metadata: ?Object}>} createR2Bucket
 * @property {(env: Object, resourceId: string) => Promise<{ok: boolean}>} deleteR2Bucket
 *
 * --- Phase 4 additions (deployment + domain management) ---
 *
 * @property {(env: Object, params: {workerName: string, scriptContent: string, bindings?: Object[], assets?: ?{manifest: Object, readAsset: function}}) => Promise<{ok: boolean}>} uploadWorkerScript
 *   Creates or updates (same call either way, matching Cloudflare's
 *   own PUT-is-upsert semantics) a Worker script's code.
 *
 * @property {(env: Object, params: {databaseId: string, sql: string}) => Promise<{ok: boolean, results: ?Array}>} runD1Query
 *   Executes one SQL statement against a remote D1 database — used
 *   to apply a site's own tenant-application migrations.
 *
 * @property {(env: Object, params: {hostname: string}) => Promise<{resourceId: string}>} createCustomHostname
 *   Registers a customer-supplied hostname for SSL issuance
 *   ("SSL for SaaS" / Cloudflare for SaaS custom hostnames).
 * @property {(env: Object, resourceId: string) => Promise<{status: string}>} getCustomHostnameStatus
 *   Returns one of: pending | active | failed — see
 *   infra-cloudflare.js's normalizeCustomHostnameStatus() for the
 *   ONLY place a Cloudflare-specific SSL status string is read.
 * @property {(env: Object, resourceId: string) => Promise<{ok: boolean}>} deleteCustomHostname
 *
 * @property {(env: Object, params: {url: string}) => Promise<{ok: boolean, statusCode: ?number}>} checkHealth
 *   A plain HTTP health check against a deployed site's reachable
 *   URL — kept on the provider interface (rather than an ad-hoc
 *   fetch in deployments.js) so it's fakeable the same way as every
 *   other network-touching call in this codebase.
 */
export const CONTRACT_VERSION = 1;
