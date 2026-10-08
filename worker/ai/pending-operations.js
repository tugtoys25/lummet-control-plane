// =====================================================
// AI PENDING OPERATIONS
// D1-backed (not in-memory) so a preview survives a reload
// between "here's what will change" and the admin pressing
// confirm. Short-lived by design (see DEFAULT_TTL_MS) --
// this is not a write queue, just that one gap.
// =====================================================

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The hash that ties a preview to exactly the operation it showed.
 * Anything that would change what gets executed (tenant, resource,
 * operation, record, or any proposed value) changes this hash, so a
 * stale or substituted confirm can never silently execute something
 * different from what the admin was shown.
 */
export function computePayloadHash({ tenantId, resourceKey, operation, recordId, proposedValues }) {
  return sha256Hex(
    stableStringify({ tenantId, resourceKey, operation, recordId: recordId ?? null, proposedValues })
  );
}

export async function createPendingOperation(env, params) {
  const {
    adminId,
    conversationId = null,
    tenantId,
    resourceKey,
    operation,
    recordId = null,
    currentValues = null,
    proposedValues,
    ttlMs = DEFAULT_TTL_MS
  } = params;

  const id = crypto.randomUUID();
  const payloadHash = await computePayloadHash({ tenantId, resourceKey, operation, recordId, proposedValues });
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_ai_pending_operations
      (id, admin_id, conversation_id, tenant_id, resource, operation, record_id, current_values, proposed_values, payload_hash, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      adminId,
      conversationId,
      tenantId,
      resourceKey,
      operation,
      recordId,
      currentValues != null ? JSON.stringify(currentValues) : null,
      JSON.stringify(proposedValues),
      payloadHash,
      expiresAt
    )
    .run();

  return { id, payloadHash, expiresAt };
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    currentValues: row.current_values ? JSON.parse(row.current_values) : null,
    proposedValues: JSON.parse(row.proposed_values)
  };
}

export async function getPendingOperation(env, id) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_ai_pending_operations WHERE id = ?`)
    .bind(id)
    .first();
  return parseRow(row);
}

/** Ownership-checked fetch -- never returns another admin's pending write. */
export async function getOwnedPendingOperation(env, admin, id) {
  const op = await getPendingOperation(env, id);
  if (!op) return null;
  if (op.admin_id !== admin.id) return null;
  return op;
}

export function isExpired(op) {
  return new Date(op.expires_at).getTime() <= Date.now();
}

export async function markStatus(env, id, status, result = null) {
  await env.LUMMET_DB.prepare(
    `UPDATE lummet_ai_pending_operations
     SET status = ?, result = ?, executed_at = CASE WHEN ? = 'executed' THEN CURRENT_TIMESTAMP ELSE executed_at END
     WHERE id = ?`
  )
    .bind(status, result != null ? JSON.stringify(result) : null, status, id)
    .run();
}
