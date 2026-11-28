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
 * @property {(env: Object, params: {pattern: string, workerName: string, zoneId?: string}) => Promise<{routeId: string}>} ensureWorkerRoute
 * @property {(env: Object, routeId: string, options?: {zoneId?: string}) => Promise<{ok: boolean}>} deleteWorkerRoute
 * @property {(env: Object, name: string) => Promise<?{zoneId: string, name: string, cfStatus: string, status: 'active'|'pending'}>} findZoneByName
 *   Looks a zone up by exact name in the platform account. null = no such zone. Never creates one.
 * @property {(env: Object, zoneId: string) => Promise<{ok: boolean, missing: string[]}>} probeZoneAccess
 *   Harmless reads proving the token may edit Workers routes and DNS on the zone; `missing` names the permissions it lacks.
 * @property {(env: Object, zoneId: string) => Promise<{enabled: boolean}>} getUniversalSsl
 * @property {(env: Object, zoneId: string) => Promise<Array<{id: string, pattern: string, script: ?string}>>} listWorkerRoutes
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
 * @property {(env: Object, params: {databaseId: string, sql: string, params?: Array}) => Promise<{ok: boolean, results: ?Array}>} runD1Query
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
 *
 * --- v1 additions (custom domains by nameserver delegation; see docs/CUSTOM_DOMAINS.md) ---
 *
 * @property {(env: Object, params: {name: string}) => Promise<{zoneId: string, nameServers: string[], originalNameServers: string[], cfStatus: string, status: 'pending'|'active'|'gone'}>} createZone
 * @property {(env: Object, zoneId: string) => Promise<{zoneId: string, nameServers: string[], cfStatus: string, status: 'pending'|'active'|'gone'}>} getZone
 *   status 'gone' = the zone was deleted/moved/deactivated or no longer exists.
 * @property {(env: Object, zoneId: string) => Promise<{ok: boolean}>} requestActivationCheck
 * @property {(env: Object, zoneId: string) => Promise<{ok: boolean}>} deleteZone
 * @property {(env: Object, zoneId: string) => Promise<{ok: boolean}>} triggerDnsScan
 * @property {(env: Object, zoneId: string) => Promise<Array<{id: string, type: string, name: string, content: string, ttl: number, proxied: boolean, priority: ?number}>>} listScannedRecords
 * @property {(env: Object, zoneId: string, ids?: string[]) => Promise<{ok: boolean, accepted: number}>} acceptScannedRecords
 * @property {(env: Object, zoneId: string) => Promise<Array<{id: string, type: string, name: string, content: string, ttl: number, proxied: boolean, priority: ?number}>>} listDnsRecords
 * @property {(env: Object, zoneId: string, record: {type: string, name: string, content: string, ttl?: number, priority?: number, proxied?: boolean}) => Promise<{id: string}>} createDnsRecord
 * @property {(env: Object, zoneId: string, recordId: string) => Promise<{ok: boolean}>} deleteDnsRecord
 * @property {(env: Object, params: {hostname: string, workerName: string, zoneId: string, zoneName: string}) => Promise<{customDomainId: ?string}>} attachWorkerDomain
 *   Serves a hostname of a delegated zone from a site's Worker (Cloudflare adds the DNS record and certificate).
 * @property {(env: Object, customDomainId: string) => Promise<{ok: boolean}>} detachWorkerDomain
 *
 * --- v1.1 additions (single subdomains through Cloudflare for SaaS custom hostnames) ---
 *
 * @property {(env: Object) => Promise<{origin: ?string, status: string}>} getFallbackOrigin
 *   The SaaS zone's fallback origin. status is "active" only when custom hostnames can really be served.
 * @property {(env: Object, params: {origin: string}) => Promise<{ok: boolean}>} setFallbackOrigin
 * @property {(env: Object, resourceId: string) => Promise<{status: 'pending'|'active'|'failed', hostnameStatus: string, records: Array<{type: string, name: string, value: string}>}>} getCustomHostnameDetail
 *   Like getCustomHostnameStatus, plus any DNS records Cloudflare still wants the customer to add (ownership TXT,
 *   certificate validation) so the dashboard can show them.
 *
 * createCustomHostname additionally returns { records } with the same shape.
 *
 * --- Customer-owned Cloudflare accounts (optional; see docs/CUSTOM_CLOUDFLARE_HOSTING.md) ---
 *
 * Every function above can also run against a customer's own account: custom-hosting.js passes a scoped env
 * (CF_ACCOUNT_ID / CF_API_TOKEN of that account, decrypted only for the call) instead of Lummet's own env.
 * These are used only for those accounts:
 *
 * @property {(env: Object) => Promise<{ok: boolean, status: string, expiresOn: ?string}>} verifyApiToken
 * @property {(env: Object) => Promise<{id: string, name: ?string}>} getAccountDetails
 * @property {(env: Object) => Promise<Array<{key: string, ok: boolean, code?: string, message?: string}>>} probeAccountPermissions
 *   One entry per capability (workers_scripts, d1, kv, r2, turnstile, workers_subdomain, zones); code "r2_not_enabled" when R2 needs activating.
 * @property {(env: Object) => Promise<?string>} getWorkersSubdomain
 * @property {(env: Object, params: {subdomain: string}) => Promise<string>} createWorkersSubdomain
 * @property {(env: Object, params: {workerName: string, enabled: boolean}) => Promise<{ok: boolean}>} setWorkersDevEnabled
 * @property {(env: Object, params: {name: string}) => Promise<?{resourceId: string, name: string}>} findDatabaseByName
 * @property {(env: Object, params: {title: string}) => Promise<?{resourceId: string, title: string}>} findKVNamespaceByName
 * @property {(env: Object) => Promise<Array<{id: string, name: string, status: string, nameServers: string[], plan: ?string}>>} listAccountZones
 * @property {(env: Object, params?: {hostname?: string}) => Promise<Array<{id: string, hostname: string, service: string, zoneId: string}>>} listWorkerDomains
 * @property {(env: Object, params: {name: string, domains: string[]}) => Promise<{sitekey: string, secret: string}>} createTurnstileWidget
 * @property {(env: Object, params: {sitekey: string, name: string, domains: string[]}) => Promise<{ok: boolean}>} updateTurnstileWidget
 * @property {(env: Object, sitekey: string) => Promise<{ok: boolean}>} deleteTurnstileWidget
 * @property {(env: Object, params: {accessKeyId: string, secretAccessKey: string, jurisdiction?: string}) => Promise<{ok: boolean, status: ?number}>} verifyR2S3Credentials
 *
 * Moving an existing site to a customer account (custom-hosting-transfer.js) also copies its data:
 *
 * @property {(env: Object, params: {databaseId: string, bookmark?: ?string}) => Promise<{status: 'complete'|'active', signedUrl?: ?string, bookmark?: ?string}>} exportD1Database
 * @property {(env: Object, params: {signedUrl: string, maxBytes?: number}) => Promise<Uint8Array>} downloadD1Export
 * @property {(env: Object, params: {databaseId: string, sql: string|Uint8Array}) => Promise<{status: 'complete'|'active', bookmark: ?string}>} importD1Sql
 * @property {(env: Object, params: {databaseId: string, bookmark: string}) => Promise<{status: 'complete'|'active', bookmark: ?string}>} pollD1Import
 * @property {(env: Object, params: {namespaceId: string, cursor?: ?string, limit?: number}) => Promise<{keys: Array<{name: string, expiration: ?number, metadata: any}>, cursor: ?string}>} listKvKeys
 * @property {(env: Object, params: {namespaceId: string, key: string}) => Promise<Uint8Array>} getKvValue
 * @property {(env: Object, params: {namespaceId: string, entries: Array<Object>}) => Promise<{ok: boolean}>} putKvBulk
 * @property {(env: Object, params: {bucket: string, cursor?: ?string, perPage?: number}) => Promise<{objects: Array<{key: string, size: number, contentType: ?string}>, cursor: ?string}>} listR2Objects
 * @property {(env: Object, params: {bucket: string, key: string}) => Promise<{body: Uint8Array, contentType: ?string}>} getR2Object
 * @property {(env: Object, params: {bucket: string, key: string, body: Uint8Array, contentType: string}) => Promise<{ok: boolean}>} putR2Object
 */
export const CONTRACT_VERSION = 1;
