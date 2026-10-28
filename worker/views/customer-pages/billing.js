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
  coupon_already_used: "Your organization has already used that code.",
  already_on_plan: "You are already on that plan.",
  plan_change_in_progress: "A plan change is already being processed. Please wait a minute and refresh.",
  plan_change_rejected: "The payment provider did not accept that change. Nothing was charged; contact support if this repeats."
};

function discountText(c) {
  const amount = c.percentOff != null ? `${c.percentOff}% off` : `${(c.amountOffCents / 100).toFixed(2)} off`;
  const when = c.duration === "forever" ? " for as long as you subscribe" : c.duration === "repeating" ? " for a limited number of months" : " on your first payment";
  return amount + when;
}

function planPrice(p) {
  return p.price_cents != null ? formatMoney(p.price_cents, p.currency) + " / " + escapeHtml(p.billing_period) : "Custom";
}

export function renderBillingPage({ subscription, plan, invoices, availablePlans, canManage, canManageBilling = canManage, checkoutStatus, selectedPlanId = null, billingProfile = null, access = null, usage = null, aiCredits = null, cardRequiredTrial = false }) {
  const isPaid = !!(subscription && subscription.provider);
  const isTrialNoCard = !!(subscription && !subscription.provider);

  const banner =
    checkoutStatus === "success"
      ? `<div class="flash flash-success">Thanks. Stripe is confirming your payment; this page updates as soon as it does (usually within a minute). Reload to check.</div>`
      : checkoutStatus === "canceled"
        ? `<div class="flash">Checkout was canceled. Nothing was charged.</div>`
        : "";

  const accessState = String(access?.state || subscription?.status || "active");
  const accessBannerCopy = {
    past_due: "Your last payment failed. Stripe will retry. Update the payment method to avoid interruption.",
    trial_expired: "The trial has ended. Choose a plan to keep making changes.",
    restricted: "This account is read-only until payment is resolved.",
    suspended: "This account is suspended for non-payment. Resolve billing to restore access.",
    closed: "This account is closed. Contact support if you believe this is incorrect.",
    paused: "Billing collection is paused. Check the resume date before making changes."
  };
  const accessBanner = accessBannerCopy[accessState]
    ? `<div class="flash ${["restricted", "suspended", "closed"].includes(accessState) ? "flash-error" : ""}" role="status"><strong>${escapeHtml(accessState.replace(/_/g, " "))}:</strong> ${escapeHtml(accessBannerCopy[accessState])} ${canManageBilling && accessState === "past_due" ? "Use the payment button below to update payment details." : ""}</div>`
    : "";
  const usageCard = usage ? `<section class="card" id="billing-overview"><h2>Overview</h2><div class="grid"><div class="stat"><div class="value">${escapeHtml(String(usage.sites?.used ?? "—"))}${usage.sites?.limit != null ? " / " + escapeHtml(String(usage.sites.limit)) : ""}</div><div class="label">Sites</div></div><div class="stat"><div class="value">${escapeHtml(String(usage.users?.used ?? "—"))}${usage.users?.limit != null ? " / " + escapeHtml(String(usage.users.limit)) : ""}</div><div class="label">Seats</div></div><div class="stat"><div class="value">${escapeHtml(String(usage.customDomains?.used ?? "—"))}${usage.customDomains?.limit != null ? " / " + escapeHtml(String(usage.customDomains.limit)) : ""}</div><div class="label">Domains</div></div><div class="stat"><div class="value">${usage.storageBytes == null ? "Unknown" : escapeHtml(String(usage.storageBytes)) + " bytes"}</div><div class="label">Storage</div></div><div class="stat"><div class="value">${aiCredits == null ? "Unknown" : escapeHtml(String(aiCredits))}</div><div class="label">AI credits</div></div></div></section>` : "";

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
        ${canManageBilling && isPaid ? `<button class="btn btn-secondary"${onClick("lummetPortal", [])}>Update payment method &amp; invoices</button>` : ""}
        ${canManage && isPaid && !subscription.cancel_at_period_end ? `<div class="card" style="margin-top:1rem"><h3>Before you cancel</h3><p>Choose one option; Lummet records only one active save offer at a time.</p><div class="actions"><button class="btn btn-secondary" type="button" data-save-offer="pause">Pause</button><button class="btn btn-secondary" type="button" data-save-offer="downgrade">Review downgrade</button><button class="btn btn-secondary" type="button" data-save-offer="coupon">Check for a one-time coupon</button><button class="btn btn-secondary" type="button" data-save-offer="export">Export my data</button></div><p id="save-offer-message" role="status"></p></div><button class="btn btn-danger"${onClick("lummetCancel", [true])}>Cancel at period end</button>` : ""}
        ${canManage && isTrialNoCard ? `<button class="btn btn-danger"${onClick("lummetCancel", [false])}>Cancel trial</button>` : ""}
      </div>`
    : `
      <div class="card">
        <h2>No plan yet</h2>
        <p style="color:var(--text-dim);font-size:14px;">${cardRequiredTrial ? "Choose a plan below. Your free trial starts on Stripe's secure payment page, where you add a card; you are not charged until the trial ends, and you can cancel before then." : "Choose a plan below. A free trial needs no card; subscribing takes you to Stripe's secure payment page."}</p>
      </div>`;

  const profileCard = canManageBilling ? `
    <div class="card" id="billing-details">
      <h2>Billing details</h2>
      <p style="color:var(--text-dim);font-size:13px">Used for invoices and Stripe Tax when enabled. Changes are sent to Stripe before Lummet saves them. Tax ID is managed by Stripe's tax-ID collection and is not editable here.</p>
      <div id="billing-profile-form">
        <div class="form-grid">
          <label>Legal name<input id="bp-legal-name" maxlength="200" required value="${escapeHtml(billingProfile?.legal_name || "")}"></label>
          <label>Billing email<input id="bp-email" type="email" maxlength="254" required value="${escapeHtml(billingProfile?.billing_email || "")}"></label>
          <label>Address line 1<input id="bp-line1" maxlength="200" required value="${escapeHtml(billingProfile?.address_line1 || "")}"></label>
          <label>Address line 2<input id="bp-line2" maxlength="200" value="${escapeHtml(billingProfile?.address_line2 || "")}"></label>
          <label>City<input id="bp-city" maxlength="100" required value="${escapeHtml(billingProfile?.city || "")}"></label>
          <label>Region / state<input id="bp-region" maxlength="100" value="${escapeHtml(billingProfile?.region || "")}"></label>
          <label>Postal code<input id="bp-postal" maxlength="32" value="${escapeHtml(billingProfile?.postal_code || "")}"></label>
          <label>Country code (ISO 3166-1 alpha-2)<input id="bp-country" maxlength="2" minlength="2" required value="${escapeHtml(billingProfile?.country || "")}"></label>
          <label>Purchase order number<input id="bp-po" maxlength="100" value="${escapeHtml(billingProfile?.po_number || "")}"></label>
          <label><input id="bp-tax-exempt" type="checkbox" ${billingProfile?.tax_exempt ? "checked" : ""}> Tax exempt (only if legally applicable)</label>
        </div>
        <button class="btn" type="button"${onClick("lummetSaveBillingProfile", [])}>Save billing details</button>
        <span id="billing-profile-message" role="status" style="margin-left:8px"></span>
      </div>
    </div>` : "";

  // CARD_REQUIRED_TRIAL: a new customer is only offered plans that can be bought online (a trial starts in Stripe Checkout).
  if (cardRequiredTrial && !subscription) availablePlans = availablePlans.filter((p) => p.active_price_id);
  const showPlans = canManage && availablePlans.length > 0;
  // A customer who arrives with a chosen, buyable plan goes straight to Checkout (not again after they cancel out of it).
  const autoCheckoutPlan = cardRequiredTrial && canManage && !subscription && !checkoutStatus && selectedPlanId
    && availablePlans.some((p) => p.id === selectedPlanId && p.active_price_id) ? selectedPlanId : null;
  const clearIntent = cardRequiredTrial && (!!subscription || !!checkoutStatus || !!autoCheckoutPlan);
  const selectedPlanBanner = selectedPlanId && availablePlans.some((p) => p.id === selectedPlanId)
    ? `<div class="flash" role="status">Your selected plan is ready. Review its terms and choose Continue below when you are ready.</div>` : "";
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
    const buy = p.active_price_id
      ? `<button class="btn"${onClick("lummetCheckout", [p.id])}>${p.id === selectedPlanId ? "Continue with selected plan" : (cardRequiredTrial && !subscription && p.trial_days ? "Start " + escapeHtml(String(p.trial_days)) + "-day trial" : "Subscribe")}</button>`
      : `<span style="color:var(--text-dim);font-size:13px;">Not available online</span>`;
    const trial = !cardRequiredTrial && !subscription && p.trial_days ? `<button class="btn btn-secondary"${onClick("lummetStartTrial", [p.id])}>Start ${escapeHtml(String(p.trial_days))}-day trial</button> ` : "";
    return trial + buy;
  };

  const planOptions = showPlans
    ? `
      <div class="card" id="billing-plans">
        <h2>${isPaid ? "Change plan" : "Available plans"}</h2>
        <table>
          <thead><tr><th>Plan</th><th>Price</th><th>Trial</th><th></th></tr></thead>
          <tbody>
            ${availablePlans.map((p) => `
              <tr class="${p.id === selectedPlanId ? "selected-plan" : ""}">
                <td>${escapeHtml(p.name)}${p.id === selectedPlanId ? ` <span class="badge">Selected</span>` : ""}</td>
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
    <p class="subtitle">Plan, subscription status, usage, invoices and billing details.</p>
    <nav aria-label="Billing sections"><a href="#billing-overview">Overview</a> · <a href="#billing-plans">Plans</a> · <a href="#billing-invoices">Payment and invoices</a> · <a href="#billing-details">Billing details</a></nav>

    ${selectedPlanBanner}
    ${banner}
    ${accessBanner}
    ${usageCard}
    ${currentPlanCard}
    ${profileCard}
    ${couponBox}
    ${planOptions}

    <div class="card" id="billing-invoices">
      <h2>Payment and invoices</h2>
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
      function lummetSaveBillingProfile() {
        var value = function (id) { return (document.getElementById(id).value || '').trim(); };
        var payload = { legal_name:value('bp-legal-name'), billing_email:value('bp-email'), address_line1:value('bp-line1'), address_line2:value('bp-line2'), city:value('bp-city'), region:value('bp-region'), postal_code:value('bp-postal'), country:value('bp-country').toUpperCase(), po_number:value('bp-po'), tax_exempt:document.getElementById('bp-tax-exempt').checked };
        var message = document.getElementById('billing-profile-message');
        fetch('/api/organizations/' + lummetActiveOrgId() + '/billing/profile', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
          .then(function(r){ return r.json(); }).then(function(data){ if(!data.success){ message.textContent='Could not save: '+String(data.error||'unknown error').replace(/_/g,' '); return; } message.textContent='Saved to Stripe and Lummet.'; });
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
        lummetBillingPost('/billing/change-plan', { planId: planId }, 'Could not change plan', function (data) {
          if (data.pending && data.direction === 'downgrade') alert('Your downgrade is scheduled for the end of the current billing period. Your current entitlements stay active until Stripe confirms the change.');
          else if (data.pending) alert('Your plan change has been sent to billing. It takes effect when Stripe confirms it, usually within a minute.');
          location.reload();
        });
      }
      function lummetPortal() {
        lummetBillingPost('/billing/portal', {}, 'Could not open the billing portal', function (data) { window.location.href = data.portalUrl; });
      }
      document.querySelectorAll('[data-save-offer]').forEach(function(btn){btn.addEventListener('click',function(){var msg=document.getElementById('save-offer-message');fetch('/api/organizations/'+lummetActiveOrgId()+'/billing/save-offer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offerKey:btn.getAttribute('data-save-offer')})}).then(function(r){return r.json()}).then(function(j){msg.textContent=j.success?'Offer recorded: '+btn.getAttribute('data-save-offer')+'. Continue with the option above or cancel when ready.':String(j.error||'Could not start this option').replace(/_/g,' ');});});});
      function lummetCancel(atPeriodEnd) {
        if (!confirm(atPeriodEnd ? 'Cancel at the end of the current period? You keep access until then.' : 'Cancel your trial now?')) return;
        var reason = prompt('Please tell us why you are cancelling: too_expensive, missing_feature, technical_issue, switching, not_using, temporary, or other');
        if (!reason) { alert('Please provide a cancellation reason. No cancellation was requested.'); return; }
        reason = reason.trim().toLowerCase();
        var allowed = ['too_expensive','missing_feature','technical_issue','switching','not_using','temporary','other'];
        if (allowed.indexOf(reason) < 0) { alert('Choose one of: ' + allowed.join(', ')); return; }
        fetch('/api/organizations/' + lummetActiveOrgId() + '/billing/cancellation-feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (!data.success) { alert('Could not save cancellation feedback. No cancellation was requested.'); return; }
          lummetBillingPost('/billing/cancel', { atPeriodEnd: atPeriodEnd }, 'Could not cancel');
        }).catch(function () { alert('Could not save cancellation feedback. No cancellation was requested.'); });
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
      ${clearIntent ? "try { localStorage.removeItem('lummetSignupIntent'); } catch (_) {}" : ""}
      ${autoCheckoutPlan ? `lummetCheckout(${JSON.stringify(autoCheckoutPlan).replace(/</g, "\\u003c")});` : ""}
    </script>
  `;
}
