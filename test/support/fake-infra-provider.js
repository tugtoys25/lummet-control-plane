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

    async runD1Query(env, { databaseId, sql }) {
      calls.push({ method: "runD1Query", databaseId, sql });
      if (failNextCallOfType?.type === "runD1Query") {
        const message = failNextCallOfType.message;
        failNextCallOfType = null;
        throw new Error(message);
      }
      return { ok: true, results: [] };
    },

    async createCustomHostname(env, { hostname }) {
      calls.push({ method: "createCustomHostname", hostname });
      return { resourceId: `fake-hostname-${nextId++}` };
    },

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
    async checkHealth(env, { url }) {
      calls.push({ method: "checkHealth", url });
      return provider._healthCheckResult;
    }
  };

  return provider;
}
