# Customer dashboard now uses the admin shell

`/app/*` pages render through `worker/views/customer-layout.js`, which now builds on the same
`shell-assets.js` (stylesheet, icons, boot and client scripts) as the staff console in `layout.js`.

- Same markup: grouped collapsible sidebar with counts and a "Find a page" filter, sticky topbar,
  menu toggle (docked on desktop, drawer on phones), light/dark theme, account menu, skip link.
- Customer groups: Workspace, Insights, Monetization, Hosting, Automation & API, Organization, Coming soon.
- Plan-hidden entries (`hiddenNavKeys`) still disappear, except the page being viewed; empty groups vanish.
- `#org-switcher` keeps its id (several pages read it). Logout posts to `/api/customer/logout`.
- Portal-only rules (status badges, `.stat .value`, domain wizard, filters, nav badge) live in
  `CUSTOMER_STYLES` in `shell-assets.js`, on the shared colour tokens, so both themes work.
- `legacy-styles.js` is deleted (nothing imports it) and the hard-coded `<style>` block in
  `customer-pages/domains.js` moved into `CUSTOMER_STYLES`.
- `renderCustomerShell()` takes the same arguments as before; no route changes in `index.js`.
