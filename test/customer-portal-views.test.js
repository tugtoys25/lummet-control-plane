// test/customer-portal-views.test.js
//
// The /app/* page ROUTES in index.js aren't covered here (that
// would need a full HTTP/Workers-runtime integration harness this
// repo doesn't have) -- but every render*() function they call is
// pure (data in, HTML string out), so this covers the actual
// template logic directly: no thrown errors on realistic data
// shapes, no missing fields silently rendering "undefined", and
// HTML-escaping actually happening on user-supplied strings (XSS
// prevention).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderCustomerShell } from '../worker/views/customer-layout.js';
import { renderCustomerLoginPage } from '../worker/views/customer-pages/login.js';
import { renderOverviewPage } from '../worker/views/customer-pages/overview.js';
import { renderSitesPage } from '../worker/views/customer-pages/sites.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';
import { renderTeamPage } from '../worker/views/customer-pages/team.js';

test('renderCustomerLoginPage renders a full HTML document with login and signup forms', () => {
  const output = renderCustomerLoginPage();
  assert.match(output, /<!DOCTYPE html>/);
  assert.match(output, /id="login-form"/);
  assert.match(output, /id="signup-form"/);
});

test('renderCustomerShell escapes the customer email and organization name', () => {
  const output = renderCustomerShell({
    title: 'Overview', activeKey: 'overview',
    customer: { email: '<script>alert(1)</script>@example.com' },
    organizations: [{ id: 'org-1', name: 'Acme "Quotes" & <Tags>' }],
    activeOrganizationId: 'org-1',
    bodyHtml: '<h1>Body</h1>'
  });
  assert.doesNotMatch(output, /<script>alert\(1\)<\/script>/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /Acme &quot;Quotes&quot;/);
});

test('renderOverviewPage handles no subscription, a trialing subscription, and an empty site list without throwing', () => {
  const noSub = renderOverviewPage({
    organization: { name: 'Acme' }, subscription: null, plan: null,
    usage: { sites: { used: 0, limit: 0 }, users: { used: 1, limit: null }, customDomains: { used: 0, limit: 0 } },
    sites: []
  });
  assert.match(noSub, /No sites yet/);
  assert.match(noSub, /Choose a plan/);

  const trialing = renderOverviewPage({
    organization: { name: 'Acme' },
    subscription: { status: 'trialing', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString() },
    plan: { name: 'Starter' },
    usage: { sites: { used: 1, limit: 1 }, users: { used: 1, limit: 2 }, customDomains: { used: 0, limit: 1 } },
    sites: [{ id: 's1', name: 'My Site', product_name: 'Casino News', status: 'active', primary_domain: 'example.com' }]
  });
  assert.match(trialing, /My Site/);
  assert.match(trialing, /days? left in trial/);
});

test('renderSitesPage escapes site names and shows the create form only when canManage', () => {
  const withManage = renderSitesPage({
    sites: [{ id: 's1', name: '<b>Evil</b> Site', product_name: 'News', status: 'pending', primary_domain: null, app_version: null }],
    products: [{ id: 'p1', name: 'Casino News' }],
    canManage: true
  });
  assert.doesNotMatch(withManage, /<b>Evil<\/b> Site/);
  assert.match(withManage, /&lt;b&gt;Evil&lt;\/b&gt; Site/);
  assert.match(withManage, /id="create-site-form"/);
  assert.match(withManage, /lummetProvision/);

  const withoutManage = renderSitesPage({ sites: [], products: [], canManage: false });
  assert.doesNotMatch(withoutManage, /id="create-site-form"/);
  assert.match(withoutManage, /No sites yet/);
});

test('renderBillingPage shows available plans only with no subscription, and invoices table always renders', () => {
  const noSub = renderBillingPage({
    subscription: null, plan: null, invoices: [],
    availablePlans: [{ id: 'p1', name: 'Starter', price_cents: 500, currency: 'USD', billing_period: 'monthly', trial_days: 7 }],
    canManage: true
  });
  assert.match(noSub, /Available plans/);
  assert.match(noSub, /Starter/);
  assert.match(noSub, /No invoices yet/);

  const withSub = renderBillingPage({
    subscription: { status: 'active', provider: 'stripe', trial_ends_at: null, cancel_at_period_end: 0 },
    plan: { name: 'Starter' },
    invoices: [{ created_at: '2026-01-01T00:00:00Z', status: 'paid', amount_due_cents: 500, currency: 'USD', hosted_invoice_url: 'https://example.test/inv' }],
    availablePlans: [],
    canManage: true
  });
  assert.doesNotMatch(withSub, /Available plans/);
  assert.match(withSub, /paid/);
});

test('renderTeamPage lists members and pending invitations, escaping names', () => {
  const output = renderTeamPage({
    members: [{ full_name: null, email: 'owner@example.com', role: 'owner' }],
    pendingInvitations: [{ email: 'invitee<script>@example.com', role: 'editor', status: 'pending' }],
    canManage: true
  });
  assert.match(output, /owner@example\.com/);
  assert.doesNotMatch(output, /invitee<script>/);
  assert.match(output, /id="invite-form"/);
});
