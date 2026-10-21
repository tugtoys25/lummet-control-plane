#!/usr/bin/env node
// =====================================================
// FIRST-SITE SMOKE TEST (go-live checklist, section 5)
//
// Walks one new customer through the whole path against a DEPLOYED
// control plane and checks each step, so the first live run tells you
// exactly where it breaks:
//   signup -> start trial -> create site -> wait for 'active' ->
//   homepage returns HTML -> its stylesheet loads ->
//   set the dashboard password -> sign in to the site's dashboard -> open it -> clean up
//
//   node scripts/smoke-test.mjs --base https://staging-cp.example.com \
//     [--plan plan_casino_news_starter] [--product prod_casino_news] \
//     [--timeout 180] [--keep] [--no-dashboard-login] [--turnstile-on]
//
// Needs a tenant release already published (publish-tenant-release.mjs)
// and the routing/DNS/certificate setup from DEPLOYMENT.md. Without
// --keep it asks for the test organization's deletion at the end (a 30 day
// grace period applies; the site's Cloudflare resources go when it runs,
// or on a manual deletion sweep from the staff overview). Use staging.
// Exit code 0 only if every step passed.
// =====================================================
import { pathToFileURL } from "node:url";

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  const hit = list.map((c) => c.split(";")[0]).find((c) => c.startsWith("lummet_customer_session="));
  return hit || null;
}

export async function runSmoke({ base, fetchImpl = fetch, planId = "plan_casino_news_starter", productId = "prod_casino_news", timeoutMs = 180000, pollMs = 3000, keep = false, dashboardLogin = false, turnstileOn = false, log = () => {} } = {}) {
  const steps = [];
  const record = (name, ok, detail = "") => { steps.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); return ok; };
  const root = base.replace(/\/+$/, "");
  let cookie = null, orgId = null, siteId = null, host = null, email = null;

  const api = async (method, path, body) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { res, status: res.status, json, text };
  };

  try {
    // 1. signup
    email = `smoke-${Date.now().toString(36)}@example.test`;
    const signup = await api("POST", "/api/customer/signup", { email, password: "Smoke-Test-Passw0rd-9", organizationName: `Smoke ${Date.now().toString(36)}`, displayName: "Smoke Test" });
    cookie = cookieFrom(signup.res);
    orgId = signup.json?.organizationId;
    if (!record("sign up", signup.status === 200 && !!orgId && !!cookie, signup.status === 200 ? "" : `HTTP ${signup.status} ${signup.json?.error || ""}`)) return { ok: false, steps };

    // 2. trial
    const trial = await api("POST", `/api/organizations/${orgId}/trial`, { planId });
    if (!record("start trial", trial.status === 200, trial.status === 200 ? planId : `HTTP ${trial.status} ${trial.json?.error || ""} (is ${planId} seeded?)`)) return { ok: false, steps };

    // 3. create site
    const created = await api("POST", `/api/organizations/${orgId}/sites`, { name: "Smoke site", productId });
    siteId = created.json?.siteId;
    if (!record("create site", created.status === 200 && !!siteId, created.status === 200 ? "" : `HTTP ${created.status} ${created.json?.error || ""}`)) return { ok: false, steps };

    // 4. wait for active
    const deadline = Date.now() + timeoutMs;
    let status = null, last = null;
    while (Date.now() < deadline) {
      const list = await api("GET", `/api/organizations/${orgId}/sites`);
      const site = (list.json?.data || []).find((s) => s.id === siteId);
      status = site?.status || null;
      if (status !== last) { log(`      site status: ${status}`); last = status; }
      if (site) host = site.primary_domain || host;
      if (status === "active" || status === "failed") break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (status !== "active") {
      let why = status === "failed" ? "provisioning or deployment failed" : `still '${status}' after ${Math.round(timeoutMs / 1000)}s`;
      const deps = await api("GET", `/api/organizations/${orgId}/sites/${siteId}/deployments`).catch(() => null);
      const bad = (deps?.json?.data || []).find((d) => d.error_message);
      if (bad) why += `; last deployment error: ${bad.error_message}`;
      else why += "; check Staff > Jobs for the failing step. If it stopped at 'provisioned', no tenant release is published.";
      record("site becomes active", false, why);
      return { ok: false, steps };
    }
    record("site becomes active", true, host || "");

    // 5. homepage
    if (!host) { record("homepage loads", false, "site has no hostname"); return { ok: false, steps }; }
    const siteUrl = `https://${host}`;
    let page;
    try { page = await fetchImpl(siteUrl + "/", { redirect: "manual" }); }
    catch (e) { record("homepage loads", false, `${siteUrl}/ unreachable: ${e.message} (DNS, route or certificate? see DEPLOYMENT.md)`); return { ok: false, steps }; }
    const html = await page.text();
    const isHtml = (page.headers.get("content-type") || "").includes("text/html");
    if (!record("homepage loads", page.status === 200 && isHtml, `${siteUrl}/ -> HTTP ${page.status}`)) return { ok: false, steps };

    // 6. stylesheet
    const css = html.match(/href=["']([^"']+\.css[^"']*)["']/i);
    if (!css) record("stylesheet loads", false, "no stylesheet link found in the homepage HTML");
    else {
      const cssUrl = new URL(css[1], siteUrl + "/").toString();
      const cssRes = await fetchImpl(cssUrl, { redirect: "manual" }).catch((e) => ({ status: 0, headers: new Headers(), err: e }));
      record("stylesheet loads", cssRes.status === 200 && (cssRes.headers.get("content-type") || "").includes("css"), `${cssUrl} -> HTTP ${cssRes.status}`);
    }

    // 7. the customer's own login to the site's dashboard (the self-serve path to editing content)
    if (dashboardLogin) {
      const dashPassword = "Smoke-Dashboard-Passw0rd-9";
      const set = await api("POST", `/api/organizations/${orgId}/sites/${siteId}/dashboard-admin`, { password: dashPassword });
      if (!record("set dashboard password", set.status === 200, set.status === 200 ? email : `HTTP ${set.status} ${set.json?.error || ""} (site_database_unavailable = the Worker's CF_API_TOKEN cannot edit the site's D1)`)) return { ok: false, steps };
      if (turnstileOn) {
        record("sign in to the dashboard", true, "skipped (--turnstile-on): this script cannot solve a Turnstile challenge; sign in by hand");
      } else {
        let login;
        try {
          login = await fetchImpl(siteUrl + "/en/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: dashPassword }), redirect: "manual" });
        } catch (e) { record("sign in to the dashboard", false, `${siteUrl} unreachable: ${e.message}`); return { ok: false, steps }; }
        const body = await login.json().catch(() => ({}));
        const sessionCookie = (typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")].filter(Boolean)).map((c) => c.split(";")[0]).find((c) => c.startsWith("session="));
        const detail = login.status === 200 ? "" : login.status === 403 ? "HTTP 403: the site asks for Turnstile. If TENANT_TURNSTILE_* are set that is expected; rerun with --turnstile-on and sign in by hand. If not, the site is running tenant code older than v7J." : `HTTP ${login.status} ${body.error || ""}`;
        if (!record("sign in to the dashboard", login.status === 200 && body.success === true && !!sessionCookie, detail)) return { ok: false, steps };
        const dash = await fetchImpl(siteUrl + "/en/dashboard", { headers: { Cookie: sessionCookie }, redirect: "manual" }).catch((e) => ({ status: 0, headers: new Headers(), err: e }));
        record("dashboard opens", dash.status === 200 && (dash.headers.get("content-type") || "").includes("text/html"), `${siteUrl}/en/dashboard -> HTTP ${dash.status}`);
      }
    }
  } catch (e) {
    record("unexpected error", false, String(e?.message || e));
  } finally {
    // 8. clean up
    if (orgId && cookie && !keep) {
      const del = await api("POST", `/api/organizations/${orgId}/request-deletion`, {}).catch(() => null);
      record("request clean-up (organization deletion)", !!del && del.status === 200, del && del.status === 200 ? "scheduled; erased after the grace period or by a manual deletion sweep" : "could not schedule; delete it manually");
    } else if (orgId && keep) {
      log(`      kept organization ${orgId}`);
    }
  }
  const ok = steps.filter((s) => !s.name.startsWith("request clean-up")).every((s) => s.ok);
  return { ok, steps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []));
  if (!args.base) { console.error("Usage: node scripts/smoke-test.mjs --base <control plane url> [--plan ...] [--product ...] [--timeout 180] [--keep] [--no-dashboard-login] [--turnstile-on]"); process.exit(2); }
  const result = await runSmoke({ base: String(args.base), planId: args.plan || undefined, productId: args.product || undefined, timeoutMs: Number(args.timeout || 180) * 1000, keep: !!args.keep, dashboardLogin: !args["no-dashboard-login"], turnstileOn: !!args["turnstile-on"], log: (m) => console.log(m) });
  console.log(result.ok ? "\nSmoke test PASSED." : "\nSmoke test FAILED. Fix the first FAIL above and run again.");
  process.exit(result.ok ? 0 : 1);
}
