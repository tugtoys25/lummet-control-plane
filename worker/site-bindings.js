// =====================================================
// PER-SITE WORKER BINDINGS
//
// The tenant application reads env.DB (D1), env.CACHE (KV),
// env.MEDIA_BUCKET (R2), env.AI, env.ASSETS and the Super API
// credential (SUPER_API_CREDENTIAL_ID / SUPER_API_SECRET) plus
// SITE_URL and DEPLOYMENT_ID. Provisioning creates the D1/KV/R2
// resources and a credential, but until this module existed nothing
// attached them to the uploaded Worker, so a deployed site had no
// database. Built from control-plane records on every deploy because a
// Worker upload replaces the script's bindings wholesale.
//
// Known consequence: the Super API secret is baked in at deploy time, so
// rotating a tenant credential needs a redeploy to reach the site.
// Optional Turnstile for the site's own login/register pages: set TENANT_TURNSTILE_SITEKEY and
// TENANT_TURNSTILE_SECRET on the control plane and every deploy passes them on as TURNSTILE_SITEKEY /
// TURNSTILE_SECRET. Without them a site has no Turnstile and relies on its attempt limiter (that is how it can
// be signed in to at all). The widget's allowed hostnames must include the site's hostnames (a Cloudflare setting).
// Email: every deploy passes the control plane's own setup to the site as RESEND_API_KEY / RESEND_FROM_EMAIL (the key from
// RESEND_API_KEY, the sender from EMAIL_FROM, only when EMAIL_PROVIDER is resend). TENANT_RESEND_API_KEY and
// TENANT_RESEND_FROM_EMAIL override them for sites only. Both a key and a sender are needed, or neither is passed.
// =====================================================
import * as siteResources from "./repositories/site-resources.js";
import { decryptSecret, aadFor } from "./crypto.js";
import { lineProfile } from "./template-lines.js";

const activeResource = siteResources.findActiveResource;

export async function buildSiteBindings(env, { site, deploymentId, host, hasAssets, line = null }) {
  // The line decides the R2 binding name and whether the AI binding exists (casino: MEDIA_BUCKET + AI, brokerage: PRIVATE_FILES).
  const profile = lineProfile(line);
  const [d1, kv, r2] = await Promise.all([
    activeResource(env, site.id, "d1"), activeResource(env, site.id, "kv"), activeResource(env, site.id, "r2")
  ]);
  const missing = [["d1", d1], ["kv", kv], ["r2", r2]].filter(([, r]) => !r).map(([t]) => t);
  if (missing.length) throw new Error(`cannot bind site resources: missing ${missing.join(", ")} (was the site fully provisioned?)`);
  if (!site.tenant_id) throw new Error("cannot bind Super API credential: site has no registered tenant");

  const credential = await siteResources.findActiveCredential(env, site.tenant_id);
  if (!credential) throw new Error("cannot bind Super API credential: tenant has no active credential");
  const secret = await decryptSecret(env, credential.encrypted_secret, credential.secret_iv, aadFor("tenant_api_credentials", credential.credential_id, "encrypted_secret"));

  const bindings = [
    { type: "d1", name: "DB", id: d1.resource_id },
    { type: "kv_namespace", name: "CACHE", namespace_id: kv.resource_id },
    { type: "r2_bucket", name: profile.r2Binding, bucket_name: r2.resource_id },
    ...(profile.ai ? [{ type: "ai", name: "AI" }] : []),
    { type: "plain_text", name: "SITE_URL", text: `https://${host}` },
    { type: "plain_text", name: "DEPLOYMENT_ID", text: String(deploymentId) },
    { type: "plain_text", name: "SUPER_API_CREDENTIAL_ID", text: credential.credential_id },
    { type: "secret_text", name: "SUPER_API_SECRET", text: secret }
  ];
  if (env.TENANT_TURNSTILE_SITEKEY && env.TENANT_TURNSTILE_SECRET) {
    bindings.push({ type: "plain_text", name: "TURNSTILE_SITEKEY", text: String(env.TENANT_TURNSTILE_SITEKEY) });
    bindings.push({ type: "secret_text", name: "TURNSTILE_SECRET", text: String(env.TENANT_TURNSTILE_SECRET) });
  }
  const siteEmailKey = env.TENANT_RESEND_API_KEY || (String(env.EMAIL_PROVIDER || "").toLowerCase() === "resend" ? env.RESEND_API_KEY : "");
  const siteEmailFrom = env.TENANT_RESEND_FROM_EMAIL || env.EMAIL_FROM;
  if (siteEmailKey && siteEmailFrom) {
    bindings.push({ type: "secret_text", name: "RESEND_API_KEY", text: String(siteEmailKey) });
    bindings.push({ type: "plain_text", name: "RESEND_FROM_EMAIL", text: String(siteEmailFrom) });
  }
  if (profile.key === "brokerage") {
    // The brokerage application (luminousagents) reads these names. PUBLIC_BASE_URL is the site's own address, APP_ENV
    // is 'production' for every provisioned site (the platform's own staging is a separate control plane deployment).
    bindings.push({ type: "plain_text", name: "APP_ENV", text: "production" });
    bindings.push({ type: "plain_text", name: "LOG_LEVEL", text: "warn" });
    bindings.push({ type: "plain_text", name: "PUBLIC_BASE_URL", text: `https://${host}` });
    if (siteEmailKey && siteEmailFrom) bindings.push({ type: "plain_text", name: "EMAIL_FROM", text: String(siteEmailFrom) });
    if (env.TENANT_TURNSTILE_SITEKEY && env.TENANT_TURNSTILE_SECRET) {
      bindings.push({ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: String(env.TENANT_TURNSTILE_SITEKEY) });
      bindings.push({ type: "secret_text", name: "TURNSTILE_SECRET_KEY", text: String(env.TENANT_TURNSTILE_SECRET) });
    }
    // Per-site secrets the application needs to start. Derived from TENANT_SECRET_ROOT and the site's id, so they differ
    // per site, are never stored, and stay the same on every redeploy. They deliberately do NOT depend on the Super API
    // credential (rotating it would make a site's stored MFA secrets unreadable) or on CREDENTIAL_KEK (which is rotated).
    // Without the root the deployment fails with a clear message instead of shipping a site with weak or missing secrets.
    if (!env.TENANT_SECRET_ROOT || String(env.TENANT_SECRET_ROOT).length < 32) {
      throw new Error("TENANT_SECRET_ROOT is not configured (a Worker secret of at least 32 characters is required to deploy brokerage sites)");
    }
    bindings.push({ type: "secret_text", name: "ADMIN_BOOTSTRAP_TOKEN", text: await siteDerivedSecret(env.TENANT_SECRET_ROOT, site.id, "admin-bootstrap") });
    bindings.push({ type: "secret_text", name: "IP_HASH_SECRET", text: await siteDerivedSecret(env.TENANT_SECRET_ROOT, site.id, "ip-hash") });
    bindings.push({ type: "secret_text", name: "OTP_ENCRYPTION_KEY", text: await siteDerivedSecret(env.TENANT_SECRET_ROOT, site.id, "otp-key", true) });
  }
  if (hasAssets) bindings.push({ type: "assets", name: "ASSETS" });
  return bindings;
}

/**
 * A stable per-site secret: HMAC-SHA-256 of the site id and a purpose label under the platform's tenant secret root.
 * base64 = the 32-byte base64 form the application expects for encryption keys; otherwise 64 hex characters.
 */
async function siteDerivedSecret(root, siteId, purpose, base64 = false) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(root)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`lummet-site-secret:v1:${siteId}:${purpose}`)));
  return base64 ? btoa(String.fromCharCode(...bytes)) : [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The code a brokerage site's owner types on the site's one-time /admin/setup page to create the first administrator.
 * It is the site's ADMIN_BOOTSTRAP_TOKEN, re-derived (never stored) so the owner can be shown it on demand.
 */
export async function deriveAdminSetupCode(env, siteId) {
  if (!env.TENANT_SECRET_ROOT || String(env.TENANT_SECRET_ROOT).length < 32) return null;
  return siteDerivedSecret(env.TENANT_SECRET_ROOT, siteId, "admin-bootstrap");
}
