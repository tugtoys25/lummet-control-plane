// =====================================================
// AFTERMARKET — NOTIFICATIONS (email, through the durable outbox in email.js)
//
// Who is told what, so nobody has to watch a dashboard:
//
//   Lummet staff  (AFTERMARKET_NOTIFY_EMAIL, else ALERT_EMAIL, else CONTACT_EMAIL)
//       a new enquiry (with the buyer's name and email)  · a seller's listing waiting for approval  · a seller's domain that went live
//   The seller    (the account email on the domain or listing)
//       an enquiry about their domain or listing (at most one email per item per hour, and NEVER the buyer's name or email)
//       their domain is verified and live  · their verification expired  · a domain or listing was removed by Lummet
//       their business listing was approved, or declined (with Lummet's note)
//
// Enquiries are sent the moment they arrive (forms.js). Status changes made by someone other than the owner are found by sweep() on the
// maintenance tick, which compares each row's status with notified_status (migration 0104), so it does not matter HOW an admin changed it.
// Not configured (no EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM) => messages wait in the outbox and are never reported as sent.
// Nothing here can fail a visitor's or seller's request.
// =====================================================

import { queueEmail, flushOutbox, portalLink } from "./email.js";
import * as repo from "./repositories/public-site.js";

const FORMS = new Set(["domain-acquisition", "listing-enquiry"]);
const hourBucket = () => new Date().toISOString().slice(0, 13);
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

export function staffRecipient(env) {
  return [env.AFTERMARKET_NOTIFY_EMAIL, env.ALERT_EMAIL, env.CONTACT_EMAIL].map((v) => String(v || "").trim()).find(looksLikeEmail) || null;
}

async function send(env, { to, subject, message, path = null, dedupeKey = null }) {
  if (!looksLikeEmail(to)) return false;
  try {
    const q = await queueEmail(env, { to: String(to).trim(), template: "notification", vars: { subject, message, link: path ? portalLink(env, path) : null }, dedupeKey });
    return Boolean(q.ok && !q.duplicate);
  } catch (err) {
    console.error("aftermarket notification not queued:", String(err?.message || err).slice(0, 160));
    return false;
  }
}

function deliver(env, execCtx) {
  const run = flushOutbox(env, { fetchImpl: typeof env.EMAIL_FETCH === "function" ? env.EMAIL_FETCH : fetch }).catch(() => {});
  if (execCtx?.waitUntil) execCtx.waitUntil(run);
  return run;
}

const money = (v) => (String(v || "").trim() ? `Offer: ${String(v).trim()}. ` : "");

/** A buyer sent an enquiry about a domain or a listing. Called by forms.js right after it is stored. */
export async function enquiryReceived(env, execCtx, record, id) {
  try {
    if (!FORMS.has(record.form_key) || !record.subject_ref) return;
    const ref = String(record.subject_ref);
    let owner = null;
    let label = ref;
    let path = null;
    if (ref.startsWith("listing:")) {
      const row = await repo.getListingBySlug(env, ref.slice(8));
      label = row?.title || ref;
      if (row?.source === "seller") { owner = row.owner_email; path = `/app/aftermarket/business/${row.id}`; }
    } else {
      const row = await repo.getAftermarketDomain(env, ref);
      if (row?.source === "seller") { owner = row.owner_email; path = `/app/aftermarket/${encodeURIComponent(row.domain)}`; }
    }
    const staff = staffRecipient(env);
    if (staff) {
      await send(env, {
        to: staff, subject: `New enquiry: ${label}`, dedupeKey: `am:enq:staff:${id}`,
        message: `${record.name || "Someone"} (${record.email || "no email"}) sent an enquiry about ${label}. ${record.summary || ""}`.trim()
      });
    }
    if (owner) {
      await send(env, {
        to: owner, subject: `New enquiry about ${label}`, path, dedupeKey: `am:enq:seller:${ref}:${hourBucket()}`,
        message: `Someone sent an enquiry about ${label}. Lummet is handling the buyer and will contact you about serious offers. You can see it in your Aftermarket dashboard.`
      });
    }
    await deliver(env, execCtx);
  } catch (err) {
    console.error("aftermarket enquiry notification failed:", String(err?.message || err).slice(0, 160));
  }
}

/** A seller's listing is waiting for an admin (created, edited, or submitted again). */
export async function listingForReview(env, execCtx, row, { edited = false } = {}) {
  try {
    const staff = staffRecipient(env);
    if (!staff) return;
    await send(env, {
      to: staff, subject: `Listing waiting for approval: ${row.title}`, dedupeKey: `am:review:${row.id}:${row.updated_at || Date.now()}`,
      path: "/cms/listings",
      message: `${edited ? "A seller changed" : "A seller submitted"} the business listing "${row.title}"${row.owner_email ? ` (${row.owner_email})` : ""}. Set its status to listed in Businesses for sale to publish it, or to unlisted with a note to the seller to decline it.`
    });
    await deliver(env, execCtx);
  } catch (err) {
    console.error("aftermarket review notification failed:", String(err?.message || err).slice(0, 160));
  }
}

// ----------------------------------------------------------------- status changes the owner did not make

async function domainChanged(env, row) {
  const dash = `/app/aftermarket/${encodeURIComponent(row.domain)}`;
  const key = (s) => `am:dom:${row.id}:${s}:${row.updated_at || ""}`;
  if (row.status === "listed") {
    await send(env, {
      to: row.owner_email, subject: `${row.domain} is verified and listed`, path: dash, dedupeKey: key("listed"),
      message: `We verified that you control ${row.domain} and it is now listed for sale.${row.hosted ? ` Its for-sale page also shows at https://${row.domain}/.` : ""} Buyers contact Lummet, and we will pass serious offers to you.`
    });
    const staff = staffRecipient(env);
    if (staff) await send(env, { to: staff, subject: `Seller domain listed: ${row.domain}`, dedupeKey: `am:dom-staff:${row.id}:${row.updated_at || ""}`, message: `${row.domain} (seller ${row.owner_email || "unknown"}) passed verification by ${row.verified_method || "unknown method"} and is listed.` });
  } else if (row.status === "unlisted") {
    await send(env, {
      to: row.owner_email, path: dash, dedupeKey: key("unlisted"),
      subject: row.verified_at ? `${row.domain} is no longer listed` : `${row.domain} could not be verified in time`,
      message: row.verified_at
        ? `${row.domain} was removed from the marketplace. If this is unexpected, contact us.`
        : `We could not verify that you control ${row.domain} in time, so the claim was closed. You can start again from your Aftermarket dashboard.`
    });
  }
  await repo.markDomainNotified(env, row.id, row.status);
}

async function listingChanged(env, row) {
  const dash = `/app/aftermarket/business/${row.id}`;
  const key = (s) => `am:lst:${row.id}:${s}:${row.updated_at || ""}`;
  if (row.status === "listed") {
    await send(env, { to: row.owner_email, path: dash, subject: `Your listing "${row.title}" is live`, dedupeKey: key("listed"), message: `"${row.title}" was approved and is now on the marketplace. Buyers contact Lummet, and we will pass serious enquiries to you.` });
  } else if (row.status === "unlisted" || row.status === "draft") {
    await send(env, {
      to: row.owner_email, path: dash, subject: `Your listing "${row.title}" was not approved`, dedupeKey: key("declined"),
      message: `"${row.title}" is not on the marketplace.${row.review_note ? ` Note from Lummet: ${row.review_note}` : ""} You can change it in your Aftermarket dashboard and submit it again.`
    });
  }
  await repo.markListingNotified(env, row.id, row.status);
}

/** Maintenance tick: tell owners about status changes they did not make. Safe to run repeatedly. */
export async function sweep(env, { limit = 20 } = {}) {
  let domains = 0;
  let listings = 0;
  for (const row of await repo.listDomainsToNotify(env, limit)) {
    try { await domainChanged(env, row); domains += 1; } catch (err) { console.error("aftermarket domain notification failed:", String(err?.message || err).slice(0, 160)); }
  }
  for (const row of await repo.listListingsToNotify(env, limit)) {
    try { await listingChanged(env, row); listings += 1; } catch (err) { console.error("aftermarket listing notification failed:", String(err?.message || err).slice(0, 160)); }
  }
  if (domains || listings) await deliver(env);
  return { domains, listings };
}
