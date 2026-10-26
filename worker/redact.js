// =====================================================
// PII AND SECRET SCRUBBING (Round 6.3C, stage 2)
//
// One scrubber shared by three consumers: error tracking (error-tracking.js), the Logpush-bound console output
// (installConsoleRedaction, behind LOG_REDACTION) and the audit stream (audit-stream.js).
//
// What this is: a safety net over FREE TEXT (error messages, stacks, reasons) and over structured values. It removes
// emails, IP addresses, JWTs, Bearer/Basic credentials, well-known provider keys, URL query strings, secret-like
// key=value pairs, Luhn-valid card numbers and long mixed tokens.
// What this is not: proof that no personal data can ever reach a log. Names, street addresses, free-form user text and
// secrets in shapes not listed here pass through. The primary control stays "do not log it in the first place".
//
// Request ids (UUIDs), short ids (cus_..., sub_...), version numbers, clock times, ISO timestamps and epoch milliseconds
// are deliberately kept: they are what makes a log line useful.
// =====================================================

const DEFAULT_MAX = 1000;
const HARD_INPUT_CAP = 100000;
const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_KEY_WORDS = "password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|signature|csrf|otp|session";
const SENSITIVE_KEY_SUBSTRING = new RegExp(SECRET_KEY_WORDS, "i");
const DROP_KEY_EXACT = new Set(["headers", "header", "cookies", "email", "e-mail", "ip", "ipaddress", "ip_address", "user", "username", "body", "query", "querystring", "query_string", "card", "phone", "address", "name", "sid"]);

function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const KEEP = (m) => m;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

// Order matters: structured credentials first, then URLs and pairs, then the generic shapes.
const PATTERNS = [
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, to: () => "[jwt]" },
  { kind: "credential", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, to: (m, scheme) => `${scheme} [token]` },
  { kind: "key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, to: () => "[key]" },
  { kind: "key", re: /\bwhsec_[A-Za-z0-9]{8,}/g, to: () => "[key]" },
  { kind: "key", re: /\bre_[A-Za-z0-9_]{16,}/g, to: () => "[key]" },
  { kind: "key", re: /\blmk_[A-Za-z0-9]{16,}/g, to: () => "[key]" },
  { kind: "key", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: () => "[key]" },
  { kind: "key", re: /\bAKIA[0-9A-Z]{16}\b/g, to: () => "[key]" },
  { kind: "key", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: () => "[key]" },
  // Query string and fragment of absolute URLs and of root-relative paths; the path stays.
  { kind: "url_query", re: /(\bhttps?:\/\/[^\s?#"'<>)\]]*|\B\/[A-Za-z0-9._~\/%:-]+)\?[^\s#"'<>)]*(?:#[^\s"'<>)]*)?/g, to: (m, base) => `${base}?[redacted]` },
  // key=value, key: value and "key":"value" for secret-like keys. Other keys are kept.
  { kind: "secret_pair", re: new RegExp(`(["']?[\\w-]*(?:${SECRET_KEY_WORDS})[\\w-]*["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}"']+)`, "gi"), to: (m, lead, value) => (value === "[redacted]" || value === '"[redacted]"' || value === "'[redacted]'" ? m : `${lead}${value[0] === '"' ? '"[redacted]"' : value[0] === "'" ? "'[redacted]'" : "[redacted]"}`) },
  { kind: "email", re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, to: () => "[email]" },
  // IPv6: eight groups, or a compressed form containing "::". Clock times (12:30:45) never contain "::".
  { kind: "ip", re: /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/gi, to: () => "[ip]" },
  // IPv4. A dotted quad whose four parts are all one digit is a version number (2.6.0.8), not an address.
  { kind: "ip", re: new RegExp(`(?<![\\w.])${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?![\\w.])`, "g"), to: (m) => (/^\d\.\d\.\d\.\d$/.test(m) ? m : "[ip]") },
  // Card numbers: 13 to 19 digits with optional single spaces or hyphens, replaced only when they pass the Luhn check.
  { kind: "card", re: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g, to: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhnValid(d) ? "[card]" : m; } },
  // Long mixed tokens: 32+ characters of letters, digits, _ and -, with at least one letter AND one digit. UUIDs are kept.
  { kind: "token", re: /(?<![\w-])[A-Za-z0-9_-]{32,}(?![\w-])/g, to: (m) => (UUID_FULL.test(m) || !/[A-Za-z]/.test(m) || !/\d/.test(m) ? m : "[token]") }
];

function applyAll(text) {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p.re, p.to);
  return out;
}

function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return String(value); } catch (_) { return "[unprintable]"; }
}

/** Redacted, length-bounded text. Never throws. `max` defaults to 1000 characters. */
export function redactText(value, { max = DEFAULT_MAX } = {}) {
  const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX;
  // Input is capped before the patterns run (bounded work); the cap is far above `limit`, so a token cut by it can only
  // sit beyond the part that is returned.
  let text = toText(value);
  const cap = Math.min(HARD_INPUT_CAP, limit * 4 + 200);
  if (text.length > cap) text = text.slice(0, cap);
  try { return applyAll(text).slice(0, limit); } catch (_) { return "[unredactable]"; }
}

/** Names of the kinds of sensitive content still present in `text` (empty array when none). Never throws. */
export function containsSensitive(text) {
  const s = toText(text).slice(0, HARD_INPUT_CAP);
  const found = new Set();
  try {
    for (const p of PATTERNS) {
      let hit = false;
      s.replace(p.re, (...args) => { const m = args[0]; if (p.to(...args) !== m) hit = true; return m; });
      if (hit) found.add(p.kind);
    }
  } catch (_) { /* detection is best effort */ }
  return [...found];
}

const MAX_DEPTH = 4, MAX_ARRAY = 50, MAX_KEYS = 50;

function dropKey(key) {
  const k = String(key).toLowerCase();
  return DROP_KEY_EXACT.has(k) || SENSITIVE_KEY_SUBSTRING.test(k);
}

/** A copy of `value` safe to log or send: sensitive keys dropped, every string redacted, depth, size and cycles bounded. */
export function scrubValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null) return value;
  const t = typeof value;
  if (t === "string") return redactText(value);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated]";
  try {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (value instanceof Error) {
      return { name: redactText(value.name, { max: 60 }), message: redactText(value.message), stack: redactText(value.stack, { max: 2000 }) };
    }
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((x) => scrubValue(x, depth + 1, seen));
    const out = {};
    let n = 0;
    for (const key of Object.keys(value)) {
      if (n >= MAX_KEYS) break;
      if (dropKey(key)) continue;
      let inner;
      try { inner = value[key]; } catch (_) { continue; }
      const cleaned = scrubValue(inner, depth + 1, seen);
      if (cleaned !== undefined) { out[key] = cleaned; n++; }
    }
    return out;
  } catch (_) {
    return "[unreadable]";
  }
}

// ---- console redaction (LOG_REDACTION) -------------------------------------------------------------------------------

const LEVELS = ["log", "info", "warn", "error"];
const ORIGINAL = Symbol.for("lummet.console.original");
const CONSOLE_MAX = 20000;

/** "on" only for that exact word (any case, surrounding spaces ignored); everything else is "off". */
export function logRedactionMode(env) {
  return String(env?.LOG_REDACTION ?? "").trim().toLowerCase() === "on" ? "on" : "off";
}

function cleanArg(arg) {
  if (typeof arg === "string") return redactText(arg, { max: CONSOLE_MAX });
  if (arg === undefined || arg === null || typeof arg === "number" || typeof arg === "boolean") return arg;
  return scrubValue(arg);
}

/**
 * Wraps console.log/info/warn/error so every argument is redacted before it reaches the Worker log (and so Logpush).
 * Idempotent: a level that is already wrapped is not wrapped again, and a console function replaced later is wrapped on
 * the next call. With the flag off, any wrapper of ours is removed, so nothing is wrapped by default.
 */
export function installConsoleRedaction(env) {
  const on = logRedactionMode(env) === "on";
  for (const level of LEVELS) {
    const current = console[level];
    if (typeof current !== "function") continue;
    if (!on) { if (current[ORIGINAL]) console[level] = current[ORIGINAL]; continue; }
    if (current[ORIGINAL]) continue;
    const wrapped = function (...args) {
      let cleaned;
      try { cleaned = args.map(cleanArg); } catch (_) { cleaned = ["[unprintable log arguments]"]; }
      return current.apply(this, cleaned);
    };
    Object.defineProperty(wrapped, ORIGINAL, { value: current });
    console[level] = wrapped;
  }
}
