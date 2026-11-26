# Advertisement slider (lummet.com homepage banner)

Staff manage advertisements at **Content > Advertisements** (`/cms/advertisements`). An advertisement in the placement `homepage_banner` is the banner shown on the public homepage. This change turns that single picture into a multi-picture slider and gives it analytics.

## What staff can do
Open an advertisement (Edit). Below the usual form there is a **Slider** card:
- **Slides** (up to 10): upload a picture (PNG, JPEG or WebP, at least 300 x 100, stored in the platform media library) or paste an https address; an optional picture for phones; alt text; headline, short text, badge, button text; link (`/path`, `https://`, `mailto:`), new tab; text position; seconds on screen; show-from / show-until (UTC). Reorder, duplicate, remove.
- **Settings**: automatic rotation and seconds per slide, animation (fade, slide, zoom, Ken Burns) and its length, shape on desktop (21:9, 3:1, 4:1, 2:1, 16:9, 3:2, 4:3, 1:1) and on phones, picture fit, text shade, arrows, dots or bars, progress bar, counter, pause on hover, loop, swipe, arrow keys, an "Ad" label.
- **Preview** (typed state, nothing saved) and **Save slider**. The form above (name, placement, status, dates) keeps its own Save button.
- **Numbers**: views, clicks and click rate for the advertisement (all time, last 7 days) and per slide.

An advertisement without slides keeps working: it shows its own image, link and alt text as one slide, exactly as before.

## Behaviour
Follows the W3C carousel pattern and web.dev carousel guidance: pauses on hover, on keyboard focus, when under 40 % is on screen and when the tab is hidden; visible play/pause button; no automatic rotation for visitors who asked for reduced motion; `region` / carousel / slide roles with "N of M" labels; inactive slides are not focusable. The first picture loads at high priority, the rest lazily; the stage reserves its height with `aspect-ratio`; only `transform` and `opacity` animate (no layout shift). External advertisement links are always `rel="sponsored noopener"` and open in a new tab.

## Data and safety
- Migration `0109_ad_slider.sql` (additive, idempotent): `lummet_ad_settings`, `lummet_ad_slides`, `lummet_ad_stats`. Run the usual migration before using the Slider card; until then the card says so and the homepage keeps showing the banner as one picture (the slider read is separate and fail-soft).
- All SQL is in `worker/repositories/ad-slider.js` (the SQL ratchet baseline is unchanged).
- Routes: `POST /cms/advertisements/:id/slider` (save), `.../slider-preview`, `POST /cms/advertisements/image` (upload): staff with the `cms / advertisements / update` permission, audit-logged, same-origin only (CSRF guard). Public: `POST /api/ad-event` (204, per-client rate limit, only real slides of active advertisements are counted, at most one counter row per ad, slide and day).
- Slides outside their window are dropped on the server and re-checked in the browser. Deleting an advertisement deletes its slides, settings and numbers. Uploaded pictures stay in the media library.

## Files
New: `worker/ad-slider.js`, `worker/repositories/ad-slider.js`, `worker/views/pages/ad-slider-panel.js`, `worker/views/pages/ad-slider-client.js`, `public/static/js/ad-slider.js`, `public/static/css/ad-slider.css`, `migrations/0109_ad_slider.sql`, `test/ad-slider.test.js`.
Changed: `worker/index.js` (routes), `worker/cms.js` (cleanup on delete), `worker/views/pages/cms.js` (card), `worker/public-site/home.js` and `worker/repositories/public-site.js` (slider read and render), `public/templates/pages/home.html`.

Only the `homepage_banner` placement is rendered on the site today; other placements are untouched.
