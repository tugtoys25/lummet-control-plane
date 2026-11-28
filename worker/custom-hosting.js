// =====================================================
// CUSTOMER-OWNED CLOUDFLARE HOSTING (optional, off by default)
//
// A site normally runs in Lummet's Cloudflare account, on a platform domain. With this feature an allowed customer can
// instead run a site in THEIR OWN Cloudflare account, on <worker>.<their-subdomain>.workers.dev or on a hostname in one of
// their own zones. Nothing about a Lummet-hosted site changes: a site with no row in site_custom_hosting goes through
// exactly the code paths it always did, and every hook below returns early for it.
//
// How it plugs into the existing machinery (no second deployment pipeline):
//   * cloudflareEnvFor()       a copy of env whose CF_API_TOKEN / CF_ACCOUNT_ID are the customer's. Every infra-cloudflare
//                              function already takes env first, so provisioning, deployments, teardown, tenant admin and
//                              erasure call the same functions with this scoped env for a custom-hosted site.
//   * hostFor()                the site's address (custom hostname or workers.dev) used by resolveResourceNames.
//   * adaptBindings()          the platform's own Turnstile and email secrets are never shipped into a customer's account; the
//                              site gets its own Turnstile widget (created in the customer's account), the customer's email key
//                              if they saved one, their R2 S3 keys and their custom variables.
//   * applyRouting()           instead of a route on a platform zone: workers.dev for the script, plus a Workers Custom Domain
//                              on the customer's zone when the site lands on its own hostname.
//
// Access: the platform setting CUSTOM_HOSTING must be on, and the organization must be allowed by staff or have the plan
// entitlement hosting.custom_cloudflare.enabled (a staff deny wins). Switching access off only stops NEW sites, new accounts
// and moves: sites already running in a customer's account keep deploying, rolling out and being managed.
//
// Secrets (API token, R2 secret key, email key, Turnstile secret, secret variables) are encrypted with CREDENTIAL_KEK in
// custom_hosting_secrets and are never returned by any API, written to a log, a job step or an audit entry.
// =====================================================
import * as repo from "./repositories/custom-hosting.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import { encryptSecret, decryptSecret, aadFor } from "./crypto.js";
import { checkEntitlement } from "./entitlements.js";
import * as announcements from "./announcements.js";

export const ENTITLEMENT_KEY = "hosting.custom_cloudflare.enabled";
export const SETTING_KEY = "CUSTOM_HOSTING";
export const CUSTOM_OPTION = "__custom__";               // the create-form dropdown value for "Custom Cloudflare hosting"
const SECRETS_TABLE = "custom_hosting_secrets";
const MAX_ACCOUNTS = 25;
const MAX_VARS = 50;

/** Capabilities a site needs from the token, why, and whether a deploy cannot work without them. */
export const CAPABILITIES = [
  { key: "workers_scripts", label: "Workers Scripts: Edit", required: true, why: "uploads the site's Worker, its secrets, bindings and cron schedule" },
  { key: "d1", label: "D1: Edit", required: true, why: "creates the site's database and runs its migrations on every release" },
  { key: "kv", label: "Workers KV Storage: Edit", required: true, why: "creates the site's cache namespace" },
  { key: "r2", label: "Workers R2 Storage: Edit", required: true, why: "creates the site's media bucket (R2 must be enabled on the account)" },
  { key: "workers_subdomain", label: "Workers Scripts: Edit (subdomain)", required: true, why: "serves the site on workers.dev and is used for health checks" },
  { key: "turnstile", label: "Turnstile: Edit", required: false, why: "creates the site's own Turnstile widget for its sign-in pages (without it the site relies on its attempt limiter)" },
  { key: "zones", label: "Zone: Read, DNS: Edit, Workers Routes: Edit", required: false, why: "lists your domains and attaches the site to a hostname in one of them (only for sites on your own domain)" }
];

// Names the platform sets on every site Worker: a custom variable may not replace them.
const RESERVED_VARS = new Set(["DB", "CACHE", "MEDIA_BUCKET", "PRIVATE_FILES", "AI", "ASSETS", "SITE_URL", "DEPLOYMENT_ID", "SUPER_API_CREDENTIAL_ID",
  "SUPER_API_SECRET", "TURNSTILE_SITEKEY", "TURNSTILE_SECRET", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "RESEND_FROM_EMAIL",
  "EMAIL_FROM", "APP_ENV", "LOG_LEVEL", "PUBLIC_BASE_URL", "ADMIN_BOOTSTRAP_TOKEN", "IP_HASH_SECRET", "OTP_ENCRYPTION_KEY", "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT", "R2_BUCKET_NAME", "LUMMET_HOSTING"]);

export class HostingError extends Error {
  constructor(code, message, status = 409) { super(message || code); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------- access

export function featureOn(env) { return String(env?.[SETTING_KEY] || "off").toLowerCase() === "on"; }

/**
 * What this organization may do. enabled = may add accounts, create custom-hosted sites and move sites. inUse = it already has
 * accounts or custom-hosted sites, which it can always see and manage (rotate a token, change a domain, delete) even when
 * access is later switched off.
 */
export async function accessFor(env, organizationId) {
  const globalOn = featureOn(env);
  const row = organizationId ? await repo.getOrgAccess(env, organizationId).catch(() => null) : null;
  const override = row?.mode || null;
  let entitled = false;
  if (globalOn && override !== "deny" && override !== "allow" && organizationId) {
    try { entitled = (await checkEntitlement(env, organizationId, ENTITLEMENT_KEY)) === true; } catch (_) { entitled = false; }
  }
  const enabled = globalOn && override !== "deny" && (override === "allow" || entitled);
  const accounts = organizationId ? await repo.countAccounts(env, organizationId).catch(() => 0) : 0;
  const sites = organizationId && accounts ? (await repo.listSiteHostingForOrg(env, organizationId).catch(() => [])).length : 0;
  const reason = enabled ? null : !globalOn ? "feature_off" : override === "deny" ? "organization_denied" : "not_in_plan";
  return { enabled, globalOn, override, entitled, inUse: accounts > 0 || sites > 0, accounts, sites, reason };
}

async function requireEnabled(env, organizationId) {
  const a = await accessFor(env, organizationId);
  if (!a.enabled) throw new HostingError("custom_hosting_not_available", "Custom Cloudflare hosting is not available for this organization.", 403);
  return a;
}

// ---------------------------------------------------------------- secrets

const hintOf = (v) => { const s = String(v || ""); return s.length > 8 ? `…${s.slice(-4)}` : "…"; };

async function writeSecret(env, { organizationId, ownerType, ownerId, name, value, isSecret = true }) {
  const existing = await repo.getSecretRow(env, ownerType, ownerId, name);
  const id = existing?.id || crypto.randomUUID();
  const enc = await encryptSecret(env, String(value), aadFor(SECRETS_TABLE, id, "encrypted_secret"));
  await repo.upsertSecretRow(env, { id, organizationId, ownerType, ownerId, name, isSecret, encryptedSecret: enc.encryptedSecret, secretIv: enc.secretIv, hint: isSecret ? hintOf(value) : null });
}

async function readSecretRow(env, row) {
  if (!row) return null;
  return decryptSecret(env, row.encrypted_secret, row.secret_iv, aadFor(SECRETS_TABLE, row.id, "encrypted_secret"));
}
async function readSecret(env, ownerType, ownerId, name) { return readSecretRow(env, await repo.getSecretRow(env, ownerType, ownerId, name)); }

// ---------------------------------------------------------------- validation

const CF_ID = /^[a-f0-9]{32}$/i;
const TOKEN = /^[A-Za-z0-9_\-.]{30,200}$/;
const R2_KEY_ID = /^[a-f0-9]{32}$/i;
const R2_SECRET = /^[a-f0-9]{64}$/i;
const EMAIL = /^[^\s@<>]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function clean(v, max = 500) { return v === undefined || v === null ? "" : String(v).trim().slice(0, max); }

function validateAccountInput(input, { partial = false } = {}) {
  const out = {};
  const errors = [];
  if (!partial || input.label !== undefined) {
    const label = clean(input.label, 80);
    if (!label) errors.push("label_required"); else out.label = label;
  }
  if (!partial || input.accountId !== undefined) {
    const id = clean(input.accountId, 64).toLowerCase();
    if (!CF_ID.test(id)) errors.push("invalid_account_id"); else out.cfAccountId = id;
  }
  if (!partial || input.apiToken !== undefined) {
    const t = clean(input.apiToken, 400);
    if (!(partial && !t)) { if (!TOKEN.test(t)) errors.push("invalid_api_token"); else out.apiToken = t; }
  }
  const keyId = input.r2AccessKeyId !== undefined ? clean(input.r2AccessKeyId, 64) : undefined;
  const keySecret = input.r2SecretAccessKey !== undefined ? clean(input.r2SecretAccessKey, 128) : undefined;
  if (keyId || keySecret) {
    if (keyId && !R2_KEY_ID.test(keyId)) errors.push("invalid_r2_access_key_id");
    if (keySecret && !R2_SECRET.test(keySecret)) errors.push("invalid_r2_secret_access_key");
    if (!partial && (!keyId || !keySecret)) errors.push("r2_keys_need_both");
    if (keyId) out.r2AccessKeyId = keyId;
    if (keySecret) out.r2SecretAccessKey = keySecret;
  }
  if (input.r2Jurisdiction !== undefined) {
    const j = clean(input.r2Jurisdiction, 16) || "default";
    if (!["default", "eu", "fedramp"].includes(j)) errors.push("invalid_r2_jurisdiction"); else out.r2Jurisdiction = j;
  }
  const emailKey = input.emailApiKey !== undefined ? clean(input.emailApiKey, 300) : undefined;
  const emailFrom = input.emailFrom !== undefined ? clean(input.emailFrom, 254) : undefined;
  if (emailFrom) { if (!EMAIL.test(emailFrom)) errors.push("invalid_email_from"); else out.emailFrom = emailFrom; }
  if (emailKey) { if (emailKey.length < 10) errors.push("invalid_email_api_key"); else out.emailApiKey = emailKey; }
  if (!partial && (!!emailKey !== !!emailFrom)) errors.push("email_needs_key_and_sender");
  return { ok: !errors.length, errors, value: out };
}

// ---------------------------------------------------------------- safe views (never a secret)

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; } }

export function accountView(row, secretRows = []) {
  const has = (n) => secretRows.some((r) => r.name === n);
  const permissions = parseJson(row.permissions, []);
  return {
    id: row.id, label: row.label, accountId: row.cf_account_id, accountName: row.cf_account_name || null,
    tokenHint: row.token_hint || null, status: row.status, workersSubdomain: row.workers_subdomain || null,
    r2AccessKeyId: row.r2_access_key_id ? `${row.r2_access_key_id.slice(0, 4)}…${row.r2_access_key_id.slice(-4)}` : null,
    r2SecretSaved: has("r2_secret_access_key"), r2Jurisdiction: row.r2_jurisdiction || "default",
    emailFrom: row.email_from || null, emailKeySaved: has("email_api_key"),
    permissions: CAPABILITIES.map((c) => ({ ...c, ...(permissions.find((p) => p.key === c.key) || { ok: null }) })).map(({ message, ...p }) => p),
    lastVerifiedAt: row.last_verified_at || null, lastError: row.last_error || null,
    siteCount: row.site_count ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export async function listAccounts(env, organizationId) {
  const rows = await repo.listAccounts(env, organizationId);
  const out = [];
  for (const r of rows) out.push(accountView(r, await repo.listSecretRows(env, "account", r.id)));
  return out;
}

export async function getAccountView(env, organizationId, id) {
  const row = await repo.getAccount(env, organizationId, id);
  if (!row) return null;
  return { ...accountView(row, await repo.listSecretRows(env, "account", row.id)), sites: await repo.sitesUsingAccount(env, row.id) };
}

// ---------------------------------------------------------------- scoped Cloudflare env

/** env with the customer's account in place of Lummet's. Only infra-cloudflare reads these keys. */
export function cloudflareEnvFor(env, account, token) {
  return {
    ...env,
    CF_API_TOKEN: token,
    CF_ACCOUNT_ID: account.cf_account_id,
    CF_ZONE_ID: "",                                        // never fall back to a platform zone
    CF_WORKERS_DEV_SUBDOMAIN: account.workers_subdomain || "",
    LUMMET_HOSTING: "custom"
  };
}

async function accountEnv(env, account) {
  const token = await readSecret(env, "account", account.id, "api_token");
  if (!token) throw new HostingError("custom_hosting_unavailable", "The Cloudflare account has no saved API token.");
  return cloudflareEnvFor(env, account, token);
}

const workersDevHostFor = (workerName, subdomain) => (subdomain ? `${workerName}.${subdomain}.workers.dev` : null);

/**
 * The hosting context of a site, or null for a Lummet-hosted site (and for one still being moved: until the switch the site
 * keeps running on Lummet). Throws HostingError("custom_hosting_unavailable") when its account is gone or has no token.
 */
export async function contextForSite(env, siteOrId, { includeTransferring = false } = {}) {
  const siteId = typeof siteOrId === "string" ? siteOrId : siteOrId?.id;
  if (!siteId || !env?.LUMMET_DB) return null;
  const hosting = await repo.getSiteHosting(env, siteId).catch(() => null);
  if (!hosting) return null;
  if (hosting.status === "transferring" && !includeTransferring) return null;
  const account = await repo.getAccountById(env, hosting.account_ref);
  if (!account || account.organization_id !== hosting.organization_id) throw new HostingError("custom_hosting_unavailable", "The Cloudflare account this site runs on was removed.");
  if (account.status === "disabled") throw new HostingError("custom_hosting_unavailable", "The Cloudflare account this site runs on is disabled.");
  const cfEnv = await accountEnv(env, account);
  return buildContext(hosting, account, cfEnv);
}

function buildContext(hosting, account, cfEnv) {
  return {
    siteId: hosting.site_id, hosting, account, cfEnv,
    host(workerName) {
      if (hosting.landing === "custom_domain" && hosting.hostname) return hosting.hostname;
      return workersDevHostFor(workerName, account.workers_subdomain);
    },
    workersDevHost: (workerName) => workersDevHostFor(workerName, account.workers_subdomain)
  };
}

/** True when the site runs (or is being moved) into a customer's account. Cheap: one indexed read. */
export async function isCustomHosted(env, siteId) {
  return !!(await repo.getSiteHosting(env, siteId).catch(() => null));
}

/** For provisioning and deployments: the host override, or null (= the platform host, unchanged). */
export async function hostOverride(env, site, workerName) {
  const hosting = await repo.getSiteHosting(env, site.id).catch(() => null);
  if (!hosting || hosting.status === "transferring") return null;
  if (hosting.landing === "custom_domain" && hosting.hostname) return hosting.hostname;
  const account = await repo.getAccountById(env, hosting.account_ref);
  return workersDevHostFor(workerName, account?.workers_subdomain) || null;
}

/** env for infra calls about a site: the customer's account for a custom-hosted site, Lummet's (unchanged) otherwise. */
export async function cloudflareEnvForSite(env, siteId) {
  const ctx = await contextForSite(env, siteId);
  return ctx ? ctx.cfEnv : env;
}

/** A deploy refusal for this site, or null. Lets rollouts skip a site whose customer account is unusable. */
export async function deployBlock(env, site) {
  const hosting = await repo.getSiteHosting(env, site.id).catch(() => null);
  if (!hosting) return null;
  if (hosting.status === "transferring") {
    const open = await repo.openTransferForSite(env, site.id);
    if (open) return { error: "site_transfer_in_progress", message: "This site is being moved to your Cloudflare account; releases resume once the move finishes." };
    return null;
  }
  try { await contextForSite(env, site); return null; }
  catch (e) { return { error: "custom_hosting_unavailable", message: e.message }; }
}

// ---------------------------------------------------------------- accounts

/** Read-only checks of the token and what it may do, stored on the account row. Never creates anything. */
export async function verifyAccount(env, organizationId, id, { infra = cloudflareProvider } = {}) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const cfEnv = await accountEnv(env, account);
  const result = await probe(env, account, cfEnv, infra);
  return { ok: true, account: await getAccountView(env, organizationId, id), check: result };
}

async function probe(env, account, cfEnv, infra, { monitor = false } = {}) {
  const now = new Date().toISOString();
  let token;
  try { token = await infra.verifyApiToken(cfEnv); }
  catch (e) { token = { ok: false, status: "unreachable", error: String(e?.message || e).slice(0, 200) }; }
  // A scheduled re-check never turns a Cloudflare outage into "your token is bad": it records the attempt and tries again later.
  if (!token.ok && monitor && token.status === "unreachable") {
    await repo.patchAccount(env, account.id, { health_checked_at: now });
    return { tokenOk: null, transient: true, permissions: [] };
  }
  if (!token.ok) {
    await repo.patchAccount(env, account.id, { status: "invalid", health_checked_at: now, last_verified_at: now, last_error: token.status === "unreachable" ? "Cloudflare could not be reached; try again." : "The API token is not valid or not active.", permissions: "[]" });
    return { tokenOk: false, tokenStatus: token.status, permissions: [] };
  }
  let name = account.cf_account_name || null;
  try { name = (await infra.getAccountDetails(cfEnv)).name || name; } catch (_) { /* a token without Account Settings: Read cannot read the name */ }
  const permissions = await infra.probeAccountPermissions(cfEnv);
  let subdomain = account.workers_subdomain || null;
  try { subdomain = (await infra.getWorkersSubdomain(cfEnv)) || null; } catch (_) { /* reported by the workers_subdomain probe */ }
  let r2Keys = null;
  if (account.r2_access_key_id) {
    const secret = await readSecret(env, "account", account.id, "r2_secret_access_key");
    if (secret) {
      const r = await infra.verifyR2S3Credentials(cfEnv, { accessKeyId: account.r2_access_key_id, secretAccessKey: secret, jurisdiction: account.r2_jurisdiction || "default" });
      r2Keys = { ok: !!r.ok, status: r.status };
      permissions.push({ key: "r2_s3_keys", ok: !!r.ok, code: r.ok ? null : r.status === 403 || r.status === 401 ? "forbidden" : "error" });
    }
  }
  const missing = CAPABILITIES.filter((c) => c.required && !permissions.find((p) => p.key === c.key && p.ok)).map((c) => c.key);
  if (!subdomain && !missing.includes("workers_subdomain")) missing.push("workers_subdomain_missing");
  const status = missing.length ? "invalid" : "verified";
  const r2Note = permissions.find((p) => p.key === "r2" && p.code === "r2_not_enabled") ? " R2 is not enabled on this account: open R2 in the Cloudflare dashboard and subscribe to R2 (the guide explains the R2 plan)." : "";
  const lastError = missing.length ? `Missing: ${missing.join(", ")}.${r2Note}` : null;
  await repo.patchAccount(env, account.id, {
    status, cf_account_name: name, workers_subdomain: subdomain, permissions: JSON.stringify(permissions.map(({ message, ...p }) => p)),
    last_verified_at: now, last_error: lastError, health_checked_at: now
  });
  return { tokenOk: true, permissions: permissions.map(({ message, ...p }) => p), missing, workersSubdomain: subdomain, r2Keys };
}

export async function addAccount(env, { organizationId, actorUserId, input, infra = cloudflareProvider }) {
  await requireEnabled(env, organizationId);
  const v = validateAccountInput(input || {});
  if (!v.ok) return { ok: false, status: 422, error: v.errors[0], errors: v.errors };
  if ((await repo.countAccounts(env, organizationId)) >= MAX_ACCOUNTS) return { ok: false, status: 409, error: "account_limit_reached" };
  if (await repo.findAccountByCfId(env, organizationId, v.value.cfAccountId)) return { ok: false, status: 409, error: "account_already_added" };

  // The token is checked BEFORE anything is stored: a typo is refused, nothing is half-saved.
  const probeEnv = cloudflareEnvFor(env, { cf_account_id: v.value.cfAccountId }, v.value.apiToken);
  let token;
  try { token = await infra.verifyApiToken(probeEnv); }
  catch (_) { return { ok: false, status: 502, error: "cloudflare_unreachable" }; }
  if (!token.ok) return { ok: false, status: 422, error: "token_invalid", message: "Cloudflare did not accept this API token for that account." };

  const id = crypto.randomUUID();
  await repo.insertAccount(env, { id, organizationId, label: v.value.label, cfAccountId: v.value.cfAccountId, tokenHint: hintOf(v.value.apiToken), r2AccessKeyId: v.value.r2AccessKeyId, r2Jurisdiction: v.value.r2Jurisdiction, emailFrom: v.value.emailFrom, createdBy: actorUserId });
  try {
    await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "api_token", value: v.value.apiToken });
    if (v.value.r2SecretAccessKey) await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "r2_secret_access_key", value: v.value.r2SecretAccessKey });
    if (v.value.emailApiKey) await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "email_api_key", value: v.value.emailApiKey });
  } catch (e) {
    await repo.deleteAccount(env, organizationId, id);           // never keep an account whose token could not be stored
    throw e;
  }
  const account = await repo.getAccount(env, organizationId, id);
  const check = await probe(env, account, cloudflareEnvFor(env, account, v.value.apiToken), infra);
  return { ok: true, status: 201, account: await getAccountView(env, organizationId, id), check };
}

/** Label, token rotation, R2 keys and email settings. Allowed even when access was switched off (existing sites keep working). */
export async function updateAccount(env, { organizationId, id, input, infra = cloudflareProvider }) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const v = validateAccountInput(input || {}, { partial: true });
  if (!v.ok) return { ok: false, status: 422, error: v.errors[0], errors: v.errors };
  if (v.value.cfAccountId && v.value.cfAccountId !== account.cf_account_id) return { ok: false, status: 422, error: "account_id_cannot_change" };
  if (v.value.apiToken) {
    const t = await infra.verifyApiToken(cloudflareEnvFor(env, account, v.value.apiToken)).catch(() => ({ ok: false }));
    if (!t.ok) return { ok: false, status: 422, error: "token_invalid" };
    await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "api_token", value: v.value.apiToken });
  }
  if (v.value.r2SecretAccessKey) await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "r2_secret_access_key", value: v.value.r2SecretAccessKey });
  if (v.value.emailApiKey) await writeSecret(env, { organizationId, ownerType: "account", ownerId: id, name: "email_api_key", value: v.value.emailApiKey });
  if (input.removeR2Keys === true) { await repo.deleteSecretRow(env, "account", id, "r2_secret_access_key"); await repo.patchAccount(env, id, { r2_access_key_id: null }); }
  if (input.removeEmail === true) { await repo.deleteSecretRow(env, "account", id, "email_api_key"); await repo.patchAccount(env, id, { email_from: null }); }
  const patch = {};
  if (v.value.label) patch.label = v.value.label;
  if (v.value.apiToken) patch.token_hint = hintOf(v.value.apiToken);
  if (v.value.r2AccessKeyId) patch.r2_access_key_id = v.value.r2AccessKeyId;
  if (v.value.r2Jurisdiction) patch.r2_jurisdiction = v.value.r2Jurisdiction;
  if (v.value.emailFrom) patch.email_from = v.value.emailFrom;
  await repo.patchAccount(env, id, patch);
  let check = null;
  if (v.value.apiToken || v.value.r2AccessKeyId || v.value.r2SecretAccessKey) check = await probe(env, await repo.getAccount(env, organizationId, id), await accountEnv(env, await repo.getAccount(env, organizationId, id)), infra);
  return { ok: true, account: await getAccountView(env, organizationId, id), check, redeployNeeded: !!(v.value.emailApiKey || v.value.emailFrom || v.value.r2AccessKeyId || input.removeEmail || input.removeR2Keys) };
}

export async function removeAccount(env, { organizationId, id }) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const using = await repo.sitesUsingAccount(env, id);
  if (using.length) return { ok: false, status: 409, error: "account_in_use", sites: using.map((s) => ({ id: s.id, name: s.name })) };
  await repo.deleteAccount(env, organizationId, id);
  return { ok: true };
}

/** Claims a workers.dev subdomain for an account that has none (Cloudflare allows one per account). */
export async function claimWorkersSubdomain(env, { organizationId, id, subdomain, infra = cloudflareProvider }) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const name = clean(subdomain, 63).toLowerCase();
  if (!LABEL.test(name)) return { ok: false, status: 422, error: "invalid_subdomain" };
  const cfEnv = await accountEnv(env, account);
  const existing = await infra.getWorkersSubdomain(cfEnv).catch(() => null);
  if (existing) { await repo.patchAccount(env, id, { workers_subdomain: existing }); return { ok: true, subdomain: existing, existed: true }; }
  try {
    const got = await infra.createWorkersSubdomain(cfEnv, { subdomain: name });
    await repo.patchAccount(env, id, { workers_subdomain: got });
    return { ok: true, subdomain: got };
  } catch (e) {
    return { ok: false, status: 409, error: "subdomain_unavailable", message: String(e?.message || "").slice(0, 200) };
  }
}

// ---------------------------------------------------------------- zones (the customer's own domains)

export async function listZones(env, { organizationId, id, infra = cloudflareProvider }) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const cfEnv = await accountEnv(env, account);
  try {
    const zones = await infra.listAccountZones(cfEnv);
    return { ok: true, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, active: z.status === "active", nameServers: z.status === "active" ? [] : z.nameServers, plan: z.plan })) };
  } catch (e) {
    return { ok: false, status: 502, error: e.httpStatus === 403 ? "zones_permission_missing" : "cloudflare_error", message: String(e?.message || "").slice(0, 200) };
  }
}

/** Adds a root domain to the customer's account (full setup). The customer then sets the two nameservers at their registrar. */
export async function addZone(env, { organizationId, id, domain, infra = cloudflareProvider }) {
  await requireEnabled(env, organizationId);
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  const name = clean(domain, 253).toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(name)) return { ok: false, status: 422, error: "invalid_domain" };
  const cfEnv = await accountEnv(env, account);
  try {
    const z = await infra.createZone(cfEnv, { name });
    return { ok: true, zone: { id: z.zoneId, name, status: z.cfStatus, active: z.status === "active", nameServers: z.nameServers } };
  } catch (e) {
    return { ok: false, status: 409, error: "domain_unavailable", message: String(e?.message || "").slice(0, 200) };
  }
}

export async function checkZone(env, { organizationId, id, zoneId, infra = cloudflareProvider }) {
  const account = await repo.getAccount(env, organizationId, id);
  if (!account) return { ok: false, status: 404, error: "account_not_found" };
  if (!CF_ID.test(String(zoneId || ""))) return { ok: false, status: 422, error: "invalid_zone_id" };
  const cfEnv = await accountEnv(env, account);
  const z = await infra.getZone(cfEnv, zoneId);
  if (z.status === "pending") { try { await infra.requestActivationCheck(cfEnv, zoneId); } catch (_) { /* rate limited: the next check will do */ } }
  return { ok: true, zone: { id: zoneId, status: z.cfStatus, active: z.status === "active", nameServers: z.nameServers } };
}

// ---------------------------------------------------------------- choosing hosting for a site

/**
 * Validates a hosting choice ({ accountId, landing, zoneId, subdomain }) for a NEW site or a move. Every check that can be done
 * before anything is written is done here: the account belongs to the organization and is verified, it has what this
 * deployment type needs (a workers.dev subdomain; for a custom domain an ACTIVE zone in that account the token may route on),
 * and the hostname is free. Returns { ok, plan } or a refusal.
 */
export async function planHosting(env, { organizationId, choice, infra = cloudflareProvider, exceptSiteId = null }) {
  await requireEnabled(env, organizationId);
  const c = choice || {};
  const account = c.accountId ? await repo.getAccount(env, organizationId, String(c.accountId)) : null;
  if (!account) return { ok: false, status: 422, error: "hosting_account_required", message: "Choose one of your saved Cloudflare accounts." };
  if (account.status !== "verified") return { ok: false, status: 422, error: "hosting_account_not_verified", message: "This Cloudflare account has not passed its permission check. Open Cloudflare hosting and check it again." };
  if (!account.workers_subdomain) return { ok: false, status: 422, error: "workers_subdomain_missing", message: "This Cloudflare account has no workers.dev subdomain yet. Claim one in Cloudflare hosting first." };
  const landing = c.landing === "custom_domain" ? "custom_domain" : "workers_dev";
  const plan = { accountRef: account.id, landing, hostname: null, zoneId: null, zoneName: null };
  if (landing === "custom_domain") {
    const zoneId = clean(c.zoneId, 64);
    if (!CF_ID.test(zoneId)) return { ok: false, status: 422, error: "hosting_zone_required", message: "Choose the domain the site should use." };
    const cfEnv = await accountEnv(env, account);
    let zones;
    try { zones = await infra.listAccountZones(cfEnv); } catch (e) { return { ok: false, status: 502, error: "zones_unavailable", message: String(e?.message || "").slice(0, 200) }; }
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return { ok: false, status: 422, error: "zone_not_in_account", message: "That domain is not in the chosen Cloudflare account." };
    if (zone.status !== "active") return { ok: false, status: 422, error: "zone_not_active", message: `${zone.name} is not active yet: set its nameservers at your registrar, then check it again.` };
    const sub = clean(c.subdomain, 63).toLowerCase();
    if (sub && !(sub === "*" ? false : sub.split(".").every((p) => LABEL.test(p)))) return { ok: false, status: 422, error: "invalid_subdomain" };
    const hostname = sub ? `${sub}.${zone.name}` : zone.name;
    if (!HOSTNAME.test(hostname)) return { ok: false, status: 422, error: "invalid_hostname" };
    if (await repo.hostnameTaken(env, hostname, exceptSiteId)) return { ok: false, status: 409, error: "hostname_taken", message: `${hostname} already serves another site.` };
    if (await repo.tenantHostTaken(env, hostname, null)) return { ok: false, status: 409, error: "hostname_taken", message: `${hostname} is already registered to a site.` };
    const access = await infra.probeZoneAccess(cfEnv, zoneId).catch(() => ({ ok: false, missing: ["zone"] }));
    if (!access.ok) return { ok: false, status: 422, error: "zone_permission_missing", message: `The API token may not attach Workers to ${zone.name} (missing: ${(access.missing || []).join(", ") || "zone access"}).` };
    Object.assign(plan, { hostname, zoneId, zoneName: zone.name });
  }
  return { ok: true, plan, account };
}

/** Records the hosting of a site created a moment ago (sites.createSite). */
export async function attachToNewSite(env, { siteId, organizationId, plan, workerName }) {
  await repo.insertSiteHosting(env, { siteId, organizationId, accountRef: plan.accountRef, status: "active", landing: plan.landing, hostname: plan.hostname, zoneId: plan.zoneId, zoneName: plan.zoneName });
  const account = await repo.getAccountById(env, plan.accountRef);
  const host = plan.hostname || workersDevHostFor(workerName, account?.workers_subdomain);
  if (host) await repo.setSitePrimaryDomain(env, siteId, host);
  return { host };
}

/** Undo for a create that could not finish (the hostname was taken between the check and the write). */
export async function rollbackNewSite(env, siteId) {
  await repo.deleteSiteHosting(env, siteId).catch(() => {});
  await repo.deletePendingSite(env, siteId).catch(() => {});
}

// ---------------------------------------------------------------- deploy hooks

/** Bindings for a site in a customer's account: no platform secret leaves Lummet's account; the site's own ones are added. */
export async function adaptBindings(infra, env, ctx, bindings, { line, host, workerName, r2BucketName }) {
  const drop = new Set(["TURNSTILE_SITEKEY", "TURNSTILE_SECRET", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "EMAIL_FROM"]);
  const out = bindings.filter((b) => !drop.has(b.name));
  const notes = {};
  const brokerage = line === "brokerage";

  const turnstile = await ensureTurnstile(infra, env, ctx, { host, workerName }).catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));
  if (turnstile?.sitekey && turnstile.secret) {
    out.push({ type: "plain_text", name: "TURNSTILE_SITEKEY", text: turnstile.sitekey }, { type: "secret_text", name: "TURNSTILE_SECRET", text: turnstile.secret });
    if (brokerage) out.push({ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: turnstile.sitekey }, { type: "secret_text", name: "TURNSTILE_SECRET_KEY", text: turnstile.secret });
    notes.turnstile = "site widget";
  } else notes.turnstile = turnstile?.error ? `not set: ${turnstile.error}` : "not set";

  const emailKey = await readSecret(env, "account", ctx.account.id, "email_api_key");
  if (emailKey && ctx.account.email_from) {
    out.push({ type: "secret_text", name: "RESEND_API_KEY", text: emailKey }, { type: "plain_text", name: "RESEND_FROM_EMAIL", text: ctx.account.email_from });
    if (brokerage) out.push({ type: "plain_text", name: "EMAIL_FROM", text: ctx.account.email_from });
    notes.email = "customer key";
  }

  const r2Secret = ctx.account.r2_access_key_id ? await readSecret(env, "account", ctx.account.id, "r2_secret_access_key") : null;
  if (r2Secret) {
    const j = ctx.account.r2_jurisdiction;
    out.push(
      { type: "plain_text", name: "R2_ACCOUNT_ID", text: ctx.account.cf_account_id },
      { type: "plain_text", name: "R2_ACCESS_KEY_ID", text: ctx.account.r2_access_key_id },
      { type: "secret_text", name: "R2_SECRET_ACCESS_KEY", text: r2Secret },
      { type: "plain_text", name: "R2_S3_ENDPOINT", text: `https://${ctx.account.cf_account_id}.${j === "eu" ? "eu." : j === "fedramp" ? "fedramp." : ""}r2.cloudflarestorage.com` },
      ...(r2BucketName ? [{ type: "plain_text", name: "R2_BUCKET_NAME", text: r2BucketName }] : [])
    );
    notes.r2Keys = true;
  }

  for (const row of await repo.listSecretRows(env, "site", ctx.siteId)) {
    if (!row.name.startsWith("var:")) continue;
    const name = row.name.slice(4);
    if (RESERVED_VARS.has(name) || out.some((b) => b.name === name)) continue;
    const value = await readSecretRow(env, row);
    out.push(row.is_secret ? { type: "secret_text", name, text: value } : { type: "plain_text", name, text: value });
  }
  out.push({ type: "plain_text", name: "LUMMET_HOSTING", text: "custom" });
  return { bindings: out, notes };
}

/** The site's own Turnstile widget in the customer's account: created once, its hostnames kept current. */
async function ensureTurnstile(infra, env, ctx, { host, workerName }) {
  const perms = parseJson(ctx.account.permissions, []);
  if (perms.length && perms.find((p) => p.key === "turnstile")?.ok === false) return { error: "token has no Turnstile permission" };
  const domains = [...new Set([host, ctx.workersDevHost(workerName)].filter(Boolean))];
  const name = `lummet-${workerName}`.slice(0, 254);
  const fresh = await repo.getSiteHosting(env, ctx.siteId);
  const secret = fresh?.turnstile_sitekey ? await readSecret(env, "site", ctx.siteId, "turnstile_secret") : null;
  if (fresh?.turnstile_sitekey && secret) {
    try { await infra.updateTurnstileWidget(ctx.cfEnv, { sitekey: fresh.turnstile_sitekey, name, domains }); return { sitekey: fresh.turnstile_sitekey, secret }; }
    catch (e) { if (e?.httpStatus !== 404) return { sitekey: fresh.turnstile_sitekey, secret }; /* the customer deleted it: make a new one */ }
  }
  return createWidget();
  async function createWidget() {
    const w = await infra.createTurnstileWidget(ctx.cfEnv, { name, domains, mode: "managed" });
    await writeSecret(env, { organizationId: ctx.hosting.organization_id, ownerType: "site", ownerId: ctx.siteId, name: "turnstile_secret", value: w.secret });
    await repo.patchSiteHosting(env, ctx.siteId, { turnstile_sitekey: w.sitekey });
    return w;
  }
}

/**
 * Makes the uploaded Worker reachable in the customer's account: always on workers.dev (also the health-check fallback), and on
 * its own hostname through a Workers Custom Domain when it lands on one. Cloudflare creates that hostname's DNS record and
 * certificate. Throws when the site's chosen address cannot be served (the deployment then fails, as for a platform route).
 */
export async function applyRouting(infra, env, ctx, { workerName }) {
  const out = { workersDev: null, customDomain: null };
  try { await infra.setWorkersDevEnabled(ctx.cfEnv, { workerName, enabled: true }); out.workersDev = ctx.workersDevHost(workerName); }
  catch (e) { if (ctx.hosting.landing === "workers_dev") throw new Error(`could not enable workers.dev for the site: ${String(e?.message || e).slice(0, 160)}`); }
  if (ctx.hosting.landing === "custom_domain" && ctx.hosting.hostname) {
    try {
      const r = await infra.attachWorkerDomain(ctx.cfEnv, { hostname: ctx.hosting.hostname, workerName, zoneId: ctx.hosting.zone_id, zoneName: ctx.hosting.zone_name });
      await repo.saveResource(env, { siteId: ctx.siteId, type: "worker_domain", resourceId: r.customDomainId || ctx.hosting.hostname, resourceName: ctx.hosting.hostname, metadata: { zoneId: ctx.hosting.zone_id, accountRef: ctx.account.id } });
      await repo.patchSiteHosting(env, ctx.siteId, { domain_status: "active", domain_error: null });
      out.customDomain = ctx.hosting.hostname;
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 200);
      await repo.patchSiteHosting(env, ctx.siteId, { domain_status: "failed", domain_error: msg });
      throw new Error(`could not attach ${ctx.hosting.hostname} to the site: ${msg}`);
    }
  }
  await repo.patchSiteHosting(env, ctx.siteId, { last_error: null });
  return out;
}

export function healthUrl(ctx, workerName, path = "/") {
  return `https://${ctx.workersDevHost(workerName)}${path || "/"}`;
}

/** Records a deploy failure on the hosting row so the customer sees it next to the site (never a secret: Cloudflare messages only). */
export async function noteFailure(env, siteId, message) {
  await repo.patchSiteHosting(env, siteId, { last_error: String(message || "").slice(0, 300) }).catch(() => {});
}

// ---------------------------------------------------------------- per-site settings

export async function siteHostingView(env, siteId) {
  const h = await repo.getSiteHosting(env, siteId);
  if (!h) return { mode: "lummet" };
  const account = await repo.getAccountById(env, h.account_ref);
  const vars = (await repo.listSecretRows(env, "site", siteId)).filter((r) => r.name.startsWith("var:"));
  const varsOut = [];
  for (const r of vars) varsOut.push({ name: r.name.slice(4), secret: !!r.is_secret, value: r.is_secret ? null : await readSecretRow(env, r).catch(() => null), hint: r.is_secret ? r.hint : null });
  return {
    mode: "custom", status: h.status, landing: h.landing, hostname: h.hostname, zoneId: h.zone_id, zoneName: h.zone_name,
    domainStatus: h.domain_status, domainError: h.domain_error, lastError: h.last_error, turnstile: !!h.turnstile_sitekey,
    account: account ? { id: account.id, label: account.label, accountId: account.cf_account_id, status: account.status, workersSubdomain: account.workers_subdomain } : null,
    variables: varsOut
  };
}

/** Sets (or, with value null, removes) custom Worker variables of a custom-hosted site. Applied on the next deploy. */
export async function setSiteVariables(env, { organizationId, siteId, variables }) {
  const h = await repo.getSiteHosting(env, siteId);
  if (!h || h.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_custom_hosted" };
  if (!Array.isArray(variables) || variables.length > MAX_VARS) return { ok: false, status: 422, error: "invalid_variables" };
  for (const v of variables) {
    const name = clean(v?.name, 64);
    if (!VAR_NAME.test(name)) return { ok: false, status: 422, error: "invalid_variable_name", name };
    if (RESERVED_VARS.has(name)) return { ok: false, status: 422, error: "reserved_variable_name", name };
    if (v.value !== null && v.value !== undefined && String(v.value).length > 5000) return { ok: false, status: 422, error: "variable_too_long", name };
  }
  const existing = (await repo.listSecretRows(env, "site", siteId)).filter((r) => r.name.startsWith("var:")).length;
  const adds = variables.filter((v) => v.value !== null && v.value !== undefined).length;
  if (existing + adds > MAX_VARS * 2) return { ok: false, status: 422, error: "too_many_variables" };
  for (const v of variables) {
    const name = clean(v.name, 64);
    if (v.value === null || v.value === undefined) await repo.deleteSecretRow(env, "site", siteId, `var:${name}`);
    else await writeSecret(env, { organizationId, ownerType: "site", ownerId: siteId, name: `var:${name}`, value: String(v.value), isSecret: v.secret !== false });
  }
  return { ok: true, redeployNeeded: true };
}

/**
 * Moves a custom-hosted site to another hostname (or back to workers.dev) in the same account. The old custom domain is detached
 * first; the new one is attached by the redeploy the caller starts (so SITE_URL and the Turnstile hostnames follow).
 */
export async function changeSiteDomain(env, { organizationId, siteId, choice, infra = cloudflareProvider }) {
  const h = await repo.getSiteHosting(env, siteId);
  if (!h || h.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_custom_hosted" };
  if (h.status !== "active") return { ok: false, status: 409, error: "site_transfer_in_progress" };
  const account = await repo.getAccountById(env, h.account_ref);
  if (!account) return { ok: false, status: 409, error: "custom_hosting_unavailable" };
  const landing = choice?.landing === "custom_domain" ? "custom_domain" : "workers_dev";
  let next = { landing, hostname: null, zoneId: null, zoneName: null };
  if (landing === "custom_domain") {
    const planned = await planHostingForExisting(env, { organizationId, account, choice, siteId, infra });
    if (!planned.ok) return planned;
    next = planned.plan;
  }
  if (next.hostname === h.hostname && landing === h.landing) return { ok: true, unchanged: true };
  const cfEnv = await accountEnv(env, account);
  const old = await repo.activeResourceRow(env, siteId, "worker_domain");
  if (old) {
    try { await infra.detachWorkerDomain(cfEnv, old.resource_id); } catch (e) { if (e?.httpStatus !== 404 && !/not\s*found/i.test(String(e?.message))) return { ok: false, status: 502, error: "detach_failed", message: String(e?.message || "").slice(0, 200) }; }
    await repo.markResourceDeleted(env, siteId, "worker_domain");
  }
  await repo.patchSiteHosting(env, siteId, { landing, hostname: next.hostname, zone_id: next.zoneId, zone_name: next.zoneName, domain_status: next.hostname ? "pending" : "none", domain_error: null });
  const site = await repo.activeResourceRow(env, siteId, "worker");
  const workerName = site?.resource_name || null;
  const host = next.hostname || workersDevHostFor(workerName || "", account.workers_subdomain);
  return { ok: true, host, redeployNeeded: true };
}

// Same checks as planHosting for a site that already exists (access switched off must not stop a customer fixing a domain).
async function planHostingForExisting(env, { organizationId, account, choice, siteId, infra }) {
  const zoneId = clean(choice?.zoneId, 64);
  if (!CF_ID.test(zoneId)) return { ok: false, status: 422, error: "hosting_zone_required" };
  const cfEnv = await accountEnv(env, account);
  const zones = await infra.listAccountZones(cfEnv).catch(() => null);
  if (!zones) return { ok: false, status: 502, error: "zones_unavailable" };
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) return { ok: false, status: 422, error: "zone_not_in_account" };
  if (zone.status !== "active") return { ok: false, status: 422, error: "zone_not_active" };
  const sub = clean(choice?.subdomain, 63).toLowerCase();
  if (sub && !sub.split(".").every((p) => LABEL.test(p))) return { ok: false, status: 422, error: "invalid_subdomain" };
  const hostname = sub ? `${sub}.${zone.name}` : zone.name;
  if (await repo.hostnameTaken(env, hostname, siteId)) return { ok: false, status: 409, error: "hostname_taken" };
  const access = await infra.probeZoneAccess(cfEnv, zoneId).catch(() => ({ ok: false, missing: ["zone"] }));
  if (!access.ok) return { ok: false, status: 422, error: "zone_permission_missing" };
  return { ok: true, plan: { landing: "custom_domain", hostname, zoneId, zoneName: zone.name } };
}

/** After a domain change: the registry and the site's address follow the new host. */
export async function applyHostChange(env, site, host) {
  if (!host) return;
  await repo.setSitePrimaryDomain(env, site.id, host);
  if (site.tenant_id && !(await repo.tenantHostTaken(env, host, site.tenant_id))) await repo.setTenantHost(env, site.tenant_id, host);
}

// ---------------------------------------------------------------- teardown / erasure

/**
 * True only for a failure reason that is clearly about the customer's Cloudflare ACCOUNT (token revoked / missing permission,
 * quota or plan limit, R2 not enabled, account disabled or removed). Those are the customer's to fix and say nothing about the
 * release, so a rollout may carry on past them. Anything else (a release that does not start, a failed health check, a
 * migration error) is treated exactly like a failure on a Lummet-hosted site: the rollout stops.
 */
export function isAccountLevelFailure(reason) {
  const t = String(reason || "");
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication error|invalid api token|token (is )?(revoked|expired|invalid)|missing permission|permission|account[^.]{0,40}(cannot be used|was removed|is disabled|suspended)|no saved api token|custom_hosting_unavailable|quota|limit (reached|exceeded)|exceeded[^.]{0,30}limit|too many (workers|namespaces|databases|buckets)|r2 is not enabled|enable r2|\b10042\b|\b10000\b|workers\.dev subdomain/i.test(t);
}

/** True for an error that means "the customer's account no longer lets us in": the resource is left to the customer. */
export function isAccessLost(e) { return e?.httpStatus === 401 || e?.httpStatus === 403 || e?.code === "custom_hosting_unavailable"; }

/**
 * env for deleting a site's provider resources. For a custom-hosted site whose account (or token) is gone the resources cannot
 * be reached at all: { env: null, lost: true } tells the caller to record them as left in the customer's account.
 */
export async function teardownEnv(env, site) {
  const hosting = await repo.getSiteHosting(env, site.id).catch(() => null);
  if (!hosting || hosting.status === "transferring") return { env, custom: false, lost: false };
  try { const ctx = await contextForSite(env, site); return { env: ctx.cfEnv, custom: true, lost: false, ctx }; }
  catch (_) { return { env: null, custom: true, lost: true }; }
}

/**
 * The extra things a custom-hosted site owns: its Workers Custom Domain and Turnstile widget in the customer's account, and a
 * Lummet copy kept after a move (old Worker, D1, KV, R2 in Lummet's account). Returns failures (empty = done).
 */
export async function cleanupSiteExtras(infra, env, site) {
  const failures = [];
  const hosting = await repo.getSiteHosting(env, site.id).catch(() => null);
  if (hosting && hosting.status === "transferring") {
    // A move that never switched: the copy it made in the customer's account goes; the site itself is still Lummet's.
    const open = await repo.latestTransferForSite(env, site.id).catch(() => null);
    if (open && open.status !== "completed") failures.push(...(await removeTransferTargets(infra, env, open)));
    if (!failures.length) { await repo.deleteSiteHosting(env, site.id); await repo.deleteSecretRow(env, "site", site.id, "turnstile_secret"); }
    return failures;
  }
  if (hosting) {
    const t = await teardownEnv(env, site);
    const domain = await repo.activeResourceRow(env, site.id, "worker_domain");
    if (domain) {
      if (t.env) {
        try { await infra.detachWorkerDomain(t.env, domain.resource_id); }
        catch (e) { if (!(e?.httpStatus === 404 || /not\s*found/i.test(String(e?.message)) || isAccessLost(e))) failures.push({ step: "worker_domain", error: String(e?.message || e).slice(0, 160) }); }
      }
      if (!failures.length) await repo.markResourceDeleted(env, site.id, "worker_domain");
    }
    if (hosting.turnstile_sitekey && t.env) {
      try { await infra.deleteTurnstileWidget(t.env, hosting.turnstile_sitekey); } catch (e) { if (!(e?.httpStatus === 404 || isAccessLost(e))) failures.push({ step: "turnstile", error: String(e?.message || e).slice(0, 160) }); }
    }
  }
  const transfer = await repo.latestTransferForSite(env, site.id).catch(() => null);
  if (transfer && transfer.status === "completed" && ["kept", "failed", "removing"].includes(transfer.old_copy_status)) {
    const r = await removeLummetCopy(infra, env, transfer);
    if (!r.ok) failures.push({ step: "old_lummet_copy", error: r.error });
  }
  return failures;
}

/** Removes what an unfinished move created in the customer's account (Worker, D1, KV, R2, domain, Turnstile). Returns failures. */
export async function removeTransferTargets(infra, env, transfer) {
  const failures = [];
  const target = parseJson(transfer.target_resources, {});
  let ctx = null;
  try { ctx = await contextForSite(env, transfer.site_id, { includeTransferring: true }); } catch (_) { return failures; }   // account gone: nothing reachable
  if (!ctx) return failures;
  const gone = (e) => e?.httpStatus === 404 || /not\s*found|does\s*not\s*exist|no\s*such/i.test(String(e?.message || e)) || isAccessLost(e);
  const tryDo = async (step, fn) => { try { await fn(); return true; } catch (e) { if (gone(e)) return true; failures.push({ step, error: String(e?.message || e).slice(0, 160) }); return false; } };
  const domain = await repo.activeResourceRow(env, transfer.site_id, "worker_domain");
  if (domain && (await tryDo("worker_domain", () => infra.detachWorkerDomain(ctx.cfEnv, domain.resource_id)))) await repo.markResourceDeleted(env, transfer.site_id, "worker_domain");
  if (ctx.hosting.turnstile_sitekey) await tryDo("turnstile", () => infra.deleteTurnstileWidget(ctx.cfEnv, ctx.hosting.turnstile_sitekey));
  if (target.worker) await tryDo("worker", () => infra.deleteWorkerScript(ctx.cfEnv, target.worker.name));
  if (target.d1) await tryDo("d1", () => infra.deleteDatabase(ctx.cfEnv, target.d1.id));
  if (target.kv) await tryDo("kv", () => infra.deleteKVNamespace(ctx.cfEnv, target.kv.id));
  if (target.r2) await tryDo("r2", () => infra.deleteR2Bucket(ctx.cfEnv, target.r2.id));
  return failures;
}

/** Deletes the Lummet-side copy a completed move kept (Worker, D1, KV, R2 in Lummet's own account). Idempotent. */
export async function removeLummetCopy(infra, env, transfer) {
  const src = parseJson(transfer.source_resources, {});
  await repo.patchTransfer(env, transfer.id, { old_copy_status: "removing" });
  const gone = (e) => e?.httpStatus === 404 || /not\s*found|does\s*not\s*exist|no\s*such/i.test(String(e?.message || e));
  const steps = [
    ["worker", src.worker && (() => infra.deleteWorkerScript(env, src.worker.name))],
    ["d1", src.d1 && (() => infra.deleteDatabase(env, src.d1.id))],
    ["kv", src.kv && (() => infra.deleteKVNamespace(env, src.kv.id))],
    ["r2", src.r2 && (() => infra.deleteR2Bucket(env, src.r2.id))]
  ];
  for (const [what, fn] of steps) {
    if (!fn || src[what]?.removed) continue;
    try { await fn(); } catch (e) {
      if (!gone(e)) { await repo.patchTransfer(env, transfer.id, { old_copy_status: "failed", source_resources: src }); return { ok: false, error: `${what}: ${String(e?.message || e).slice(0, 160)}` }; }
    }
    src[what].removed = true;
  }
  await repo.patchTransfer(env, transfer.id, { old_copy_status: "removed", source_resources: src });
  return { ok: true };
}

// ---------------------------------------------------------------- token health + enforcement (hardening)

const HEALTH_INTERVAL_MS = 6 * 3600_000;       // each saved account is re-verified about every six hours
const REALERT_MS = 7 * 86400_000;              // a problem that stays unfixed is repeated weekly, not on every check
const SITE_ALERT_MS = 24 * 3600_000;

async function tellOrganization(env, organizationId, subject, body) {
  try { await announcements.send(env, { staff: { id: "system" }, subject, body, format: "text", kind: "organization", ref: organizationId, channels: ["dashboard", "email"] }); return true; }
  catch (e) { console.error(JSON.stringify({ msg: "custom_hosting_notice_failed", organizationId, error: e?.message || String(e) })); return false; }
}

function healthKey(status, lastError) { return status === "verified" ? "ok" : `${status}:${String(lastError || "").slice(0, 120)}`; }

/**
 * Scheduled re-verification of saved Cloudflare accounts (a few per tick, each about every six hours; read-only calls).
 * A token that was revoked, expired or lost a permission is shown as invalid on the account and the organization is told once
 * (again weekly while unfixed), and again when it works again. A Cloudflare outage never changes an account's status.
 * Messages carry the account label and the missing capability names, never a credential.
 */
export async function sweepAccountHealth(env, { limit = 5, now = Date.now(), infra = cloudflareProvider } = {}) {
  const out = { checked: 0, invalid: 0, recovered: 0, alerts: 0, transient: 0 };
  if (!env?.LUMMET_DB) return out;
  for (const account of await repo.listAccountsDueForHealth(env, { olderThanIso: new Date(now - HEALTH_INTERVAL_MS).toISOString(), limit })) {
    out.checked++;
    let result;
    try { result = await probe(env, account, await accountEnv(env, account), infra, { monitor: true }); }
    catch (e) {
      if (!(e instanceof HostingError)) { out.transient++; await repo.patchAccount(env, account.id, { health_checked_at: new Date(now).toISOString() }).catch(() => {}); continue; }
      await repo.patchAccount(env, account.id, { status: "invalid", health_checked_at: new Date(now).toISOString(), last_error: "The account has no saved API token." });
      result = { tokenOk: false };
    }
    if (result.transient) { out.transient++; continue; }
    const fresh = await repo.getAccountById(env, account.id);
    if (!fresh) continue;
    const key = healthKey(fresh.status, fresh.last_error);
    const alerted = fresh.health_alert_state || null;
    const due = !fresh.health_alerted_at || now - Date.parse(fresh.health_alerted_at) > REALERT_MS;
    if (fresh.status === "invalid") {
      out.invalid++;
      if (alerted !== key || due) {
        const sites = account.in_use ? ` ${account.in_use} of your site(s) run on it: they keep serving, but new releases cannot be delivered to them until this is fixed.` : "";
        const ok = await tellOrganization(env, fresh.organization_id, `Your Cloudflare account "${fresh.label}" needs attention`,
          `Lummet re-checked the Cloudflare account "${fresh.label}" and it no longer passes: ${fresh.last_error || "the API token was rejected"}${sites}\n\nOpen Cloud hosting, choose the account, update the API token (create a new one with the permissions listed in the guide) and press Check. Nothing about your sites was changed.`);
        if (ok) { out.alerts++; await repo.patchAccount(env, fresh.id, { health_alert_state: key, health_alerted_at: new Date(now).toISOString() }); }
      }
    } else if (fresh.status === "verified" && alerted && alerted !== "ok") {
      out.recovered++;
      const ok = await tellOrganization(env, fresh.organization_id, `Your Cloudflare account "${fresh.label}" works again`, `The Cloudflare account "${fresh.label}" passed its check again. Releases will be delivered to the sites on it as usual.`);
      if (ok) await repo.patchAccount(env, fresh.id, { health_alert_state: "ok", health_alerted_at: new Date(now).toISOString() });
    }
  }
  return out;
}

/** A deployment failed for an account-level reason: tell the organization (at most once a day per account), never a secret. */
export async function notifyAccountProblem(env, siteId, reason, { now = Date.now() } = {}) {
  const hosting = await repo.getSiteHosting(env, siteId).catch(() => null);
  if (!hosting) return false;
  const account = await repo.getAccountById(env, hosting.account_ref);
  if (!account) return false;
  if (account.health_alerted_at && now - Date.parse(account.health_alerted_at) < SITE_ALERT_MS) return false;
  const ok = await tellOrganization(env, hosting.organization_id, `A release could not be delivered to your Cloudflare account "${account.label}"`,
    `Lummet could not deliver the latest release to a site that runs on your Cloudflare account "${account.label}": ${String(reason || "").slice(0, 240)}\n\nThe site keeps serving what it has. Open Cloud hosting, check the account and fix the token, quota or R2 setting named above; the next release (or the site's Update button) will then go through.`);
  if (ok) await repo.patchAccount(env, account.id, { health_alerted_at: new Date(now).toISOString(), health_alert_state: `deploy:${String(reason || "").slice(0, 100)}` });
  return ok;
}

/**
 * Edge enforcement for suspended (or suspended / closed organization) custom-hosted sites. The signed "suspended" state pushed to
 * the site is cooperative: it is the site's own code that honours it. Here Lummet ALSO uses the customer's API token to stop the
 * Worker being reachable (workers.dev switched off, Workers Custom Domain detached) and restores both on reactivation. This is
 * the strongest control possible without owning the account: a customer who revokes the token or edits their own account can
 * undo it, and the guide says so. Failures are recorded on the site's hosting row and retried by the next tick.
 */
export async function enforceAccessSweep(env, { limit = 10, infra = cloudflareProvider } = {}) {
  const out = { blocked: 0, restored: 0, failed: 0 };
  if (!env?.LUMMET_DB) return out;
  for (const w of await repo.listEnforcementWork(env, limit)) {
    const block = w.site_status === "suspended" || ["suspended", "closed"].includes(w.organization_status);
    try {
      const ctx = await contextForSite(env, w.site_id);
      if (!ctx) continue;
      const workerRow = await repo.activeResourceRow(env, w.site_id, "worker");
      const workerName = workerRow?.resource_name || workerRow?.resource_id;
      if (!workerName) throw new Error("the site has no Worker recorded");
      if (block) {
        await infra.setWorkersDevEnabled(ctx.cfEnv, { workerName, enabled: false });
        const domain = await repo.activeResourceRow(env, w.site_id, "worker_domain");
        if (domain) { try { await infra.detachWorkerDomain(ctx.cfEnv, domain.resource_id); } catch (e) { if (!(e?.httpStatus === 404 || /not\s*found/i.test(String(e?.message)))) throw e; } await repo.markResourceDeleted(env, w.site_id, "worker_domain"); }
        out.blocked++;
      } else {
        await applyRouting(infra, env, ctx, { workerName });
        out.restored++;
      }
      await repo.patchSiteHosting(env, w.site_id, { enforced_state: block ? "blocked" : "serving", enforced_at: new Date().toISOString(), enforce_error: null });
    } catch (e) {
      out.failed++;
      await repo.patchSiteHosting(env, w.site_id, { enforce_error: String(e?.message || e).slice(0, 250), enforced_at: new Date().toISOString() }).catch(() => {});
    }
  }
  return out;
}

// ---------------------------------------------------------------- staff

export async function staffOverview(env) {
  const [sites, accounts, access, transfers] = await Promise.all([repo.listAllHostedSites(env), repo.countAllAccounts(env), repo.listOrgAccess(env), repo.listRecentTransfers(env)]);
  return { enabled: featureOn(env), sites, accounts, access, transfers };
}

export async function setOrganizationAccess(env, { organization, mode, note, actorId }) {
  if (!["allow", "deny", "default"].includes(mode)) return { ok: false, status: 422, error: "invalid_mode" };
  const org = await repo.findOrganization(env, clean(organization, 200));
  if (!org) return { ok: false, status: 404, error: "organization_not_found" };
  await repo.setOrgAccess(env, { organizationId: org.id, mode, note: clean(note, 300), updatedBy: actorId });
  return { ok: true, organization: { id: org.id, name: org.name }, mode };
}

/** What the create-site form needs: null unless the organization may create custom-hosted sites (the form is then unchanged). */
export async function createFormData(env, organizationId) {
  const access = await accessFor(env, organizationId);
  if (!access.enabled) return null;
  return { enabled: true, accounts: await listAccounts(env, organizationId) };
}

export const __internal = { validateAccountInput, readSecret, writeSecret, RESERVED_VARS, hintOf };
