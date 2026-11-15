// Conversions and earnings across ALL of an organization's sites.
//
// Each site keeps its own database, so this asks every live site for the same figures it already shows its owner (the Super API
// analytics-overview endpoint, grouped by program) and adds them up here. Nothing new is needed on the sites, so it works whatever
// version each site runs. Money is never added across currencies: every amount is kept per currency.

export const MAX_SITES = 25;
const CONCURRENCY = 5;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NONE = "(none)";
const cur = (c) => (c && String(c).trim() && c !== NONE ? String(c).trim().toUpperCase() : NONE);

function addMoney(target, currency, revenue, commission) {
  const k = cur(currency);
  const m = (target[k] ||= { revenue: 0, commission: 0 });
  m.revenue = round2(m.revenue + (Number(revenue) || 0));
  m.commission = round2(m.commission + (Number(commission) || 0));
}

// results: [{ site: {id, name, primary_domain}, ok, status, message, rows: [...] }]
export function summarizeCrossSite(results, { skipped = 0 } = {}) {
  const sites = []; const programs = new Map(); const totals = { clicks: 0, conversions: 0, by_currency: {} };
  for (const r of results) {
    const base = { id: r.site.id, name: r.site.name, domain: r.site.primary_domain || null };
    if (!r.ok) { sites.push({ ...base, status: r.status === "not_deployed" ? "not_deployed" : "error", message: r.message || "Could not be reached.", clicks: 0, conversions: 0, by_currency: {} }); continue; }
    const s = { ...base, status: "ok", message: null, clicks: 0, conversions: 0, by_currency: {} };
    for (const row of r.rows || []) {
      const clicks = Number(row.clicks) || 0; const conversions = Number(row.conversions) || 0;
      s.clicks += clicks; s.conversions += conversions;
      addMoney(s.by_currency, row.currency, row.revenue, row.commission);
      const name = (row.name && String(row.name).trim()) || `Program ${row.dimensionId}`;
      const key = name.toLowerCase();
      const p = programs.get(key) || { name, sites: [], clicks: 0, conversions: 0, by_currency: {} };
      if (!p.sites.includes(s.name)) p.sites.push(s.name);
      p.clicks += clicks; p.conversions += conversions;
      addMoney(p.by_currency, row.currency, row.revenue, row.commission);
      programs.set(key, p);
    }
    totals.clicks += s.clicks; totals.conversions += s.conversions;
    for (const [c, m] of Object.entries(s.by_currency)) addMoney(totals.by_currency, c, m.revenue, m.commission);
    s.conversion_rate = s.clicks ? round2((s.conversions / s.clicks) * 100) : null;
    sites.push(s);
  }
  const progList = [...programs.values()].map((p) => ({ ...p, conversion_rate: p.clicks ? round2((p.conversions / p.clicks) * 100) : null })).sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks);
  return { sites, programs: progList, totals: { ...totals, conversion_rate: totals.clicks ? round2((totals.conversions / totals.clicks) * 100) : null }, skipped };
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// One site's failure (down, not deployed, an old version) never hides the others.
export async function loadCrossSite(env, tenantPortal, sitesList, { startDate, endDate }) {
  const eligible = sitesList.filter((s) => s.status !== "deleted" && s.status !== "archived");
  const chosen = eligible.slice(0, MAX_SITES);
  const results = await inBatches(chosen, CONCURRENCY, async (site) => {
    if (!site.tenant_id) return { site, ok: false, status: "not_deployed", message: "This site is not live yet." };
    try {
      const res = await tenantPortal.getAnalyticsOverview(env, site, { startDate, endDate, dimensionType: "program" });
      if (!res.ok) return { site, ok: false, status: "error", message: res.message || res.reason || "Could not be reached." };
      return { site, ok: true, rows: Array.isArray(res.data?.rows) ? res.data.rows : [] };
    } catch (e) {
      return { site, ok: false, status: "error", message: "Could not be reached." };
    }
  });
  return summarizeCrossSite(results, { skipped: Math.max(0, eligible.length - chosen.length) });
}

export function defaultRange(now = new Date()) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { startDate: ymd(new Date(now.getTime() - 29 * 86400000)), endDate: ymd(now) };
}
