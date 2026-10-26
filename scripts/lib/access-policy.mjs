// Pure helpers for the Cloudflare Access config (no network, no env access). Used by the check script and the tests.
import { readFileSync } from "node:fs";

export const CONFIG_URL = new URL("../../config/cloudflare-access-policy.v1.json", import.meta.url);
export const loadConfig = () => JSON.parse(readFileSync(CONFIG_URL, "utf8"));

const SAFE_PATTERN = /^\/[A-Za-z0-9/_.\-]*(\*)?$/;
const stem = (value) => String(value).replace(/\*$/, "");

/** True when a protected path pattern and a never-protect path (exact or prefix ending in /) can cover the same URL. */
export function overlaps(pattern, never) {
  const a = stem(pattern), b = stem(never);
  return a.startsWith(b) || b.startsWith(a);
}

/** Every string value in the config that still carries an [OPEN marker, as "path: text". */
export function openPlaceholders(node, trail = "") {
  if (typeof node === "string") return node.includes("[OPEN") ? [`${trail}: ${node}`] : [];
  if (Array.isArray(node)) return node.flatMap((value, index) => openPlaceholders(value, `${trail}[${index}]`));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([key, value]) => openPlaceholders(value, trail ? `${trail}.${key}` : key));
  return [];
}

/** Structural checks on the config file itself. Returns a list of problems. */
export function validateConfig(config) {
  const errors = [];
  if (!config || config.version !== 1) errors.push("version must be 1");
  if (config?.denyByDefault !== true) errors.push("denyByDefault must be true");
  if (config?.application?.type !== "self_hosted") errors.push("application.type must be self_hosted");
  const paths = config?.protectedPaths;
  if (!Array.isArray(paths) || paths.length !== 2 || !paths.includes("/platform/*") || !paths.includes("/api/platform/*")) errors.push("protectedPaths must be exactly /platform/* and /api/platform/*");
  for (const path of paths || []) {
    if (typeof path !== "string" || !SAFE_PATTERN.test(path)) errors.push(`unsafe protected path: ${path}`);
    for (const never of config?.neverProtect || []) if (overlaps(path, never)) errors.push(`${path} would cover ${never}, which cannot complete an Access login`);
  }
  if (!Array.isArray(config?.neverProtect) || !config.neverProtect.includes("/api/ci/") || !config.neverProtect.includes("/api/billing/webhook/stripe")) errors.push("neverProtect must keep /api/ci/ and /api/billing/webhook/stripe");
  const policies = config?.allowPolicies;
  if (!Array.isArray(policies) || !policies.length) errors.push("allowPolicies must not be empty");
  for (const policy of policies || []) {
    if (policy.decision !== "allow") errors.push(`policy ${policy.name}: only allow policies are expressed here (deny by default covers the rest)`);
    if (policy.requireMfaAtIdp !== true) errors.push(`policy ${policy.name}: requireMfaAtIdp must be true`);
  }
  return errors;
}

/** What the owner would create in Cloudflare, with the Worker settings that must match it. Placeholders stay visible. */
export function renderPlan(config, env = {}) {
  const hostname = config.application.hostname;
  return {
    application: { name: config.application.name, type: config.application.type, sessionDuration: config.application.sessionDuration, destinations: config.protectedPaths.map((path) => `${hostname}${path}`) },
    identityProvider: config.identityProvider,
    policies: config.allowPolicies,
    workerSettings: { PLATFORM_ACCESS_JWT_MODE: "shadow first, then enforce", CF_ACCESS_ISSUER: env.CF_ACCESS_ISSUER || config.application.teamDomain, CF_ACCESS_AUD: env.CF_ACCESS_AUD ? "(set)" : config.application.audienceTag }
  };
}
