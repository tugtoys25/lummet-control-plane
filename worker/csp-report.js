// =====================================================
// CSP VIOLATION-REPORT COLLECTION (Round 6.3C)
//
// POST /api/csp-report is unauthenticated by design (browsers send reports on their own, possibly with cookies), so
// everything in a report is attacker-controlled text. Reports are logged as one structured JSON line each and stored
// nowhere; the review procedure (docs/CSP_REPORTING.md, scripts/csp-report-review.mjs) reads them back from the Worker
// logs (wrangler tail, or Logpush once configured). The answer is always 204.
//
// CSP_REPORT_MODE
//   basic (default)  exactly the 2.6.0.7 behaviour: one record with four fields, query dropped.
//   full             also reads Reporting API batches (application/reports+json), adds disposition, source and line,
//                    removes tokens and ids from every path, never logs the script sample, the original policy or a
//                    nonce, caps logging per minute (CSP_REPORT_MAX_PER_MINUTE, default 60, 0 = unlimited) and asks
//                    browsers to keep reporting after CSP_MODE is flipped to enforce (see csp.js).
//
// Never logged in either mode: query strings, fragments, cookies, headers, IP addresses, script samples.
// =====================================================
import { routeOf } from "./observability.js";

export const REPORT_PATH = "/api/csp-report";
export const REPORT_ENDPOINT_NAME = "csp-endpoint";
const MAX_BODY = 8000;
const MAX_BATCH = 10;
const DEFAULT_PER_MINUTE = 60;

export function cspReportMode(env) {
  return env && String(env.CSP_REPORT_MODE || "").trim().toLowerCase() === "full" ? "full" : "basic";
}

/** Reports logged per minute per isolate in full mode. 0 means unlimited; anything unusable falls back to the default. */
export function cspReportLimit(env) {
  const raw = env && env.CSP_REPORT_MAX_PER_MINUTE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_PER_MINUTE;
  return /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : DEFAULT_PER_MINUTE;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;
const KEYWORD = /^[a-z][a-z0-9-]{0,29}$/i;

/**
 * A URL from a report, reduced to what is safe to keep: scheme and host plus a path with ids and tokens replaced.
 * Keywords (inline, eval, self...) pass; data:, blob: and similar keep only the scheme; anything unparsable becomes "".
 */
export function sanitizeReportUri(value) {
  if (typeof value !== "string") return "";
  const s = value.replace(CONTROL, "").trim().slice(0, 2000);
  if (!s) return "";
  if (KEYWORD.test(s)) return s.toLowerCase();
  let u;
  try { u = new URL(s); } catch (_) { return ""; }
  const scheme = u.protocol.replace(/:$/, "");
  if (["data", "blob", "about", "javascript", "filesystem"].includes(scheme)) return scheme;
  if (!u.host) return scheme.slice(0, 30);
  return `${u.protocol}//${u.host}${routeOf(u.pathname)}`.slice(0, 200);
}

function directiveName(value) {
  const first = String(value ?? "").trim().split(/\s+/)[0].toLowerCase();
  return /^[a-z-]{1,40}$/.test(first) ? first : "";
}

const asObject = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);

/** Full-mode normaliser: text and content type in, zero to MAX_BATCH sanitised records out. Never throws. */
export function normalizeReports(text) {
  let body;
  try { body = JSON.parse(text); } catch (_) { return []; }
  const out = [];
  const push = (rec) => { if (rec && (rec.directive || rec.blocked || rec.document)) out.push(rec); };
  const shared = (r) => {
    const rec = {};
    const disp = String(r.disposition ?? "").toLowerCase();
    if (disp === "report" || disp === "enforce") rec.disposition = disp;
    return rec;
  };
  const lineOf = (n) => (Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : undefined);

  if (Array.isArray(body)) {
    for (const item of body) {
      const it = asObject(item); const b = it && asObject(it.body);
      if (!it || !b || it.type !== "csp-violation") continue;
      push({
        csp_violation: true,
        directive: directiveName(b.effectiveDirective || b.violatedDirective),
        blocked: sanitizeReportUri(b.blockedURL),
        document: sanitizeReportUri(b.documentURL || it.url),
        ...shared(b),
        source: sanitizeReportUri(b.sourceFile) || undefined,
        line: lineOf(b.lineNumber),
        format: "reporting-api"
      });
      if (out.length >= MAX_BATCH) break;
    }
    return out;
  }
  const top = asObject(body);
  if (!top) return out;
  const r = asObject(top["csp-report"]) || (("document-uri" in top || "violated-directive" in top || "blocked-uri" in top) ? top : null);
  if (!r) return out;
  push({
    csp_violation: true,
    directive: directiveName(r["effective-directive"] || r["violated-directive"]),
    blocked: sanitizeReportUri(r["blocked-uri"]),
    document: sanitizeReportUri(r["document-uri"]),
    ...shared(r),
    source: sanitizeReportUri(r["source-file"]) || undefined,
    line: lineOf(r["line-number"]),
    format: "legacy"
  });
  return out;
}

// Per-isolate flood cap (log volume is billed and this endpoint is open to the internet). One marker line per window
// tells the reviewer that reports were dropped, so a silent log is never mistaken for a clean one.
const limiter = { window: -1, count: 0, marked: false };
export function resetCspReportLimiter() { limiter.window = -1; limiter.count = 0; limiter.marked = false; }

function admit(limit, now) {
  if (limit === 0) return true;
  const w = Math.floor(now / 60000);
  if (w !== limiter.window) { limiter.window = w; limiter.count = 0; limiter.marked = false; }
  if (limiter.count < limit) { limiter.count++; return true; }
  if (!limiter.marked) { limiter.marked = true; console.warn(JSON.stringify({ csp_violation_suppressed: true, limit_per_minute: limit })); }
  return false;
}

/** Handles POST /api/csp-report: logs sanitised records, stores nothing, always 204. */
export async function handleCspReport(request, env = {}, now = Date.now()) {
  let text = "";
  try { text = (await request.text()).slice(0, MAX_BODY); } catch (_) { /* an unreadable body is not worth anything */ }

  if (cspReportMode(env) === "full") {
    const limit = cspReportLimit(env);
    for (const rec of normalizeReports(text)) if (admit(limit, now)) console.warn(JSON.stringify(rec));
    return new Response(null, { status: 204 });
  }

  // basic: unchanged since v7E
  try {
    const body = JSON.parse(text);
    const r = body["csp-report"] || (Array.isArray(body) ? (body[0] && body[0].body) : body) || {};
    const doc = String(r["document-uri"] || r.documentURL || "").split("?")[0].slice(0, 200);
    console.warn(JSON.stringify({
      csp_violation: true,
      directive: String(r["violated-directive"] || r.effectiveDirective || "").slice(0, 80),
      blocked: String(r["blocked-uri"] || r.blockedURL || "").split("?")[0].slice(0, 200),
      document: doc
    }));
  } catch (_) { /* a malformed report is not worth anything */ }
  return new Response(null, { status: 204 });
}
