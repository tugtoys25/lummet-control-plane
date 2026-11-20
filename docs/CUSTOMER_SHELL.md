# Customer dashboard now uses the admin shell

`/app/*` pages render through `worker/views/customer-layout.js`, which now builds on the same
`shell-assets.js` (stylesheet, icons, boot and client scripts) as the staff console in `layout.js`.

- Same markup: grouped collapsible sidebar with counts and a "Find a page" filter, sticky topbar,
  menu toggle (docked on desktop, drawer on phones), light/dark theme, account menu, skip link.
- Customer groups: Workspace, Insights, Monetization, Hosting, Automation & API (Automations, Integrations, API & webhooks), Organization (Team, Support, ...). The "Coming soon" group only appears while `COMING_SOON` in `customer-layout.js` has entries; it is empty now.
- Plan-hidden entries (`hiddenNavKeys`) still disappear, except the page being viewed; empty groups vanish.
- `#org-switcher` keeps its id (several pages read it). Logout posts to `/api/customer/logout`.
- Portal-only rules (status badges, `.stat .value`, domain wizard, filters, nav badge) live in
  `CUSTOMER_STYLES` in `shell-assets.js`, on the shared colour tokens, so both themes work.
- `legacy-styles.js` is deleted (nothing imports it) and the hard-coded `<style>` block in
  `customer-pages/domains.js` moved into `CUSTOMER_STYLES`.
- `renderCustomerShell()` takes the same arguments as before; no route changes in `index.js`.

## Integrations and Support
- **Integrations** (`/app/integrations`, admins): connect Slack, Discord, Microsoft Teams or Telegram. The same events webhooks use are posted as a short message (`worker/integrations.js`, called from `webhooks.dispatchEvent`). The destination is encrypted (`integrations.encrypted_secret`, in the key-rotation list), only its host is shown, and each provider accepts only its own official hosts.
- **Support** (`/app/support`, every member): tickets with threaded replies (`worker/support.js`). A reply from the team marks the ticket "answered", emails the person who wrote it and shows a badge on the Support menu link. Staff answer in the SaaS area under **Support inbox** (`/platform/saas/support`). Erasing an organization removes its tickets and integrations; erasing a person anonymises the messages they wrote.
- SQL for both lives in `worker/repositories/integrations.js` and `worker/repositories/support.js`; migration `0106_integrations_support.sql`.
