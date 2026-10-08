// Load-test engine used by scripts/loadtest.mjs (and exercised by an automated
// test against an in-process server, so the harness itself is verified).
import { emailFor, orgFor, SHARED_ORG } from "./loadtest-seed.mjs";

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(samples, elapsedMs) {
  const latencies = samples.filter((s) => s.status !== 0).map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const s of samples) statuses[s.status] = (statuses[s.status] || 0) + 1;
  const total = samples.length;
  const serverErrors = samples.filter((s) => s.status >= 500 || s.status === 0).length;
  const rateLimited = samples.filter((s) => s.status === 429).length;
  const unexpected = samples.filter((s) => !s.ok && s.status !== 429 && s.status < 500 && s.status !== 0).length;
  return {
    requests: total,
    seconds: +(elapsedMs / 1000).toFixed(1),
    requestsPerSecond: +((total / elapsedMs) * 1000).toFixed(1),
    statuses,
    serverErrors, rateLimited, unexpected,
    errorRate: total ? +((serverErrors + unexpected) / total).toFixed(4) : 0,
    ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies[latencies.length - 1] ?? null }
  };
}

async function timed(fetchImpl, url, init, okStatuses) {
  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, { redirect: "manual", ...init });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t0, ok: okStatuses.includes(res.status), headers: res.headers, text };
  } catch (_) {
    return { status: 0, ms: performance.now() - t0, ok: false, text: "" };    // network error / timeout
  }
}

export async function login(base, i, password, fetchImpl = fetch) {
  const r = await timed(fetchImpl, `${base}/api/customer/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: emailFor(i), password })
  }, [200]);
  const cookie = (r.headers && r.headers.get("set-cookie") || "").split(";")[0];
  return { ...r, cookie };
}

// Each scenario is one "user action". `u` = { i, cookie, orgId }.
export const SCENARIOS = {
  // Read-heavy browsing of the customer portal and its JSON APIs.
  "portal-read": async (c, u, n) => {
    const paths = [`/app/overview`, `/api/organizations/${u.orgId}/sites`, `/api/organizations/${u.orgId}/usage`, `/api/organizations/${u.orgId}/api-keys`, `/app/domains`];
    return timed(c.fetch, c.base + paths[n % paths.length], { headers: { Cookie: u.cookie } }, [200]);
  },
  // Writes spread over many organizations (the normal shape of production traffic).
  "write-own": async (c, u, n) => {
    const base = `${c.base}/api/organizations/${u.orgId}/api-keys`;
    const h = { Cookie: u.cookie, "Content-Type": "application/json" };
    const made = await timed(c.fetch, base, { method: "POST", headers: h, body: JSON.stringify({ name: `lt-${u.i}-${n}`, scopes: ["sites:read"] }) }, [200]);
    if (made.ok) {
      try {
        const id = JSON.parse(made.text).id || JSON.parse(made.text).keyId;
        if (id) { const del = await timed(c.fetch, `${base}/${id}`, { method: "DELETE", headers: h }, [200]); return { ...del, ms: made.ms + del.ms }; }
      } catch (_) { /* leave the key; cleanup removes the organization */ }
    }
    return made;
  },
  // Every virtual user writing into ONE organization: worst case for D1's single writer.
  "write-hot": async (c, u, n) => timed(c.fetch, `${c.base}/api/organizations/${SHARED_ORG}/api-keys`, {
    method: "POST", headers: { Cookie: u.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: `hot-${u.i}-${n}`, scopes: ["sites:read"] })
  }, [200]),
  // Password login is deliberately expensive (PBKDF2): shows the CPU cost of sign-ins.
  login: async (c, u) => { const r = await login(c.base, u.i, c.password, c.fetch); return { status: r.status, ms: r.ms, ok: r.ok }; },
  // The alert/backup pinger tick (needs ALERT_CHECK_TOKEN).
  "ops-ping": async (c) => timed(c.fetch, `${c.base}/api/ops/alert-check`, { method: "POST", headers: { Authorization: `Bearer ${c.opsToken}` } }, [200])
};

export function assertTargetAllowed(baseUrl, allowHost) {
  const host = new URL(baseUrl).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!local && allowHost !== host) {
    throw new Error(`Refusing to run against ${host}. Pass --allow-host ${host} to confirm it is a STAGING environment (this writes data).`);
  }
  return host;
}

export async function runLoad({ base, scenario, users, password, concurrency, durationSec, maxRequests, opsToken, fetchImpl = fetch, log = () => {} }) {
  const fn = SCENARIOS[scenario];
  if (!fn) throw new Error(`Unknown scenario "${scenario}". Choose: ${Object.keys(SCENARIOS).join(", ")}`);

  // Log everyone in first (not measured), then spread virtual users across them.
  const pool = [];
  if (scenario !== "ops-ping") {
    for (let i = 0; i < users; i++) {
      const r = await login(base, i, password, fetchImpl);
      if (!r.ok || !r.cookie) throw new Error(`Setup login failed for lt-${i} (status ${r.status}). Was the seed applied with this LOADTEST_PASSWORD?`);
      pool.push({ i, cookie: r.cookie, orgId: orgFor(i) });
    }
  } else pool.push({ i: 0 });
  log(`logged in ${pool.length} test user(s)`);

  const ctx = { base, fetch: fetchImpl, password, opsToken };
  const samples = [];
  const stopAt = performance.now() + durationSec * 1000;
  let started = 0;
  const t0 = performance.now();
  const worker = async (w) => {
    let n = 0;
    while (performance.now() < stopAt && (!maxRequests || started < maxRequests)) {
      started += 1;
      const u = pool[(w + n) % pool.length];
      const r = await fn(ctx, u, n++);
      samples.push({ status: r.status, ms: r.ms, ok: r.ok });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  return summarize(samples, performance.now() - t0);
}
