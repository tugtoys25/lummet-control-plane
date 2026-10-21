// =====================================================
// CONTENT SECURITY POLICY (v7E)
//
// Goal: an attacker who manages to inject HTML into a page (stored XSS in a name, a note, a title...) can not run
// script. That needs three things, all here:
//
//   1. Every legitimate inline <script> carries a per-response NONCE, and the policy only runs scripts with it.
//   2. No inline event handlers (onclick="..."): they cannot carry a nonce. Templates use onClick()/onSubmit()/
//      onChange() below instead, which emit  data-onclick="functionName" data-args='[...JSON...]'. One static runtime
//      (UI_RUNTIME) listens at the document and calls the named page function. Data only ever travels as JSON in an
//      attribute; it is never code.
//   3. script-src-attr 'none' so a handler attribute that does slip into a page is inert.
//
// HOW THE NONCE IS ISSUED, and why it is not "blessing every script": views write  <script nonce="${nonceToken()}">.
// nonceToken() is a random secret created lazily inside this isolate. It exists only in memory and in Worker-side
// templates; finalizeResponse() swaps it for the real per-response nonce on the way out. An injected script cannot
// contain it because it never appears in anything an attacker can read (the response carries the swapped nonce, and the
// token is stripped from every non-HTML text response too). Scripts without the token get no nonce and do not run.
// =====================================================

let TOKEN = null;

/** Secret placeholder for the response nonce. Lazy: Workers forbid random values at global scope. */
export function nonceToken() {
  if (!TOKEN) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    TOKEN = "lnt" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return TOKEN;
}

const escAttr = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FN_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * Attributes that make an element call the page function `fn` with `args` when `event` happens. Returned with a
 * leading space so it drops straight into a tag:  <button class="x"${onClick("lummetRevokeKey", [key.id])}>
 *
 * args    JSON-serialisable values. The strings "$el", "$ev" and "$value" are replaced in the browser by the element,
 *         the event and the element's current value.
 * confirm text to ask with window.confirm first; cancelling stops the call.
 * prevent preventDefault() always (the old `return false`). A function that returns false also prevents default.
 */
function attrs(event, fn, args = [], { confirm, prevent } = {}) {
  if (!FN_NAME.test(fn)) throw new Error(`invalid action function name: ${fn}`);
  let out = ` data-on${event}="${fn}"`;
  if (args && args.length) out += ` data-args="${escAttr(JSON.stringify(args))}"`;
  if (confirm) out += ` data-confirm="${escAttr(confirm)}"`;
  if (prevent) out += ` data-prevent="1"`;
  return out;
}
export const onClick = (fn, args, opts) => attrs("click", fn, args, opts);
export const onSubmit = (fn, args, opts) => attrs("submit", fn, args, opts);
export const onChange = (fn, args, opts) => attrs("change", fn, args, opts);
export const onInput = (fn, args, opts) => attrs("input", fn, args, opts);

/** For browser-side code that builds HTML strings: same JSON-in-attribute encoding as the helpers above. */
export const BROWSER_HELPER = `function lummetAttrs(ev, fn, args, opts) {
  opts = opts || {};
  var s = ' data-on' + ev + '="' + fn + '"';
  if (args && args.length) s += ' data-args="' + lummetEscAttr(JSON.stringify(args)) + '"';
  if (opts.confirm) s += ' data-confirm="' + lummetEscAttr(opts.confirm) + '"';
  if (opts.prevent) s += ' data-prevent="1"';
  return s;
}
function lummetEscAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }`;

const RUNTIME_MARK = "/*lummet-ui-runtime*/";

/** Static. Delegated listeners that turn data-on<event> attributes into calls of named page functions. */
export const UI_RUNTIME = `${RUNTIME_MARK}(function () {
  var EVENTS = ['click', 'change', 'submit', 'input'];
  function run(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-on' + e.type + ']');
    if (!el) return;
    var name = el.getAttribute('data-on' + e.type);
    var fn = /^[A-Za-z_$][\\w$]*$/.test(name || '') ? window[name] : null;
    if (typeof fn !== 'function') return;
    var msg = el.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    var args = [];
    try { args = JSON.parse(el.getAttribute('data-args') || '[]'); } catch (_) { args = []; }
    if (!Array.isArray(args)) args = [];
    args = args.map(function (a) { return a === '$el' ? el : a === '$ev' ? e : a === '$value' ? el.value : a; });
    if (el.getAttribute('data-prevent')) e.preventDefault();
    var r = fn.apply(el, args);
    if (r === false) e.preventDefault();
  }
  window.lummetSubmitForm = function (el) { if (el && el.form) el.form.submit(); };
  EVENTS.forEach(function (type) { document.addEventListener(type, run, true); });
})();`;

function makeNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** 'enforce' | 'report-only'. Anything but "enforce" reports without blocking (staging first, then flip). */
export function cspMode(env) {
  return env && String(env.CSP_MODE || "").toLowerCase() === "enforce" ? "enforce" : "report-only";
}

/** Directives that apply to every response (the v7 baseline). */
export const BASE_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; connect-src 'self'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; img-src 'self' data: https:";

/** The directives v7E adds for HTML pages. */
export function scriptDirectives(nonce) {
  return `script-src 'nonce-${nonce}'; script-src-attr 'none'`;
}

const isHtml = (ct) => /text\/html/i.test(ct);
const isTextual = (ct) => /application\/json|text\/(plain|csv|xml)/i.test(ct);

/**
 * Applies the policy to a finished response: swaps the secret token for this response's nonce, adds the UI runtime
 * if the page uses data-on* attributes, and sets the CSP headers. Non-HTML text responses just lose the token if
 * it ever leaked into them. Everything else (binary, streams, no body) passes through untouched except for headers.
 */
export async function finalizeResponse(response, env) {
  const headers = new Headers(response.headers);
  const ct = headers.get("Content-Type") || "";
  const mode = cspMode(env);
  const token = nonceToken();

  // A response that brings its own policy keeps it exactly as it is. The public site does: it loads same-origin script
  // files under its own `script-src 'self'`, and replacing that with a nonce-only policy would block all of them.
  // (It never contains the secret token; stripping it anyway costs nothing and keeps the guarantee unconditional.)
  if (headers.has("Content-Security-Policy") || headers.has("Content-Security-Policy-Report-Only")) {
    if (response.body && (isHtml(ct) || isTextual(ct))) {
      const text = await response.text();
      headers.delete("Content-Length");
      return new Response(text.includes(token) ? text.split(token).join("") : text, { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  if (response.body && isHtml(ct)) {
    let html = await response.text();
    const nonce = makeNonce();
    html = html.split(token).join(nonce);
    if (/\sdata-on(click|submit|change|input)=/.test(html) && !html.includes(RUNTIME_MARK)) {
      const tag = `<script nonce="${nonce}">${UI_RUNTIME}</script>`;
      const i = html.lastIndexOf("</body>");
      html = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
    }
    const scripts = scriptDirectives(nonce);
    if (mode === "enforce") {
      headers.set("Content-Security-Policy", `${BASE_CSP}; ${scripts}`);
    } else {
      headers.set("Content-Security-Policy", BASE_CSP);
      headers.set("Content-Security-Policy-Report-Only", `${scripts}; report-uri /api/csp-report`);
    }
    headers.delete("Content-Length");
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  }

  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", BASE_CSP);

  if (response.body && isTextual(ct)) {
    const text = await response.text();
    if (text.includes(token)) {
      headers.delete("Content-Length");
      return new Response(text.split(token).join(""), { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Handles POST /api/csp-report: logs a trimmed record, stores nothing, always 204. */
export async function handleCspReport(request) {
  let text = "";
  try { text = (await request.text()).slice(0, 8000); } catch (_) { /* ignore */ }
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
