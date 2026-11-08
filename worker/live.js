// Live regions: server side. A page marks a region (data-live-src) and the shell script (views/live-runtime.js) keeps it fresh;
// the endpoint behind the URL returns { html, hash, busy } built by the SAME renderer the page used, so there is one source of truth.

/** 32-bit FNV-1a of the rendered html, hex: lets the browser skip a swap when nothing changed. */
export function liveHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Statuses that are in flight: the region is polled quickly while any is present, and slowly otherwise. */
export const SITE_TRANSIENT = new Set(["pending", "provisioning", "configuring", "deploying", "deleting"]);
export const DEPLOYMENT_TRANSIENT = new Set(["queued", "building", "migrating", "deploying", "checking"]);

export const liveAttrs = (src, html) => ` data-live-src="${String(src).replace(/"/g, "&quot;")}" data-live-hash="${liveHash(html)}"`;
