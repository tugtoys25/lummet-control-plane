// =====================================================
// TRIAL ABUSE CHECKS (Phase 1.5)
//
// One trial per organization, per card, and per business email domain. Only HASHES are stored
// (trial_fingerprints), never a card fingerprint or a domain in the clear.
//
//   card     Stripe's card fingerprint, captured after a checkout that carried a trial.
//   domain   the domain of an OWNER's address, free-mail providers excluded (a gmail.com address says nothing
//            about who the person is). Only owners count, so agency staff invited into client organizations are
//            never the reason for a refusal (N3).
//
// BILLING_ENFORCE:  off     -> neither check runs (the always-on same-person check in plans.js still does)
//                   shadow  -> a refusal is only RECORDED in subscription_access_shadow, the trial goes ahead
//                   enforce -> the second trial is refused (local trial) or ended at once (card trial)
// =====================================================

import { billingConfig } from "./billing-config.js";
import * as repo from "./repositories/billing-lifecycle.js";

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
  "qq.com", "163.com", "126.com", "web.de", "mail.ru", "inbox.com", "duck.com"
]);

/** The domain of an address when it identifies an organization, otherwise null (free-mail, malformed). */
export function businessDomain(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  return FREE_MAIL_DOMAINS.has(domain) ? null : domain;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Salted so the stored hash cannot be matched against a list of known fingerprints or domains.
const hashOf = (env, kind, value) => sha256Hex(`lummet-trial:${kind}:${(env && env.TRIAL_FINGERPRINT_SALT) || ""}:${value}`);
export const cardHash = (env, cardFingerprint) => hashOf(env, "card", cardFingerprint);
export const domainHash = (env, domain) => hashOf(env, "domain", domain);

/** The business domains of an organization's owners (usually zero or one). */
export async function ownerBusinessDomains(env, organizationId) {
  const out = new Set();
  for (const o of await repo.ownerEmails(env, organizationId)) {
    const d = businessDomain(o.email);
    if (d) out.add(d);
  }
  return [...out];
}

async function recordShadow(env, organizationId, reason) {
  if (await repo.shadowReasonSeenRecently(env, organizationId, reason)) return;
  await repo.insertShadow(env, { organizationId, subscriptionId: null, state: "trial_refused", wouldChangeFrom: null, reason });
}

/**
 * Is this organization allowed a (new) trial, going by business domain? Does not look at cards (not known yet).
 * Returns {ok:true} or {ok:false, error, reason}. In shadow mode a refusal is recorded and ok:true is returned.
 */
export async function checkTrialByDomain(env, organizationId) {
  const mode = billingConfig(env).mode;
  if (mode === "off") return { ok: true };
  for (const domain of await ownerBusinessDomains(env, organizationId)) {
    const prior = await repo.findTrialFingerprint(env, await domainHash(env, domain));
    if (prior && prior.organization_id && prior.organization_id !== organizationId) {
      if (mode === "shadow") { await recordShadow(env, organizationId, "trial_refused:domain"); return { ok: true, shadowed: "domain" }; }
      return { ok: false, error: "trial_already_used", reason: "domain" };
    }
  }
  return { ok: true };
}

/** Remember that this organization has used its trial: one row per business domain of its owners. */
export async function recordTrialByDomain(env, organizationId) {
  if (billingConfig(env).mode === "off") return 0;
  let n = 0;
  for (const domain of await ownerBusinessDomains(env, organizationId)) {
    if (await repo.insertTrialFingerprint(env, { hash: await domainHash(env, domain), emailDomain: domain, organizationId })) n += 1;
  }
  return n;
}

/**
 * After a checkout that carried a trial: has this card already had a trial in ANOTHER organization?
 * Records the card when it is new. Returns {used:false} | {used:true, organizationId}.
 */
export async function registerCardForTrial(env, organizationId, cardFingerprint) {
  if (!cardFingerprint) return { used: false, unknown: true };
  const hash = await cardHash(env, cardFingerprint);
  const prior = await repo.findTrialFingerprint(env, hash);
  if (prior && prior.organization_id && prior.organization_id !== organizationId) return { used: true, organizationId: prior.organization_id };
  if (!prior) {
    const domains = await ownerBusinessDomains(env, organizationId);
    await repo.insertTrialFingerprint(env, { hash, emailDomain: domains[0] || null, organizationId });
  }
  return { used: false };
}

export { recordShadow as recordTrialRefusalShadow };
