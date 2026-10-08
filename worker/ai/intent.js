// =====================================================
// AI INTENT
// Turns one chat message into a structured, UNVALIDATED
// proposal of what the admin wants. Nothing here is
// trusted -- resolver.js re-checks every field against the
// real resource schema and the admin's real authorization
// before anything is read or written. This module's only
// job is "guess the shape", not "decide what's allowed".
//
// Model integration: reuses the SAME Workers AI binding
// (env.AI) and call shape the tenant repo already uses for
// its own understand.js (en/worker/ai/understand.js) --
// system+user chat messages, ask for raw JSON, strip code
// fences, parse leniently. No new AI provider/dependency is
// introduced. If env.AI is absent or the call fails, a
// deterministic keyword-based fallback runs instead of
// failing closed (same pattern as understand.js).
// =====================================================

import { listResourceKeys, buildSchemaPromptSection } from "./schema.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const OPERATIONS = ["read", "create", "update", "delete", "schema", "unknown"];

function systemPrompt(resourceKeys) {
  return `You are the intent parser for the Lummet Control Plane's AI management chat. An authorized platform administrator is asking to inspect or change tenant data.

Known resources and their fields (the ONLY resources/fields that exist -- never invent one):
${buildSchemaPromptSection()}

Respond with ONLY a raw JSON object, no markdown, no code fences, no explanation. Shape:
{"operation":"read|create|update|delete|schema|unknown","resource":"<one of: ${resourceKeys.join(", ")}, or null>","tenantHint":null,"recordId":null,"filters":{},"fields":{},"requestedFields":[],"clarificationNeeded":null}

Field meanings:
- operation: "read" for viewing/finding/listing records or their current values; "create"/"update"/"delete" for a requested change; "schema" if they're asking what fields/columns a resource has; "unknown" if you cannot tell.
- resource: the single resource key this request is about, or null if unclear or not about a specific resource.
- tenantHint: a tenant name/host the admin explicitly mentioned (e.g. "level.casino", "for Tenant B"), or null if they mean whatever tenant is currently active. This is only a HINT for the server to look up among tenants that admin can already access -- it is never used directly as an id.
- recordId: the specific record identifier mentioned (an id or slug), or null for a list/filter request.
- filters: a flat object of simple field:value filters mentioned (e.g. {"country":"Rwanda"} or {"status":"published"}). Keep this small and literal -- do not guess values that weren't stated.
- fields: for create/update requests only -- the exact field:value pairs the admin wants written, using the real field names listed above. Do not include a field the admin didn't mention. Never invent a value.
- requestedFields: for read requests where the admin asked about specific fields only (e.g. "show me the current rating") -- the field names, or [] to return the normal summary.
- For create/update requests, NEVER set clarificationNeeded just because fields are missing or unspecified: put whatever the admin stated in "fields" (even if empty) and the server will report exactly which required fields are missing.
- clarificationNeeded: a short question to ask the admin, ONLY if the request is genuinely too ambiguous to proceed (e.g. two different resources could match, or a record wasn't identified for an update). Otherwise null.

Never resolve or assume a tenant id, a database id, a permission decision, or a default value the admin didn't state. Those are the server's job, not yours.`;
}

function stripToJson(text) {
  if (typeof text !== "string") text = JSON.stringify(text ?? {});
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  const candidate = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const loosened = candidate
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/'([^']*)'/g, '"$1"');
    try {
      return JSON.parse(loosened);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Normalizes and safety-clamps whatever the model (or the fallback
 * parser) produced. This is still NOT authorization or schema
 * validation -- resolver.js does that against the real data. This
 * step only guarantees the shape is well-formed so the resolver
 * never has to null-check ad hoc.
 */
export function normalizeIntent(raw, resourceKeys) {
  const operation = OPERATIONS.includes(raw?.operation) ? raw.operation : "unknown";
  const resource =
    typeof raw?.resource === "string" && resourceKeys.includes(raw.resource) ? raw.resource : null;

  return {
    operation,
    resource,
    tenantHint: typeof raw?.tenantHint === "string" && raw.tenantHint.trim() ? raw.tenantHint.trim() : null,
    recordId:
      raw?.recordId === null || raw?.recordId === undefined || raw?.recordId === ""
        ? null
        : String(raw.recordId),
    filters: raw && typeof raw.filters === "object" && !Array.isArray(raw.filters) ? raw.filters : {},
    fields: raw && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields : {},
    requestedFields: Array.isArray(raw?.requestedFields)
      ? raw.requestedFields.filter((f) => typeof f === "string")
      : [],
    clarificationNeeded:
      typeof raw?.clarificationNeeded === "string" && raw.clarificationNeeded.trim()
        ? raw.clarificationNeeded.trim()
        : null
  };
}

export async function parseIntent(env, message, conversationHistory = []) {
  const resourceKeys = listResourceKeys();

  if (!env.AI) {
    return fallbackIntent(message, resourceKeys);
  }

  const historyStr =
    conversationHistory.length > 0
      ? conversationHistory
          .slice(-6)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : "No previous messages.";

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt(resourceKeys) },
        { role: "user", content: `Conversation so far:\n${historyStr}\n\nAdmin's new message: ${message}` }
      ],
      temperature: 0.1,
      max_tokens: 400
    });

    const text = result?.response || result?.choices?.[0]?.message?.content || result?.output?.text || "";
    const parsed = stripToJson(text);
    if (!parsed) return fallbackIntent(message, resourceKeys);

    return normalizeIntent(parsed, resourceKeys);
  } catch (_) {
    return fallbackIntent(message, resourceKeys);
  }
}

// -----------------------------------------------------
// Deterministic fallback -- used when env.AI is unavailable
// or the model's output couldn't be parsed. Covers the exact
// phrasing patterns from the brief's own examples so read
// requests still work without a model call.
// -----------------------------------------------------

const RESOURCE_ALIASES = {
  casino: "casinos",
  casinos: "casinos",
  review: "reviews",
  reviews: "reviews",
  article: "research",
  research: "research",
  news: "news",
  page: "pages",
  pages: "pages",
  category: "categories",
  categories: "categories",
  country: "countries",
  countries: "countries",
  author: "authors",
  authors: "authors",
  offer: "offers",
  offers: "offers",
  campaign: "campaigns",
  campaigns: "campaigns"
};

export function fallbackIntent(message, resourceKeys) {
  const text = String(message || "").toLowerCase();

  let resource = null;
  for (const [alias, key] of Object.entries(RESOURCE_ALIASES)) {
    if (resourceKeys.includes(key) && text.includes(alias)) {
      resource = key;
      break;
    }
  }

  let operation = "unknown";
  if (/\b(fields|columns|schema)\b/.test(text)) operation = "schema";
  else if (/\b(delete|remove|archive)\b/.test(text)) operation = "delete";
  else if (/\b(create|add|new)\b/.test(text)) operation = "create";
  else if (/\b(change|update|set|edit)\b/.test(text)) operation = "update";
  else if (/\b(show|find|get|list|what is|what's|current)\b/.test(text)) operation = "read";

  // "casino 123", "record 123", "id 123"
  const idMatch = text.match(/\b(?:casino|record|review|id|research)\s+#?([a-z0-9-]+)\b/i);
  const recordId = idMatch ? idMatch[1] : null;

  // "rating from 4.5 to 4.7", "rating to 4.7"
  const changeMatch = text.match(/\b([a-z_]+)\s+(?:from\s+[\d.]+\s+)?to\s+([\d.]+|"[^"]*"|'[^']*')\b/i);
  const fields = {};
  if (operation === "update" && changeMatch) {
    const [, fieldName, rawValue] = changeMatch;
    fields[fieldName] = rawValue.replace(/^["']|["']$/g, "");
  }

  // "in Rwanda" / "for <country>"
  const countryMatch = text.match(/\bin\s+([a-z][a-z\s]{2,})\b/i);
  const filters = countryMatch ? { country: countryMatch[1].trim() } : {};

  return {
    operation,
    resource,
    tenantHint: null,
    recordId,
    filters,
    fields,
    requestedFields: [],
    clarificationNeeded:
      operation === "unknown" || (!resource && operation !== "unknown")
        ? "Which resource is this about, and what would you like to do (view, create, update, or delete)?"
        : null
  };
}
