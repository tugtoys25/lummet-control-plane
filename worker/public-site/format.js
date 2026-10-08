// =====================================================
// PUBLIC SITE — small pure helpers (dates, text, URLs)
// =====================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-30" or full ISO -> { iso: "2026-09-30", label: "Sep 30, 2026" } (UTC, no locale drift). */
export function formatDate(value) {
  if (!value) return { iso: "", label: "" };
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { iso: "", label: "" };
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return { iso: "", label: "" };
  return { iso: `${m[1]}-${m[2]}-${m[3]}`, label: `${month} ${Number(m[3])}, ${m[1]}` };
}

export function stripTags(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** ~220 words per minute, minimum 1. Computed from the real body text. */
export function readingMinutes(html) {
  const words = stripTags(html).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export function initials(name) {
  const clean = String(name || "")
    .replace(/\.(com|casino|xyz|io|net|org)$/i, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim();
  if (!clean) return "";
  const parts = clean.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
}

/**
 * Allow only http(s), mailto, site-relative and in-page URLs. Anything
 * else (javascript:, data:, vbscript:, ...) becomes "" so it can never
 * reach an href/src, even if an admin pastes it into a CMS field.
 */
export function safeUrl(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (v.startsWith("#")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v)) return v;
  return "";
}

export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isExternal(url) {
  return /^https?:\/\//i.test(url || "");
}

/** Validated CSS colour (hex / rgb() / bare keyword) — goes into a <style> block. */
export function safeCssColor(value) {
  if (!value) return "";
  const v = String(value).trim();
  const ok =
    /^#[0-9a-fA-F]{3,8}$/.test(v) ||
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v) ||
    /^[a-zA-Z]{3,20}$/.test(v);
  return ok ? v : "";
}

export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** "{center} has {count}" + { center, count } -> text. Unknown tokens are left empty, never "undefined". */
export function fill(template, vars = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));
}
