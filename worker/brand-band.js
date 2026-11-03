// =====================================================
// BRAND PARTNERS BAND (dashboards)
//
// A strip under the dashboard header that lists the brand profiles behind lummet.com/brands ("Powered by Lummet"): every site that has
// gone live (created UNPUBLISHED, an admin publishes it) plus the hand-made profiles. Every card is a link.
//   staff     manage mode: a card opens that brand's editor (Lummet Site > Brand profiles), "Manage" and "Add brand" are shown
//             when the admin may write brands, unpublished brands are included and marked.
//   customer  view mode: published brands only, each card opens the public brand page.
// Read-only toward the database, fails soft (an error renders nothing rather than breaking the page), and draws each brand's
// colour from its slug so the same brand always has the same colour without storing anything.
// =====================================================

import { listForBand } from "./repositories/brands.js";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const BAND_LIMIT = 24;

/** Same text always gives the same hue (0-359). */
export function hueFor(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % 360;
}

/** Stored #RRGGBB (editable in Brand profiles) or "" when absent/invalid: nothing user-typed reaches CSS unvalidated. */
export function accentOf(row) {
  const v = String(row?.accent_color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "";
}

/** Hue (0-359) of a #RRGGBB colour, so the card tint follows the chosen accent. */
export function hueOfHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 220;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

/** show_in_strip is absent before the accent/strip migration: treated as shown. */
const inStrip = (b) => b.show_in_strip !== 0 && b.show_in_strip !== "0";

function initialsOf(name) {
  const parts = String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function httpsOrEmpty(value) {
  try { const u = new URL(String(value || "")); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : ""; } catch { return ""; }
}

/** includeDrafts: staff see offline brands too (marked), customers never do. */
export async function loadBrandBand(env, { includeDrafts = false } = {}) {
  try {
    // Customers only see brands that are switched on for the strip; staff see all of them (hidden ones are marked).
    const all = await listForBand(env, { includeDrafts, limit: BAND_LIMIT * 2 });
    const rows = all.filter((b) => includeDrafts || inStrip(b));
    return rows.slice(0, BAND_LIMIT);
  } catch (error) {
    console.error(JSON.stringify({ msg: "brand_band_load_failed", error: error?.message || String(error) }));
    return [];
  }
}

function card(b, manage) {
  const accent = accentOf(b);
  const hue = accent ? hueOfHex(accent) : hueFor(b.slug || b.name);
  const logo = httpsOrEmpty(b.logo_url);
  const live = b.status === "published";
  const href = manage ? `/cms/brands/${encodeURIComponent(b.id)}/edit` : `/brands/${encodeURIComponent(b.slug)}`;
  const label = manage ? `Edit ${b.name}` : `Open ${b.name}`;
  const visit = httpsOrEmpty(b.website_url);
  const avatar = logo ? `<img src="${esc(logo)}" alt="" width="40" height="40" loading="lazy" decoding="async">` : `<span>${esc(initialsOf(b.name))}</span>`;
  const outOfStrip = manage && !inStrip(b);
  return `<li class="bb-card${live ? "" : " is-off"}" style="--h:${hue}${accent ? `;--c:${accent}` : ""}">
    <a class="bb-main" href="${href}" aria-label="${esc(label)}">
      <span class="bb-avatar" aria-hidden="true">${avatar}</span>
      <span class="bb-text"><strong>${esc(b.name)}</strong><small>${esc(b.category || b.tagline || "Powered by Lummet")}</small></span>
      <span class="bb-state ${live ? "on" : "off"}">${live ? "Live" : b.auto_hidden ? "Offline" : "Unpublished"}</span>${outOfStrip ? `<span class="bb-state off" title="Not shown to customers">Hidden</span>` : ""}
    </a>${visit && manage ? `<a class="bb-visit" href="${esc(visit)}" target="_blank" rel="noopener noreferrer" aria-label="Visit ${esc(b.name)}">Visit</a>` : ""}
  </li>`;
}

/** Returns "" when there is nothing to show and nobody may add brands. */
export function renderBrandBand(brands, { manage = false, canAdd = false } = {}) {
  const rows = Array.isArray(brands) ? brands : [];
  if (!rows.length && !canAdd) return "";
  const live = rows.filter((b) => b.status === "published").length;
  const actions = [
    manage ? `<a class="btn btn-secondary btn-small" href="/cms/brands">Manage</a>` : `<a class="btn btn-secondary btn-small" href="/brands">View all</a>`,
    canAdd ? `<a class="btn btn-primary btn-small" href="/cms/brands/new">Add brand</a>` : ""
  ].join("");
  const list = rows.length
    ? `<ul class="bb-list">${rows.map((b) => card(b, manage)).join("")}</ul>`
    : `<p class="bb-empty">No brands yet. New live sites appear here as unpublished until an admin publishes them.</p>`;
  return `<section class="brand-band" aria-label="Brand partners">
    <div class="bb-head"><div><h2>Brand partners</h2><p>${live} published${rows.length !== live ? `, ${rows.length - live} unpublished${manage ? " - open one to customize and publish it" : ""}` : ""}</p></div><div class="bb-actions">${actions}</div></div>
    ${list}
  </section>`;
}
