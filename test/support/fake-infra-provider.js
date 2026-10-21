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
      return { resourceId: `fake-d1-${nextId++}`, metadata: { name } };
    },

    // Test-controlled: make a delete call fail until cleared (_deleteFailures.delete(name)).
    _deleteFailures: new Map(),
    async ensureWorkerRoute(env, { pattern, workerName }) {
      calls.push({ method: "ensureWorkerRoute", pattern, workerName });
      if (provider._routeFailure) throw new Error(provider._routeFailure);
      return { routeId: `fake-route-${nextId++}` };
    },
    async deleteWorkerRoute(env, routeId) {
      calls.push({ method: "deleteWorkerRoute", routeId });
      if (provider._deleteFailures.has("deleteWorkerRoute")) throw new Error(provider._deleteFailures.get("deleteWorkerRoute"));
      return { ok: true };
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
      return { ok: true };
    },

    async createKVNamespace(env, { title }) {
      calls.push({ method: "createKVNamespace", title });
      if (failNextCallOfType?.type === "createKVNamespace") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      return { resourceId: `fake-kv-${nextId++}`, metadata: { title } };
    },

    async deleteKVNamespace(env, resourceId) {
      calls.push({ method: "deleteKVNamespace", resourceId });
      if (provider._deleteFailures.has("deleteKVNamespace")) throw new Error(provider._deleteFailures.get("deleteKVNamespace"));
      return { ok: true };
    },

    async createR2Bucket(env, { name }) {
      calls.push({ method: "createR2Bucket", name });
      if (failNextCallOfType?.type === "createR2Bucket") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      return { resourceId: `fake-r2-${nextId++}`, metadata: { name } };
    },

    async deleteR2Bucket(env, resourceId) {
      calls.push({ method: "deleteR2Bucket", resourceId });
      if (provider._deleteFailures.has("deleteR2Bucket")) throw new Error(provider._deleteFailures.get("deleteR2Bucket"));
      return { ok: true };
    },

    // --- Phase 4 additions ---

    async uploadWorkerScript(env, { workerName, scriptContent, bindings, assets }) {
      calls.push({ method: "uploadWorkerScript", workerName, scriptContent, bindings, assetManifest: assets ? assets.manifest : null });
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
      const rec = { id: `fake-rec-${nextId++}`, ttl: 1, proxied: false, priority: null, ...record };
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
