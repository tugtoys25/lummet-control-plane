// The "Slider" card on an advertisement's edit page: settings, slides (the editor itself is ad-slider-client.js), a preview and
// the numbers. Server-rendered shell; the data the editor starts from is embedded as JSON (with "<" escaped).
import { escapeHtml } from "../layout.js";
import { nonceToken } from "../../csp.js";
import { AD_SLIDER_CLIENT } from "./ad-slider-client.js";
import * as repo from "../../repositories/ad-slider.js";
import * as media from "../../platform-media.js";
import { DEFAULTS, LIMITS, CHOICES, normalizeSettings, renderAdSlider } from "../../ad-slider.js";

const STYLE = `
.adx { margin-top: 20px; }
.adx h2 { margin: 0 0 4px; font-size: 18px; } .adx h3 { margin: 18px 0 8px; font-size: 15px; }
.adx .hint { margin: 0 0 12px; color: var(--text-dim); font-size: 13px; }
.adx-stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.adx-stat { min-width: 120px; padding: 10px 14px; border: 1px solid var(--border, #d9dde3); border-radius: 10px; }
.adx-stat b { display: block; font-size: 20px; } .adx-stat span { font-size: 12px; color: var(--text-dim); }
.adx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 16px; align-items: end; }
.adx-f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; } .adx-f small { color: var(--text-dim); }
.adx-c { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.adx-pic { display: flex; flex-direction: column; gap: 6px; }
.adx-slide { margin: 0 0 10px; border: 1px solid var(--border, #d9dde3); border-radius: 10px; }
.adx-slide > summary { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; font-weight: 600; }
.adx-thumb { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; background: rgba(128,128,128,.2); }
.adx-fig { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.adx-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 16px; padding: 4px 12px 12px; }
.adx-tools { display: flex; flex-wrap: wrap; gap: 6px; grid-column: 1 / -1; }
.adx-danger { color: #b42318; }
.adx-empty { margin: 0; padding: 12px; border: 1px dashed var(--border, #d9dde3); border-radius: 10px; color: var(--text-dim); font-size: 13px; }
.adx-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
#adSliderPreviewBox { max-width: 900px; margin-top: 12px; }
`;

const pct = (c, v) => (v ? `${Math.round((c / v) * 1000) / 10}%` : "0%");

/** `id` of an existing advertisement. Returns "" when the slider tables are not there yet (migration 0109 not run). */
export async function adSliderPanel(env, ad) {
  let slider, stats;
  try {
    slider = await repo.loadSlider(env, ad.id);
    stats = await repo.statsFor(env, ad.id, new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  } catch (err) {
    return `<div class="card adx"><h2>Slider</h2><p class="hint">The slider tables are missing. Run the latest database migration (0109_ad_slider), then reload this page.</p></div>`;
  }
  const data = { adId: ad.id, settings: normalizeSettings(slider.settings), slides: slider.slides.map(({ position, ...s }) => s), stats, defaults: DEFAULTS, limits: LIMITS, choices: CHOICES, mediaOk: media.storageConfigured(env) };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const preview = renderAdSlider({ ad, slides: slider.slides, settings: slider.settings, preview: true, now: null });
  const live = ad.placement === "homepage_banner";
  return `<section class="card adx" aria-labelledby="adxTitle">
  <h2 id="adxTitle">Slider</h2>
  <p class="hint">Add several pictures to this advertisement. They rotate on their own, every slide can link somewhere, and each slide is counted separately.${live ? "" : ` <strong>Only the placement “homepage_banner” is shown on the site today; this advertisement's placement is “${escapeHtml(ad.placement || "")}”.</strong>`}</p>
  <div class="adx-stats" aria-label="Numbers">
    <div class="adx-stat"><b>${stats.total.views}</b><span>views (all time)</span></div><div class="adx-stat"><b>${stats.total.clicks}</b><span>clicks (all time)</span></div>
    <div class="adx-stat"><b>${pct(stats.total.clicks, stats.total.views)}</b><span>click rate</span></div><div class="adx-stat"><b>${stats.last7.views} / ${stats.last7.clicks}</b><span>views / clicks, last 7 days</span></div>
  </div>
  <div id="adSliderStatus" role="status" hidden></div>
  <div id="adSliderEditor">
    <h3>Slides</h3><div id="adSliderSlides"></div>
    <div class="adx-actions"><button type="button" class="btn btn-secondary" id="adSliderAdd">+ Add slide</button></div>
    <h3>Timing, animation and controls</h3><div id="adSliderSettings"></div>
    <div class="adx-actions"><button type="button" class="btn btn-primary" id="adSliderSave">Save slider</button><button type="button" class="btn btn-secondary" id="adSliderPreview">Preview</button></div>
    <p class="hint">The form above (name, placement, status, dates) is saved with its own button. The preview shows the first slide, without motion; open the homepage to see the animation.</p>
    <div id="adSliderPreviewBox" class="banner-ad">${preview}</div>
  </div>
  <script type="application/json" id="adSliderData">${json}</script>
  <link rel="stylesheet" href="/static/css/ad-slider.css">
  <style>${STYLE}</style>
  <script nonce="${nonceToken()}">${AD_SLIDER_CLIENT}</script>
</section>`;
}
