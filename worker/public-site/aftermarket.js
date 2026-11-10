// =====================================================
// PUBLIC SITE — DOMAIN AFTERMARKET
//
//   /aftermarket/list-of-domains          the domains for sale (Buy now at the marketplace, or enquire)
//   /aftermarket/domains/:domain          one domain's for-sale page + enquiry form
//   /aftermarket/domain-acquisition       the buy form; shows "<domain> is for sale" when reached by a redirect (?domain=) or
//                                         on a hosted for-sale domain's own address
//   /aftermarket/sell-your-domain         seller form (a normal DB form, key sell-domain) -> verification page
//   /aftermarket/sell-your-domain/verify  prove control by nameservers (AFTERMARKET_NAMESERVERS) or a TXT record
//
// Every enquiry goes through forms.js, so it has the same protection as the other forms (same-origin check, honeypot, per-IP
// limit, Turnstile when PUBLIC_FORMS_TURNSTILE_REQUIRED=on) and lands in lummet_inquiries with the domain in subject_ref.
// =====================================================

import * as data from "./data.js";
import * as forms from "./forms.js";
import { renderPage } from "./render.js";
import { buildHead, breadcrumbLd } from "./seo.js";
import { fill, truncate, stripTags } from "./format.js";
import { lookupNS, lookupTXT } from "../dns-doh.js";
import { BUY_FORM_KEY, SELL_FORM_KEY, normalizeDomain, isReservedDomain, platformHosts } from "./aftermarket-domains.js";

const VERIFY_PATH = "/aftermarket/sell-your-domain/verify";
const CHECK_COOLDOWN_MS = 15 * 1000;
const TOKEN_PREFIX = "lummet-verify=";

function crumbs(ui, extra) {
  return [{ label: ui.crumb_home, href: "/" }, ...extra].map((c, i, a) => ({ ...c, last: i === a.length - 1 }));
}

function nameServers(env) {
  return String(env.AFTERMARKET_NAMESERVERS || "").split(/[\s,]+/).map((n) => n.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------ list + landing

export async function listPage(ctx) {
  const { env, siteCtx } = ctx;
  const { site, ui } = siteCtx;
  const rows = await data.listAftermarketDomains(env, 200);
  const items = rows.map((r) => {
    const buy = /^https:\/\//i.test(r.buy_url || "") ? r.buy_url : "";
    return {
      domain: r.domain,
      price: String(r.asking_price || "").trim() || ui.aftermarket_price_on_request,
      href: `/aftermarket/domains/${encodeURIComponent(r.domain)}`,
      buy_url: buy,
      has_buy: Boolean(buy)
    };
  });
  const trail = crumbs(ui, [{ label: ui.aftermarket_crumb, href: "/aftermarket/list-of-domains" }]);
  const head = buildHead({
    site, title: ui.aftermarket_list_title, description: ui.aftermarket_list_intro, path: "/aftermarket/list-of-domains",
    jsonLd: [breadcrumbLd(site, trail.map((t) => ({ label: t.label, href: t.href })))]
  });
  return renderPage(ctx, {
    template: "aftermarket-list",
    data: { title: ui.aftermarket_list_title, intro: ui.aftermarket_list_intro, items, has_items: items.length > 0, sell_href: "/aftermarket/sell-your-domain", crumbs: trail },
    head,
    bodyClass: "page-aftermarket"
  });
}

export async function landingPage(ctx, params) {
  const domain = normalizeDomain(params.domain);
  const row = domain ? await data.getListedAftermarketDomain(ctx.env, domain) : null;
  if (!row) return null;
  return forms.formPage(ctx, { key: BUY_FORM_KEY, path: `/aftermarket/domains/${row.domain}`, subject: { row, domain: row.domain, source: "landing" } });
}

export async function landingSubmit(ctx, params) {
  const domain = normalizeDomain(params.domain);
  const row = domain ? await data.getListedAftermarketDomain(ctx.env, domain) : null;
  if (!row) return null;
  return forms.submitForm(ctx, { key: BUY_FORM_KEY, path: `/aftermarket/domains/${row.domain}`, subject: { row, domain: row.domain, source: "landing" } });
}

/** "/" requested on a hosted for-sale domain's own address: show that domain's for-sale page. Null on every other host. */
export async function hostedLanding(ctx) {
  const host = normalizeDomain(ctx.url.hostname);
  if (!host || platformHosts(ctx.env, ctx.siteCtx.site.base_url).has(host)) return null;
  const row = await data.getHostedAftermarketDomain(ctx.env, host);
  if (!row) return null;
  return forms.formPage(ctx, { key: BUY_FORM_KEY, path: `/aftermarket/domains/${row.domain}`, subject: { row, domain: row.domain, source: "host" } });
}

// ------------------------------------------------------------------- sellers

const sellHooks = {
  async validate(ctx, values) {
    const { ui } = ctx.siteCtx;
    const domain = normalizeDomain(values.domain);
    if (!domain) return { domain: ui.aftermarket_err_domain || "" };
    if (isReservedDomain(ctx.env, domain, ctx.siteCtx.site.base_url)) return { domain: ui.aftermarket_err_taken || "" };
    const existing = await data.getAftermarketDomain(ctx.env, domain);
    if (existing && !(existing.source === "seller" && ["pending", "unlisted"].includes(existing.status))) return { domain: ui.aftermarket_err_taken || "" };
    return {};
  },
  async after(ctx, { values }) {
    const domain = normalizeDomain(values.domain);
    // A new submission replaces the token, so only the DNS record the latest submitter was shown can verify.
    const ok = await data.upsertAftermarketClaim(ctx.env, {
      domain, email: values.email, price: values.asking_price, description: values.message, token: newToken()
    });
    if (!ok) return null;
    return new Response(null, { status: 303, headers: { location: `${VERIFY_PATH}?domain=${encodeURIComponent(domain)}`, "cache-control": "no-store" } });
  }
};

export const sellPage = (ctx) => forms.formPage(ctx, { key: SELL_FORM_KEY, path: "/aftermarket/sell-your-domain", subject: null });
export const sellSubmit = (ctx) => forms.submitForm(ctx, { key: SELL_FORM_KEY, path: "/aftermarket/sell-your-domain", subject: null, hooks: sellHooks });

const MESSAGES = { ns: "aftermarket_not_verified_ns", txt: "aftermarket_not_verified_txt", wait: "aftermarket_throttled", ns_off: "aftermarket_ns_unavailable" };

export async function verifyPage(ctx) {
  const { env, url, siteCtx } = ctx;
  const { site, ui } = siteCtx;
  const domain = normalizeDomain(url.searchParams.get("domain"));
  const row = domain ? await data.getAftermarketDomain(env, domain) : null;
  if (!row || row.source !== "seller" || !["pending", "listed"].includes(row.status)) return null;

  const listed = row.status === "listed";
  const ns = nameServers(env);
  const msgKey = MESSAGES[url.searchParams.get("msg")];
  const title = fill(ui.aftermarket_verify_title, { domain });
  const trail = crumbs(ui, [{ label: ui.aftermarket_sell_crumb, href: "/aftermarket/sell-your-domain" }, { label: title, href: VERIFY_PATH }]);
  const head = buildHead({ site, title, description: truncate(stripTags(fill(ui.aftermarket_verify_intro, { domain })), 170), path: VERIFY_PATH, noindex: true });
  return renderPage(ctx, {
    template: "aftermarket-verify",
    data: {
      title,
      intro: fill(ui.aftermarket_verify_intro, { domain }),
      domain,
      listed,
      listed_notice: fill(ui.aftermarket_listed_notice, { domain }),
      listing_href: `/aftermarket/domains/${encodeURIComponent(domain)}`,
      message: msgKey ? fill(ui[msgKey], { domain }) : "",
      ns_title: ui.aftermarket_ns_title,
      ns_body: fill(ui.aftermarket_ns_body, { domain }),
      has_ns: ns.length > 0,
      name_servers: ns.map((n) => ({ value: n })),
      txt_body: ui.aftermarket_txt_body,
      txt_type: "TXT",
      txt_name: `_lummet-verify.${domain}`,
      txt_value: row.verify_token || "",
      action: VERIFY_PATH,
      crumbs: trail
    },
    head,
    cacheControl: "no-store",
    bodyClass: "page-aftermarket"
  });
}

function back(domain, msg) {
  const q = new URLSearchParams({ domain });
  if (msg) q.set("msg", msg);
  return new Response(null, { status: 303, headers: { location: `${VERIFY_PATH}?${q}`, "cache-control": "no-store" } });
}

export async function verifySubmit(ctx) {
  const { env, request, url } = ctx;
  if (!forms.sameOrigin(request, url)) return new Response(null, { status: 403 });
  let formData;
  try { formData = await request.formData(); } catch { return new Response(null, { status: 400 }); }
  const domain = normalizeDomain(formData.get("domain"));
  const method = String(formData.get("method") || "");
  const row = domain ? await data.getAftermarketDomain(env, domain) : null;
  if (!row || row.source !== "seller") return null;
  if (row.status !== "pending" || !["ns", "txt"].includes(method)) return back(domain);

  const last = row.last_check_at ? Date.parse(`${String(row.last_check_at).replace(" ", "T")}Z`) : 0;
  if (last && Date.now() - last < CHECK_COOLDOWN_MS) return back(domain, "wait");
  await data.touchAftermarketCheck(env, row.id);

  let verified = false;
  if (method === "ns") {
    const expected = nameServers(env);
    if (!expected.length) return back(domain, "ns_off");
    const seen = await lookupNS(domain);
    verified = Boolean(seen && seen.ok && expected.every((n) => (seen.nameServers || []).map((s) => String(s).toLowerCase().replace(/\.$/, "")).includes(n)));
  } else {
    const values = await lookupTXT(`_lummet-verify.${domain}`);
    verified = Boolean(row.verify_token) && values.some((v) => String(v).trim() === row.verify_token);
  }
  if (!verified) return back(domain, method);

  await data.markAftermarketVerified(env, row.id, method);
  await forms.notify(ctx, { form_key: "aftermarket-listed", name: null, email: row.owner_email, subject_ref: domain, summary: `${domain} verified by ${method} and listed` }, row.id);
  return back(domain);
}
