// =====================================================
// HTML SANITISER for staff-written announcements.
//
// Staff may format a message with HTML. The result is shown inside customers' dashboards and sent as email, so it is rebuilt from an allow-list:
// only the tags and attributes below survive, scripts/styles/frames and their contents are dropped, every event handler and inline style is
// removed, links must be http(s), mailto, tel, a path or an anchor, and images must be https or a path of this site. Anything else is
// turned into harmless text. Unclosed tags are closed so one message can never break the page around it.
// =====================================================
export const MAX_HTML_CHARS = 60000;

const VOID = new Set(["br", "hr", "img"]);
const ALLOWED = {
  a: ["href", "title"], img: ["src", "alt", "width", "height"], p: [], br: [], hr: [], b: [], strong: [], i: [], em: [], u: [], s: [], small: [], sup: [], sub: [],
  ul: [], ol: [], li: [], h1: [], h2: [], h3: [], h4: [], blockquote: [], code: [], pre: [], span: [], div: [],
  table: [], thead: [], tbody: [], tr: [], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
};
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "head", "title", "noscript", "template", "textarea", "select", "form", "button", "frameset", "applet"]);

const escText = (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (v) => String(v).replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32)).replace(/&colon;/gi, ":").replace(/&tab;|&newline;/gi, "").replace(/&amp;/gi, "&");

/** A link or image address that is safe to keep, or null. */
export function safeUrl(raw, { image = false } = {}) {
  const v = decode(raw).replace(/[\u0000- \u007f-\u009f]+/g, "");
  if (!v || v.length > 2000) return null;
  if (v.startsWith("#")) return image ? null : v;
  if (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")) return v;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === "https") return v;
  if (!image && (scheme === "http" || scheme === "mailto" || scheme === "tel")) return v;
  return null;
}

function parseAttrs(src) {
  const out = {}; const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let m;
  while ((m = re.exec(src))) { const name = m[1].toLowerCase(); if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? ""; }
  return out;
}

export function sanitizeHtml(input) {
  let html = String(input == null ? "" : input).slice(0, MAX_HTML_CHARS).replace(/\u0000/g, "");
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<![^>]*>/g, "").replace(/<\?[^>]*>/g, "");
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = "", last = 0, m; const stack = [];
  while ((m = tag.exec(html))) {
    out += escText(html.slice(last, m.index)); last = tag.lastIndex;
    const closing = m[1] === "/", name = m[2].toLowerCase();
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        const end = new RegExp(`</${name}\\s*>`, "i"); const rest = html.slice(last); const e = end.exec(rest);
        if (e) { last += e.index + e[0].length; tag.lastIndex = last; } else { last = html.length; tag.lastIndex = last; }
      }
      continue;
    }
    if (!(name in ALLOWED)) continue;
    if (closing) {
      const i = stack.lastIndexOf(name);
      if (i === -1) continue;
      while (stack.length > i) out += `</${stack.pop()}>`;
      continue;
    }
    const attrs = parseAttrs(m[3]); let built = "";
    for (const a of ALLOWED[name]) {
      if (!(a in attrs)) continue;
      let v = attrs[a];
      if (a === "href") { v = safeUrl(v); if (v === null) continue; }
      else if (a === "src") { v = safeUrl(v, { image: true }); if (v === null) continue; }
      else if (a === "width" || a === "height" || a === "colspan" || a === "rowspan") { if (!/^\d{1,4}$/.test(String(v).trim())) continue; v = String(v).trim(); }
      else v = String(v).slice(0, 300);
      built += ` ${a}="${escAttr(v)}"`;
    }
    if (name === "img" && !/ src=/.test(built)) continue;
    if (name === "a") built += ' rel="noopener noreferrer nofollow" target="_blank"';
    if (name === "img") built += ' style="max-width:100%;height:auto"';
    out += `<${name}${built}>`;
    if (!VOID.has(name)) stack.push(name);
  }
  out += escText(html.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out.trim();
}

/** Plain text the author typed, as paragraphs. */
export function textToHtml(text) {
  return String(text == null ? "" : text).slice(0, MAX_HTML_CHARS).replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escText(p.replace(/&/g, "&amp;")).replace(/\n/g, "<br>")}</p>`).join("");
}

/** A readable text version of sanitised HTML, for the plain-text part of an email. */
export function htmlToText(html) {
  return String(html || "").replace(/<(br|hr)\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-4]|li|tr|blockquote|pre)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ").replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, "")} (${decode(href)})`)
    .replace(/<img [^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => (alt ? `[${alt}]` : "")).replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}
