#!/usr/bin/env node
// =====================================================
// STAGING CHECKS (docs/STAGING_VALIDATION.md, phase 1)
//
// Probes a DEPLOYED control plane (and, with --site, one deployed customer site) for the things that are easy to get
// wrong on real infrastructure and that code tests cannot see: transport and headers, cookies, who is turned away,
// what the public site publishes, and what a site exposes. Nothing here needs a secret.
//
//   node scripts/staging-checks.mjs --base https://staging-cp.example.com \
//     [--site https://some-site.sites.example.com] [--with-signup] [--rate-limit] [--launch] [--json]
//
//   --with-signup   creates two throwaway organizations (cookie flags, CSRF, cross-organization isolation) and asks for
//                   their deletion afterwards. Use staging only.
//   --rate-limit    sends up to 15 wrong logins to prove the limiter answers 429. It locks YOUR address out of login for
//                   the limiter's window, so it is opt-in.
//   --launch        also fail the run for the LAUNCH checks (the things that must be true before taking money).
//
// Severity: BLOCKER fails the run. WARN is printed and should be fixed. LAUNCH is a gate for real customers: it never fails a
// staging run unless --launch is given. INFO is for the record. Exit code 0 = no blocker failed.
// =====================================================
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITIES = ["blocker", "warn", "launch", "info"];

export async function runStagingChecks({ base, site = null, fetchImpl = fetch, withSignup = false, rateLimit = false, log = () => {} } = {}) {
  const root = base.replace(/\/+$/, "");
  const results = [];
  const check = (id, severity, name, ok, detail = "") => {
    results.push({ id, severity, name, ok: !!ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  [${severity}]  ${id}  ${name}${detail ? "  " + detail : ""}`);
    return !!ok;
  };
  const get = async (url, init = {}) => {
    try {
      const res = await fetchImpl(url, { redirect: "manual", ...init });
      const text = init.skipBody ? "" : await res.text().catch(() => "");
      return { res, text, status: res.status, h: (n) => res.headers.get(n) };
    } catch (e) {
      return { res: null, text: "", status: 0, h: () => null, error: String(e?.message || e) };
    }
  };
  const cookieList = (res) => (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean));

  // ---------------------------------------------------------------- A. transport and headers
  const isHttps = root.startsWith("https://");
  check("A1", "blocker", "the control plane is served over HTTPS", isHttps, isHttps ? "" : root);
  if (isHttps) {
    const plain = await get("http://" + root.slice(8) + "/", { skipBody: true });
    const loc = plain.h("location") || "";
    check("A2", "warn", "plain HTTP is redirected to HTTPS", plain.status === 0 ? true : ([301, 302, 307, 308].includes(plain.status) && loc.startsWith("https://")),
      plain.status === 0 ? "port 80 not reachable (fine)" : `HTTP ${plain.status} ${loc}`);
  }

  const login = await get(root + "/app/login");
  check("A3", "blocker", "the customer login page loads", login.status === 200 && /html/.test(login.h("content-type") || ""), `HTTP ${login.status}${login.error ? " " + login.error : ""}`);
  const hsts = login.h("strict-transport-security") || "";
  const maxAge = Number((hsts.match(/max-age=(\d+)/) || [])[1] || 0);
  check("A4", "blocker", "Strict-Transport-Security is set for at least 6 months", maxAge >= 15552000, hsts || "missing");
  check("A5", "blocker", "X-Content-Type-Options is nosniff", (login.h("x-content-type-options") || "").toLowerCase() === "nosniff", login.h("x-content-type-options") || "missing");
  check("A6", "blocker", "framing is refused (X-Frame-Options DENY and frame-ancestors 'none')", /deny/i.test(login.h("x-frame-options") || "") && /frame-ancestors 'none'/.test(login.h("content-security-policy") || ""), `${login.h("x-frame-options") || "no XFO"}`);
  check("A7", "warn", "Referrer-Policy and Permissions-Policy are set", !!login.h("referrer-policy") && !!login.h("permissions-policy"), `${login.h("referrer-policy") || "no referrer-policy"} / ${login.h("permissions-policy") ? "permissions-policy set" : "no permissions-policy"}`);

  const enforced = /script-src 'nonce-[^']+'/.test(login.h("content-security-policy") || "") && /script-src-attr 'none'/.test(login.h("content-security-policy") || "");
  const reporting = /script-src 'nonce-[^']+'/.test(login.h("content-security-policy-report-only") || "");
  check("A8", "blocker", "the script policy is active (enforced or reporting) on customer pages", enforced || reporting, enforced ? "enforced" : reporting ? "report-only" : "no script policy header");
  check("A9", "launch", "the script policy is ENFORCED, not only reporting (CSP_MODE=enforce)", enforced, enforced ? "" : "set CSP_MODE=enforce once the soak shows no violations (docs/CSP.md)");
  const nonceMatch = `${login.h("content-security-policy") || ""} ${login.h("content-security-policy-report-only") || ""}`.match(/'nonce-([^']+)'/);
  const scripts = [...login.text.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  check("A10", "blocker", "every inline script on the login page carries this response's nonce", !!nonceMatch && scripts.filter((a) => !/\bsrc=/.test(a) && !/ld\+json/.test(a)).every((a) => a.includes(`nonce="${nonceMatch[1]}"`)), nonceMatch ? `${scripts.length} script tag(s)` : "no nonce found");
  check("A11", "blocker", "no inline event-handler attributes on the login page", !/<[^>]*[\s"'/]on(click|submit|change|input|load|error)=/.test(login.text));

  const ids = [];
  for (const p of ["/app/login", "/api/health", "/does-not-exist-" + Math.random().toString(36).slice(2)]) ids.push((await get(root + p, { skipBody: true })).h("x-request-id"));
  check("A12", "blocker", "every response carries a unique X-Request-Id", ids.every((i) => UUID.test(i || "")) && new Set(ids).size === ids.length, ids.map((i) => (i || "none").slice(0, 8)).join(" "));

  const missing = await get(root + "/does-not-exist-" + Math.random().toString(36).slice(2));
  check("A13", "blocker", "an unknown path is a 404 (or a redirect to sign in) and leaks no internals", (missing.status === 404 || ([301, 302, 303, 307].includes(missing.status) && /login/.test(missing.h("location") || ""))) && !/node_modules|\.js:\d+|stack|ReferenceError|TypeError|at async/i.test(missing.text), `HTTP ${missing.status}`);
  const health = await get(root + "/api/health");
  check("A14", "warn", "/api/health answers 200 {\"ok\":true} (for uptime monitors)", health.status === 200 && /"ok"\s*:\s*true/.test(health.text), `HTTP ${health.status}`);
  check("A15", "warn", "no X-Powered-By header", !login.h("x-powered-by"), login.h("x-powered-by") || "");
  const report = await get(root + "/api/csp-report", { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "document-uri": root + "/staging-check", "violated-directive": "script-src", "blocked-uri": "inline" } }) });
  check("A16", "warn", "CSP reports are accepted (204)", report.status === 204, `HTTP ${report.status}`);

  // ---------------------------------------------------------------- B. who is turned away
  const wall = async (id, name, path, accept, init = {}) => { const r = await get(root + path, { skipBody: true, ...init }); return check(id, "blocker", name, accept(r), `HTTP ${r.status}`); };
  await wall("B1", "a signed-out visitor is sent to sign in, not shown the portal", "/app/overview", (r) => [301, 302, 303, 307].includes(r.status) && /\/app\/login/.test(r.h("location") || ""));
  await wall("B2", "the organization API refuses a signed-out caller", "/api/organizations/00000000-0000-0000-0000-000000000000/sites", (r) => r.status === 401);
  await wall("B3", "the staff console is not shown to a signed-out visitor", "/platform/saas", (r) => r.status !== 200 && r.status < 500);
  await wall("B4", "the staff API refuses a signed-out caller", "/api/platform/saas/jobs", (r) => [401, 403].includes(r.status));
  await wall("B5", "the developer API refuses a bad key", "/api/v1/sites", (r) => r.status === 401, { headers: { Authorization: "Bearer lmk_badbadbad_badbadbadbadbadbadbadbadbadbadbadbad" } });
  await wall("B6", "the maintenance tick refuses a caller without the token", "/api/ops/alert-check", (r) => [401, 403, 404].includes(r.status), { method: "POST" });
  const spoof = await get(root + "/api/customer/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ email: "nobody@example.test", password: "x" }), skipBody: true });
  check("B7", "warn", "a login attempt from a foreign Origin is not accepted as a normal request", spoof.status !== 200, `HTTP ${spoof.status}`);

  // ---------------------------------------------------------------- C. cookies, CSRF, isolation (throwaway organizations)
  if (withSignup) {
    const mk = async (label) => {
      const email = `staging-${label}-${Date.now().toString(36)}@example.test`;
      const res = await fetchImpl(root + "/api/customer/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Staging-Check-Passw0rd-9", organizationName: `Staging ${label} ${Date.now().toString(36)}` }), redirect: "manual" });
      const body = await res.json().catch(() => ({}));
      const raw = cookieList(res).find((c) => c.startsWith("lummet_customer_session="));
      return { email, orgId: body.organizationId, setCookie: raw || "", cookie: raw ? raw.split(";")[0] : null, status: res.status };
    };
    const a = await mk("a"); const b = await mk("b");
    check("C1", "blocker", "sign-up works and sets a session cookie", a.status === 200 && !!a.cookie && !!a.orgId, `HTTP ${a.status}`);
    if (a.cookie) {
      const flags = a.setCookie.toLowerCase();
      check("C2", "blocker", "the session cookie is HttpOnly, Secure, SameSite and path /", flags.includes("httponly") && flags.includes("secure") && /samesite=(lax|strict)/.test(flags) && /path=\//.test(flags), a.setCookie.replace(/=[^;]+/, "=<value>"));
      const foreign = await get(root + "/api/customer/logout", { method: "POST", headers: { Cookie: a.cookie, Origin: "https://evil.example" }, skipBody: true });
      check("C3", "blocker", "a cookie-authenticated request from a foreign Origin is refused (CSRF)", foreign.status === 403, `HTTP ${foreign.status}`);
      const own = await get(root + `/api/organizations/${a.orgId}/sites`, { headers: { Cookie: a.cookie, Origin: root }, skipBody: true });
      check("C4", "blocker", "the same request from the portal's own Origin works", own.status === 200, `HTTP ${own.status}`);
    }
    if (a.cookie && b.cookie && b.orgId) {
      const cross = await get(root + `/api/organizations/${b.orgId}/sites`, { headers: { Cookie: a.cookie, Origin: root } });
      check("C5", "blocker", "organization A cannot read organization B's sites", [403, 404].includes(cross.status) && !/"data"\s*:\s*\[/.test(cross.text), `HTTP ${cross.status}`);
      const crossWrite = await get(root + `/api/organizations/${b.orgId}/sites`, { method: "POST", headers: { Cookie: a.cookie, Origin: root, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", productId: "prod_casino_news" }), skipBody: true });
      check("C6", "blocker", "organization A cannot create a site in organization B", [403, 404].includes(crossWrite.status), `HTTP ${crossWrite.status}`);
    }
    for (const x of [a, b]) if (x.cookie && x.orgId) await get(root + `/api/organizations/${x.orgId}/request-deletion`, { method: "POST", headers: { Cookie: x.cookie, Origin: root, "Content-Type": "application/json" }, body: "{}", skipBody: true });
  }

  // ---------------------------------------------------------------- D. the public site
  const page = async (p) => get(root + p);
  const home = await page("/");
  check("D1", "blocker", "the public home page loads", home.status === 200 && /html/.test(home.h("content-type") || ""), `HTTP ${home.status}`);
  const pubCsp = home.h("content-security-policy") || "";
  const scriptDirective = (pubCsp.match(/script-src([^;]*)/) || [])[1] || "";
  check("D2", "blocker", "the public site's script policy allows no inline or foreign scripts", /script-src/.test(pubCsp) && !/unsafe-inline|unsafe-eval|\*|https?:/.test(scriptDirective), pubCsp ? `script-src${scriptDirective}` : "no CSP");
  const pricing = await page("/pricing");
  check("D3", "warn", "/pricing loads and lists at least one plan", pricing.status === 200 && /per month|per year/.test(pricing.text), `HTTP ${pricing.status}`);
  const sitemap = await page("/sitemap.xml");
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check("D4", "blocker", "sitemap.xml lists absolute URLs on the real host (not localhost or a placeholder)", sitemap.status === 200 && locs.length > 0 && locs.every((l) => /^https:\/\//.test(l) && !/localhost|127\.0\.0\.1|example\.(com|org|net)\b/.test(l)), `${locs.length} URL(s), e.g. ${locs[0] || "none"}`);
  const robots = await page("/robots.txt");
  check("D5", "warn", "robots.txt exists, does not block everything and points at the sitemap", robots.status === 200 && !/^\s*Disallow:\s*\/\s*$/m.test(robots.text) && /sitemap:/i.test(robots.text), `HTTP ${robots.status}`);
  for (const [id, p] of [["D6", "/privacy"], ["D7", "/terms"]]) {
    const r = await page(p);
    check(id, "launch", `${p} is published with real text`, r.status === 200 && !/draft|replace this text|lorem ipsum|todo/i.test(r.text), r.status === 200 ? "" : `HTTP ${r.status}: not published (needs counsel-approved text)`);
  }
  for (const [id, p] of [["D8", "/about"], ["D9", "/contact"], ["D10", "/security"]]) {
    const r = await page(p); check(id, "warn", `${p} loads`, r.status === 200, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- E. attempt limiting (opt-in)
  if (rateLimit) {
    let limited = false, tries = 0;
    for (; tries < 15 && !limited; tries++) {
      const r = await get(root + "/api/customer/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: root }, body: JSON.stringify({ email: "nobody@example.test", password: "wrong-" + tries }), skipBody: true });
      limited = r.status === 429;
    }
    check("E1", "blocker", "repeated wrong logins are answered 429", limited, limited ? `after ${tries} attempt(s)` : "15 attempts never limited");
  }

  // ---------------------------------------------------------------- F. one deployed customer site
  if (site) {
    const sroot = site.replace(/\/+$/, "");
    check("F1", "blocker", "the site is served over HTTPS", sroot.startsWith("https://"), sroot);
    const sh = await get(sroot + "/");
    check("F2", "blocker", "the site's home page loads", sh.status === 200 && /html/.test(sh.h("content-type") || ""), `HTTP ${sh.status}${sh.error ? " " + sh.error : ""}`);
    const css = (sh.text.match(/href=["']([^"']+\.css[^"']*)["']/i) || [])[1];
    const cssRes = css ? await get(new URL(css, sroot + "/").toString(), { skipBody: true }) : null;
    check("F3", "blocker", "its stylesheet loads", !!cssRes && cssRes.status === 200 && /css/.test(cssRes.h("content-type") || ""), css ? `HTTP ${cssRes.status}` : "no stylesheet link");
    const setup = await get(sroot + "/en/api/v1/setup/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "attacker@example.test", password: "Attacker-Passw0rd-123" }), skipBody: true });
    check("F4", "blocker", "the open administrator-setup endpoint does not exist (nobody can make themselves admin)", setup.status === 404, `HTTP ${setup.status}`);
    const sup = await get(sroot + "/en/api/super/analytics-overview", { skipBody: true });
    check("F5", "blocker", "the Super API refuses an unsigned request", [401, 403].includes(sup.status), `HTTP ${sup.status}`);
    const dash = await get(sroot + "/en/dashboard", { skipBody: true });
    check("F6", "blocker", "the dashboard is not shown to a signed-out visitor", dash.status !== 200, `HTTP ${dash.status}`);
    const lp = await get(sroot + "/en/login");
    const widget = /class="cf-turnstile"/.test(lp.text);
    check("F7", "blocker", "the site's login page loads", lp.status === 200, `HTTP ${lp.status}`);
    check("F8", "info", "Turnstile on the site's login page", true, widget ? "on (TENANT_TURNSTILE_* set)" : "off (relies on the attempt limiter)");
    check("F9", "warn", "the site sends no X-Powered-By header", !sh.h("x-powered-by"), sh.h("x-powered-by") || "");
  }

  const failed = (sev) => results.filter((r) => !r.ok && r.severity === sev);
  return { results, counts: Object.fromEntries(SEVERITIES.map((s) => [s, { total: results.filter((r) => r.severity === s).length, failed: failed(s).length }])), blockers: failed("blocker"), launch: failed("launch"), ok: failed("blocker").length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []));
  if (!args.base) { console.error("Usage: node scripts/staging-checks.mjs --base <control plane url> [--site <site url>] [--with-signup] [--rate-limit] [--launch] [--json]"); process.exit(2); }
  const quiet = !!args.json;
  const r = await runStagingChecks({ base: String(args.base), site: args.site ? String(args.site) : null, withSignup: !!args["with-signup"], rateLimit: !!args["rate-limit"], log: (m) => { if (!quiet) console.log(m); } });
  if (quiet) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`\nBlockers failed: ${r.counts.blocker.failed}/${r.counts.blocker.total}   Warnings failed: ${r.counts.warn.failed}/${r.counts.warn.total}   Launch gates open: ${r.counts.launch.failed}/${r.counts.launch.total}`);
    for (const x of r.blockers) console.log(`  BLOCKER ${x.id} ${x.name} ${x.detail}`);
    for (const x of r.launch) console.log(`  LAUNCH  ${x.id} ${x.name} ${x.detail}`);
  }
  process.exit(r.blockers.length === 0 && (!args.launch || r.launch.length === 0) ? 0 : 1);
}
