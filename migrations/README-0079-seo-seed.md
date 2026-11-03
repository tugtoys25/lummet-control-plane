# 0079 SEO seed: Start an Affiliate Business

Apply once per database (staging first):

    node scripts/migration-preflight.mjs --db <database> [--remote]
    node scripts/migrate.mjs ...        # your normal migration command

Contents: 6 pages (/p/...), 8 Insights posts, 12 FAQs (group `affiliate`), 2 feature groups,
3 homepage sections (affiliate-launch 25, affiliate-features 35, affiliate-faq 115), 7 nav links,
and homepage title/description/hero eyebrow/title/subtitle.

Not touched: hero buttons (set by 0073), existing brand profiles, pages, posts.
Content rows are INSERT OR IGNORE; the site_settings block overwrites only the 5 keys it names.

## Keyword map
- Pillar: start an affiliate business -> /p/start-affiliate-business
- affiliate website builder -> /p/affiliate-website-builder
- best website builder for affiliate marketing -> /p/best-website-builder-for-affiliate-marketing
- multi-site website platform -> /p/multi-site-website-platform
- white-label website platform -> /p/white-label-website-platform
- AI content tools for affiliate websites -> /p/ai-content-for-affiliate-sites
All spokes link to the pillar; Insights posts link to the matching page.
