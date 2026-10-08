// =====================================================
// AI SCHEMA
// The AI's entire view of "what resources exist" comes
// from here, and only from here. It is a read-only lens
// over the SAME contracts the dashboard's generic CRUD
// screens already use (../resources.js) -- not a second,
// parallel resource list. If a resource or field isn't in
// RESOURCES, the AI cannot see it, resolve it, or write to
// it, no matter what the model outputs.
//
// Phase 1 covers tenant resources (resources.js) only --
// cms-resources.js (lummet.com's own CMS, not tenant data)
// is deliberately out of scope for now; see the discovery
// doc's "known limitations". Adding it later is additive:
// a second lookup table here, not a redesign.
// =====================================================

import { RESOURCES, getResourceConfig } from "../resources.js";

/** Every resource key the AI is allowed to know about. */
export function listResourceKeys() {
  return Object.keys(RESOURCES);
}

/** Same lookup the dashboard uses -- never a separate copy. */
export function getSchema(resourceKey) {
  return getResourceConfig(resourceKey);
}

export function isKnownResource(resourceKey) {
  return Object.prototype.hasOwnProperty.call(RESOURCES, resourceKey);
}

export function isKnownField(resourceKey, fieldName) {
  const config = getSchema(resourceKey);
  if (!config) return false;
  return config.fields.some((f) => f.name === fieldName);
}

export function getField(resourceKey, fieldName) {
  const config = getSchema(resourceKey);
  if (!config) return null;
  return config.fields.find((f) => f.name === fieldName) || null;
}

/**
 * A compact, deterministic text description of every resource for
 * the model's system prompt. Field lists are capped so the prompt
 * stays small even as RESOURCES grows -- the resolver re-validates
 * every field name against the real schema regardless of what the
 * prompt happened to mention, so truncation here is a token-budget
 * choice, not a security boundary.
 */
export function buildSchemaPromptSection(maxFieldsPerResource = 12) {
  const lines = [];
  for (const key of listResourceKeys()) {
    const config = RESOURCES[key];
    const fieldNames = config.fields.slice(0, maxFieldsPerResource).map((f) => f.name);
    const more = config.fields.length > maxFieldsPerResource ? ", ..." : "";
    lines.push(
      `- ${key} (idField: ${config.idField}, create: ${!!config.supportsCreate}, delete: ${!!config.supportsDelete}): ${fieldNames.join(", ")}${more}`
    );
  }
  return lines.join("\n");
}

/** Public, machine-readable form of one resource's schema -- what
 * "show me the fields for casinos" returns, and what the confirm
 * path re-validates proposed writes against. */
export function describeResource(resourceKey) {
  const config = getSchema(resourceKey);
  if (!config) return null;
  return {
    resource: resourceKey,
    label: config.label,
    idField: config.idField,
    supportsCreate: !!config.supportsCreate,
    supportsDelete: !!config.supportsDelete,
    fields: config.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      lockOnEdit: !!f.lockOnEdit
    })),
    listColumns: config.listColumns.map((c) => c.key)
  };
}
