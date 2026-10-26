// Pure helpers for the CSP violation review procedure (Round 6.3C). No network, no env access.
// Input: Worker log text in any of three shapes, one JSON document per line:
//   1. the record itself  {"csp_violation":true,"directive":...}
//   2. `wrangler tail --format json` events  {"logs":[{"message":["<record json>"],"timestamp":...}]}
//   3. Logpush workers_trace_events          {"Logs":[{"Message":["<record json>"],"TimestampMs":...}], ...}
// Records are re-sanitised and truncated here: a log file is not trusted just because Lummet wrote it.

export const DEFAULT_MIN_DAYS = 7; // [OPEN] placeholder: the owner decides how long staging must stay quiet. See docs/PLACEHOLDERS.md.

const CONTROL = /[\u0000-\u001f\u007f]/g;
const clip = (v, n) => String(v ?? "").replace(CONTROL, "").slice(0, n);
const dirOf = (v) => { const f = String(v ?? "").trim().split(/\s+/)[0].toLowerCase(); return /^[a-z-]{1,40}$/.test(f) ? f : ""; };
const tsOf = (v) => { const n = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };

function clean(rec, ts) {
  return { directive: dirOf(rec.directive), blocked: clip(rec.blocked, 200), document: clip(rec.document, 200), ts: ts || null };
}

/** Walks one parsed log line; returns nothing, pushes into acc. Depth-limited so a hostile line cannot recurse far. */
function walk(node, acc, ts, depth) {
  if (depth > 6 || node === null || node === undefined) return;
  if (typeof node === "string") {
    if (!node.includes("csp_violation")) return;
    let inner;
    try { inner = JSON.parse(node); } catch (_) { return; }
    walk(inner, acc, ts, depth + 1);
    return;
  }
  if (Array.isArray(node)) { for (const x of node) walk(x, acc, ts, depth + 1); return; }
  if (typeof node !== "object") return;
  if (node.csp_violation === true) { acc.violations.push(clean(node, ts)); return; }
  if (node.csp_violation_suppressed === true) { acc.suppressed++; return; }
  const own = tsOf(node.TimestampMs ?? node.timestamp ?? node.EventTimestampMs) || ts;
  for (const key of Object.keys(node)) walk(node[key], acc, own, depth + 1);
}

export function extractViolations(text) {
  const acc = { violations: [], suppressed: 0, lines: 0, skipped: 0 };
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { acc.skipped++; continue; }
    acc.lines++;
    walk(parsed, acc, null, 0);
  }
  return acc;
}

export function aggregate(violations) {
  const map = new Map();
  for (const v of violations) {
    const key = `${v.directive}\u0000${v.blocked}\u0000${v.document}`;
    let row = map.get(key);
    if (!row) { row = { directive: v.directive, blocked: v.blocked, document: v.document, count: 0, first: null, last: null }; map.set(key, row); }
    row.count++;
    if (v.ts) { if (!row.first || v.ts < row.first) row.first = v.ts; if (!row.last || v.ts > row.last) row.last = v.ts; }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.directive.localeCompare(b.directive) || a.blocked.localeCompare(b.blocked) || a.document.localeCompare(b.document));
}

/**
 * pass is true only for NO_VIOLATIONS_IN_WINDOW. Order matters: a violation is reported even when the window is short.
 * The window comes from the operator (--from, --to), never from the file, because a file cannot prove what it does not contain.
 */
export function verdict({ violations, suppressed, lines, from, to, minDays }) {
  if (!lines) return { code: "NO_INPUT", pass: false, message: "No parseable log lines were read, so nothing can be said about violations. Check the log source and the file path." };
  if (violations.length) return { code: "VIOLATIONS_FOUND", pass: false, message: `${violations.length} violation record(s) in ${aggregate(violations).length} distinct group(s). Fix or consciously accept each group before considering CSP_MODE=enforce.` };
  if (suppressed) return { code: "INCOMPLETE", pass: false, message: `The flood cap dropped reports (${suppressed} marker(s)). Raise CSP_REPORT_MAX_PER_MINUTE or find the source of the flood, then review again.` };
  const a = Date.parse(from || ""); const b = Date.parse(to || "");
  const days = Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 86400000 : null;
  const need = Number.isFinite(minDays) ? minDays : DEFAULT_MIN_DAYS;
  if (days === null || days < need) return { code: "WINDOW_TOO_SHORT", pass: false, message: `The observation window is ${days === null ? "not stated (pass --from and --to)" : `${days.toFixed(1)} day(s)`}; at least ${need} day(s) are required (default is a placeholder [OPEN]).` };
  return { code: "NO_VIOLATIONS_IN_WINDOW", pass: true, message: `No violation records and no suppressed reports in ${days.toFixed(1)} day(s). This is evidence only if every page type was actually visited in a real browser during the window (see the coverage checklist in docs/CSP_REPORTING.md); silence on pages nobody opened proves nothing.` };
}

export function renderTable(rows) {
  if (!rows.length) return "(no violation records)";
  const head = ["count", "directive", "blocked", "document", "first", "last"];
  const body = rows.map((r) => [String(r.count), r.directive || "-", r.blocked || "-", r.document || "-", r.first || "-", r.last || "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(head), ...body.map(fmt)].join("\n");
}
