// =====================================================
// AI FORM ADAPTER
// crud.js's submitCreate/submitUpdate/submitDelete (the
// SAME functions the human dashboard forms call) expect a
// "form" object shaped like what an HTML <form> submission
// produces: every value a string, checkboxes as "1"/"",
// lists as newline-joined text, JSON-ish fields as raw JSON
// text. The AI instead produces typed JS values (numbers,
// booleans, arrays, objects). This module is the ONLY place
// that bridges the two shapes, so the actual write path
// (crud.js) never needs to know or care that a request
// originated from the AI rather than a browser form post.
//
// submitUpdate() (crud.js) fetches the full current record
// and does `Object.assign(existingRecordFields, editedValues)`,
// but `editedValues` comes from coerceFormValues(config, form)
// which iterates EVERY field in config.fields -- a field
// missing from `form` coerces to null for most types. A form
// built from only the AI's changed fields would therefore
// silently null out every untouched field. buildMergedForm()
// exists specifically to prevent that: it fills in every
// field's CURRENT value (stringified back to form shape) and
// overlays only the fields actually being changed, so the
// round-trip through coerceFormValues reconstructs exactly
// the same "merged" object crud.js's own comment above
// submitUpdate says it must produce.
// =====================================================

export function validateProposedFields(config, proposedValues, { forUpdate }) {
  const realFieldNames = new Set(config.fields.map((f) => f.name));
  const unknownFields = [];
  const lockedFields = [];

  for (const name of Object.keys(proposedValues || {})) {
    if (!realFieldNames.has(name)) {
      unknownFields.push(name);
      continue;
    }
    if (forUpdate) {
      const field = config.fields.find((f) => f.name === name);
      if (field.lockOnEdit) lockedFields.push(name);
    }
  }

  return { ok: unknownFields.length === 0 && lockedFields.length === 0, unknownFields, lockedFields };
}

export function valueToFormString(field, value) {
  switch (field.type) {
    case "checkbox":
      if (typeof value === "string") {
        return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) ? "1" : "";
      }
      return value ? "1" : "";

    case "number":
      return value == null || value === "" ? "" : String(value);

    case "list":
      if (Array.isArray(value)) return value.join("\n");
      return value == null ? "" : String(value);

    case "json_object":
      if (typeof value === "string") return value;
      return JSON.stringify(value ?? {});

    case "json_raw":
      if (typeof value === "string") return value;
      return JSON.stringify(Array.isArray(value) ? value : value ?? []);

    case "media":
    case "resource_select":
      return value == null || value === "" ? "" : String(value);

    case "multi_select":
      if (Array.isArray(value)) return JSON.stringify(value);
      return value == null ? "[]" : JSON.stringify([value]);

    case "geo_rules":
    case "geo_destinations":
      return JSON.stringify(Array.isArray(value) ? value : []);

    case "richtext":
      return value == null ? "" : String(value);

    case "content_json_rich":
      // Best-effort: an object shaped { text: "<html>" } round-trips
      // as richtext (coerceFieldValue's own richtext-mode fallback
      // shape); anything else goes through as raw JSON.
      if (value && typeof value === "object" && Object.keys(value).length === 1 && "text" in value) {
        return String(value.text ?? "");
      }
      return typeof value === "string" ? value : JSON.stringify(value ?? {});

    default: // "text", "select", "textarea"
      return value == null ? "" : String(value);
  }
}

/** For CREATE: only the fields the admin/AI actually specified are
 * included -- everything else is left for the tenant's own defaults,
 * exactly as an admin leaving a create-form field blank would be. */
export function buildProposedForm(config, proposedValues) {
  const form = {};
  for (const [name, value] of Object.entries(proposedValues || {})) {
    const field = config.fields.find((f) => f.name === name);
    if (!field) continue; // validateProposedFields should already have caught this
    form[field.name] = valueToFormString(field, value);
    if (field.type === "content_json_rich") {
      form[`${field.name}__mode`] = value && typeof value === "object" && !("text" in value) ? "json" : "richtext";
    }
  }
  return form;
}

/** For UPDATE: every field gets a value -- the record's current
 * value for anything not being changed, the proposed value for
 * anything that is -- so round-tripping through crud.js's
 * coerceFormValues reconstructs the full merged record, never a
 * partial one with untouched fields nulled out. */
export function buildMergedForm(config, currentRecord, proposedValues) {
  const form = {};
  for (const field of config.fields) {
    const isChanging = Object.prototype.hasOwnProperty.call(proposedValues || {}, field.name);
    const value = isChanging ? proposedValues[field.name] : currentRecord?.[field.name];
    form[field.name] = valueToFormString(field, value);
    if (field.type === "content_json_rich") {
      form[`${field.name}__mode`] = value && typeof value === "object" && !("text" in value) ? "json" : "richtext";
    }
  }
  return form;
}
