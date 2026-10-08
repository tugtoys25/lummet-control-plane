// test/analytics-page.test.js
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { encryptSecret } from '../worker/crypto.js';
import {
  fmtNum, fmtMoney, fmtPct, computeTotals, currenciesOf, dimensionLabel,
  defaultDateRange, renderTotalsCards, renderPerformanceTable, renderGeoTable,
  renderHealthTable, renderAlertsSummary, isKnownAnalyticsRun, submitAnalyticsRun,
  renderAnalyticsPage
} from '../worker/views/pages/analytics.js';

describe('formatting helpers', () => {
  test('fmtNum adds thousands separators', () => { assert.equal(fmtNum(12345), '12,345'); assert.equal(fmtNum(null), '0'); });
  test('fmtMoney shows two decimals and an optional currency suffix', () => {
    assert.equal(fmtMoney(1234.5), '1,234.50'); assert.equal(fmtMoney(10, 'USD'), '10.00 USD');
  });
  test('fmtPct converts a 0..1 fraction to a percent string', () => { assert.equal(fmtPct(0.0523), '5.23%'); assert.equal(fmtPct(undefined), '0.00%'); });
  test('dimensionLabel prefers name, falls back to #id, then "Overall"', () => {
    assert.equal(dimensionLabel({ name: 'Level Casino', dimensionId: 7 }), 'Level Casino');
    assert.equal(dimensionLabel({ dimensionId: 7 }), '#7');
    assert.equal(dimensionLabel({ dimensionId: null }), 'Overall');
  });
});

describe('computeTotals / currenciesOf', () => {
  test('sums the additive columns across rows', () => {
    const t = computeTotals([{ views: 10, clicks: 2, conversions: 1, revenue: 100, commission: 20 }, { views: 5, clicks: 1, conversions: 0, revenue: 50, commission: 10 }]);
    assert.deepEqual(t, { views: 15, clicks: 3, conversions: 1, revenue: 150, commission: 30 });
  });
  test('an empty row set totals to all zeros, not NaN', () => {
    assert.deepEqual(computeTotals([]), { views: 0, clicks: 0, conversions: 0, revenue: 0, commission: 0 });
  });
  test('currenciesOf reports the distinct currencies present', () => {
    assert.deepEqual(currenciesOf([{ currency: 'USD' }, { currency: 'EUR' }, { currency: 'USD' }]), ['USD', 'EUR']);
  });
});

describe('renderTotalsCards — mixed-currency safety', () => {
  test('a single currency shows a real money total', () => {
    const html = renderTotalsCards([{ revenue: 100, currency: 'USD' }], '');
    assert.match(html, /100\.00 USD/);
  });
  test('mixed currencies never silently sum money into one misleading total', () => {
    const html = renderTotalsCards([{ revenue: 100, currency: 'USD' }, { revenue: 50, currency: 'EUR' }], '');
    assert.match(html, /mixed currencies/);
    assert.doesNotMatch(html, /150\.00/);
  });
});

describe('renderPerformanceTable', () => {
  test('empty rows show a friendly empty state, not a blank table', () => {
    assert.match(renderPerformanceTable([]), /No data/);
  });
  test('a row renders its name (not the bare id) and formatted rates', () => {
    const html = renderPerformanceTable([{ dimensionId: 7, name: 'Level Casino', currency: 'USD', views: 100, clicks: 10, conversions: 1, revenue: 50, commission: 10, ctr: 0.1, cvr: 0.1, epc: 5, rpc: 5, cpa: 10 }]);
    assert.match(html, /Level Casino/);
    assert.doesNotMatch(html, />7</); // bare id must not appear on its own
    assert.match(html, /10\.00%/);
  });
  test('a deleted dimension (name null) still renders, using #id', () => {
    const html = renderPerformanceTable([{ dimensionId: 42, name: null, views: 1, clicks: 0, conversions: 0, revenue: 0, commission: 0 }]);
    assert.match(html, /#42/);
  });
});

describe('renderGeoTable / renderHealthTable / renderAlertsSummary', () => {
  test('geo: empty state, and a real row shows the country', () => {
    assert.match(renderGeoTable([]), /No GEO data/);
    assert.match(renderGeoTable([{ country: 'GB', clicks: 5, conversions: 1, revenue: 10, commission: 2, cvr: 0.2, epc: 2 }]), /GB/);
  });
  test('health: every status maps to a human label', () => {
    const html = renderHealthTable([{ key: 'analytics_aggregation', label: 'Analytics Aggregation', status: 'stale', lastRunAt: '2026-01-01' }]);
    assert.match(html, /Stale/);
  });
  test('alerts: empty state, and a row shows the rule name', () => {
    assert.match(renderAlertsSummary([]), /No open alerts/);
    assert.match(renderAlertsSummary([{ rule_name: 'High CPA', scope_type: 'tenant', created_at: '2026-01-01' }]), /High CPA/);
  });
});

describe('defaultDateRange', () => {
  test('spans 30 days ending today', () => {
    const r = defaultDateRange(new Date('2026-01-31T00:00:00Z'));
    assert.equal(r.endDate, '2026-01-31');
    assert.equal(r.startDate, '2026-01-02');
  });
});

describe('submitAnalyticsRun', () => {
  test('rejects an unknown run kind before touching the tenant', async () => {
    const result = await submitAnalyticsRun({}, { activeTenantId: 'x' }, 'not-a-real-kind', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });
  test('fails closed with no active tenant', async () => {
    const result = await submitAnalyticsRun({}, { activeTenantId: null }, 'aggregate', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'no_active_tenant');
  });
  test('isKnownAnalyticsRun recognizes exactly the three run kinds', () => {
    assert.equal(isKnownAnalyticsRun('aggregate'), true);
    assert.equal(isKnownAnalyticsRun('evaluate-alerts'), true);
    assert.equal(isKnownAnalyticsRun('run-due-reports'), true);
    assert.equal(isKnownAnalyticsRun('delete-everything'), false);
  });
});

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const API_BASE = 'https://mock.tenant.test';

describe('renderAnalyticsPage — full assembly against a mocked tenant', () => {
  let db, env, originalFetch;

  beforeEach(async () => {
    db = createTestDb(); applyMigrations(db);
    const kek = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    env = { LUMMET_DB: db, CREDENTIAL_KEK: kek };
    await env.LUMMET_DB.prepare(
      `INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, 'level.casino', 'level.casino', ?, 'active')`
    ).bind(TENANT_A, API_BASE).run();
    const { encryptedSecret, secretIv } = await encryptSecret(env, 'test-hmac-secret');
    await env.LUMMET_DB.prepare(
      `INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES (?, 'cred-1', ?, ?, 'active')`
    ).bind(TENANT_A, encryptedSecret, secretIv).run();

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, ...data }) });
      if (u.pathname === '/en/api/super/analytics-overview') {
        return ok({ dimension_type: 'casino', rows: [{ dimensionId: 7, name: 'Level Casino', currency: 'USD', views: 100, clicks: 10, conversions: 1, revenue: 50, commission: 10, ctr: 0.1, cvr: 0.1, epc: 5, rpc: 5, cpa: 10 }] });
      }
      if (u.pathname === '/en/api/super/analytics-revenue') return ok({ series: [{ date: '2026-01-15', views: 10, clicks: 2, conversions: 1, revenue: 5, commission: 1, ctr: 0.2, cvr: 0.5 }] });
      if (u.pathname === '/en/api/super/analytics-geo') return ok({ rows: [{ country: 'GB', clicks: 4, conversions: 1, revenue: 20, commission: 4, cvr: 0.25, epc: 5 }] });
      if (u.pathname === '/en/api/super/analytics-health') return ok({ jobs: [{ key: 'analytics_aggregation', label: 'Analytics Aggregation', status: 'ok', lastRunAt: '2026-01-15' }] });
      if (u.pathname === '/en/api/super/alerts') return ok({ data: [{ rule_name: 'High CPA', scope_type: 'tenant', created_at: '2026-01-15' }] });
      if (u.pathname === '/en/api/super/tracking-health') return ok({ counts: { healthy: 3 }, unhealthy_links: [] });
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'unhandled_mock_path: ' + u.pathname }) };
    };
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('assembles names, totals, GEO and alerts from every section into one page', async () => {
    const admin = { id: 1, role: 'super_admin', activeTenantId: TENANT_A };
    const html = await renderAnalyticsPage(env, admin, { start_date: '2026-01-01', end_date: '2026-01-31', dimension_type: 'casino' });
    assert.match(html, /Level Casino/);        // name, not bare id
    assert.match(html, /50\.00 USD/);           // formatted totals card
    assert.match(html, /10\.00%/);              // formatted CTR/CVR
    assert.match(html, />GB</);                 // GEO table
    assert.match(html, /High CPA/);              // open alerts
    assert.match(html, /Manage alerts/);          // link to the Alerts page
    assert.match(html, /Analytics Aggregation/);  // health section
  });

  test('a section the tenant has not redeployed for (404) degrades to a clear message, not a page crash', async () => {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/en/api/super/analytics-geo') return { ok: false, status: 404, json: async () => ({ success: false, error: 'not_found' }) };
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, ...data }) });
      if (u.pathname === '/en/api/super/analytics-overview') return ok({ rows: [] });
      if (u.pathname === '/en/api/super/analytics-revenue') return ok({ series: [] });
      if (u.pathname === '/en/api/super/analytics-health') return ok({ jobs: [] });
      if (u.pathname === '/en/api/super/alerts') return ok({ data: [] });
      if (u.pathname === '/en/api/super/tracking-health') return ok({ counts: {}, unhealthy_links: [] });
      return { ok: false, status: 404, json: async () => ({ success: false }) };
    };
    const admin = { id: 1, role: 'super_admin', activeTenantId: TENANT_A };
    const html = await renderAnalyticsPage(env, admin, {});
    assert.match(html, /redeployed with Super API v15/);
    assert.doesNotMatch(html, /undefined/);
  });
});
