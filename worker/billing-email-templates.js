// =====================================================
// BILLING EMAIL TEMPLATES (Phase 2.1)
//
// Pure functions: facts in, { subject, text, html } out. Every template works with and without its optional facts
// (no plan name, no invoice link, no date) and never prints "undefined". All interpolated text is HTML-escaped.
// Wording states only what the system does; it makes no promise the lifecycle does not keep.
// =====================================================

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function formatMoney(cents, currency = "USD") {
  if (!Number.isFinite(Number(cents))) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency || "USD").toUpperCase() }).format(Number(cents) / 100);
  } catch (_) {
    return `${(Number(cents) / 100).toFixed(2)} ${String(currency || "").toUpperCase()}`.trim();
  }
}

export function formatDate(value) {
  if (!value) return null;
  const t = typeof value === "number" ? value : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? String(value) : String(value).replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

/** Shared branded frame. `paragraphs` are plain strings; `cta` is { label, url } or null; `footnote` is optional. */
function frame({ brand, heading, paragraphs, cta, facts = [], footnote }) {
  const factLines = facts.filter((f) => f && f[1]);
  const text = [
    heading, "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(factLines.length ? [...factLines.map(([k, v]) => `${k}: ${v}`), ""] : []),
    ...(cta ? [`${cta.label}: ${cta.url}`, ""] : []),
    ...(footnote ? [footnote, ""] : []),
    `The ${brand} team`
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2330">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">` +
    `<tr><td style="font-size:13px;font-weight:600;letter-spacing:.04em;color:#5b6577;text-transform:uppercase">${esc(brand)}</td></tr>` +
    `<tr><td style="font-size:20px;font-weight:600;padding:10px 0 14px">${esc(heading)}</td></tr>` +
    paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.55;padding-bottom:12px">${esc(p)}</td></tr>`).join("") +
    (factLines.length ? `<tr><td style="padding:4px 0 14px"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${factLines.map(([k, v]) => `<tr><td style="color:#5b6577;padding:2px 14px 2px 0">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></td></tr>` : "") +
    (cta ? `<tr><td style="padding:6px 0 16px"><a href="${esc(cta.url)}" style="display:inline-block;background:#2457d6;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:10px 18px;border-radius:6px">${esc(cta.label)}</a></td></tr>` : "") +
    (footnote ? `<tr><td style="font-size:13px;line-height:1.5;color:#5b6577;padding-bottom:10px">${esc(footnote)}</td></tr>` : "") +
    `<tr><td style="font-size:13px;color:#5b6577;padding-top:6px">The ${esc(brand)} team</td></tr>` +
    `</table></td></tr></table></body></html>`;
  return { text, html };
}

const days = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? `${Number(n)} day${Number(n) === 1 ? "" : "s"}` : null);
const plan = (v) => (v.planName ? ` on the ${v.planName} plan` : "");
const billingCta = (v, label = "Open billing") => (v.billingUrl ? { label, url: v.billingUrl } : null);

/** kind -> (facts) => { subject, text, html }. `v.brand` and `v.orgName` are always set by the engine. */
export const billingTemplates = {
  trial_welcome: (v) => {
    const end = formatDate(v.trialEndsAt);
    return {
      subject: `Welcome to ${v.brand}: your trial has started`,
      ...frame({
        brand: v.brand, heading: "Your trial has started",
        paragraphs: [
          `${v.orgName} is now on a free trial${plan(v)}.${end ? ` It runs until ${end}.` : ""}`,
          "You can add a payment method at any time to keep your sites running after the trial ends."
        ],
        cta: billingCta(v, "Open billing")
      })
    };
  },
  trial_ended: (v) => ({
    subject: `Your ${v.brand} trial has ended`,
    ...frame({
      brand: v.brand, heading: "Your trial has ended",
      paragraphs: [
        `The trial for ${v.orgName} ended without a payment method on file.`,
        v.restrictedDays ? `Your account stays available for ${v.restrictedDays} more days. Add a payment method before then to continue without interruption.` : "Add a payment method to continue without interruption."
      ],
      cta: billingCta(v, "Choose a plan")
    })
  }),
  payment_failed: (v) => {
    const amount = formatMoney(v.amountCents, v.currency);
    const grace = formatDate(v.graceEndsAt);
    const final = v.attempt >= 3;
    return {
      subject: final ? `Final notice: we could not collect your ${v.brand} payment` : `Your ${v.brand} payment did not go through`,
      ...frame({
        brand: v.brand, heading: final ? "We still could not collect your payment" : "Your payment did not go through",
        paragraphs: [
          `We tried to charge the payment method for ${v.orgName}${plan(v)}${amount ? ` (${amount})` : ""} and it was declined.`,
          grace ? `Everything keeps working until ${grace}. After that date the account becomes read-only until the payment succeeds.` : "Please update your payment method so the next attempt can succeed.",
          "Updating your card is the fastest fix; we retry automatically afterwards."
        ],
        facts: [["Amount due", amount], ["Attempt", v.attempt ? String(v.attempt) : null], ["Keeps working until", grace]],
        cta: billingCta(v, "Update payment method"),
        footnote: v.invoiceUrl ? `Invoice: ${v.invoiceUrl}` : undefined
      })
    };
  },
  receipt: (v) => {
    const amount = formatMoney(v.amountCents, v.currency);
    const period = [formatDate(v.periodStart), formatDate(v.periodEnd)].filter(Boolean).join(" to ");
    return {
      subject: `Your ${v.brand} receipt${amount ? ` for ${amount}` : ""}`,
      ...frame({
        brand: v.brand, heading: "Payment received",
        paragraphs: [`Thank you. We received your payment for ${v.orgName}${plan(v)}.`],
        facts: [["Amount paid", amount], ["Period", period || null]],
        cta: v.invoiceUrl ? { label: "View invoice", url: v.invoiceUrl } : billingCta(v, "Open billing")
      })
    };
  },
  restricted: (v) => {
    const until = formatDate(v.suspendsAt);
    return {
      subject: `${v.orgName} is now read-only until payment is received`,
      ...frame({
        brand: v.brand, heading: "Your account is read-only",
        paragraphs: [
          `The payment for ${v.orgName} was not received in time, so changes are now paused. Your sites stay online and your data is safe.`,
          until ? `If payment is not received by ${until}, the sites will be suspended.` : "If payment is still not received, the sites will be suspended.",
          "As soon as a payment succeeds, everything is restored automatically."
        ],
        facts: [["Suspension date", until]],
        cta: billingCta(v, "Update payment method")
      })
    };
  },
  suspended: (v) => ({
    subject: `${v.orgName} has been suspended`,
    ...frame({
      brand: v.brand, heading: "Your account is suspended",
      paragraphs: [
        `${v.orgName} has been suspended because payment was not received.`,
        "Your data is kept. Paying the outstanding invoice restores the account automatically."
      ],
      cta: billingCta(v, "Pay and restore")
    })
  }),
  reactivated: (v) => ({
    subject: `${v.orgName} is active again`,
    ...frame({
      brand: v.brand, heading: "Your account is active again",
      paragraphs: [`Your payment went through and ${v.orgName} has been restored. No further action is needed.`],
      cta: billingCta(v, "Open billing")
    })
  }),
  cancellation_scheduled: (v) => {
    const end = formatDate(v.endsAt);
    return {
      subject: `Your ${v.brand} subscription will end${end ? ` on ${end}` : ""}`,
      ...frame({
        brand: v.brand, heading: "Your cancellation is confirmed",
        paragraphs: [
          `The subscription for ${v.orgName}${plan(v)} is set to end${end ? ` on ${end}` : " at the end of the current period"}. You keep full access until then and will not be charged again.`,
          "Changed your mind? You can resume the subscription before it ends."
        ],
        facts: [["Ends on", end]],
        cta: billingCta(v, "Resume subscription")
      })
    };
  },

  // ---- Phase 2.2 templates ----
  trial_reminder: (v) => {
    const end = formatDate(v.trialEndsAt);
    const left = days(v.daysLeft);
    return {
      subject: `Your ${v.brand} trial ends${left ? ` in ${left}` : " soon"}`,
      ...frame({
        brand: v.brand, heading: left ? `Your trial ends in ${left}` : "Your trial ends soon",
        paragraphs: [
          `The trial for ${v.orgName}${plan(v)} ends${end ? ` on ${end}` : " soon"}.`,
          "If a payment method is already on file, nothing more is needed. Otherwise add one before the trial ends to keep working without interruption."
        ],
        facts: [["Trial ends", end]],
        cta: billingCta(v, "Add a payment method")
      })
    };
  },
  renewal_notice: (v) => {
    const when = formatDate(v.renewsAt);
    const amount = formatMoney(v.amountCents, v.currency);
    return {
      subject: `Your ${v.brand} subscription renews${when ? ` on ${when}` : " soon"}`,
      ...frame({
        brand: v.brand, heading: "Your subscription renews soon",
        paragraphs: [
          `The subscription for ${v.orgName}${plan(v)} renews${when ? ` on ${when}` : " soon"}${amount ? ` for ${amount}` : ""}. No action is needed.`,
          "To change plan, update your card or cancel before then, open billing."
        ],
        facts: [["Renews on", when], ["Amount", amount]],
        cta: billingCta(v, "Manage subscription")
      })
    };
  },
  grace_reminder: (v) => {
    const until = formatDate(v.graceEndsAt);
    const left = days(v.daysLeft);
    return {
      subject: `Payment still needed for ${v.orgName}${left ? `: ${left} left` : ""}`,
      ...frame({
        brand: v.brand, heading: "Your payment is still outstanding",
        paragraphs: [
          `We have not been able to collect the payment for ${v.orgName}${plan(v)}.`,
          until ? `Everything keeps working until ${until}. After that date the account becomes read-only until the payment succeeds.` : "If the payment is not received, the account will become read-only.",
          "Updating your card is the fastest fix."
        ],
        facts: [["Keeps working until", until]],
        cta: billingCta(v, "Update payment method"),
        footnote: v.invoiceUrl ? `Invoice: ${v.invoiceUrl}` : undefined
      })
    };
  },
  card_authentication: (v) => {
    const amount = formatMoney(v.amountCents, v.currency);
    const url = v.invoiceUrl || v.billingUrl;
    return {
      subject: `Action needed: confirm your ${v.brand} payment`,
      ...frame({
        brand: v.brand, heading: "Your bank needs you to confirm this payment",
        paragraphs: [
          `Your bank asked for extra confirmation before it will approve the payment for ${v.orgName}${plan(v)}${amount ? ` (${amount})` : ""}.`,
          "Open the link below and follow your bank's steps. The payment is not complete until you do."
        ],
        facts: [["Amount due", amount]],
        cta: url ? { label: "Confirm payment", url } : null
      })
    };
  },
  plan_changed: (v) => ({
    subject: `Your ${v.brand} plan has changed`,
    ...frame({
      brand: v.brand, heading: "Your plan has changed",
      paragraphs: [
        `${v.orgName} is now on the ${v.planName || "new"} plan${v.previousPlanName ? ` (it was ${v.previousPlanName})` : ""}.`,
        "Your next invoice shows any difference in price. If you did not make this change, contact us right away."
      ],
      facts: [["New plan", v.planName || null], ["Previous plan", v.previousPlanName || null]],
      cta: billingCta(v, "Open billing")
    })
  }),
  ending_soon: (v) => {
    const end = formatDate(v.endsAt);
    const left = days(v.daysLeft);
    return {
      subject: `Your ${v.brand} subscription ends${left ? ` in ${left}` : " soon"}`,
      ...frame({
        brand: v.brand, heading: left ? `Your subscription ends in ${left}` : "Your subscription ends soon",
        paragraphs: [
          `The subscription for ${v.orgName}${plan(v)} is set to end${end ? ` on ${end}` : " at the end of the current period"}. You keep full access until then.`,
          "You can resume it at any time before it ends."
        ],
        facts: [["Ends on", end]],
        cta: billingCta(v, "Resume subscription")
      })
    };
  },
  // Promotional. Shipped switched off (BILLING_WINBACK_EMAILS) until an unsubscribe path exists; the unsubscribe link is
  // printed when the caller supplies one.
  win_back: (v) => ({
    subject: `${v.orgName} is waiting for you on ${v.brand}`,
    ...frame({
      brand: v.brand, heading: "Come back whenever you are ready",
      paragraphs: [
        `Your subscription for ${v.orgName} has ended. Your account and data are still here, and you can start a new plan at any time.`
      ],
      cta: billingCta(v, "Choose a plan"),
      footnote: v.unsubscribeUrl ? `Do not want these emails? Unsubscribe: ${v.unsubscribeUrl}` : undefined
    })
  }),
  refund_issued: (v) => {
    const amount = formatMoney(v.amountCents, v.currency);
    return {
      subject: `Your ${v.brand} refund${amount ? ` of ${amount}` : ""} has been issued`,
      ...frame({
        brand: v.brand, heading: "Your refund has been issued",
        paragraphs: [
          `We refunded${amount ? ` ${amount}` : " a payment"} for ${v.orgName}${plan(v)} to the original payment method.`,
          "Depending on your bank, it can take several business days to appear on your statement."
        ],
        facts: [["Refunded", amount]],
        cta: v.invoiceUrl ? { label: "View invoice", url: v.invoiceUrl } : billingCta(v, "Open billing")
      })
    };
  },
  deletion_warning: (v) => {
    const when = formatDate(v.deletesAt);
    const left = days(v.daysLeft);
    return {
      subject: `${v.orgName} will be deleted${left ? ` in ${left}` : " soon"}`,
      ...frame({
        brand: v.brand, heading: left ? `Your organization is deleted in ${left}` : "Your organization will be deleted soon",
        paragraphs: [
          `${v.orgName} is scheduled for permanent deletion${when ? ` on ${when}` : ""}. Its sites and data cannot be recovered afterwards.`,
          "Download your data before then. An owner can also cancel the deletion request before that date."
        ],
        facts: [["Deletion date", when]],
        cta: v.exportUrl ? { label: "Download your data", url: v.exportUrl } : billingCta(v, "Open your account"),
        footnote: v.exportUrl ? "You need to be signed in as an organization admin to download the export." : undefined
      })
    };
  }
};

export const BILLING_KINDS = Object.keys(billingTemplates);

export function renderBillingEmail(kind, facts) {
  const build = billingTemplates[kind];
  if (!build) return null;
  return build(facts);
}
