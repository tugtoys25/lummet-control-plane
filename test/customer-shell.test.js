// The customer portal shell must look and behave like the staff shell: same grouped sidebar, topbar,
// theme toggle and mobile drawer. These tests pin the structure (not the pixels) and the portal-specific
// rules: plan-hidden entries, the organization switcher id pages depend on, no links to unbuilt pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderCustomerShell, NAV } from '../worker/views/customer-layout.js';
import { NAV as STAFF_NAV } from '../worker/views/layout.js';

const base = {
  title: 'Overview', activeKey: 'overview',
  customer: { email: 'owner@example.com' },
  organizations: [
    { id: 'org-1', name: 'Acme', my_role: 'owner' },
    { id: 'org-2', name: 'Globex', my_role: 'viewer' }
  ],
  activeOrganizationId: 'org-1',
  bodyHtml: '<h1>Body</h1><table><tr><td>x</td></tr></table>'
};

// Links inside the sidebar navigation only (the brand and user menu link to /app/* too).
const hrefs = (html) => {
  const nav = html.slice(html.indexOf('<nav class="nav-scroll"'), html.indexOf('</nav>'));
  return [...nav.matchAll(/<a href="(\/app\/[^"]+)"/g)].map((m) => m[1]);
};

test('customer shell uses the same structure as the staff shell', () => {
  const out = renderCustomerShell(base);
  for (const marker of [
    'class="app"', 'class="sidebar" id="sidebar"', 'class="nav-group"', 'id="nav-filter"', 'id="nav-toggle"',
    'id="nav-backdrop"', 'id="theme-toggle"', 'class="user-menu" id="user-menu"', 'class="topbar"',
    'id="main-content"', 'viewport-fit=cover', 'data-theme="dark"', 'class="skip-link"'
  ]) {
    assert.ok(out.includes(marker), `missing ${marker}`);
  }
  assert.ok(!out.includes('class="nav-section"'), 'old flat nav must be gone');
  // The staff nav exposes the same group fields the customer nav uses.
  assert.deepEqual(Object.keys(NAV[0]).sort(), Object.keys(STAFF_NAV[0]).sort().filter((k) => k in NAV[0]));
});

test('customer navigation is grouped, complete, and opens the current page\'s group', () => {
  const out = renderCustomerShell({ ...base, title: 'Domains', activeKey: 'domains' });
  const all = NAV.flatMap((g) => g.items.map((i) => i.href));
  // The Security (2FA setup) entry shows only while CUSTOMER_2FA_ENROLL_PAGE is on (securityLink).
  assert.deepEqual(hrefs(out).sort(), all.filter((h) => h !== '/app/security/2fa').sort());
  const withSecurity = renderCustomerShell({ ...base, title: 'Domains', activeKey: 'domains', securityLink: true });
  assert.deepEqual(hrefs(withSecurity).sort(), all.sort());
  assert.match(out, /data-group="hosting" data-has-active open/);
  assert.match(out, /aria-current="page"/);
  assert.equal(new Set(NAV.map((g) => g.id)).size, NAV.length);
});

test('entries for features the plan lacks are hidden, but never the page being viewed', () => {
  const hidden = ['backups', 'automations', 'analytics', 'reports', 'campaigns', 'alerts'];
  const out = renderCustomerShell({ ...base, hiddenNavKeys: hidden });
  for (const h of ['/app/backups', '/app/automations', '/app/analytics', '/app/reports', '/app/campaigns', '/app/alerts']) {
    assert.ok(!hrefs(out).includes(h), `${h} should be hidden`);
  }
  assert.ok(!out.includes('data-group="monetization"'), 'a group with nothing left disappears');

  const viewing = renderCustomerShell({ ...base, title: 'Backups', activeKey: 'backups', hiddenNavKeys: hidden });
  assert.ok(hrefs(viewing).includes('/app/backups'));
});

test('unbuilt pages are shown disabled, not as links', () => {
  const out = renderCustomerShell(base);
  assert.match(out, /class="nav-disabled"[^>]*>Integrations/);
  assert.match(out, /class="nav-disabled"[^>]*>Support/);
});

test('notification badge renders on the nav link and caps at 99+', () => {
  assert.match(renderCustomerShell({ ...base, navBadges: { notifications: 4 } }), /has-badge[^>]*>Notifications<span class="nav-badge"[^>]*>4</);
  assert.match(renderCustomerShell({ ...base, navBadges: { notifications: 250 } }), />99\+</);
  assert.ok(!renderCustomerShell({ ...base, navBadges: { notifications: 0 } }).includes('nav-badge"'));
});

test('organization switcher keeps id org-switcher and marks the active organization', () => {
  const out = renderCustomerShell(base);
  assert.match(out, /<select id="org-switcher"/);
  assert.match(out, /<option value="org-1" selected>Acme<\/option>/);
  assert.match(out, /<option value="org-2" >Globex<\/option>/);
  assert.match(out, /Acme <span aria-hidden="true">\/<\/span> <strong>Overview/);
  assert.match(out, /role-badge">owner</);
});

test('shell renders without organizations or customer and never leaks staff-only controls', () => {
  const out = renderCustomerShell({ title: 'Invitation', activeKey: '', customer: null, organizations: [], activeOrganizationId: null, bodyHtml: '' });
  assert.ok(!out.includes('id="org-switcher"'));
  assert.ok(!out.includes('id="user-menu"'));
  assert.ok(!out.includes('id="logout-btn"'), 'customer logout goes through /api/customer/logout');
  assert.match(out, /\/api\/customer\/logout/);
  assert.ok(!out.includes('tenant-switcher'));
  assert.ok(!out.includes('/platform/'));
});
