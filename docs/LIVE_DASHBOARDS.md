# Live dashboards

**Live regions.** A region marked `data-live-src="<url>"` keeps itself current without a page reload (`worker/views/live-runtime.js`, shipped in the cached shell script). The endpoint answers `{ success, data: { html, hash, busy } }`, built by the same renderer the page used (`renderSiteRows`, `renderDeploymentCards`), so a refresh never shows something the page would not.
- Polls every 4 s while the server says something is in flight (`busy`) and every 30 s otherwise; stops while the tab is hidden and checks at once when it is visible again; backs off after errors (up to 5 min); never replaces a region while the person is typing in it; swaps only when the hash changed; an ended session reloads once to reach the login page.
- In use: Sites table (`GET /api/organizations/:id/sites/live-rows`) and Deployments cards (`GET /api/organizations/:id/deployments/live-cards`). After an action (pause, resume, delete, retry, deploy, rollback) the page refetches the region at once instead of reloading.
- To add one: render the region's inner html with a shared function, return it from a `live-*` endpoint with `Cache-Control: no-store`, and add `liveAttrs(url, html)` to the container.

**Faster loading.** Reads that were awaited one after another now run together: the shared portal setup (organization, IP policy, plan flags, notifications), the Sites page (4 rounds to 2), the Domains page (3 reads per site, one by one, to all at once), the Deployments page (one read per site, one by one, to all at once) and the Billing plan list. The existing hashed, immutable shell assets, D1 read sessions and `Server-Timing` header are unchanged.

**Not covered.** The Overview page and the staff console do not yet refresh themselves.
