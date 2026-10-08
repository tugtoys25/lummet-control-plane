// =====================================================
// AI READ EXECUTION
// Calls the tenant through the SAME client every dashboard
// screen uses (../client.js's getFromTenant) against the
// SAME Super API paths crud.js already calls -- no second
// tenant-communication path, no direct D1 access.
//
// Values returned here are passed through exactly as the
// tenant sent them. This module never rounds, summarizes,
// truncates, or reformats a field's actual value -- only
// which records/fields are included is filtered, per the
// rule that reads must preserve exact values.
// =====================================================

import { getFromTenant } from "../client.js";

const SUPER_API_BASE = "/en/api/super";

/**
 * Matches the tenant Super API's own path convention
 * (worker/super/router.js): resource key -> literal path
 * segment, no transformation. Kept as one function so a
 * future resource with a different path shape has a single
 * place to special-case, per resources.js's own convention.
 */
export function resourceListPath(resourceKey) {
  return `${SUPER_API_BASE}/${resourceKey}`;
}

export function resourceRecordPath(resourceKey, recordId) {
  return `${SUPER_API_BASE}/${resourceKey}/${encodeURIComponent(recordId)}`;
}

export function matchesFilter(record, key, rawValue) {
  if (!(key in record) && !(`${key}_id` in record) && !(`${key}_code` in record)) {
    // Unknown filter key on this resource -- don't silently drop
    // every row; the caller surfaces this as "filter not applied".
    return null;
  }
  const candidateKeys = [key, `${key}_id`, `${key}_code`].filter((k) => k in record);
  const needle = String(rawValue).toLowerCase();
  return candidateKeys.some((k) => {
    const v = record[k];
    if (v == null) return false;
    return String(v).toLowerCase().includes(needle);
  });
}

/**
 * Applies the intent's (server-unvalidated, best-effort) filters
 * client-side over a fetched list. This is deliberately simple and
 * literal -- substring match on stated fields only, never a fuzzy
 * or inferred match on a field the admin didn't name. Filter keys
 * the resource doesn't actually have are reported back, not
 * silently ignored, so the admin isn't misled into thinking an
 * unmatched filter narrowed the results.
 */
export function applyFilters(records, filters) {
  const entries = Object.entries(filters || {});
  if (entries.length === 0) return { records, unrecognizedFilters: [] };

  const unrecognizedFilters = [];
  let result = records;
  for (const [key, value] of entries) {
    const sample = records[0];
    if (sample && matchesFilter(sample, key, value) === null) {
      unrecognizedFilters.push(key);
      continue;
    }
    result = result.filter((r) => matchesFilter(r, key, value) === true);
  }
  return { records: result, unrecognizedFilters };
}

export function projectFields(record, requestedFields) {
  if (!requestedFields || requestedFields.length === 0) return record;
  const projected = {};
  for (const field of requestedFields) {
    if (field in record) projected[field] = record[field];
  }
  // Always keep the id field so the admin can tell which record this is.
  return projected;
}

/**
 * @returns {Promise<{ok:true, mode:'record'|'list', tenant, resourceKey,
 *   record?, records?, unrecognizedFilters?} | {ok:false, status, error, message}>}
 */
export async function executeRead(env, resolved, intent) {
  const { tenant, resourceKey } = resolved;

  if (intent.recordId) {
    const result = await getFromTenant(env, tenant, resourceRecordPath(resourceKey, intent.recordId));
    if (!result.ok) {
      return { ok: false, status: result.status, error: result.reason, message: result.message };
    }
    const record = result.data.data ?? result.data;
    return {
      ok: true,
      mode: "record",
      tenant: { id: tenant.id, name: tenant.name },
      resourceKey,
      record: projectFields(record, intent.requestedFields)
    };
  }

  const result = await getFromTenant(env, tenant, resourceListPath(resourceKey));
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.reason, message: result.message };
  }
  const rawRecords = Array.isArray(result.data.data) ? result.data.data : [];
  const { records: filtered, unrecognizedFilters } = applyFilters(rawRecords, intent.filters);
  const projected = filtered.map((r) => projectFields(r, intent.requestedFields));

  return {
    ok: true,
    mode: "list",
    tenant: { id: tenant.id, name: tenant.name },
    resourceKey,
    records: projected,
    totalBeforeFilters: rawRecords.length,
    unrecognizedFilters
  };
}
