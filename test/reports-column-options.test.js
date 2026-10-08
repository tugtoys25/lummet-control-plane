// test/reports-column-options.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchReportColumnOptions } from '../worker/views/pages/reports.js';

describe('fetchReportColumnOptions', () => {
  test('fails closed with no active tenant, no network involved', async () => {
    const result = await fetchReportColumnOptions({}, { activeTenantId: null }, 'casino_performance');
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'no_active_tenant');
  });
});
