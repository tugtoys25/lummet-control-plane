// =====================================================
// AI ACTION ENGINE
// The single place that decides, for one resolved intent,
// what actually happens. Phase 1 (this file, as shipped)
// only ever executes reads -- create/update/delete are
// fully resolved and permission-checked (so a wrong
// permission or an unsupported operation is reported
// correctly) but deliberately NOT executed, per the
// project's phased rollout. Phase 2 adds a `write.js` that
// this file's WRITE_OPERATIONS branch will call into,
// without changing anything about how READ_OPERATIONS or
// the dispatch itself works -- resolver.js/read.js are not
// replaced, only added to.
// =====================================================

import { resolveAction } from "./resolver.js";
import { executeRead } from "./read.js";
import { buildWritePreview } from "./write.js";
import { describeResource } from "./schema.js";
import { isKnownResource, listResourceKeys } from "./schema.js";

const WRITE_OPERATIONS = new Set(["create", "update", "delete"]);

export async function runAction(env, admin, intent, options = {}) {
  if (intent.clarificationNeeded) {
    return { ok: false, error: "clarification_needed", message: intent.clarificationNeeded };
  }

  if (intent.operation === "schema") {
    if (!intent.resource) {
      return { ok: true, kind: "schema_list", resources: listResourceKeys() };
    }
    if (!isKnownResource(intent.resource)) {
      return {
        ok: false,
        error: "unknown_resource",
        message: `"${intent.resource}" is not a resource this system manages.`,
        available: listResourceKeys()
      };
    }
    return { ok: true, kind: "schema", schema: describeResource(intent.resource) };
  }

  if (intent.operation === "unknown") {
    return {
      ok: false,
      error: "unrecognized_request",
      message: "I couldn't tell what you'd like to do. Try naming a resource (e.g. casinos, reviews, research) and whether you want to view, create, update, or delete."
    };
  }

  const resolved = await resolveAction(env, admin, intent);
  if (!resolved.ok) {
    return resolved; // already shaped as {ok:false, error, message, ...}
  }

  if (intent.operation === "read") {
    const result = await executeRead(env, resolved, intent);
    return { ...result, kind: "read" };
  }

  if (WRITE_OPERATIONS.has(intent.operation)) {
    // Resolution above already proved: tenant is authorized, resource
    // is real, the admin has the relevant permission, and (for
    // delete/create) the resource's own supportsDelete/supportsCreate
    // flags allow it. write.js only builds a preview + pending
    // operation here -- nothing is executed until a separate,
    // independently re-verified call to confirm.js.
    return await buildWritePreview(env, admin, resolved, intent, { conversationId: options.conversationId });
  }

  return { ok: false, error: "unsupported_operation", message: `"${intent.operation}" is not supported.` };
}
