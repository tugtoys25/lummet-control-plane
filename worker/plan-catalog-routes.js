// =====================================================
// STAFF API: plan catalog management
//
// Mounted by worker/index.js inside the super-admin-only /api/platform/saas/ block, so the guard, the CSRF check and the
// session already ran. Every mutation is audited (resource "plan" / "plan_label" / "product" / "plan_promotion") with a
// one-line summary of what changed in `reason`; a bulk action writes one audit row per plan.
//
//   GET  /plan-catalog                       list (q, status, product, label, period, sort, dir, page, pageSize)
//   GET  /plan-catalog/export.csv            every plan as CSV
//   GET  /plan-catalog/options               products, labels, coupons, entitlement catalog (for forms)
//   GET  /plan-catalog/:id                   one plan with features, entitlements, labels, promotions, price versions
//   POST /plan-catalog                       create a plan (starts as a draft)
//   POST /plan-catalog/bulk                  { action, ids, labelId?, trialDays? }
//   POST /plan-catalog/:id                   edit fields
//   POST /plan-catalog/:id/{publish|unpublish|archive|restore|delete|duplicate}
//   POST /plan-catalog/:id/{features|entitlements|labels|price|promotions}
//   POST /plan-catalog/promotions/:pid[/delete]
//   POST /plan-labels, /plan-labels/:id, /plan-labels/:id/delete
//   POST /products, /products/:id
// =====================================================

import * as catalog from "./plan-catalog.js";

const PAGE_SIZES = [25, 50, 100];

export async function handlePlanCatalogRoute({ env, request, url, method, path, admin, requestId, ipHash, json, logAudit, matchPath }) {
  const base = "/api/platform/saas";
  if (!(path.startsWith(`${base}/plan-catalog`) || path.startsWith(`${base}/plan-labels`) || path.startsWith(`${base}/products`))) return null;

  const body = async () => (await request.json().catch(() => ({})));
  const audit = async (resource, resourceId, action, result, detail = null) => {
    await logAudit(env, {
      adminId: admin.id, endpoint: path, method, resource, resourceId, action,
      success: !!result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error,
      requestId, ipHash, reason: detail ? String(detail).slice(0, 1000) : null
    });
  };
  const reply = (result, extra = {}) => result.ok
    ? json({ success: true, ...extra, ...(result.warnings ? { warnings: result.warnings } : {}) })
    : json({ success: false, error: result.error, ...(result.blockers ? { blockers: result.blockers } : {}), ...(result.hint ? { hint: result.hint } : {}), ...(result.key ? { key: result.key } : {}) }, result.status || 400);
  const diff = (changed) => Object.entries(changed || {}).map(([k, c]) => `${k}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join("; ");

  // ------------------------------------------------------------------ reads
  if (method === "GET" && path === `${base}/plan-catalog`) {
    const q = url.searchParams;
    const pageSize = PAGE_SIZES.includes(Number(q.get("pageSize"))) ? Number(q.get("pageSize")) : 50;
    const page = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
    const data = await catalog.listCatalog(env, {
      q: String(q.get("q") || "").slice(0, 80), status: ["draft", "active", "retired"].includes(q.get("status")) ? q.get("status") : "",
      productId: String(q.get("product") || "").slice(0, 80), labelId: String(q.get("label") || "").slice(0, 80),
      period: ["monthly", "annual", "custom"].includes(q.get("period")) ? q.get("period") : "", sort: String(q.get("sort") || "product"), dir: q.get("dir") === "desc" ? "desc" : "asc",
      limit: pageSize, offset: (page - 1) * pageSize
    });
    return json({ success: true, data: data.rows, total: data.total, counts: data.counts, page, pageSize });
  }
  if (method === "GET" && path === `${base}/plan-catalog/export.csv`) {
    const csv = await catalog.exportCsv(env);
    await logAudit(env, { adminId: admin.id, endpoint: path, method, resource: "plan", action: "export_csv", success: true, statusCode: 200, requestId, ipHash });
    return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="lummet-plans.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  if (method === "GET" && path === `${base}/plan-catalog/options`) {
    return json({ success: true, data: { ...(await catalog.formOptions(env)), entitlementCatalog: catalog.ENTITLEMENT_CATALOG, labelColors: catalog.LABEL_COLORS, categories: catalog.PRODUCT_CATEGORIES } });
  }
  const one = method === "GET" ? matchPath(`${base}/plan-catalog/:id`, path) : null;
  if (one) {
    const d = await catalog.planDetail(env, one.id);
    return d ? json({ success: true, data: d }) : json({ success: false, error: "not_found" }, 404);
  }

  if (method !== "POST") return json({ success: false, error: "not_found" }, 404);

  // ------------------------------------------------------------------ plans
  if (path === `${base}/plan-catalog`) {
    const b = await body();
    const r = await catalog.createPlan(env, b);
    await audit("plan", r.planId || "none", "create", r, r.ok ? `created ${r.key}` : null);
    return reply(r, r.ok ? { planId: r.planId } : {});
  }
  if (path === `${base}/plan-catalog/bulk`) {
    const b = await body();
    const r = await catalog.bulkAction(env, b.action, b.ids, b);
    if (!r.ok) { await audit("plan", "bulk", `bulk_${String(b.action).slice(0, 30)}`, r); return reply(r); }
    for (const x of r.results) {
      await audit("plan", x.id, `bulk_${r.action}`, { ok: x.ok, status: 400, error: x.error }, x.ok ? `bulk ${r.action}` : null);
    }
    return json({ success: true, action: r.action, done: r.done, failed: r.failed, results: r.results.map(({ id, ok, error, warnings }) => ({ id, ok, error, warnings })) });
  }

  const promo = matchPath(`${base}/plan-catalog/promotions/:pid`, path);
  if (promo) {
    const r = await catalog.updatePromotion(env, promo.pid, await body());
    await audit("plan_promotion", promo.pid, "update", r);
    return reply(r);
  }
  const promoDel = matchPath(`${base}/plan-catalog/promotions/:pid/delete`, path);
  if (promoDel) {
    const r = await catalog.deletePromotion(env, promoDel.pid);
    await audit("plan_promotion", promoDel.pid, "delete", r);
    return reply(r);
  }

  const act = matchPath(`${base}/plan-catalog/:id/:action`, path);
  if (act) {
    const id = act.id;
    switch (act.action) {
      case "publish": case "unpublish": case "archive": case "restore": {
        const fn = { publish: catalog.publishPlan, unpublish: catalog.unpublishPlan, archive: catalog.archivePlan, restore: catalog.restorePlan }[act.action];
        const r = await fn(env, id);
        await audit("plan", id, act.action, r, r.ok ? `${r.from} -> ${r.to}${r.liveSubscriptions ? `; ${r.liveSubscriptions} live subscription(s) unaffected` : ""}` : null);
        return reply(r, r.ok ? { from: r.from, to: r.to } : {});
      }
      case "delete": {
        const r = await catalog.deletePlan(env, id);
        await audit("plan", id, "delete", r, r.ok ? `deleted ${r.key}` : null);
        return reply(r);
      }
      case "duplicate": {
        const r = await catalog.duplicatePlan(env, id);
        await audit("plan", id, "duplicate", r, r.ok ? `copy ${r.key}` : null);
        return reply(r, r.ok ? { planId: r.planId } : {});
      }
      case "features": {
        const b = await body(); const r = await catalog.setFeatureLines(env, id, b.features);
        await audit("plan", id, "set_features", r, r.ok ? `${r.count} line(s)` : null);
        return reply(r);
      }
      case "entitlements": {
        const b = await body(); const r = await catalog.setEntitlements(env, id, b.entitlements);
        await audit("plan", id, "set_entitlements", r, r.ok ? `${r.count} entitlement(s)` : null);
        return reply(r);
      }
      case "labels": {
        const b = await body(); const r = await catalog.setLabels(env, id, b.labelIds);
        await audit("plan", id, "set_labels", r, r.ok ? `${r.count} label(s)` : null);
        return reply(r);
      }
      case "price": {
        const b = await body(); const r = await catalog.setPlanPrice(env, id, b);
        await audit("plan", id, "set_price", r, r.ok ? `v${r.version} ${r.from} -> ${r.to} cents (${r.verified ? "verified with Stripe" : "NOT verified"}); ${r.reason}` : null);
        return reply(r, r.ok ? { version: r.version, verified: r.verified } : {});
      }
      case "promotions": {
        const r = await catalog.createPromotion(env, id, await body());
        await audit("plan_promotion", r.promotionId || id, "create", r, r.ok ? `plan ${id}` : null);
        return reply(r, r.ok ? { promotionId: r.promotionId } : {});
      }
      default: return json({ success: false, error: "not_found" }, 404);
    }
  }
  const edit = matchPath(`${base}/plan-catalog/:id`, path);
  if (edit) {
    const r = await catalog.updatePlan(env, edit.id, await body());
    await audit("plan", edit.id, "update", r, r.ok ? diff(r.changed) || "no change" : null);
    return reply(r, r.ok ? { changed: Object.keys(r.changed || {}) } : {});
  }

  // ------------------------------------------------------------------ labels & products
  if (path === `${base}/plan-labels`) {
    const r = await catalog.createLabel(env, await body());
    await audit("plan_label", r.labelId || "none", "create", r);
    return reply(r, r.ok ? { labelId: r.labelId } : {});
  }
  const lblDel = matchPath(`${base}/plan-labels/:id/delete`, path);
  if (lblDel) { const r = await catalog.deleteLabel(env, lblDel.id); await audit("plan_label", lblDel.id, "delete", r); return reply(r); }
  const lbl = matchPath(`${base}/plan-labels/:id`, path);
  if (lbl) { const r = await catalog.updateLabel(env, lbl.id, await body()); await audit("plan_label", lbl.id, "update", r); return reply(r); }

  if (path === `${base}/products`) {
    const r = await catalog.createProduct(env, await body());
    await audit("product", r.productId || "none", "create", r);
    return reply(r, r.ok ? { productId: r.productId } : {});
  }
  const prod = matchPath(`${base}/products/:id`, path);
  if (prod) { const r = await catalog.updateProduct(env, prod.id, await body()); await audit("product", prod.id, "update", r); return reply(r); }

  return json({ success: false, error: "not_found" }, 404);
}
