import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

function formatMoney(cents, currency) {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency || "USD"}`;
}

function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const COUPON_ERRORS = {
  invalid_coupon: "That code isn't valid or has expired.",
  coupon_exhausted: "That code has reached its limit.",
  coupon_already_used: "Your organization has already used that code."
};

function discountText(c) {
  const amount = c.percentOff != null ? `${c.percentOff}% off` : `${(c.amountOffCents / 100).toFixed(2)} off`;
  const when = c.duration === "forever" ? " for as long as you subscribe" : c.duration === "repeating" ? " for a limited number of months" : " on your first payment";
  return amount + when;
}

function planPrice(p) {
  return p.price_cents != null ? formatMoney(p.price_cents, p.currency) + " / " + escapeHtml(p.billing_period) : "Custom";
}

export function renderBillingPage({ subscription, plan, invoices, availablePlans, canManage, checkoutStatus }) {
  const isPaid = !!(subscription && subscription.provider);
  const isTrialNoCard = !!(subscription && !subscription.provider);

  const banner =
    checkoutStatus === "success"
      ? `<div class="flash flash-success">Thanks. Stripe is confirming your payment; this page updates as soon as it does (usually within a minute). Reload to check.</div>`
      : checkoutStatus === "canceled"
        ? `<div class="flash">Checkout was canceled. Nothing was charged.</div>`
        : "";

  const pastDue = subscription && subscription.status === "past_due"
    ? `<div class="flash flash-error">Your last payment failed. Stripe will retry. ${canManage ? "Use the payment button below to fix your card." : "Ask an organization admin to update the payment method."}</div>`
    : "";

  const currentPlanCard = subscription
    ? `
      <div class="card">
        <h2>Current plan</h2>
        <p style="font-size:15px;">${escapeHtml(plan?.name || "—")}
          <span class="badge badge-${escapeHtml(subscription.status)}">${escapeHtml(subscription.status)}</span>
        </p>
        ${subscription.trial_ends_at ? `<p style="color:var(--text-dim);font-size:13px;">Trial ends ${formatDate(subscription.trial_ends_at)}</p>` : ""}
        ${subscription.cancel_at_period_end ? `<p style="color:var(--warn);font-size:13px;">Cancels at the end of the current period.</p>` : ""}
        ${isTrialNoCard ? `<p style="color:var(--text-dim);font-size:13px;">This is a trial with no payment method on file yet. Subscribe below to keep your plan after the trial.</p>` : ""}
        ${canManage && isPaid && subscription.cancel_at_period_end ? `<button class="btn"${onClick("lummetBillingPost", ["/billing/resume", {}, "Could not resume"])}>Keep my subscription</button>` : ""}
        ${canManage && isPaid ? `<button class="btn btn-secondary"${onClick("lummetPortal", [])}>Update payment method &amp; invoices</button>` : ""}
        ${canManage && isPaid && !subscription.cancel_at_period_end ? `<button class="btn btn-danger"${onClick("lummetCancel", [true])}>Cancel at period end</button>` : ""}
        ${canManage && isTrialNoCard ? `<button class="btn btn-danger"${onClick("lummetCancel", [false])}>Cancel trial</button>` : ""}
      </div>`
    : `
      <div class="card">
        <h2>No plan yet</h2>
        <p style="color:var(--text-dim);font-size:14px;">Choose a plan below. A free trial needs no card; subscribing takes you to Stripe's secure payment page.</p>
      </div>`;

  const showPlans = canManage && availablePlans.length > 0;
  const couponBox = showPlans && !isPaid
    ? `
      <div class="card">
        <h2>Discount code</h2>
        <input type="text" id="coupon-code" placeholder="Enter a code" autocomplete="off" style="max-width:240px;" />
        <button class="btn" type="button" id="coupon-apply">Apply</button>
        <p id="coupon-message" style="font-size:13px;margin-top:8px;"></p>
      </div>`
    : "";

  const rowActions = (p) => {
    if (!canManage) return "";
    if (isPaid) return `<button class="btn"${onClick("lummetChangePlan", [p.id])}>Switch to this plan</button>`;
    const buy = p.stripe_price_id
      ? `<button class="btn"${onClick("lummetCheckout", [p.id])}>Subscribe</button>`
      : `<span style="color:var(--text-dim);font-size:13px;">Not available online</span>`;
    const trial = !subscription && p.trial_days ? `<button class="btn btn-secondary"${onClick("lummetStartTrial", [p.id])}>Start ${escapeHtml(String(p.trial_days))}-day trial</button> ` : "";
    return trial + buy;
  };

  const planOptions = showPlans
    ? `
      <div class="card">
        <h2>${isPaid ? "Change plan" : "Available plans"}</h2>
        <table>
          <thead><tr><th>Plan</th><th>Price</th><th>Trial</th><th></th></tr></thead>
          <tbody>
            ${availablePlans.map((p) => `
              <tr>
                <td>${escapeHtml(p.name)}</td>
                <td>${planPrice(p)}</td>
                <td>${p.trial_days ? escapeHtml(String(p.trial_days)) + " days" : "—"}</td>
                <td class="actions">${rowActions(p)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`
    : "";

  const invoiceRows = invoices.length
    ? invoices
        .map(
          (inv) => `
          <tr>
            <td>${formatDate(inv.created_at)}</td>
            <td><span class="badge badge-${inv.status === "paid" ? "active" : "past_due"}">${escapeHtml(inv.status)}</span></td>
            <td>${formatMoney(inv.amount_due_cents, inv.currency)}</td>
            <td>${inv.hosted_invoice_url ? `<a href="${escapeHtml(inv.hosted_invoice_url)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">No invoices yet.</td></tr>`;

  return `
    <h1>Billing</h1>
    <p class="subtitle">Plan, subscription status, and invoice history.</p>

    ${banner}
    ${pastDue}
    ${currentPlanCard}
    ${couponBox}
    ${planOptions}

    <div class="card">
      <h2>Invoices</h2>
      <table>
        <thead><tr><th>Date</th><th>Status</th><th>Amount</th><th></th></tr></thead>
        <tbody>${invoiceRows}</tbody>
      </table>
    </div>

    <script nonce="${nonceToken()}">
      var COUPON_ERRORS = ${JSON.stringify(COUPON_ERRORS).replace(/</g, "\\u003c")};
      function lummetActiveOrgId() {
        var el = document.getElementById('org-switcher');
        return el ? el.value : null;
      }
      function lummetBillingPost(sub, body, failLabel, done) {
        fetch('/api/organizations/' + lummetActiveOrgId() + sub, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.success) { alert(failLabel + ': ' + (COUPON_ERRORS[data.error] || String(data.error || 'unknown error').replace(/_/g, ' '))); return; }
            if (done) done(data); else location.reload();
          });
      }
      function lummetStartTrial(planId) { lummetBillingPost('/trial', { planId: planId }, 'Could not start trial'); }
      function lummetCheckout(planId) {
        var code = (document.getElementById('coupon-code') || { value: '' }).value.trim();
        lummetBillingPost('/billing/checkout', { planId: planId, couponCode: code || undefined }, 'Could not start checkout', function (data) {
          window.location.href = data.checkoutUrl;
        });
      }
      function lummetChangePlan(planId) {
        if (!confirm('Switch to this plan? Stripe adjusts the charge for the rest of the period.')) return;
        lummetBillingPost('/billing/change-plan', { planId: planId }, 'Could not change plan');
      }
      function lummetPortal() {
        lummetBillingPost('/billing/portal', {}, 'Could not open the billing portal', function (data) { window.location.href = data.portalUrl; });
      }
      function lummetCancel(atPeriodEnd) {
        if (!confirm(atPeriodEnd ? 'Cancel at the end of the current period? You keep access until then.' : 'Cancel your trial now?')) return;
        lummetBillingPost('/billing/cancel', { atPeriodEnd: atPeriodEnd }, 'Could not cancel');
      }
      var applyBtn = document.getElementById('coupon-apply');
      if (applyBtn) applyBtn.addEventListener('click', function () {
        var msg = document.getElementById('coupon-message');
        var code = document.getElementById('coupon-code').value.trim();
        if (!code) { msg.textContent = ''; return; }
        fetch('/api/organizations/' + lummetActiveOrgId() + '/billing/coupon/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.success) {
            var c = data.coupon;
            var amount = c.percentOff != null ? c.percentOff + '% off' : (c.amountOffCents / 100).toFixed(2) + ' off';
            var when = c.duration === 'forever' ? ' for as long as you subscribe' : c.duration === 'repeating' ? ' for a limited number of months' : ' on your first payment';
            msg.style.color = 'var(--ok, green)'; msg.textContent = 'Code applied: ' + amount + when + '. It is used when you subscribe.';
          } else { msg.style.color = 'var(--danger, red)'; msg.textContent = COUPON_ERRORS[data.error] || 'That code could not be used.'; }
        });
      });
    </script>
  `;
}
