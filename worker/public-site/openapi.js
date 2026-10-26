// OpenAPI 3.1 description of the PUBLIC API: the API-key endpoints under /api/v1/ (worker/index.js), plus the signing
// format of outgoing customer webhooks (worker/webhooks.js). Staff, session-cookie, Stripe and Resend routes are not
// part of the public API and are deliberately not listed. test/openapi-docs.test.js cross-checks this file against the
// worker source (routes, scopes) and the webhook module (event types, header names), so it cannot drift silently.

export const API_V1_SCOPES = ["sites:read", "domains:read", "analytics:read", "usage:read"];
export const WEBHOOK_EVENT_TYPES = ["site.created", "site.provisioned", "site.deployed", "site.failed", "domain.verified", "subscription.changed", "payment.failed"];

const jsonBody = (schemaRef) => ({ "application/json": { schema: { $ref: schemaRef } } });
const err = (description) => ({ description, content: jsonBody("#/components/schemas/Error") });
const SITE_ID = { name: "siteId", in: "path", required: true, schema: { type: "string" }, description: "Site id." };

function operation({ id, summary, scope, description, parameters = [], okSchema = "#/components/schemas/DataEnvelope", site = false }) {
  const responses = {
    "200": { description: "Success.", content: jsonBody(okSchema) },
    "401": err("Missing, malformed, revoked or expired API key."),
    "403": err(`The key does not carry the ${scope} scope.`),
    "429": { description: "Too many invalid keys from this address. Retry after the interval in Retry-After.", headers: { "Retry-After": { schema: { type: "integer", minimum: 1 }, description: "Seconds to wait." } }, content: jsonBody("#/components/schemas/Error") },
    "402": err("The organization's billing state currently blocks API access (error billing_access_restricted, with a reasonCode).")
  };
  if (site) responses["404"] = err("The site does not exist, belongs to another organization, or is outside this key's site restriction.");
  return { operationId: id, summary, description, tags: ["API v1"], security: [{ apiKey: [scope] }], parameters, responses };
}

export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Lummet public API",
      version: "1",
      description: "Read-only, API-key authenticated endpoints under /api/v1/. Routes not listed here are not public API. No rate-limit quota is promised beyond the invalid-key protection described on 429."
    },
    servers: [{ url: "/", description: "The Lummet origin you are calling." }],
    tags: [{ name: "API v1" }],
    paths: {
      "/api/v1/sites": { get: operation({ id: "listSites", summary: "List the organization's sites", scope: "sites:read", description: "A key restricted to one site sees only that site." }) },
      "/api/v1/sites/{siteId}": { get: operation({ id: "getSite", summary: "Get one site", scope: "sites:read", parameters: [SITE_ID], site: true }) },
      "/api/v1/sites/{siteId}/domains": { get: operation({ id: "listSiteDomains", summary: "List a site's domains", scope: "domains:read", parameters: [SITE_ID], site: true }) },
      "/api/v1/sites/{siteId}/domain-zones": { get: operation({ id: "listSiteDomainZones", summary: "List a site's DNS zones and hostnames", scope: "domains:read", parameters: [SITE_ID], site: true }) },
      "/api/v1/sites/{siteId}/analytics/overview": {
        get: operation({
          id: "getSiteAnalyticsOverview", summary: "Analytics overview for a site", scope: "analytics:read", site: true,
          description: "The response body is the analytics result object itself, not wrapped in the data envelope. Error bodies use error, reasonCode and message.",
          okSchema: "#/components/schemas/Free",
          parameters: [SITE_ID,
            { name: "start_date", in: "query", required: false, schema: { type: "string" } },
            { name: "end_date", in: "query", required: false, schema: { type: "string" } },
            { name: "dimension_type", in: "query", required: false, schema: { type: "string" } },
            { name: "currency", in: "query", required: false, schema: { type: "string" } }]
        })
      },
      "/api/v1/usage": { get: operation({ id: "getUsage", summary: "Usage snapshot for the organization", scope: "usage:read" }) }
    },
    webhooks: {
      lummetDelivery: {
        post: {
          operationId: "receiveLummetWebhook",
          summary: "Outgoing webhook delivery (implemented by the receiver)",
          description: "Lummet POSTs JSON to the endpoint you registered. Verify before trusting: compute HMAC-SHA256 keyed with the endpoint secret over the exact string `{t}.{raw request body}`, hex-encode it, and compare with `v1` in constant time. Reject timestamps outside a replay window you choose. Every retry is re-signed with a fresh timestamp and carries the same Lummet-Delivery-Id, so use that id to ignore duplicates. Respond 2xx to acknowledge; 410 ends deliveries to that endpoint permanently.",
          tags: ["Webhooks"],
          parameters: [
            { name: "Lummet-Signature", in: "header", required: true, schema: { type: "string", pattern: "^t=\\d+,v1=[0-9a-f]{64}$" }, description: "t=<unix seconds>,v1=<hex HMAC-SHA256>." },
            { name: "Lummet-Delivery-Id", in: "header", required: true, schema: { type: "string" } },
            { name: "Lummet-Delivery-Attempt", in: "header", required: true, schema: { type: "integer", minimum: 1 } }
          ],
          requestBody: { required: true, content: jsonBody("#/components/schemas/WebhookEvent") },
          responses: { "2XX": { description: "Acknowledged." }, "410": { description: "Endpoint is gone; Lummet stops delivering to it." } }
        }
      }
    },
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "Customer API key created by an organization owner. Scopes: " + API_V1_SCOPES.join(", ") + "." } },
      schemas: {
        Error: { type: "object", required: ["success", "error"], properties: { success: { type: "boolean", const: false }, error: { type: "string" }, reasonCode: { type: "string" }, message: { type: "string" } }, additionalProperties: true },
        DataEnvelope: { type: "object", required: ["success", "data"], properties: { success: { type: "boolean", const: true }, data: {} }, additionalProperties: true },
        Free: { type: "object", additionalProperties: true },
        WebhookEvent: { type: "object", description: "Event payload as sent; never contains secrets. id is the delivery id (also sent as Lummet-Delivery-Id).", required: ["id", "type", "created", "data"], properties: { id: { type: "string" }, type: { type: "string", enum: WEBHOOK_EVENT_TYPES }, created: { type: "integer", description: "Unix seconds when the event was created." }, data: { type: "object", additionalProperties: true } }, additionalProperties: false }
      }
    }
  };
}
