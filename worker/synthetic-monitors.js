// =====================================================
// SYNTHETIC MONITORS (Round 6.5A, blueprint 6.5)
//
// Four probes run on the existing five-minute tick, before the alert check:
//
//   signin         a real customer sign-in, a session check and a sign-out, over HTTP, as the monitor account
//   checkout       a test-mode checkout SESSION is created for the monitor organization (nothing is paid; the session
//                  expires on its own). Needs the sign-in session.
//   canary_site    the canary customer site is fetched and must answer 200 AND contain an owner-chosen marker
//   domain_attach  Cloudflare for SaaS attach READINESS: the API credentials work, the fallback origin is active and
//                  (optionally) the owner's permanent canary hostname still reports active. It does NOT create a
//                  hostname on every run (see docs/SYNTHETIC_MONITORS.md for why).
//
// Rules that never bend:
//   * A probe is "ok" only when every step was positively confirmed. An exception, a timeout, an unexpected status, a
//     malformed body, a missing marker: all of these are failures. Nothing is ever reported ok by default.
//   * Not configured, skipped (checkout against a live-mode key) and blocked (checkout while sign-in is down) are three
//     distinct states. None of them is ok; none of them writes an "ok" anywhere.
//   * A result that is too old is a failure ("stale"), so a monitor that stopped reporting pages instead of looking healthy.
//   * The page goes through the EXISTING alert machinery (alerts.js: once when it starts, reminders, resolved). This
//     module only produces the number that machinery reads. State lives in alert_state (see repositories/synthetic-monitors.js).
//   * Only reason CODES leave a probe: never the password, a cookie, a checkout URL, a response body or an error message.
//
// SYNTHETIC_MONITORS: off (default; nothing is probed or written), shadow (probe and record, never page), on (page).
// =====================================================

import * as repo from "./repositories/synthetic-monitors.js";
import { checkOutboundUrl } from "./url-safety.js";
import * as infraCloudflare from "./infra-cloudflare.js";
import { logAudit } from "./audit.js";

export const MONITOR_MODES = ["off", "shadow", "on"];

export const MONITORS = [
  { name: "signin", alertKey: "synthetic_signin", label: "Customer sign-in",
    alertTitle: "Synthetic monitor: customer sign-in is failing (a real sign-in, session check and sign-out did not complete)" },
  { name: "checkout", alertKey: "synthetic_checkout", label: "Test-mode checkout",
    alertTitle: "Synthetic monitor: test-mode checkout is failing (a checkout session could not be created)" },
  { name: "canary_site", alertKey: "synthetic_canary_site", label: "Canary customer site",
    alertTitle: "Synthetic monitor: the canary customer site is not serving as expected" },
  { name: "domain_attach", alertKey: "synthetic_domain_attach", label: "Domain attach",
    alertTitle: "Synthetic monitor: custom-domain attach is not ready (Cloudflare for SaaS fallback origin or the canary hostname is unhealthy)" }
];

const PROBE_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 524288;
const USER_AGENT = "LummetSyntheticMonitor/1";

/** SYNTHETIC_MONITORS: off (default, also unset or invalid), shadow, on. */
export function monitorMode(env) {
  const v = String((env && env.SYNTHETIC_MONITORS) || "off").trim().toLowerCase();
  return MONITOR_MODES.includes(v) ? v : "off";
}

function intSetting(env, key, fallback, min, max) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const text = (env, key) => (env && typeof env[key] === "string" ? env[key].trim() : "");

export function monitorSettings(env) {
  return {
    baseUrl: (text(env, "SYNTHETIC_BASE_URL") || text(env, "PORTAL_BASE_URL")).replace(/\/+$/, ""),
    email: text(env, "SYNTHETIC_SIGNIN_EMAIL").toLowerCase(),
    password: env && typeof env.SYNTHETIC_SIGNIN_PASSWORD === "string" ? env.SYNTHETIC_SIGNIN_PASSWORD : "",
    organizationId: text(env, "SYNTHETIC_ORGANIZATION_ID"),
    planId: text(env, "SYNTHETIC_CHECKOUT_PLAN_ID"),
    allowLiveCheckout: text(env, "SYNTHETIC_CHECKOUT_ALLOW_LIVE").toLowerCase() === "yes",
    canaryUrl: text(env, "SYNTHETIC_CANARY_URL"),
    canaryMarker: text(env, "SYNTHETIC_CANARY_MARKER"),
    domainResourceId: text(env, "SYNTHETIC_DOMAIN_RESOURCE_ID"),
    threshold: intSetting(env, "SYNTHETIC_FAILURE_THRESHOLD", 2, 1, 10),
    staleMinutes: intSetting(env, "SYNTHETIC_STALE_MINUTES", 20, 10, 120)
  };
}

/** "test" | "live" | "unknown" | "missing", from the key prefix only. The key itself is never returned. */
export function stripeKeyMode(env) {
  const k = text(env, "STRIPE_SECRET_KEY");
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return k ? "unknown" : "missing";
}

const isHttpsUrl = (v) => /^https:\/\/[^\s/]+/i.test(v) && checkOutboundUrl(v).ok;

/**
 * Whether a monitor can run: { state: "run" } | { state: "not_configured", reason } | { state: "skipped", reason }.
 * not_configured lists setting NAMES that are missing, never values. skipped means configured but deliberately not run.
 * Pure: the runner, the alert count and the staff view all use this one function, so they cannot disagree.
 */
export function applicability(name, env, s = monitorSettings(env)) {
  const missing = [];
  const signinMissing = () => {
    if (!isHttpsUrl(s.baseUrl)) missing.push("SYNTHETIC_BASE_URL/PORTAL_BASE_URL");
    if (!s.email) missing.push("SYNTHETIC_SIGNIN_EMAIL");
    if (!s.password) missing.push("SYNTHETIC_SIGNIN_PASSWORD");
  };
  if (name === "signin") signinMissing();
  else if (name === "checkout") {
    signinMissing();
    if (!s.organizationId) missing.push("SYNTHETIC_ORGANIZATION_ID");
    if (!s.planId) missing.push("SYNTHETIC_CHECKOUT_PLAN_ID");
  } else if (name === "canary_site") {
    if (!isHttpsUrl(s.canaryUrl)) missing.push("SYNTHETIC_CANARY_URL");
    if (!s.canaryMarker) missing.push("SYNTHETIC_CANARY_MARKER");
  } else if (name === "domain_attach") {
    for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID"]) if (!text(env, k)) missing.push(k);
  } else return { state: "not_configured", reason: "unknown_monitor" };
  if (missing.length) return { state: "not_configured", reason: `missing: ${missing.join(", ")}` };
  if (name === "checkout") {
    const mode = stripeKeyMode(env);
    if (mode === "live" && !s.allowLiveCheckout) return { state: "skipped", reason: "stripe_live_mode_key" };
    if (mode === "unknown") return { state: "skipped", reason: "stripe_key_mode_unknown" };
    if (mode === "missing") return { state: "skipped", reason: "stripe_key_missing" };
  }
  return { state: "run" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Probes. Each returns { status: "ok" } or { status: "fail", reason }. They are wrapped by safe(), which turns anything
// else (an exception, no result, an unknown status) into a failure.
// ---------------------------------------------------------------------------------------------------------------------

const okResult = (extra = {}) => ({ status: "ok", ...extra });
const failResult = (reason) => ({ status: "fail", reason });
const blockedResult = (reason) => ({ status: "blocked", reason });

async function safe(fn) {
  try {
    const r = await fn();
    if (r && (r.status === "ok" || r.status === "fail" || r.status === "blocked")) return r;
    return failResult("probe_no_result");
  } catch (error) {
    // The message is deliberately dropped: it may contain a URL, a header or a token. Only the error class is logged.
    console.error(JSON.stringify({ msg: "synthetic_probe_exception", errorName: error && error.name ? String(error.name).slice(0, 40) : "Error" }));
    return failResult("probe_exception");
  }
}

const isTimeout = (error) => !!error && (error.name === "TimeoutError" || error.name === "AbortError");

/** One HTTP call with a timeout and no redirects. Returns { res } or { reason }. */
async function call(fetchImpl, prefix, url, init) {
  try {
    const res = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res || typeof res.status !== "number") return { reason: `${prefix}_bad_response` };
    return { res };
  } catch (error) {
    return { reason: isTimeout(error) ? `${prefix}_timeout` : `${prefix}_request_failed` };
  }
}

async function readJson(res) {
  try {
    const parsed = JSON.parse((await res.text()).slice(0, MAX_BODY_CHARS));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;     // not JSON: the caller turns this into a *_bad_response failure
  }
}

function sessionCookie(res) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie")];
  for (const line of lines) {
    const pair = String(line || "").split(";")[0].trim();
    if (/^[A-Za-z0-9_.-]+=[^\s;,]+$/.test(pair)) return pair;      // a name and a NON-empty value; a cleared cookie does not count
  }
  return null;
}

function headersFor(c, extra = {}) {
  return { Accept: "application/json", "User-Agent": USER_AGENT, Origin: new URL(c.s.baseUrl).origin, ...extra };
}

async function login(c) {
  const r = await call(c.fetchImpl, "login", `${c.s.baseUrl}/api/customer/login`, {
    method: "POST", headers: headersFor(c, { "Content-Type": "application/json" }), body: JSON.stringify({ email: c.s.email, password: c.s.password })
  });
  if (r.reason) return failResult(r.reason);
  if (r.res.status !== 200) return failResult(`login_http_${r.res.status}`);
  const body = await readJson(r.res);
  if (!body) return failResult("login_bad_response");
  if (body.success !== true) return failResult("login_rejected");
  if (body.mfaRequired) return failResult("login_mfa_required");
  if (body.twoFactorEnrollmentRequired) return failResult("login_org_2fa_enrollment_required");
  const cookie = sessionCookie(r.res);
  if (!cookie) return failResult("login_no_session_cookie");
  return okResult({ cookie });
}

async function verifySession(c, cookie) {
  const r = await call(c.fetchImpl, "session_check", `${c.s.baseUrl}/api/organizations`, { method: "GET", headers: headersFor(c, { Cookie: cookie }) });
  if (r.reason) return failResult(r.reason);
  if (r.res.status !== 200) return failResult(`session_check_http_${r.res.status}`);
  const body = await readJson(r.res);
  if (!body || body.success !== true || !Array.isArray(body.data)) return failResult("session_check_bad_response");
  if (c.s.organizationId && !body.data.some((o) => o && o.id === c.s.organizationId)) return failResult("monitor_organization_missing");
  return okResult();
}

async function logout(c, cookie) {
  const r = await call(c.fetchImpl, "logout", `${c.s.baseUrl}/api/customer/logout`, { method: "POST", headers: headersFor(c, { Cookie: cookie }) });
  if (r.reason) return failResult(r.reason);
  return r.res.status === 200 ? okResult() : failResult(`logout_http_${r.res.status}`);
}

async function checkoutProbe(c, cookie) {
  const r = await call(c.fetchImpl, "checkout", `${c.s.baseUrl}/api/organizations/${encodeURIComponent(c.s.organizationId)}/billing/checkout`, {
    method: "POST", headers: headersFor(c, { "Content-Type": "application/json", Cookie: cookie }), body: JSON.stringify({ planId: c.s.planId })
  });
  if (r.reason) return failResult(r.reason);
  if (r.res.status !== 200) return failResult(`checkout_http_${r.res.status}`);
  const body = await readJson(r.res);
  if (!body) return failResult("checkout_bad_response");
  if (body.success !== true) return failResult("checkout_rejected");
  if (typeof body.checkoutUrl !== "string" || !body.checkoutUrl) return failResult("checkout_no_url");
  let protocol = "";
  try { protocol = new URL(body.checkoutUrl).protocol; } catch (error) { protocol = ""; }
  return protocol === "https:" ? okResult() : failResult("checkout_url_not_https");
}

async function canaryProbe(c) {
  const r = await call(c.fetchImpl, "canary", c.s.canaryUrl, { method: "GET", headers: { Accept: "text/html", "User-Agent": USER_AGENT } });
  if (r.reason) return failResult(r.reason);
  if (r.res.status !== 200) return failResult(`canary_http_${r.res.status}`);
  let page = "";
  try { page = (await r.res.text()).slice(0, MAX_BODY_CHARS); } catch (error) { return failResult("canary_read_failed"); }
  return page.includes(c.s.canaryMarker) ? okResult() : failResult("canary_marker_missing");
}

const codePart = (v, max = 40) => String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);

async function domainProbe(c) {
  let fallback;
  try { fallback = await c.infra.getFallbackOrigin(c.env); } catch (error) { return failResult("domain_cloudflare_error"); }
  if (!fallback || !fallback.origin) return failResult("domain_fallback_origin_missing");
  const status = codePart(fallback.status);
  if (!status) return failResult("domain_fallback_origin_unknown");
  if (status !== "active") return failResult(`domain_fallback_origin_${status}`);
  if (c.s.domainResourceId) {
    let detail;
    try { detail = await c.infra.getCustomHostnameDetail(c.env, c.s.domainResourceId); } catch (error) { return failResult("domain_cloudflare_error"); }
    const hostStatus = codePart(detail && detail.status);
    if (!hostStatus) return failResult("domain_canary_hostname_unknown");
    if (hostStatus !== "active") return failResult(`domain_canary_hostname_${hostStatus}`);
  }
  return okResult();
}

/**
 * Runs every applicable probe and returns { signin, checkout, canary_site, domain_attach }, each { status, reason? } with status
 * ok | fail | blocked | skipped | not_configured. Records nothing. Sign-in and checkout share ONE login, which is always signed out.
 */
export async function runProbes(env, { fetchImpl = (...args) => fetch(...args), infra = infraCloudflare } = {}) {
  const s = monitorSettings(env);
  const plan = Object.fromEntries(MONITORS.map((m) => [m.name, applicability(m.name, env, s)]));
  const out = {};
  for (const m of MONITORS) if (plan[m.name].state !== "run") out[m.name] = { status: plan[m.name].state, reason: plan[m.name].reason };
  const c = { env, s, fetchImpl, infra };

  const chain = async () => {
    if (plan.signin.state !== "run") return;
    const wantCheckout = plan.checkout.state === "run";
    const lg = await safe(() => login(c));
    if (lg.status !== "ok") { out.signin = lg; if (wantCheckout) out.checkout = blockedResult("signin_failed"); return; }
    const cookie = lg.cookie;
    let signin = await safe(() => verifySession(c, cookie));
    if (wantCheckout) out.checkout = signin.status === "ok" ? await safe(() => checkoutProbe(c, cookie)) : blockedResult("signin_failed");
    const lo = await safe(() => logout(c, cookie));       // always: a monitor must not leave sessions behind
    if (signin.status === "ok" && lo.status !== "ok") signin = lo;
    out.signin = signin.status === "ok" ? okResult() : signin;
  };
  await Promise.all([
    chain(),
    (async () => { if (plan.canary_site.state === "run") out.canary_site = await safe(() => canaryProbe(c)); })(),
    (async () => { if (plan.domain_attach.state === "run") out.domain_attach = await safe(() => domainProbe(c)); })()
  ]);
  for (const m of MONITORS) if (!out[m.name]) out[m.name] = failResult("probe_no_result");     // a probe that never produced anything is a failure
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Runner: probe, then record. Called by the five-minute tick and the external pinger, before the alert check.
// ---------------------------------------------------------------------------------------------------------------------

async function auditTransition(env, monitor, outcome, prev) {
  const wasFailing = !!prev && prev.last_count > 0;
  if (outcome.status === "ok") {
    if (!wasFailing) return;
    await logAudit(env, { actorType: "system", endpoint: "scheduled", method: "SYNTHETIC", resource: "synthetic_monitor", resourceId: monitor, action: "recover", success: true });
    return;
  }
  if (outcome.status !== "fail") return;
  if (wasFailing && (await repo.latestFailureReason(env, monitor)) === outcome.reason) return;     // same reason as before: not a transition
  await logAudit(env, { actorType: "system", endpoint: "scheduled", method: "SYNTHETIC", resource: "synthetic_monitor", resourceId: monitor, action: "fail", success: false, errorMessage: outcome.reason });
}

export async function runSyntheticMonitors(env, { fetchImpl, infra, now = Date.now() } = {}) {
  const mode = monitorMode(env);
  if (mode === "off") return { ok: true, mode, skipped: "off", results: [] };
  const nowIso = new Date(now).toISOString();
  const outcomes = await runProbes(env, { ...(fetchImpl ? { fetchImpl } : {}), ...(infra ? { infra } : {}) });
  const results = [];
  for (const m of MONITORS) {
    const outcome = outcomes[m.name];
    const result = { monitor: m.name, status: outcome.status, reason: outcome.reason || null, recorded: false, action: "not_recorded" };
    if (["ok", "fail", "blocked"].includes(outcome.status)) {
      try {
        const prev = await repo.getProbe(env, m.name);
        if (outcome.status === "ok") await repo.recordOk(env, m.name, nowIso);
        else if (outcome.status === "fail") await repo.recordFail(env, m.name, nowIso);
        else await repo.recordBlocked(env, m.name, nowIso);
        result.recorded = true; result.action = "recorded";
        if (outcome.status === "fail") console.error(JSON.stringify({ msg: "synthetic_monitor_failed", monitor: m.name, reason: outcome.reason, consecutiveFailures: (prev ? prev.last_count : 0) + 1, mode }));
        await auditTransition(env, m.name, outcome, prev);
      } catch (error) {
        // Not recorded means the previous state stands (never advanced to ok). It will go stale and page if this keeps happening.
        result.recorded = false; result.action = "record_failed";
        console.error(JSON.stringify({ msg: "synthetic_monitor_record_failed", monitor: m.name, status: outcome.status, errorName: error && error.name ? String(error.name).slice(0, 40) : "Error" }));
      }
    }
    results.push(result);
  }
  return { ok: true, mode, results };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the state: alert counts and the staff view.
// ---------------------------------------------------------------------------------------------------------------------

function ageMs(row, now) {
  const t = Date.parse(row.updated_at);
  return Number.isFinite(t) ? now - t : Infinity;
}
const isStale = (row, s, now) => ageMs(row, now) > s.staleMinutes * 60 * 1000;

/**
 * The number the alert machinery reads for `synthetic_<monitor>`: 0 = healthy or not applicable, otherwise consecutive failed
 * probes once they reach SYNTHETIC_FAILURE_THRESHOLD, or the threshold itself when the result is stale. Only mode "on" pages.
 * Blocked leaves the failure count alone, so a blocked monitor neither raises nor clears its alert.
 */
export async function monitorAlertCount(env, name, now = Date.now()) {
  if (monitorMode(env) !== "on") return 0;
  const s = monitorSettings(env);
  if (applicability(name, env, s).state !== "run") return 0;
  const row = await repo.getProbe(env, name);
  if (!row) return 0;
  if (isStale(row, s, now)) return Math.max(row.last_count, s.threshold);
  return row.last_count >= s.threshold ? row.last_count : 0;
}

/** Text appended to the page: a reason CODE and timing, nothing else. */
export async function monitorAlertDetail(env, name, now = Date.now()) {
  const s = monitorSettings(env);
  const row = await repo.getProbe(env, name);
  if (!row) return "";
  if (isStale(row, s, now)) {
    const minutes = Number.isFinite(ageMs(row, now)) ? Math.round(ageMs(row, now) / 60000) : "many";
    return `No probe result for ${minutes} minutes (the monitor itself is not running or cannot record: check the scheduler, the database and the logs)`;
  }
  const reason = (await repo.latestFailureReason(env, name)) || "unknown";
  return `Reason: ${codePart(reason, 80) || "unknown"}. ${row.last_count} failed probes in a row since ${row.first_seen_at || "unknown"}`;
}

/**
 * One entry per monitor for the staff tile. status: off | not_configured | skipped | unknown (configured, never probed) |
 * ok | failing | blocked | stale. Only "ok" means a recent probe passed.
 */
export async function monitorStatuses(env, { now = Date.now() } = {}) {
  const mode = monitorMode(env);
  const s = monitorSettings(env);
  const out = [];
  for (const m of MONITORS) {
    const entry = { monitor: m.name, label: m.label, mode, status: "off", reason: null, consecutiveFailures: 0, lastProbeAt: null, lastOkAt: null, failingSince: null };
    const app = applicability(m.name, env, s);
    if (mode === "off") { out.push(entry); continue; }
    if (app.state !== "run") { entry.status = app.state; entry.reason = app.reason; out.push(entry); continue; }
    const row = await repo.getProbe(env, m.name);
    if (!row) { entry.status = "unknown"; out.push(entry); continue; }
    entry.consecutiveFailures = row.last_count; entry.lastProbeAt = row.updated_at; entry.lastOkAt = row.last_notified_at; entry.failingSince = row.first_seen_at;
    if (isStale(row, s, now)) entry.status = "stale";
    else if (row.firing === 2) { entry.status = "blocked"; entry.reason = "signin_failed"; }
    else if (row.last_count > 0) { entry.status = "failing"; entry.reason = codePart((await repo.latestFailureReason(env, m.name)) || "unknown", 80); }
    else entry.status = "ok";
    out.push(entry);
  }
  return out;
}
