#!/usr/bin/env node
// =====================================================
// FIRST-SITE SMOKE TEST (go-live checklist, section 5)
//
// Walks one new customer through the whole path against a DEPLOYED
// control plane and checks each step, so the first live run tells you
// exactly where it breaks:
//   signup -> start trial -> create site -> wait for 'active' ->
//   homepage returns HTML -> its stylesheet loads -> clean up
//
//   node scripts/smoke-test.mjs --base https://staging-cp.example.com \
//     [--plan plan_casino_news_starter] [--product prod_casino_news] \
//     [--timeout 180] [--keep]
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

export async function runSmoke({ base, fetchImpl = fetch, planId = "plan_casino_news_starter", productId = "prod_casino_news", timeoutMs = 180000, pollMs = 3000, keep = false, log = () => {} } = {}) {
  const steps = [];
  const record = (name, ok, detail = "") => { steps.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); return ok; };
  const root = base.replace(/\/+$/, "");
  let cookie = null, orgId = null, siteId = null, host = null;

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
    const email = `smoke-${Date.now().toString(36)}@example.test`;
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
  } catch (e) {
    record("unexpected error", false, String(e?.message || e));
  } finally {
    // 7. clean up
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
  if (!args.base) { console.error("Usage: node scripts/smoke-test.mjs --base <control plane url> [--plan ...] [--product ...] [--timeout 180] [--keep]"); process.exit(2); }
  const result = await runSmoke({ base: String(args.base), planId: args.plan || undefined, productId: args.product || undefined, timeoutMs: Number(args.timeout || 180) * 1000, keep: !!args.keep, log: (m) => console.log(m) });
  console.log(result.ok ? "\nSmoke test PASSED." : "\nSmoke test FAILED. Fix the first FAIL above and run again.");
  process.exit(result.ok ? 0 : 1);
}
