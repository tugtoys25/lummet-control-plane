// =====================================================
// OPTIONAL ERROR TRACKING (Round 6.3C)
//
// ERROR_TRACKING=off (default) | shadow | on. SENTRY_DSN is a Worker secret (any Sentry-protocol service; the provider is an
// owner decision, see docs/ERROR_TRACKING.md).
//   off     nothing is built, logged or sent.
//   shadow  the event is built and scrubbed and a one-line summary is logged; nothing leaves the Worker. Needs no DSN.
//   on      the scrubbed event is sent once to the DSN's envelope endpoint. Never retried, bounded by a timeout.
//
// What an event contains: error type, scrubbed message, scrubbed stack frames (function, bare file name, line), the request
// id, method, route (ids and tokens already replaced), status, environment and, when the owner sets one, the release id.
// What it never contains: request URL or query, headers, cookies, bodies, user, IP, server name, env, contexts, breadcrumbs
// or any free-form "extra" the caller hands in. Every string passes through redact.js.
//
// Limits: the same error on the same route is sent once a minute; at most ERROR_TRACKING_MAX_PER_MINUTE events a minute
// (default 30, 0 = unlimited). captureException never throws and never logs the DSN.
// =====================================================
import { redactText } from "./redact.js";

const DEFAULT_MAX_PER_MINUTE = 30;
const DEFAULT_TIMEOUT_MS = 2000;
const WINDOW_MS = 60_000;
const MAX_FRAMES = 20;
const MAX_DEDUPE_KEYS = 200;

const state = { windowStart: 0, sentInWindow: 0, lastSent: new Map(), warnedDsn: false };

export function resetErrorTrackingForTests() {
  state.windowStart = 0; state.sentInWindow = 0; state.lastSent = new Map(); state.warnedDsn = false;
}

/** "shadow" or "on" only for those exact words (any case, surrounding spaces ignored); everything else is "off". */
export function errorTrackingMode(env) {
  const v = String(env?.ERROR_TRACKING ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

function maxPerMinute(env) {
  const raw = env?.ERROR_TRACKING_MAX_PER_MINUTE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_PER_MINUTE;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_PER_MINUTE;
}

// ---- DSN ---------------------------------------------------------------------------------------------------------

function isPublicHostname(host) {
  const h = String(host || "").toLowerCase();
  if (!h || h.startsWith("[")) return false;                       // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;             // IPv4 literal (private, loopback, link-local or public: a tracker has a name)
  if (!h.includes(".")) return false;                              // localhost, bare internal names
  if (/\.(internal|local|localhost|lan|home|corp|intranet)$/.test(h)) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

/**
 * Parses a Sentry-style DSN (https://<public key>@<host>[:port]/[<prefix>/]<project id>). Only the public key is kept: a
 * legacy "secret" part is ignored and never returned. Returns { ok: false } for anything that is not a public HTTPS address.
 */
export function parseDsn(dsn) {
  try {
    if (typeof dsn !== "string" || dsn.trim() === "") return { ok: false };
    const u = new URL(dsn.trim());
    if (u.protocol !== "https:" || !u.username || u.search || u.hash) return { ok: false };
    if (!isPublicHostname(u.hostname)) return { ok: false };
    const publicKey = decodeURIComponent(u.username);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(publicKey)) return { ok: false };
    const segments = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (segments.length === 0 || !segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return { ok: false };
    const projectId = segments[segments.length - 1];
    const prefix = segments.slice(0, -1).join("/");
    const endpoint = `https://${u.host}/${prefix ? prefix + "/" : ""}api/${projectId}/envelope/`;
    return { ok: true, endpoint, publicKey, projectId };
  } catch (_) {
    return { ok: false };
  }
}

// ---- the event ---------------------------------------------------------------------------------------------------

// 32 decimal digits: valid lowercase hex for the tracker (128 bits are not needed for uniqueness; about 106 are used) and, by
// construction, never matched by the "long mixed token" rule of redact.js, so the scrubbing test can hold over the whole body.
function newEventId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += String(b % 10);
  return out;
}

function safeGet(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function cleanFileName(location) {
  let file = String(location || "");
  file = file.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");        // scheme and host
  file = file.replace(/^file:\/*/i, "").replace(/[?#].*$/, "");     // query and fragment
  file = file.replace(/^\/+/, "").slice(0, 120);
  return /^[A-Za-z0-9_.\/-]+$/.test(file) ? file : "unknown";
}

function cleanFunction(name) {
  const f = String(name || "").replace(/^(async|new)\s+/g, "").trim().slice(0, 80);
  return /^[A-Za-z0-9_.$<>\[\] ]+$/.test(f) ? f : "?";
}

function parseFrames(stack) {
  const frames = [];
  for (const raw of String(stack || "").split("\n")) {
    const m = raw.match(/^\s*at\s+(.*)$/);
    if (!m) continue;
    let fn = "?"; let loc = m[1].trim();
    const paren = loc.match(/^(.*?)\s+\((.*)\)$/);
    if (paren) { fn = paren[1]; loc = paren[2]; }
    const pos = loc.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (!pos) continue;
    frames.push({ function: cleanFunction(fn), filename: cleanFileName(pos[1]), lineno: Number(pos[2]) });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();                                          // the tracker wants the innermost frame last
}

const tag = (v, max = 160) => redactText(v === undefined || v === null ? "" : String(v), { max });

/** The scrubbed event for `error` and the request context `{ requestId, method, route, status, eventKind }`. Never throws. */
export function buildEvent(error, context, env) {
  const ctx = context && typeof context === "object" ? context : {};
  const isError = error instanceof Error || (error && typeof error === "object" && "message" in Object(error));
  const type = isError ? safeGet(() => redactText(error.name || "Error", { max: 60 }), "Error") : "Error";
  const message = isError ? safeGet(() => redactText(error.message, { max: 500 }), "[unreadable]") : redactText(error === undefined || error === null ? "unknown error" : error, { max: 500 });
  const frames = isError ? safeGet(() => parseFrames(error.stack), []) : [];
  const tags = {
    request_id: tag(ctx.requestId, 64), route: tag(ctx.route, 160), status: tag(ctx.status, 8),
    method: tag(ctx.method, 12), event_kind: tag(ctx.eventKind || "request", 24)
  };
  for (const k of Object.keys(tags)) if (tags[k] === "") delete tags[k];
  const event = {
    event_id: newEventId(),
    timestamp: Math.floor(Date.now() / 1000),
    level: "error",
    platform: "javascript",
    environment: tag(env?.ENVIRONMENT || "unknown", 40),
    exception: { values: [{ type, value: message, ...(frames.length ? { stacktrace: { frames } } : {}) }] },
    tags
  };
  const release = env?.ERROR_TRACKING_RELEASE ? tag(String(env.ERROR_TRACKING_RELEASE).trim(), 64) : "";
  if (release) event.release = release;
  if (tags.method) event.request = { method: tags.method };
  return event;
}

/** The three-line envelope (envelope header, item header, event) ending in a newline. The DSN is not part of it. */
export function buildEnvelope(event, nowMs = Date.now()) {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date(nowMs).toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event)
  ].join("\n") + "\n";
}

// ---- capture -----------------------------------------------------------------------------------------------------

function admit(env, event, nowMs) {
  const key = `${event.exception.values[0].type}|${event.tags.route || ""}|${event.exception.values[0].value.slice(0, 120)}`;
  const last = state.lastSent.get(key);
  if (last !== undefined && nowMs - last < WINDOW_MS) return { ok: false, status: "deduped", reason: "duplicate" };
  const cap = maxPerMinute(env);
  if (nowMs - state.windowStart >= WINDOW_MS || nowMs < state.windowStart) { state.windowStart = nowMs; state.sentInWindow = 0; }
  if (cap > 0 && state.sentInWindow >= cap) return { ok: false, status: "skipped", reason: "rate_limited" };
  state.sentInWindow++;
  if (state.lastSent.size >= MAX_DEDUPE_KEYS) {
    for (const [k, t] of state.lastSent) if (nowMs - t >= WINDOW_MS) state.lastSent.delete(k);
    if (state.lastSent.size >= MAX_DEDUPE_KEYS) state.lastSent.delete(state.lastSent.keys().next().value);
  }
  state.lastSent.set(key, nowMs);
  return { ok: true };
}

/**
 * Reports one exception according to ERROR_TRACKING. Resolves to { status, reason? } and never throws. `ctx` is accepted for
 * call-site symmetry; callers hand this promise to ctx.waitUntil themselves. Options (tests): fetchImpl, now, timeoutMs.
 */
export async function captureException(env, ctx, error, context, opts = {}) {
  try {
    const mode = errorTrackingMode(env);
    if (mode === "off") return { status: "skipped", reason: "off" };
    const nowMs = typeof opts.now === "function" ? opts.now() : Date.now();
    let dsn = null;
    if (mode === "on") {
      dsn = parseDsn(env?.SENTRY_DSN);
      if (!dsn.ok) {
        if (!state.warnedDsn) { state.warnedDsn = true; console.warn(JSON.stringify({ level: "warn", event: "error_tracking_dsn_invalid" })); }
        return { status: "skipped", reason: "dsn_invalid" };
      }
    }
    const event = buildEvent(error, context, env);
    const gate = admit(env, event, nowMs);
    if (!gate.ok) return { status: gate.status, reason: gate.reason };
    const body = buildEnvelope(event, nowMs);
    if (mode === "shadow") {
      console.warn(JSON.stringify({ level: "warn", event: "error_tracking_shadow", event_id: event.event_id, bytes: body.length, route: event.tags.route, error_type: event.exception.values[0].type }));
      return { status: "shadowed", eventId: event.event_id };
    }
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(dsn.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=lummet-error-tracking/1, sentry_key=${dsn.publicKey}` },
        body, signal: controller.signal, redirect: "error"
      });
      if (res && res.status >= 200 && res.status < 300) return { status: "sent", eventId: event.event_id };
      console.warn(JSON.stringify({ level: "warn", event: "error_tracking_failed", reason: `http_${res ? res.status : "none"}` }));
      return { status: "failed", reason: `http_${res ? res.status : "none"}` };
    } catch (_) {
      console.warn(JSON.stringify({ level: "warn", event: "error_tracking_failed", reason: "network" }));   // the error text is not logged: it can carry the DSN
      return { status: "failed", reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return { status: "failed", reason: "internal" };
  }
}
