// test/support/fake-infra-provider.js
//
// Implements infra-provider.js's contract with no network calls, so
// worker/provisioning.js's actual orchestration logic (idempotency,
// resumability, failure handling, site status transitions) can be
// tested deterministically -- the same pattern as
// fake-billing-provider.js for the billing service.

export function createFakeInfraProvider() {
  let nextId = 1;
  const calls = [];
  let failNextCallOfType = null; // { type: 'createDatabase', message } -- for failure-path tests

  const provider = {
    PROVIDER_NAME: "fake-cloudflare",
    _calls: calls,
    _routeFailByPattern: new Map(),   // pattern -> message: ensureWorkerRoute throws for that pattern (move-site tests)

    /** Makes the NEXT call to the named method throw, once. */
    _failNextCall(type, message) {
      failNextCallOfType = { type, message };
    },

    async createDatabase(env, { name }) {
      calls.push({ method: "createDatabase", name });
      if (failNextCallOfType?.type === "createDatabase") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      const resourceId = `fake-d1-${nextId++}`;
      provider._databases.set(resourceId, name);
      return { resourceId, metadata: { name } };
    },
    _databases: new Map(),      // resourceId -> name (what exists in the account)
    _namespaces: new Map(),     // resourceId -> title
    _buckets: new Set(),        // bucket resource ids
    _bucketBlocked: new Map(),  // bucket name -> ISO time until which it cannot be recreated (R2 rule after a delete)
    async findDatabaseByName(env, { name }) { calls.push({ method: "findDatabaseByName", name }); for (const [id, n] of provider._databases) if (n === name) return { resourceId: id, name: n }; return null; },
    async findKVNamespaceByName(env, { title }) { calls.push({ method: "findKVNamespaceByName", title }); for (const [id, t] of provider._namespaces) if (t === title) return { resourceId: id, title: t }; return null; },

    // Test-controlled: make a delete call fail until cleared (_deleteFailures.delete(name)).
    _deleteFailures: new Map(),
    async ensureWorkerRoute(env, { pattern, workerName, zoneId }) {
      calls.push({ method: "ensureWorkerRoute", pattern, workerName, zoneId });
      if (provider._routeFailure) throw new Error(provider._routeFailure);
      if (provider._routeFailByPattern.has(pattern)) throw new Error(provider._routeFailByPattern.get(pattern));
      return { routeId: `fake-route-${nextId++}` };
    },
    async deleteWorkerRoute(env, routeId, { zoneId } = {}) {
      calls.push({ method: "deleteWorkerRoute", routeId, zoneId });
      if (provider._deleteFailures.has("deleteWorkerRoute")) throw new Error(provider._deleteFailures.get("deleteWorkerRoute"));
      return { ok: true };
    },
    // Platform domains: zones come from _zones above (seed with _seedZone). _accessMissing: zoneId -> [permissions].
    _seedZone(name, { zoneId = `fake-zone-${nextId++}`, status = "active", records = [] } = {}) { provider._zones.set(zoneId, { name, status, nameServers: [], records: records.slice(), scanned: [] }); return zoneId; },
    _accessMissing: new Map(),
    _ssl: new Map(),
    _routes: new Map(),
    async findZoneByName(env, name) {
      calls.push({ method: "findZoneByName", name });
      const id = provider._zoneIdByName(name);
      if (!id) return null;
      const z = provider._zones.get(id);
      return { zoneId: id, name, cfStatus: z.status, status: z.status === "active" ? "active" : "pending" };
    },
    async probeZoneAccess(env, zoneId) {
      calls.push({ method: "probeZoneAccess", zoneId });
      const missing = provider._accessMissing.get(zoneId) || [];
      return { ok: missing.length === 0, missing };
    },
    async getUniversalSsl(env, zoneId) {
      calls.push({ method: "getUniversalSsl", zoneId });
      return { enabled: provider._ssl.get(zoneId) !== false };
    },
    async listWorkerRoutes(env, zoneId) {
      calls.push({ method: "listWorkerRoutes", zoneId });
      return [...(provider._routes.get(zoneId) || [])];
    },
    async setWorkerSchedule(env, { workerName, crons }) {
      calls.push({ method: "setWorkerSchedule", workerName, crons });
      if (provider._scheduleFailure) throw new Error(provider._scheduleFailure);
      return { ok: true };
    },
    async deleteWorkerScript(env, workerName) {
      calls.push({ method: "deleteWorkerScript", workerName });
      if (provider._deleteFailures.has("deleteWorkerScript")) throw new Error(provider._deleteFailures.get("deleteWorkerScript"));
      if (failNextCallOfType?.type === "deleteWorkerScript") { const m = failNextCallOfType.message; failNextCallOfType = null; throw new Error(m); }
      return { ok: true };
    },

    async deleteDatabase(env, resourceId) {
      calls.push({ method: "deleteDatabase", resourceId });
      if (provider._deleteFailures.has("deleteDatabase")) throw new Error(provider._deleteFailures.get("deleteDatabase"));
      provider._databases.delete(resourceId);
      return { ok: true };
    },

    async createKVNamespace(env, { title }) {
      calls.push({ method: "createKVNamespace", title });
      if (failNextCallOfType?.type === "createKVNamespace") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      const resourceId = `fake-kv-${nextId++}`;
      provider._namespaces.set(resourceId, title);
      return { resourceId, metadata: { title } };
    },

    async deleteKVNamespace(env, resourceId) {
      calls.push({ method: "deleteKVNamespace", resourceId });
      if (provider._deleteFailures.has("deleteKVNamespace")) throw new Error(provider._deleteFailures.get("deleteKVNamespace"));
      provider._namespaces.delete(resourceId);
      return { ok: true };
    },

    async createR2Bucket(env, { name }) {
      calls.push({ method: "createR2Bucket", name });
      if (failNextCallOfType?.type === "createR2Bucket") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      const blocked = provider._bucketBlocked.get(name);
      if (blocked && Date.parse(blocked) > Date.now()) throw Object.assign(new Error(`Bucket was deleted at ${new Date().toISOString()}; same-name recreation is blocked until ${blocked}`), { httpStatus: 409 });
      const resourceId = `fake-r2-${nextId++}`;
      provider._buckets.add(resourceId);
      provider._bucketNames = provider._bucketNames || new Map(); provider._bucketNames.set(resourceId, name);
      return { resourceId, metadata: { name } };
    },

    async deleteR2Bucket(env, resourceId) {
      calls.push({ method: "deleteR2Bucket", resourceId });
      if (provider._deleteFailures.has("deleteR2Bucket")) throw new Error(provider._deleteFailures.get("deleteR2Bucket"));
      provider._buckets.delete(resourceId);
      return { ok: true };
    },

    // --- Phase 4 additions ---

    async uploadWorkerScript(env, { workerName, scriptContent, bindings, assets, profile = null, assetsConfig = null }) {
      calls.push({ method: "uploadWorkerScript", workerName, scriptContent, bindings, profile, assetsConfig, assetManifest: assets ? assets.manifest : null });
      if (assets) {
        // Prove the readAsset supplier works for every manifest entry.
        for (const meta of Object.values(assets.manifest)) {
          const bytes = await assets.readAsset(meta.hash);
          if (!bytes) throw new Error("asset missing: " + meta.hash);
        }
      }
      if (failNextCallOfType?.type === "uploadWorkerScript") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      return { ok: true };
    },

    async runD1Query(env, { databaseId, sql, params }) {
      calls.push({ method: "runD1Query", databaseId, sql, params });
      if (failNextCallOfType?.type === "runD1Query") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      return { ok: true, results: [] };
    },


    // --- v1: custom domains by nameserver delegation ---------------------------------------------------------
    // Zones are created "pending"; a test calls _activateZone() to model Cloudflare seeing the delegation.
    _zones: new Map(),            // zoneId -> { name, status, nameServers, records: [], scanned: [] }
    _customDomains: new Map(),    // customDomainId -> { hostname, workerName, zoneId }
    _zoneFailure: null,           // message: createZone throws it once
    _attachFailure: null,         // message: attachWorkerDomain throws while set
    _activationChecks: 0,
    _activationCheckFailure: false,
    _setZoneStatus(zoneId, status) { provider._zones.get(zoneId).status = status; },
    _activateZone(zoneId) { provider._zones.get(zoneId).status = "active"; },
    _zoneIdByName(name) { for (const [id, z] of provider._zones) if (z.name === name) return id; return null; },
    async createZone(env, { name }) {
      calls.push({ method: "createZone", name });
      if (provider._zoneFailure) { const m = provider._zoneFailure; provider._zoneFailure = null; throw new Error(m); }
      const existing = provider._zoneIdByName(name);
      const id = existing || `fake-zone-${nextId++}`;
      if (!existing) provider._zones.set(id, { name, status: "pending", nameServers: ["amy.ns.fake.test", "bob.ns.fake.test"], records: [], scanned: [] });
      const z = provider._zones.get(id);
      return { zoneId: id, nameServers: z.nameServers, originalNameServers: [], cfStatus: z.status, status: z.status === "active" ? "active" : z.status === "gone" ? "gone" : "pending" };
    },
    async getZone(env, zoneId) {
      calls.push({ method: "getZone", zoneId });
      const z = provider._zones.get(zoneId);
      if (!z || z.status === "deleted") return { zoneId, nameServers: [], originalNameServers: [], cfStatus: "deleted", status: "gone" };
      return { zoneId, nameServers: z.nameServers, originalNameServers: [], cfStatus: z.status, status: z.status === "active" ? "active" : z.status === "gone" ? "gone" : "pending" };
    },
    async requestActivationCheck(env, zoneId) {
      calls.push({ method: "requestActivationCheck", zoneId });
      provider._activationChecks++;
      if (provider._activationCheckFailure) throw new Error("rate limited");
      return { ok: true };
    },
    async deleteZone(env, zoneId) {
      calls.push({ method: "deleteZone", zoneId });
      if (provider._deleteFailures.has("deleteZone")) throw new Error(provider._deleteFailures.get("deleteZone"));
      const z = provider._zones.get(zoneId);
      if (z) z.status = "deleted";
      return { ok: true };
    },
    async triggerDnsScan(env, zoneId) { calls.push({ method: "triggerDnsScan", zoneId }); return { ok: true }; },
    async listScannedRecords(env, zoneId) { calls.push({ method: "listScannedRecords", zoneId }); return provider._zones.get(zoneId)?.scanned || []; },
    async acceptScannedRecords(env, zoneId, ids) {
      calls.push({ method: "acceptScannedRecords", zoneId, ids });
      const z = provider._zones.get(zoneId);
      const take = z.scanned.filter((r) => !ids || ids.includes(r.id));
      z.records.push(...take); z.scanned = z.scanned.filter((r) => !take.includes(r));
      return { ok: true, accepted: take.length };
    },
    async listDnsRecords(env, zoneId) { calls.push({ method: "listDnsRecords", zoneId }); return (provider._zones.get(zoneId)?.records || []).slice(); },
    async createDnsRecord(env, zoneId, record) {
      calls.push({ method: "createDnsRecord", zoneId, record });
      const z = provider._zones.get(zoneId);
      if (z.records.some((r) => r.type === record.type && r.name === record.name && r.content === record.content)) throw new Error("Record already exists.");
      const rec = { id: String(nextId++).padStart(32, "0"), ttl: 1, proxied: false, priority: null, ...record };
      z.records.push(rec);
      return rec;
    },
    async deleteDnsRecord(env, zoneId, recordId) {
      calls.push({ method: "deleteDnsRecord", zoneId, recordId });
      const z = provider._zones.get(zoneId);
      z.records = z.records.filter((r) => r.id !== recordId);
      return { ok: true };
    },
    async attachWorkerDomain(env, { hostname, workerName, zoneId, zoneName }) {
      calls.push({ method: "attachWorkerDomain", hostname, workerName, zoneId, zoneName });
      if (provider._attachFailure) throw new Error(provider._attachFailure);
      const z = provider._zones.get(zoneId);
      // Cloudflare refuses while A/AAAA/CNAME records for the hostname exist (the service must have removed them).
      if (z && z.records.some((r) => r.name === hostname && ["A", "AAAA", "CNAME"].includes(r.type))) throw new Error("Hostname already has externally managed DNS records");
      const id = `fake-cd-${nextId++}`;
      provider._customDomains.set(id, { hostname, workerName, zoneId });
      return { customDomainId: id, certId: null };
    },
    async detachWorkerDomain(env, customDomainId) {
      calls.push({ method: "detachWorkerDomain", customDomainId });
      if (provider._deleteFailures.has("detachWorkerDomain")) throw new Error(provider._deleteFailures.get("detachWorkerDomain"));
      provider._customDomains.delete(customDomainId);
      return { ok: true };
    },

    _customHostnameRecords: new Map(),   // v1.1: records Cloudflare still wants (ownership TXT ...), by hostname
    _fallbackOrigin: { origin: "customers.sites.lummet.test", status: "active" },
    _setFallbackOrigin(v) { provider._fallbackOrigin = v; },
    _hostnameByResource: new Map(),
    async createCustomHostname(env, { hostname }) {
      calls.push({ method: "createCustomHostname", hostname });
      if (provider._deleteFailures.has("createCustomHostname")) throw new Error(provider._deleteFailures.get("createCustomHostname"));
      const resourceId = `fake-hostname-${nextId++}`;
      provider._hostnameByResource.set(resourceId, hostname);
      return { resourceId, records: (provider._customHostnameRecords.get(hostname) || []).slice() };
    },
    async getCustomHostnameDetail(env, resourceId) {
      calls.push({ method: "getCustomHostnameDetail", resourceId });
      const host = provider._hostnameByResource.get(resourceId);
      return { status: provider._customHostnameStatuses.get(resourceId) || "pending", hostnameStatus: "pending", records: (provider._customHostnameRecords.get(host) || []).slice() };
    },
    async getFallbackOrigin() {
      calls.push({ method: "getFallbackOrigin" });
      if (!provider._fallbackOrigin) throw new Error("not enabled");
      return provider._fallbackOrigin;
    },
    async setFallbackOrigin(env, { origin }) { calls.push({ method: "setFallbackOrigin", origin }); provider._fallbackOrigin = { origin, status: "active" }; return { ok: true }; },

    // Test-controlled: defaults to 'pending' until the test calls
    // _setCustomHostnameStatus() to simulate Cloudflare's own async
    // SSL issuance completing (or failing).
    _customHostnameStatuses: new Map(),
    _setCustomHostnameStatus(resourceId, status) {
      provider._customHostnameStatuses.set(resourceId, status);
    },
    async getCustomHostnameStatus(env, resourceId) {
      calls.push({ method: "getCustomHostnameStatus", resourceId });
      return { status: provider._customHostnameStatuses.get(resourceId) || "pending" };
    },

    async deleteCustomHostname(env, resourceId) {
      calls.push({ method: "deleteCustomHostname", resourceId });
      if (provider._deleteFailures.has("deleteCustomHostname")) throw new Error(provider._deleteFailures.get("deleteCustomHostname"));
      return { ok: true };
    },

    // --- Customer-owned Cloudflare accounts (custom-hosting.js) ---
    // Calls record env.CF_ACCOUNT_ID so tests can prove which account a call used.
    _badTokens: new Set(),            // CF_API_TOKEN values that verifyApiToken rejects
    _missingPerms: new Map(),         // accountId -> [capability keys that probe as forbidden]
    _workersSubdomains: new Map(),    // accountId -> subdomain (absent = none yet; default "fake-sub")
    _noSubdomain: new Set(),          // accountIds with no workers.dev subdomain
    _r2KeysValid: true,
    _r2: new Map(),                   // bucket -> Map(key -> { body, contentType })
    _kv: new Map(),                   // namespaceId -> Map(key -> value)
    _d1Dumps: new Map(),              // databaseId -> SQL text (export) / imported SQL
    _turnstile: new Map(),
    async verifyApiToken(env) {
      calls.push({ method: "verifyApiToken", accountId: env.CF_ACCOUNT_ID });
      if (provider._badTokens.has(env.CF_API_TOKEN)) return { ok: false, status: "invalid", expiresOn: null };
      return { ok: true, status: "active", expiresOn: null };
    },
    async getAccountDetails(env) {
      calls.push({ method: "getAccountDetails", accountId: env.CF_ACCOUNT_ID });
      return { id: env.CF_ACCOUNT_ID, name: "Fake account" };
    },
    async probeAccountPermissions(env) {
      calls.push({ method: "probeAccountPermissions", accountId: env.CF_ACCOUNT_ID });
      const missing = provider._missingPerms.get(env.CF_ACCOUNT_ID) || [];
      return ["workers_scripts", "d1", "kv", "r2", "turnstile", "workers_subdomain", "zones"].map((key) => missing.includes(key) ? { key, ok: false, code: key === "r2" ? "r2_not_enabled" : "forbidden", message: "forbidden" } : { key, ok: true });
    },
    async getWorkersSubdomain(env) {
      calls.push({ method: "getWorkersSubdomain", accountId: env.CF_ACCOUNT_ID });
      if (provider._noSubdomain.has(env.CF_ACCOUNT_ID)) return null;
      return provider._workersSubdomains.get(env.CF_ACCOUNT_ID) || "fake-sub";
    },
    async createWorkersSubdomain(env, { subdomain }) {
      calls.push({ method: "createWorkersSubdomain", accountId: env.CF_ACCOUNT_ID, subdomain });
      provider._noSubdomain.delete(env.CF_ACCOUNT_ID);
      provider._workersSubdomains.set(env.CF_ACCOUNT_ID, subdomain);
      return subdomain;
    },
    async setWorkersDevEnabled(env, { workerName, enabled }) {
      calls.push({ method: "setWorkersDevEnabled", accountId: env.CF_ACCOUNT_ID, workerName, enabled });
      return { ok: true };
    },
    async listAccountZones(env) {
      calls.push({ method: "listAccountZones", accountId: env.CF_ACCOUNT_ID });
      return [...provider._zones].map(([id, z]) => ({ id, name: z.name, status: z.status, nameServers: z.nameServers || [], plan: "Free" }));
    },
    async listWorkerDomains(env, { hostname } = {}) {
      calls.push({ method: "listWorkerDomains", accountId: env.CF_ACCOUNT_ID, hostname });
      return [...provider._customDomains].filter(([, d]) => !hostname || d.hostname === hostname).map(([id, d]) => ({ id, hostname: d.hostname, service: d.workerName, zoneId: d.zoneId }));
    },
    async createTurnstileWidget(env, { name, domains }) {
      calls.push({ method: "createTurnstileWidget", accountId: env.CF_ACCOUNT_ID, name, domains });
      if (failNextCallOfType?.type === "createTurnstileWidget") { const m = failNextCallOfType.message; failNextCallOfType = null; throw new Error(m); }
      const sitekey = `0xFAKESITEKEY${nextId++}`;
      provider._turnstile.set(sitekey, { name, domains });
      return { sitekey, secret: `0xFAKESECRET${nextId++}` };
    },
    async updateTurnstileWidget(env, { sitekey, name, domains }) {
      calls.push({ method: "updateTurnstileWidget", accountId: env.CF_ACCOUNT_ID, sitekey, domains });
      provider._turnstile.set(sitekey, { name, domains });
      return { ok: true };
    },
    async deleteTurnstileWidget(env, sitekey) {
      calls.push({ method: "deleteTurnstileWidget", accountId: env.CF_ACCOUNT_ID, sitekey });
      provider._turnstile.delete(sitekey);
      return { ok: true };
    },
    async exportD1Database(env, { databaseId }) {
      calls.push({ method: "exportD1Database", accountId: env.CF_ACCOUNT_ID, databaseId });
      return { status: "complete", signedUrl: `https://d1-export.fake.test/${databaseId}` };
    },
    async downloadD1Export(env, { signedUrl }) {
      calls.push({ method: "downloadD1Export", signedUrl });
      const id = signedUrl.split("/").pop();
      return new TextEncoder().encode(provider._d1Dumps.get(id) || "CREATE TABLE t (x);");
    },
    async importD1Sql(env, { databaseId, sql }) {
      calls.push({ method: "importD1Sql", accountId: env.CF_ACCOUNT_ID, databaseId });
      provider._d1Dumps.set(databaseId, typeof sql === "string" ? sql : new TextDecoder().decode(sql));
      return { status: "complete", bookmark: null };
    },
    async pollD1Import(env, { databaseId }) {
      calls.push({ method: "pollD1Import", accountId: env.CF_ACCOUNT_ID, databaseId });
      return { status: "complete", bookmark: null };
    },
    async listKvKeys(env, { namespaceId }) {
      calls.push({ method: "listKvKeys", accountId: env.CF_ACCOUNT_ID, namespaceId });
      return { keys: [...(provider._kv.get(namespaceId) || new Map()).keys()].map((name) => ({ name })), cursor: null };
    },
    async getKvValue(env, { namespaceId, key }) {
      calls.push({ method: "getKvValue", accountId: env.CF_ACCOUNT_ID, namespaceId, key });
      const v = (provider._kv.get(namespaceId) || new Map()).get(key);
      if (v === undefined) throw Object.assign(new Error("key not found"), { httpStatus: 404 });
      return typeof v === "string" ? new TextEncoder().encode(v) : v;
    },
    async putKvBulk(env, { namespaceId, entries }) {
      calls.push({ method: "putKvBulk", accountId: env.CF_ACCOUNT_ID, namespaceId, count: entries.length });
      if (!provider._kv.has(namespaceId)) provider._kv.set(namespaceId, new Map());
      for (const e of entries) provider._kv.get(namespaceId).set(e.key, e.value);
      return { ok: true };
    },
    async listR2Objects(env, { bucket }) {
      calls.push({ method: "listR2Objects", accountId: env.CF_ACCOUNT_ID, bucket });
      return { objects: [...(provider._r2.get(bucket) || new Map())].map(([key, o]) => ({ key, size: o.body.length, contentType: o.contentType })), cursor: null };
    },
    async getR2Object(env, { bucket, key }) {
      calls.push({ method: "getR2Object", accountId: env.CF_ACCOUNT_ID, bucket, key });
      const o = (provider._r2.get(bucket) || new Map()).get(key);
      if (!o) throw new Error("object not found");
      return { body: o.body, contentType: o.contentType };
    },
    async putR2Object(env, { bucket, key, body, contentType }) {
      calls.push({ method: "putR2Object", accountId: env.CF_ACCOUNT_ID, bucket, key });
      if (!provider._r2.has(bucket)) provider._r2.set(bucket, new Map());
      provider._r2.get(bucket).set(key, { body, contentType });
      return { ok: true };
    },
    async verifyR2S3Credentials(env) {
      calls.push({ method: "verifyR2S3Credentials", accountId: env.CF_ACCOUNT_ID });
      return provider._r2KeysValid ? { ok: true, status: 200 } : { ok: false, status: 403 };
    },

    // Test-controlled: defaults to healthy; a test can call
    // _setHealthCheckResult() to simulate an unreachable deployment.
    _healthCheckResult: { ok: true, statusCode: 200 },
    _setHealthCheckResult(result) {
      provider._healthCheckResult = result;
    },
    _healthByUrl: new Map(),
    async checkHealth(env, { url }) {
      calls.push({ method: "checkHealth", url });
      if (provider._healthByUrl.has(url)) return provider._healthByUrl.get(url);
      return provider._healthCheckResult;
    }
  };

  return provider;
}
