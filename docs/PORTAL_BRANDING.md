# Portal branding and the media library (2.8.0)

Code: `worker/portal-branding.js` (fields, validation, head tags, manifest, public routes), `worker/platform-media.js` (library), `worker/image-inspect.js` (bytes -> type and size, SVG safety), `worker/portal-branding-routes.js` (staff API), `worker/views/pages/portal-branding.js` (screens), repositories `portal-branding.js` and `platform-media.js`. Tables: `platform_branding`, `platform_media` (migration 0096).

Fields (same ideas as the tenant's `site_*` icon settings): `brand_name`, `brand_short_name`, `logo`, `og_image`, `favicon_svg`, `favicon_ico`, `favicon_96` (96x96 PNG), `apple_touch_icon` (180x180 PNG), `pwa_icon_192`, `pwa_icon_512`, `manifest_display`, `theme_color`, `background_color`.

Markers (site-chrome.js): `<!--lummet:head-icons-->` (all shells), `<!--lummet:portal-brand-->` and `<!--lummet:portal-name-->` (staff console only). The public site gets the tags through `site.icon_links_html` in `public/templates/layout/base.html`.

Operations: values are cached 15 s per isolate; unreadable storage falls back to the built-in look. Deleting a file that a field uses is refused. Uploads need the `PLATFORM_MEDIA` R2 binding; an https address works without it. Every write is in the audit log (`portal_branding`, `platform_media`).
