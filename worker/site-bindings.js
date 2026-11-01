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
// Email variables (RESEND_*) are NOT set here; add them if tenants should send mail.
// =====================================================
import * as siteResources from "./repositories/site-resources.js";
import { decryptSecret, aadFor } from "./crypto.js";

const activeResource = siteResources.findActiveResource;

export async function buildSiteBindings(env, { site, deploymentId, host, hasAssets }) {
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
    { type: "r2_bucket", name: "MEDIA_BUCKET", bucket_name: r2.resource_id },
    { type: "ai", name: "AI" },
    { type: "plain_text", name: "SITE_URL", text: `https://${host}` },
    { type: "plain_text", name: "DEPLOYMENT_ID", text: String(deploymentId) },
    { type: "plain_text", name: "SUPER_API_CREDENTIAL_ID", text: credential.credential_id },
    { type: "secret_text", name: "SUPER_API_SECRET", text: secret }
  ];
  if (env.TENANT_TURNSTILE_SITEKEY && env.TENANT_TURNSTILE_SECRET) {
    bindings.push({ type: "plain_text", name: "TURNSTILE_SITEKEY", text: String(env.TENANT_TURNSTILE_SITEKEY) });
    bindings.push({ type: "secret_text", name: "TURNSTILE_SECRET", text: String(env.TENANT_TURNSTILE_SECRET) });
  }
  if (hasAssets) bindings.push({ type: "assets", name: "ASSETS" });
  return bindings;
}
