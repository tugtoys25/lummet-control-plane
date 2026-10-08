# v7B: v7A + tenant v14 (Wednesday12)

Only the tenant changed; the control plane is identical to v7A (the Wednesday12 control plane is the older standalone
one and has nothing newer than v7A).

## Tenant: every page type that shows components can be assigned
Dashboard > Components > "Assign Component to Page" (and the filter list) now offers: sportsbook, sportsbook listing,
affiliate partner, affiliate partner listing, content landing page, generic review, country sub-page, category+country
page, the three comparison types and their lists, plus your own custom content types (read from Custom Types, listed
at the bottom). Comparison and Generic Review pages gained the "Content Top" slot.
Files: component-admin.js, components.html, comparison.html, generic-review.html, test/component-page-types.test.js,
docs/RELEASE_MORE_PAGE_TYPES.md (the install steps in it are for the standalone repo; ignore them).
No migrations. Backup, patch, .git and .wrangler files from the Wednesday12 zip were left out.

## Still to check (carried from v7A)
- Visitor inquiries hold personal data and are not covered by customer erasure; staff delete them in Site Forms > Inquiries.
- The seeded public navigation has no link to /app/login or sign-up; add one under /cms/nav_links.
- The tenant build needs wrangler; publish a new tenant release to ship the tenant code.
- The billing webhook retry issue noted in v6B is unchanged.
