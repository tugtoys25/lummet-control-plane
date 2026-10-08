# Dashboard shell (staff UI)

Server-rendered, no build step. Files:

| File | Role |
|---|---|
| `worker/views/layout.js` | `NAV` (groups and links), `renderShell`, `renderAuthShell` |
| `worker/views/shell-assets.js` | stylesheet, icons, the early theme script and the client script |

## Behaviour

- **Menu button** (top left): on screens wider than 900px it collapses and restores the
  sidebar and remembers the choice; on narrower screens it opens a slide-out drawer.
  The drawer closes from the backdrop, the close button, the Escape key, or by choosing a link.
- **Groups** are `<details>` elements, so they work without JavaScript. The group holding the
  current page is open and flagged; other groups remember whether you opened them.
- **Find a page** filters links across all groups.
- **Theme:** dark by default, light on request or when the system prefers it. The choice is
  stored in `localStorage` (guarded; the page works without it). A tiny script in `<head>`
  applies it before first paint so there is no flash.
- **Tables** are wrapped in a scroll container at run time so wide tables scroll sideways inside
  the card instead of widening the page.

## Rules that did not change

- A link is shown only when the staff member holds a `read` grant on its `area` / `resource`
  (`rbac.js`). Tenants and Platform are super-admin only. **Hiding a link is a convenience;
  the route guards in `worker/index.js` are the security boundary.**
- Every previous URL still exists. A test compares the grouped navigation with the list of links
  the flat navigation offered.

## Changing the navigation

Edit `NAV` in `layout.js`. Each group needs `id`, `section`, `icon` (a key of `ICONS`) and `items`.
Keep one `key` and one `href` per item (tests enforce uniqueness and the 67-link inventory;
update `PREVIOUS_HREFS` in `test/admin-shell.test.js` when you add a page on purpose).

## Colors

All colors are tokens at the top of `STYLES` (`:root` for dark, `:root[data-theme="light"]`).
Legacy names used by older pages (`--success`, `--warning`, `--border-color`) are aliases.

## Addresses

The public website owns `/` and every public path for all visitors, including signed-in staff.
The dashboard is at `/dashboard` and still requires a session (anonymous requests go to `/login`).
The top bar has a **View site** link that opens the public site in a new tab.
