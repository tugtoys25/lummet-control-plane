// =====================================================
// ADVERTISEMENT SLIDER (lummet.com homepage banner)
//
// An advertisement can hold up to ten slides. This module is the single place that
//   * validates what staff save (settings + slides: allow-lists, clamped numbers, safe links and pictures),
//   * renders the accessible slider markup (pure, everything interpolated is escaped),
//   * accepts picture uploads into the platform media library,
//   * counts views / clicks per slide (beacons from public/static/js/ad-slider.js).
// SQL lives in repositories/ad-slider.js. An advertisement without slides renders as one slide made from its own
// image_url / link_url / alt_text, so every advertisement created before sliders existed looks and behaves as before.
// =====================================================

import * as repo from "./repositories/ad-slider.js";
import * as media from "./platform-media.js";
import { inspectFile, extensionOf } from "./image-inspect.js";

export const LIMITS = { maxSlides: 10, interval: [2, 30], speed: [200, 2000], duration: [2, 60] };
export const CHOICES = {
  transition: ["fade", "slide", "zoom", "kenburns"],
  ratio: ["21:9", "3:1", "4:1", "2:1", "16:9", "3:2", "4:3", "1:1"],
  mobile_ratio: ["same", "16:9", "3:2", "4:3", "1:1", "3:4"],
  overlay: ["soft", "strong", "none"], fit: ["contain", "cover"], nav: ["dots", "bars", "none"], text_pos: ["left", "center", "right"]
};
export const DEFAULTS = { autoplay: true, interval: 6, transition: "fade", speed: 600, pause_hover: true, loop: true, arrows: true, nav: "dots", progress: true, counter: false,
  swipe: true, keyboard: true, ratio: "3:1", mobile_ratio: "16:9", fit: "contain", overlay: "soft", ad_label: true, ad_text: "Ad" };
const SETTING_KEYS = Object.keys(DEFAULTS);
export const SLIDE_FIELDS = ["key", "title", "subtitle", "badge", "image", "image_mobile", "alt", "url", "cta_label", "new_tab", "sponsored", "text_pos", "duration", "start_at", "end_at"];

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const txt = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
const flag = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === 1 || v === "1" || v === "true" || v === "on");

/** Links: /path, https:// or mailto: only. */
export function linkOf(v) {
  const s = String(v ?? "").trim();
  if (!s || s.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(s)) return "";
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  return /^https:\/\/[^\s/]/i.test(s) || /^mailto:[^\s]+$/i.test(s) ? s : "";
}
/** Pictures: this site's media library (/brand-media/...) or https:// only. */
export function pictureOf(v) {
  const s = String(v ?? "").trim();
  if (!s || s.length > 2048 || /[\u0000-\u001f\u007f\s"'<>]/.test(s)) return "";
  return s.startsWith(media.PUBLIC_PREFIX) || /^https:\/\/[^\s/]/i.test(s) ? s : "";
}

/** "2026-11-24", "2026-11-24T10:30" or "2026-11-24 10:30:00" -> "2026-11-24 10:30:00" (UTC), or null. */
export function dateOf(v) {
  const m = String(v ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  return m && !Number.isNaN(Date.parse(m[1])) ? `${m[1]} ${m[2] || "00:00"}:${m[3] || "00"}` : null;
}

export function normalizeSettings(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    autoplay: flag(o.autoplay, DEFAULTS.autoplay), interval: num(o.interval, LIMITS.interval, DEFAULTS.interval), transition: oneOf(o.transition, CHOICES.transition, DEFAULTS.transition),
    speed: num(o.speed, LIMITS.speed, DEFAULTS.speed), pause_hover: flag(o.pause_hover, DEFAULTS.pause_hover), loop: flag(o.loop, DEFAULTS.loop), arrows: flag(o.arrows, DEFAULTS.arrows),
    nav: oneOf(o.nav, CHOICES.nav, DEFAULTS.nav), progress: flag(o.progress, DEFAULTS.progress), counter: flag(o.counter, DEFAULTS.counter), swipe: flag(o.swipe, DEFAULTS.swipe),
    keyboard: flag(o.keyboard, DEFAULTS.keyboard), ratio: oneOf(o.ratio, CHOICES.ratio, DEFAULTS.ratio), mobile_ratio: oneOf(o.mobile_ratio, CHOICES.mobile_ratio, DEFAULTS.mobile_ratio),
    fit: oneOf(o.fit, CHOICES.fit, DEFAULTS.fit), overlay: oneOf(o.overlay, CHOICES.overlay, DEFAULTS.overlay), ad_label: flag(o.ad_label, DEFAULTS.ad_label), ad_text: txt(o.ad_text, 12) || DEFAULTS.ad_text
  };
}

/** Staff input -> { ok, errors, settings, slides }. Unknown fields are rejected, empty optional values dropped. */
export function validateSlider(input) {
  const errors = [];
  const body = input && typeof input === "object" ? input : {};
  for (const k of Object.keys(body.settings || {})) if (!SETTING_KEYS.includes(k)) errors.push(`settings: unknown field "${k}"`);
  const list = Array.isArray(body.slides) ? body.slides : [];
  if (list.length > LIMITS.maxSlides) errors.push(`A slider holds at most ${LIMITS.maxSlides} slides.`);
  const seen = new Set(); const slides = [];
  list.slice(0, LIMITS.maxSlides).forEach((s, i) => {
    const n = i + 1; const o = s && typeof s === "object" ? s : {};
    for (const k of Object.keys(o)) if (!SLIDE_FIELDS.includes(k)) errors.push(`Slide ${n}: unknown field "${k}"`);
    const key = String(o.key ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(key) || seen.has(key)) { errors.push(`Slide ${n}: invalid or repeated key`); return; }
    seen.add(key);
    const out = { key, image: pictureOf(o.image) };
    if (!out.image) errors.push(`Slide ${n}: a picture is required (uploaded here, or an https:// address)`);
    if (o.image_mobile) { const m = pictureOf(o.image_mobile); if (m) out.image_mobile = m; else errors.push(`Slide ${n}: the phone picture must be uploaded here or an https:// address`); }
    if (o.url) { const u = linkOf(o.url); if (u) out.url = u; else errors.push(`Slide ${n}: the link must be /path, https:// or mailto:`); }
    for (const [k, max] of [["title", 120], ["subtitle", 200], ["badge", 30], ["alt", 160], ["cta_label", 40]]) if (o[k]) out[k] = txt(o[k], max);
    if (flag(o.new_tab, false)) out.new_tab = true;
    if (flag(o.sponsored, false)) out.sponsored = true;
    if (o.text_pos) out.text_pos = oneOf(o.text_pos, CHOICES.text_pos, "left");
    if (o.duration !== undefined && o.duration !== "" && o.duration !== null) out.duration = num(o.duration, LIMITS.duration, LIMITS.duration[0]);
    const a = o.start_at ? dateOf(o.start_at) : null, z = o.end_at ? dateOf(o.end_at) : null;
    if (o.start_at && !a) errors.push(`Slide ${n}: the start is not a valid date`);
    if (o.end_at && !z) errors.push(`Slide ${n}: the end is not a valid date`);
    if (a && z && z < a) errors.push(`Slide ${n}: the end must be after the start`);
    out.start_at = a || ""; out.end_at = z || "";
    slides.push(out);
  });
  return { ok: errors.length === 0, errors, settings: normalizeSettings(body.settings), slides };
}

// ---- rendering --------------------------------------------------------------------------------------------------------
const ms = (s) => { const t = s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : NaN; return Number.isFinite(t) ? t : 0; };
const inWindow = (s, now) => (!ms(s.start_at) || ms(s.start_at) <= now) && (!ms(s.end_at) || ms(s.end_at) >= now);
const ratioCss = (r) => String(r).replace(":", " / ");
const external = (u) => /^https?:\/\//i.test(u);

/** The slides to show: the advertisement's own slides inside their window, or one made from its legacy fields. */
export function slidesOf(ad, stored, now = Date.now()) {
  if (stored && stored.length) return now === null ? stored : stored.filter((s) => inWindow(s, now)); // now === null: show every slide (editor preview)
  const image = pictureOf(ad?.image_url);
  return image ? [{ key: "main", image, url: linkOf(ad.link_url), alt: ad.alt_text || ad.name || "", sponsored: true, new_tab: true }] : [];
}

function slideHtml(s, i, n, o) {
  const href = linkOf(s.url), name = s.title || s.alt || "", label = name || `Slide ${i + 1}`;
  const pic = pictureOf(s.image); if (!pic) return "";
  const mob = pictureOf(s.image_mobile);
  const loading = o.eager && i === 0 ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" fetchpriority="low" decoding="async"';
  const source = mob ? `<source media="(max-width: 640px)" srcset="${esc(mob)}" width="800" height="${o.mh}">` : "";
  // "Show the whole picture": the same picture, blurred and cropped, fills whatever the contained one leaves free (same URL, no extra download)
  const fill = o.cfg.fit === "contain" ? `<picture class="ad-sl__bgpic" aria-hidden="true">${source}<img class="ad-sl__bg" src="${esc(pic)}" alt="" width="1600" height="${o.h}" loading="lazy" fetchpriority="low" decoding="async"></picture>` : "";
  const picture = `${fill}<picture class="ad-sl__pic">${source}<img class="ad-sl__img" src="${esc(pic)}" alt="${esc(s.alt || s.title || "")}" width="1600" height="${o.h}"${loading}></picture>`;
  const cta = s.cta_label || "";
  const showText = s.title || s.subtitle || s.badge || (cta && href);
  const pos = CHOICES.text_pos.includes(s.text_pos) ? s.text_pos : "left";
  const text = showText ? `<span class="ad-sl__shade" aria-hidden="true"></span><span class="ad-sl__text ad-sl__text--${pos}">${s.badge ? `<span class="ad-sl__badge">${esc(s.badge)}</span>` : ""}${s.title ? `<strong class="ad-sl__h">${esc(s.title)}</strong>` : ""}${s.subtitle ? `<span class="ad-sl__sub">${esc(s.subtitle)}</span>` : ""}${cta && href ? `<span class="ad-sl__cta">${esc(cta)}</span>` : ""}</span>` : "";
  const tag = o.cfg.ad_label || s.sponsored ? `<span class="ad-sl__ad">${esc(o.cfg.ad_text)}</span>` : "";
  const target = href && (s.new_tab || external(href)) ? ' target="_blank"' : "";
  const rel = href && external(href) ? "sponsored noopener" : href && s.sponsored ? "sponsored" : ""; // an external advertisement link is always marked as paid
  const named = name || s.subtitle || s.badge || (cta && href);
  const box = href
    ? `<a class="ad-sl__link" href="${esc(href)}"${target}${rel ? ` rel="${rel}"` : ""} data-ad-click${named ? "" : ` aria-label="${esc(label)}"`}>${picture}${text}${tag}</a>`
    : `<div class="ad-sl__link">${picture}${text}${tag}</div>`;
  const dur = Number(s.duration) > 0 ? ` data-dur="${Math.round(Number(s.duration) * 1000)}"` : "";
  const win = (ms(s.start_at) ? ` data-start="${ms(s.start_at)}"` : "") + (ms(s.end_at) ? ` data-end="${ms(s.end_at)}"` : "");
  return `<li class="ad-slide${i === 0 ? " is-active" : ""}" data-ad-slide data-sid="${esc(s.key)}" data-title="${esc(label)}"${dur}${win} role="group" aria-roledescription="slide" aria-label="${i + 1} of ${n}: ${esc(label)}"${i ? " hidden" : ""}>${box}</li>`;
}

/** Complete markup of the slider. Returns "" when there is nothing to show. */
export function renderAdSlider({ ad, slides, settings, now = Date.now(), preview = false, label = "" }) {
  const shown = slidesOf(ad, slides, now);
  const cfg = normalizeSettings(settings);
  const [rw, rh] = cfg.ratio.split(":").map(Number), [mw, mh] = (cfg.mobile_ratio === "same" ? cfg.ratio : cfg.mobile_ratio).split(":").map(Number);
  const o = { cfg, eager: true, h: Math.round((1600 * rh) / rw), mh: Math.round((800 * mh) / mw) };
  const lis = shown.map((s, i) => slideHtml(s, i, shown.length, o)).filter(Boolean);
  if (!lis.length) return "";
  const n = lis.length, multi = n > 1, uid = `ad-sl-${Number(ad?.id) || 0}`;
  const items = shown.filter((s) => pictureOf(s.image));
  const dots = multi && cfg.nav !== "none" ? `<div class="ad-sl__nav" role="group" aria-label="Choose a slide">${items.map((s, i) => `<button type="button" class="ad-sl__dot" data-ad-dot="${i}" aria-label="Slide ${i + 1}${s.title || s.alt ? `: ${esc(s.title || s.alt)}` : ""}" aria-current="${i === 0 ? "true" : "false"}"></button>`).join("")}</div>` : "";
  const arrows = multi && cfg.arrows ? `<button type="button" class="ad-sl__arrow" data-ad-prev aria-controls="${uid}-s" aria-label="Previous slide">‹</button><button type="button" class="ad-sl__arrow" data-ad-next aria-controls="${uid}-s" aria-label="Next slide">›</button>` : "";
  const ctrl = multi ? `<div class="ad-sl__ctrl">${cfg.counter ? `<span class="ad-sl__count" data-ad-count aria-hidden="true">1 / ${n}</span>` : ""}${cfg.autoplay ? `<button type="button" class="ad-sl__play" data-ad-play aria-controls="${uid}-s" aria-label="Pause automatic slide show"></button>` : ""}</div>` : "";
  const bar = multi && cfg.autoplay ? `<span class="ad-sl__bar" data-ad-bar aria-hidden="true"></span>` : "";
  const cls = ["ad-sl", `ad-sl--${cfg.transition}`, `ad-sl--ov-${cfg.overlay}`, `ad-sl--nav-${cfg.nav}`, cfg.fit === "contain" ? "ad-sl--contain" : "", cfg.progress ? "ad-sl--prog" : ""].filter(Boolean).join(" ");
  const data = `data-ad-slider data-ad="${Number(ad?.id) || 0}" data-auto="${multi && cfg.autoplay ? 1 : 0}" data-interval="${cfg.interval * 1000}" data-speed="${cfg.speed}" data-hover="${cfg.pause_hover ? 1 : 0}" data-loop="${cfg.loop ? 1 : 0}" data-swipe="${cfg.swipe ? 1 : 0}" data-keys="${cfg.keyboard ? 1 : 0}"${preview ? ' data-preview="1"' : ""}`;
  const vars = `--ad-ratio:${ratioCss(cfg.ratio)};--ad-ratio-m:${ratioCss(cfg.mobile_ratio === "same" ? cfg.ratio : cfg.mobile_ratio)};--ad-speed:${cfg.speed}ms`;
  const out = `<div class="${cls}" ${data} role="region" aria-roledescription="carousel" aria-label="${esc(label || ad?.name || "Featured")}" style="${vars}">${ctrl}<div class="ad-sl__stage"><ul class="ad-sl__slides" id="${uid}-s" aria-live="off">${lis.join("")}</ul>${arrows}${dots}${bar}</div></div>`;
  return out; // the stylesheet and script are linked by public/templates/pages/home.html (scripts are never written from worker code, see test/csp.test.js)
}

// ---- picture upload ---------------------------------------------------------------------------------------------------
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** Staff upload of a slide picture into the platform media library. Returns { ok, url } or { ok:false, status, error }. */
export async function attachPicture(env, { file, altText = "", actorId = null }) {
  if (!media.storageConfigured(env)) return { ok: false, status: 503, error: "media_storage_not_configured" };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, status: 400, error: "no_file" };
  if (!(file.size > 0)) return { ok: false, status: 422, error: "empty_file" };
  if (file.size > media.MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "file_too_large" };
  if (!EXTS.has(extensionOf(file.name || ""))) return { ok: false, status: 415, error: "unsupported_file_type" };
  const seen = inspectFile(new Uint8Array(await file.arrayBuffer()), file.name || "");
  if (!seen.ok || !MIMES.has(seen.mime)) return { ok: false, status: 422, error: "not_an_image" };
  if (!(seen.width >= 300 && seen.height >= 100) || seen.width > 10000 || seen.height > 10000) return { ok: false, status: 422, error: "image_dimensions" };
  const stored = await media.uploadMedia(env, { file, folder: "ads", altText: txt(altText, 160), actorId });
  if (!stored.ok) return { ok: false, status: stored.status || 400, error: stored.error };
  return { ok: true, url: stored.media.url, width: seen.width, height: seen.height };
}

// ---- beacons ----------------------------------------------------------------------------------------------------------
const buckets = new Map();
export function _resetRate() { buckets.clear(); }
function rateLimited(key, nowMs) {
  const b = buckets.get(key) || { t: nowMs, n: 0 };
  if (nowMs - b.t > 60000) { b.t = nowMs; b.n = 0; }
  b.n++; buckets.set(key, b);
  if (buckets.size > 5000) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size < 2500) break; }
  return b.n > 60;
}
const SLIDE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;

/** body: { id, type, s? } or { events: [...] } (at most 20). With `s` the event counts for that slide only. Never echoes input. */
export async function recordEvents(env, body, { clientKey = "anon", now = new Date() } = {}) {
  if (rateLimited(clientKey, now.getTime())) return { status: 429, accepted: 0 };
  const raw = Array.isArray(body?.events) ? body.events : body && typeof body === "object" ? [body] : [];
  if (!raw.length || raw.length > 20) return { status: 400, accepted: 0 };
  const sums = new Map();
  for (const e of raw) {
    const id = Number(e?.id);
    if (!Number.isInteger(id) || id < 1 || (e?.type !== "view" && e?.type !== "click")) return { status: 400, accepted: 0 };
    if (e.s !== undefined && !SLIDE_KEY.test(String(e.s))) return { status: 400, accepted: 0 };
    const k = `${id}|${e.s === undefined ? "" : e.s}`; const s = sums.get(k) || { v: 0, c: 0 };
    if (e.type === "view") s.v++; else s.c++;
    sums.set(k, s);
  }
  const ids = [...new Set([...sums.keys()].map((k) => Number(k.split("|")[0])))];
  const live = await repo.liveAdIds(env, ids);
  const keys = await repo.slideKeys(env, ids.filter((id) => live.has(id)));
  const day = now.toISOString().slice(0, 10); let accepted = 0;
  for (const [k, s] of sums) {
    const id = Number(k.split("|")[0]), sid = k.slice(k.indexOf("|") + 1);
    if (!live.has(id) || (sid !== "" && sid !== "main" && !keys.get(id)?.has(sid))) continue; // only real slides of live ads: no junk rows
    await repo.addStats(env, id, sid, day, s.v, s.c); accepted += s.v + s.c;
  }
  return { status: accepted ? 200 : 404, accepted };
}
