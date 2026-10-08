// test/support/fake-tenant-client.js
//
// Implements the same shape as worker/client.js's getFromTenant/
// postToTenant (the ONLY real functions tenant-portal.js calls) --
// no network, no HMAC signing, no D1 tenant-credential lookup. A
// test queues a canned response per path (or a default) and asserts
// on what was actually requested.

export function createFakeTenantClient() {
  const calls = [];
  const responses = new Map(); // "METHOD path" -> response to return
  let defaultResponse = { ok: true, status: 200, data: { success: true } };

  function key(method, path) {
    return `${method} ${path}`;
  }

  return {
    _calls: calls,
    _setDefaultResponse(response) {
      defaultResponse = response;
    },
    _setResponse(method, path, response) {
      responses.set(key(method, path), response);
    },
    async getFromTenant(env, tenantOrId, path) {
      calls.push({ method: "GET", tenantOrId, path });
      return responses.get(key("GET", path)) || defaultResponse;
    },
    async postToTenant(env, tenantOrId, path, body) {
      calls.push({ method: "POST", tenantOrId, path, body });
      return responses.get(key("POST", path)) || defaultResponse;
    }
  };
}
