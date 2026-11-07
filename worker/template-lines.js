// =====================================================
// TEMPLATE LINES (release 2.7.1)
//
// A template line is one application the platform can release and provision: 'casino' is lummet-tenant (the original
// and the default for everything that does not name a line), 'brokerage' is luminousagents. A product belongs to
// exactly one line (products.template_line); a site's line is its product's line; a release belongs to one line.
//
// This file is the control plane's own, trusted description of what each application needs from Cloudflare. A published
// release can never change which resources its Worker is bound to, which cron schedule it gets or which URL is checked:
// those come from here, so a release is code and static files, not infrastructure.
// =====================================================

export const DEFAULT_LINE = "casino";

export const TEMPLATE_LINES = Object.freeze({
  casino: Object.freeze({
    key: "casino",
    label: "Casino platform",
    // The application's own schedule (lummet-tenant wrangler triggers).
    crons: Object.freeze(["0 */6 * * *"]),
    healthPath: "/",
    compatibilityDate: null, // null = TENANT_COMPAT_DATE or the control plane default
    compatibilityFlags: Object.freeze(["nodejs_compat"]),
    r2Binding: "MEDIA_BUCKET",
    ai: true,
    // Every request goes through the Worker except /static/* (see infra-cloudflare.js tenantAssetsConfig).
    assets: "worker_first_except_static"
  }),
  brokerage: Object.freeze({
    key: "brokerage",
    label: "Brokerage site",
    crons: Object.freeze(["*/5 * * * *"]),
    healthPath: "/healthz",
    compatibilityDate: "2026-10-09",
    compatibilityFlags: Object.freeze(["nodejs_compat"]),
    r2Binding: "PRIVATE_FILES",
    ai: false,
    // Static files first, the Worker for what the release names (carried in the release as assetsConfig.runWorkerFirst).
    assets: "release_defined"
  })
});

export const LINE_KEYS = Object.freeze(Object.keys(TEMPLATE_LINES));

/** Accepts a line key (or nothing, meaning the default) and returns it, or null when it is not a known line. */
export function normalizeLine(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LINE;
  const key = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TEMPLATE_LINES, key) ? key : null;
}

/** The profile for a line; an unknown or missing line is the default (casino) profile, never an error. */
export function lineProfile(value) {
  return TEMPLATE_LINES[normalizeLine(value) || DEFAULT_LINE];
}

export function healthUrl(baseUrl, profile) {
  return new URL(profile.healthPath, baseUrl).toString();
}
