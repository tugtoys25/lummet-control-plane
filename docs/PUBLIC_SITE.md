> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Lummet public website

The public site (lummet.com) is rendered by the control-plane Worker from its
own D1 database. There is no mock data, no placeholder copy and no hardcoded
content list in code: what a visitor sees is exactly the set of **published**
rows in the database.

## Layout of the code (mirrors the tenant's organisation)

```
public/                          Workers Assets root (wrangler.jsonc "assets")
  templates/
    layout/base.html             <head>, skip link, {{> header}}, <main>{{{content}}}, {{> footer}}, scripts
    layout/header.html           logo, nav (from DB), theme toggle, CTA buttons, mobile menu
    layout/footer.html           brand blurb + link columns (from DB)
    components/*.html            cards, breadcrumbs, pagination, one partial per homepage section kind
    pages/*.html                 home, brands, brand, updates, update, insights, insight,
                                 partners, author, page, 404
  static/
    css/tokens.css               colours (light + dark), type scale, spacing, radii
    css/base.css                 reset, typography, layout, header, footer
    css/components.css           buttons, cards, sections, prose, FAQ, panel, stats
    css/pages.css                hero + network graph, page headers, articles, timeline
    (forms, sticky footer and error styling live in base.css / components.css)
    js/theme.js                  applies light/dark before first paint
    js/nav.js                    mobile menu, theme toggle, header shadow
    js/reveal.js                 scroll reveal (content is visible without JS)
    js/filter.js                 brand category filter (progressive enhancement)
    js/article.js                copy-link button, external links in articles
    js/form.js                   double-submit guard for the contact / demo forms
    images/                      favicon.svg, brands/<logo files you own>

worker/public-site/
  router.js     routes, edge cache, static passthrough (returns null for admin paths)
  context.js    per-request site context: branding, nav/footer links, canonical base
  data.js       read-only D1 queries, always `status = 'published'`
  models.js     row -> safe view model (sanitized HTML, validated URLs)
  home.js       composes the homepage from lummet_homepage_sections
  pages.js      one handler per public page + SEO/JSON-LD
  seo.js        <title>, canonical, Open Graph, Twitter, JSON-LD builders
  render.js     shared layout render, security headers, cache headers
  template.js   the template engine ({{x}} escaped, {{{x}}} raw, if/else/unless/each, partials)
  forms.js      /contact, /demo, /forms/:key: rendering, validation, spam guards, storage
  links.js      isLiveHref(): is a link's destination currently published content?
  sitemap.js    sitemap.xml and robots.txt generated from the DB
  hero-graph.js hero network diagram: one SVG node per published brand
  sanitize.js   HTML sanitizer for CMS rich text (same as the tenant's)
  icons.js, format.js
```

## Routes

| URL | Source |
|---|---|
| `/` | `lummet_homepage_sections` (ordered), `lummet_site_settings` (hero), counts |
| `/brands`, `/brands/:slug` | `lummet_brands` |
| `/updates`, `/updates/:slug` | `lummet_updates` (paginated, newest first) |
| `/insights`, `/insights/:slug` | `lummet_publications` (filter `?type=`) |
| `/partners` | `lummet_partners` |
| `/authors/:slug` | `lummet_authors` + their published work |
| `/contact`, `/demo`, `/forms/:key` | `lummet_forms` + `lummet_form_fields`; POST stores into `lummet_inquiries` |
| `/about`, `/security`, `/privacy`, `/terms`, `/p/:slug` | `lummet_pages` |
| `/sitemap.xml`, `/robots.txt` | generated |
| `/static/*` | `public/static/**` |

`/` still shows the authenticated dashboard to a signed-in admin.

## What is managed where (Dashboard -> Lummet Site)

| Screen | Controls |
|---|---|
| Homepage settings | site name/logo/accent colours, homepage `<title>` and description, canonical URL, hero copy and buttons, footer text, contact email, list-page titles and intros |
| Homepage sections | which sections appear, their order, `kind`, background, title/eyebrow/body, button |
| Features | the cards, steps, checklist items and AI-panel items inside sections (`group_key` <-> section `feature_group`) |
| FAQs | the FAQ section, and FAQPage structured data |
| Navigation links | header, header buttons and the three footer columns |
| Forms / Form fields | the contact and demo pages: titles, intro, button, success message, side panel, and every field (label, type, required, options, order) |
| Inquiries | submissions from the forms: read, set status (new / read / replied / spam / archived), add internal notes, delete |
| Interface text | every small label the site shows: button text, aria labels, empty states, form errors, footer column titles, type labels (`lummet_ui_strings`) |
| Brand profiles / Updates / Publications / Partners / Authors / Pages | the content pages, each with SEO title, description and social image |

Section kinds: `text`, `features`, `steps`, `checklist`, `panel`, `brands`,
`stats`, `updates`, `insights`, `partners`, `faq`, `cta`, `contact`.

## Nothing hardcoded: where each kind of text lives

| Kind of text | Lives in |
|---|---|
| Page and section copy, hero, footer text, list-page titles | `lummet_site_settings`, `lummet_homepage_sections`, `lummet_pages` |
| Cards, steps, checklist items, AI panel items | `lummet_features` |
| Navigation (header, buttons, footer columns) | `lummet_nav_links` |
| Contact / demo copy and every form field | `lummet_forms`, `lummet_form_fields` |
| Small interface text (labels, errors, empty states, ARIA) | `lummet_ui_strings` |
| Brands, updates, insights, partners, authors, FAQs | their own tables |

`test/forms.test.js` enforces this: it fails if a template contains literal
text outside `{{ }}`, if a template uses an interface key that is not seeded,
or if a client script contains a label. The only text outside the database is
the last-resort "Temporarily unavailable" page, which is shown when the
database itself cannot be read.

## Contact and demo forms

- **Submit flow:** POST to the same URL -> validate against the database field
  definitions -> store in `lummet_inquiries` -> 303 redirect to `?sent=1`
  (refreshing never resubmits). Errors re-render the form with the visitor's
  text kept and each message coming from `lummet_ui_strings`.
- **Spam and abuse controls, no third-party service and no cookies:** a hidden
  honeypot field (bots get a fake success and nothing is stored); a same-origin
  check on every POST (`Origin` / `Sec-Fetch-Site`); a per-visitor hourly limit
  (hashed IP; default 5, change with the `inquiry_rate_limit_per_hour` setting);
  size and length limits; select values must be one of the stored options.
- **Privacy:** only the submitted fields and a one-way IP hash are stored. Delete
  an inquiry from Lummet Site -> Inquiries when it is no longer needed.
- **Notification (optional):** `wrangler secret put INQUIRY_WEBHOOK_URL` with an
  `https://` Slack, Discord or other JSON webhook URL. Each new inquiry sends one
  short message. A failing webhook never loses the inquiry. Without it, check
  Lummet Site -> Inquiries (the app does not send email).
- **New forms:** Forms -> New (key `partners` -> `/forms/partners`), then add rows
  in Form fields with the same form key. A draft form returns 404.

## Footer at the bottom

`body` is a full-height flex column (`min-height: 100dvh`) and `<main>` has
`flex: 1 0 auto`, so the footer is flush with the bottom of the screen on a
short page and follows the content on a long one, at any screen size.

## The "real content" rules the code enforces

- Drafts are never queried by a public route.
- A section whose data source has no published rows is not rendered.
- A navigation link with `visible_when` = `has_partners` (etc.) hides until that content exists; `/#anchor` links hide when the section is not on the page.
- Every button and link is checked against what is published (`links.js`): a link to `/brands`, `/partners`, `/demo`, a page or a homepage anchor disappears when its destination would be empty, a 404, or absent from the page.
- The contact section links to the contact form when one is published; an email address is shown only if `contact_email` (or the `CONTACT_EMAIL` var) is set.
- The stats strip shows counts read from the database, never typed numbers.
- A brand without a `logo_url` shows an initials tile, not a fabricated logo.
- CMS URLs are restricted to `http(s)`, `mailto`, site-relative and `#`; CMS HTML is sanitized; accent colours are validated before reaching CSS.

## Caching

Rendered pages carry `Cache-Control: public, max-age=30, s-maxage=60,
stale-while-revalidate=300` and are stored with the Cache API, so D1 is not hit
on every view. A dashboard edit is live within about a minute. (The Cache API
only operates on custom domains, not `*.workers.dev`; there it renders each
request, which is still correct.)

## Content Security Policy

Public pages send `script-src 'self'`: there are no inline scripts, so a
stored-XSS payload in CMS content cannot execute even if a sanitizer gap is
found. Do not add inline `<script>` blocks to templates; add a file in
`public/static/js/` and reference it from `base.html`.

## Adding things

- **A new brand**: Brand profiles -> New. Upload the logo file to
  `public/static/images/brands/` (commit + deploy) and set Logo URL to
  `/static/images/brands/<file>`, or use a full `https://` URL.
- **A new homepage section**: Homepage sections -> New; pick a `kind`. For
  `features`/`steps`/`checklist`/`panel`, add Features rows with the same group.
- **A new page in the footer**: create the page in Pages, then add a
  Navigation link with Show when = `always` (an unpublished page 404s, so
  publish it first).
- **A new icon**: add its SVG path to `worker/public-site/icons.js` and to the
  Features `icon` list in `worker/cms-resources.js`.

## Tests

`npm test` runs `test/public-site.test.js` against the real migrations, the real
seed, the real templates and the real router (D1 -> `node:sqlite`, ASSETS ->
the `public/` folder).

## Header link for signed-in staff

`header.html` carries `data-signed-in-label` and `data-signed-in-href`, filled from
`lummet_ui_strings` (`signed_in_label`, `signed_in_href`). `public/static/js/session.js` calls
`GET /session-status` (same origin, `no-store`). When it returns `{"signedIn":true}` every header link
that points to `/login` (desktop and mobile menu) gets that label and target. If the strings are
missing, the request fails, or the visitor is not signed in, the page is left as rendered.
The endpoint returns only the flag, and the real access checks on `/dashboard` are unchanged.
