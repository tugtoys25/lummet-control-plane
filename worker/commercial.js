import { queueEmail, emailHash } from "./email.js";
import { stripeRequest } from "./billing-stripe.js";
import * as repo from "./repositories/commercial.js";
// Phase 5 commercial services. Database access stays here rather than in routes.
const id = () => crypto.randomUUID();
const day = (now = new Date()) => now.toISOString().slice(0, 10);

export async function recordCancellationFeedback(env, { organizationId, subscriptionId = null, reason, detail = null, offerShown = null, offerAccepted = false }) {
  const allowed = new Set(["too_expensive", "missing_feature", "technical_issue", "switching", "not_using", "temporary", "other"]);
  const offers = new Set(["pause", "downgrade", "coupon", "export"]);
  if (!organizationId || !allowed.has(reason) || (offerShown && !offers.has(offerShown))) return { ok: false, status: 422, error: "invalid_cancellation_feedback" };
  const cleanDetail = String(detail || "").trim().slice(0, 2000) || null;
  await repo.insertCancellationFeedback(env, { id: id(), organizationId, subscriptionId, reason, detail: cleanDetail, offerShown, offerAccepted: offerAccepted === true });
  return { ok: true };
}

export async function captureUsageSnapshot(env, organizationId, usage, { now = new Date(), source = "control_plane" } = {}) {
  const snapshotDay = day(now);
  const metrics = { sites: usage?.sites?.used, seats: usage?.users?.used, domains: usage?.customDomains?.used, storage_bytes: usage?.storageBytes, ai_credits: usage?.aiCredits };
  let written = 0;
  for (const [metric, value] of Object.entries(metrics)) {
    // Unknown values stay absent; never turn unmeasured data into a fake zero.
    if (!Number.isSafeInteger(value) || value < 0) continue;
    await repo.upsertUsageSnapshot(env, { organizationId, day: snapshotDay, metric, value, source });
    written++;
  }
  return { ok: true, day: snapshotDay, written };
}

export async function listUsageSnapshots(env, organizationId, limit = 90) {
  return repo.selectUsageSnapshots(env, organizationId, Math.min(365, Math.max(1, Number(limit) || 90)));
}

export async function listActiveAddons(env) {
  return repo.selectActiveAddons(env);
}

export async function listActiveCreditPacks(env) {
  return repo.selectActiveCreditPacks(env);
}

export async function createQuote(env, input, { staffId }) {
  const name = String(input?.contact_name || "").trim().slice(0, 200);
  const email = String(input?.contact_email || "").trim().toLowerCase().slice(0, 254);
  const company = String(input?.company_name || "").trim().slice(0, 200) || null;
  const currency = String(input?.currency || "usd").toLowerCase();
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[a-z]{3}$/.test(currency) || !lines.length || lines.length > 30) return { ok: false, status: 422, error: "invalid_quote" };
  for (const line of lines) {
    if (!String(line.plan_key || "").trim() || !String(line.description || "").trim() || !Number.isSafeInteger(line.unit_amount_cents) || line.unit_amount_cents < 0 || !Number.isSafeInteger(line.quantity || 1) || (line.quantity || 1) < 1) return { ok: false, status: 422, error: "invalid_quote_line" };
  }
  const quoteId = id();
  await repo.insertQuote(env, { quoteId, organizationId: input.organization_id || null, name, email, company, currency, validUntil: input.valid_until || null, notes: String(input.notes || "").slice(0, 4000) || null, staffId });
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    await repo.insertQuoteLine(env, { id: id(), quoteId, planKey: String(line.plan_key).trim().slice(0, 100), description: String(line.description).trim().slice(0, 500), quantity: line.quantity || 1, unitAmountCents: line.unit_amount_cents, taxBehavior: ["inclusive","exclusive","unspecified"].includes(line.tax_behavior) ? line.tax_behavior : "exclusive", sortOrder: i });
  }
  return { ok: true, quoteId, status: "draft" };
}

export async function acceptQuote(env, quoteId, { organizationId, userId }) {
  const quote = await repo.findQuote(env, quoteId);
  if (!quote || (quote.organization_id && quote.organization_id !== organizationId)) return { ok: false, status: 404, error: "quote_not_found" };
  if (quote.status !== "sent") return { ok: false, status: 409, error: "quote_not_acceptable" };
  if (quote.valid_until && Date.parse(quote.valid_until) < Date.now()) return { ok: false, status: 409, error: "quote_expired" };
  const result = await repo.acceptQuoteIfSent(env, { quoteId, organizationId, userId });
  if (!(result.meta?.changes > 0)) return { ok: false, status: 409, error: "quote_state_changed" };
  // Acceptance is not payment and does not grant entitlements. Invoice/payment provisioning is an explicit follow-up.
  return { ok: true, quoteId, paymentRequired: true };
}

export async function addStaffBillingNote(env, { organizationId, staffId, note }) {
  const clean = String(note || "").trim();
  if (!organizationId || !staffId || clean.length < 1 || clean.length > 5000) return { ok: false, status: 422, error: "invalid_staff_note" };
  const noteId = id();
  await repo.insertStaffBillingNote(env, { id: noteId, organizationId, staffId, note: clean });
  return { ok: true, noteId };
}

export async function listStaffBillingNotes(env, organizationId, limit = 100) {
  return repo.selectStaffBillingNotes(env, organizationId, Math.min(200, Math.max(1, Number(limit) || 100)));
}

export async function startCreditPackCheckout(env, organizationId, packId, portalOrigin, requestKey) {
  const pack = await repo.findActiveCreditPack(env, packId);
  if (!pack) return { ok: false, status: 422, error: "credit_pack_unavailable" };
  const key = String(requestKey || "").trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) return { ok: false, status: 422, error: "idempotency_key_required" };
  const customer = await repo.findBillingCustomer(env, organizationId);
  if (!customer?.provider_customer_id) return { ok: false, status: 409, error: "billing_customer_required" };
  const session = await stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment", customer: customer.provider_customer_id, client_reference_id: organizationId,
    line_items: [{ price: pack.stripe_price_id, quantity: 1 }],
    success_url: `${portalOrigin}/app/usage?credits=success`, cancel_url: `${portalOrigin}/app/usage?credits=canceled`,
    metadata: { lummet_purchase_type: "credit_pack", organization_id: organizationId, credit_pack_id: pack.id }
  }, { idempotencyKey: `credit-pack-checkout:${organizationId}:${pack.id}:${key}` });
  return { ok: true, checkoutUrl: session.url };
}

export async function grantCreditPackFromCheckout(env, session) {
  if (session?.metadata?.lummet_purchase_type !== "credit_pack") return { handled: false };
  if (session.payment_status !== "paid" || session.mode !== "payment") throw new Error(`credit pack checkout not paid or wrong mode (${session.id})`);
  const organizationId = session.metadata.organization_id || session.client_reference_id;
  const packId = session.metadata.credit_pack_id;
  if (!organizationId || !packId || !session.payment_intent) throw new Error(`credit pack checkout missing required metadata (${session.id})`);
  const pack = await repo.findPurchasedCreditPack(env, packId);
  if (!pack) throw new Error(`credit pack ${packId} is missing or inactive for paid checkout ${session.id}`);
  await repo.insertCreditGrant(env, { id: id(), organizationId, packId: pack.id, paymentId: session.payment_intent, credits: pack.credits });
  // Balance is derived from the unique grant ledger. This avoids a second mutable counter that could drift if a
  // process fails between inserting the grant and incrementing a balance row.
  const balance = await repo.selectCreditBalance(env, organizationId);
  return { handled: true, organizationId, credits: pack.credits, balance: Number(balance?.credits || 0) };
}


// Staff quote lifecycle. Acceptance is deliberately separate from invoicing or entitlement grants.
export async function editQuote(env, quoteId, input, { staffId } = {}) {
  const quote = await repo.findQuote(env, quoteId);
  if (!quote) return { ok: false, status: 404, error: "quote_not_found" };
  if (!["draft"].includes(quote.status)) return { ok: false, status: 409, error: "quote_not_editable" };
  const validUntil = input?.valid_until == null ? quote.valid_until : String(input.valid_until);
  if (validUntil && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now())) return { ok: false, status: 422, error: "invalid_quote_expiry" };
  const contactName = input?.contact_name === undefined ? quote.contact_name : String(input.contact_name).trim();
  const contactEmail = input?.contact_email === undefined ? quote.contact_email : String(input.contact_email).trim().toLowerCase();
  if (!contactName || contactName.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 254) return { ok: false, status: 422, error: "invalid_quote_contact" };
  const lines = input?.lines;
  if (lines !== undefined && (!Array.isArray(lines) || !lines.length || lines.length > 30 || lines.some(x => !String(x.plan_key || "").trim() || !String(x.description || "").trim() || !Number.isSafeInteger(x.unit_amount_cents) || x.unit_amount_cents < 0 || !Number.isSafeInteger(x.quantity || 1) || (x.quantity || 1) < 1))) return { ok: false, status: 422, error: "invalid_quote_lines" };
  const updated = await repo.editQuoteDraftAtomic(env, quoteId, {
    validUntil, notes: input?.notes === undefined ? quote.notes : String(input.notes || "").slice(0, 4000),
    name: contactName.slice(0, 200), email: contactEmail.slice(0, 254),
    company: input?.company_name === undefined ? quote.company_name : String(input.company_name || "").trim().slice(0, 200) || null,
    staffId
  }, lines);
  if (!updated.ok) return updated;
  return { ok: true, quoteId };
}
export async function sendQuote(env, quoteId, { staffId } = {}) {
  const q = await repo.findQuote(env, quoteId);
  if (!q) return { ok: false, status: 404, error: "quote_not_found" };
  if (q.status !== "draft") return { ok: false, status: 409, error: "quote_not_draft" };
  if (q.valid_until && Date.parse(q.valid_until) <= Date.now()) return { ok: false, status: 422, error: "quote_expired" };
  const lines = await repo.listQuoteLines(env, quoteId);
  if (!lines.length) return { ok: false, status: 422, error: "quote_has_no_lines" };
  const linesText = lines.map((line) => `${line.quantity} × ${line.description}: ${(line.unit_amount_cents * line.quantity / 100).toFixed(2)} ${q.currency.toUpperCase()}`).join("\n");
  const queued = await queueEmail(env, {
    to: q.contact_email, template: "notification", organizationId: q.organization_id || null,
    dedupeKey: `quote:${quoteId}:send`,
    vars: { subject: `Lummet business quote ${quoteId}`, message: `Hello ${q.contact_name},\n\nYour quote is ready for review. It is valid until ${q.valid_until || "further notice"}.\n\n${linesText}\n\nAcceptance does not create an invoice or activate entitlements. Please sign in to your Lummet account to review it.` }
  });
  if (!queued.ok) return { ok: false, status: 503, error: "quote_email_queue_failed" };
  await repo.markQuoteSent(env, quoteId, staffId);
  return { ok: true, quoteId, status: "sent", emailQueued: true };
}
export async function expireQuotes(env, now = new Date()) {
  return repo.expireQuotes(env, now.toISOString());
}
export async function getCustomer360(env, organizationId) {
  const data = await repo.selectCustomer360(env, organizationId);
  if (!data) return null;
  return { ...data, notes: await repo.selectStaffBillingNotes(env, organizationId, 50) };
}
export async function listQuoteQueue(env, { limit = 50, offset = 0 } = {}) {
  return repo.listQuotes(env, Math.min(100, Math.max(1, Number(limit)||50)), Math.max(0, Number(offset)||0));
}


// ---- v2.5.2.4 Phase 5 completion ----
export async function changeAddon(env, organizationId, addonId, quantity, { requestKey, provider = null } = {}) {
  const q = Number(quantity); const key = String(requestKey || '').trim();
  if (!Number.isInteger(q) || q < 1 || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) return { ok:false,status:422,error:'invalid_addon_change' };
  const addon = await repo.findActiveAddon(env, addonId); if (!addon) return {ok:false,status:404,error:'addon_unavailable'};
  const sub = await repo.activeSubscriptionForOrganization(env, organizationId);
  if (!sub?.provider_subscription_id) return {ok:false,status:409,error:'no_provider_subscription'};
  const existing = await repo.findAddonForSubscription(env, sub.id, addonId);
  const idempotencyKey = `addon:${organizationId}:${addonId}:${q}:${key}`;
  const prior = await repo.findAddonIntentByKey(env,idempotencyKey); if (prior) return {ok:true,pending:prior.status!=='confirmed',intentId:prior.id,status:prior.status,duplicate:true};
  const intentId=id();
  await repo.insertAddonIntent(env,{id:intentId,organizationId,subscriptionId:sub.id,addonId,fromQuantity:Number(existing?.quantity||0),toQuantity:q,idempotencyKey});
  try {
    const result = provider ? await provider.changeSubscriptionAddon(env, sub.provider_subscription_id, {priceId:addon.stripe_price_id,quantity:q,subscriptionItemId:existing?.provider_subscription_item_id,idempotencyKey}) : await billingProviderAddon(env, sub.provider_subscription_id, addon, q, existing?.provider_subscription_item_id, idempotencyKey);
    await repo.upsertSubscriptionAddon(env,{subscriptionId:sub.id,addonId,quantity:q});
    await repo.updateAddonIntent(env,intentId,{status:'submitted',provider_subscription_item_id:result.subscriptionItemId});
    return {ok:true,pending:true,intentId,status:'submitted',quantity:q};
  } catch (e) {
    await repo.updateAddonIntent(env,intentId,{status:'failed',last_error:e?.message||String(e)});
    return {ok:false,status:502,error:'addon_change_failed'};
  }
}
async function billingProviderAddon(env, subscriptionId, addon, quantity, subscriptionItemId, idempotencyKey) {
  const { changeSubscriptionAddon } = await import('./billing-stripe.js');
  return changeSubscriptionAddon(env,subscriptionId,{priceId:addon.stripe_price_id,quantity,subscriptionItemId,idempotencyKey});
}

export async function beginSaveOffer(env, organizationId, subscriptionId, offerKey, detail='') {
  const valid = new Set(['pause','downgrade','coupon','export']); if(!valid.has(offerKey)) return {ok:false,status:422,error:'invalid_save_offer'};
  const active=await repo.activeSaveOffer(env,subscriptionId); if(active) return {ok:false,status:409,error:'save_offer_already_active',offer:active};
  const row={id:id(),organizationId,subscriptionId,offerKey,status:'shown',detail:String(detail||'').slice(0,1000)}; await repo.insertSaveOffer(env,row); return {ok:true,offer:row};
}
export async function completeSaveOffer(env, offerId, status='accepted') { if(!['accepted','declined','completed','expired'].includes(status)) return {ok:false,status:422,error:'invalid_save_offer_status'}; await repo.updateSaveOffer(env,offerId,status); return {ok:true}; }

export async function recordImmediateCancelDecision(env,{organizationId,subscriptionId,staffId,refundDecision='none',refundAmountCents=0,currency='usd',reason}) {
  if(!staffId || !reason || !['none','full','partial'].includes(refundDecision) || !Number.isSafeInteger(refundAmountCents) || refundAmountCents<0) return {ok:false,status:422,error:'invalid_refund_decision'};
  const sub=await repo.subscriptionForOrganization(env,subscriptionId,organizationId); if(!sub) return {ok:false,status:404,error:'subscription_not_found'};
  const decision={id:id(),organizationId,subscriptionId,staffId,refundDecision,refundAmountCents,currency:String(currency||'usd').toLowerCase(),reason:String(reason).trim().slice(0,2000)};
  await repo.insertImmediateCancelDecision(env,decision); return {ok:true,decisionId:decision.id};
}
export async function immediateCancelStaff(env,organizationId,subscriptionId,{staffId,reason}={}) {
  const d=await repo.latestImmediateCancelDecision(env,subscriptionId,organizationId);
  if(!d || d.staff_id!==staffId) return {ok:false,status:409,error:'refund_decision_required'};
  const sub=await repo.subscriptionForOrganization(env,subscriptionId,organizationId); if(!sub?.provider_subscription_id) return {ok:false,status:404,error:'subscription_not_found'};
  const { cancelSubscription }=await import('./billing-stripe.js');
  try { await cancelSubscription(env,sub.provider_subscription_id,{atPeriodEnd:false}); } catch { return {ok:false,status:502,error:'provider_cancel_failed'}; }
  return {ok:true,refundDecision:d.refund_decision,refundAmountCents:d.refund_amount_cents};
}


export async function listQuoteLinesForEntitlements(env,quoteId){return repo.listQuoteLines(env,quoteId);}
export async function grantQuoteEntitlementsAfterPayment(env,quote,lines){const entitlements={};for(const line of lines||[]){const r=await repo.entitlementRowsForPlanKey(env,line.plan_key);for(const x of r)entitlements[x.key]={type:x.value_type,value:x.value};}await repo.upsertQuoteEntitlementGrant(env,{organizationId:quote.organization_id,quoteId:quote.id,entitlements});return {ok:true};}

export async function sendQuoteInvoice(env, quoteId, { staffId, reason, mode='one_time' } = {}) {
  if(!staffId||!String(reason||'').trim())return {ok:false,status:422,error:'reason_required'};
  const q=await repo.findQuote(env,quoteId); if(!q||q.status!=='invoiced'||!q.stripe_invoice_id)return {ok:false,status:409,error:'quote_invoice_not_ready'};
  const {stripeRequest}=await import('./billing-stripe.js');
  try {
    const finalized=await stripeRequest(env,'POST',`/invoices/${encodeURIComponent(q.stripe_invoice_id)}/finalize`,{}, {idempotencyKey:`quote-finalize:${quoteId}`});
    await stripeRequest(env,'POST',`/invoices/${encodeURIComponent(q.stripe_invoice_id)}/send`,{}, {idempotencyKey:`quote-send:${quoteId}`});
    const lines=await repo.listQuoteLines(env,quoteId); const entitlements={};
    for(const line of lines){const r=await repo.entitlementRowsForPlanKey(env,line.plan_key);for(const x of r)entitlements[x.key]={type:x.value_type,value:x.value};}
    await repo.updateQuoteInvoiced(env,quoteId);
    return {ok:true,providerInvoiceId:q.stripe_invoice_id,finalized:!!finalized,mode,entitlementsAfterPayment:true};
  } catch { return {ok:false,status:502,error:'quote_invoice_send_failed'}; }
}

export async function founderLicenseInvoice(env,quoteId,{staffId,reason}={}) {
  if(String(env.FOUNDER_LICENSE_ENABLED||'off').toLowerCase()!=='on') return {ok:false,status:404,error:'founder_license_disabled'};
  const q=await repo.findQuote(env,quoteId); if(!q||q.status!=='accepted') return {ok:false,status:409,error:'quote_not_accepted'};
  if(q.created_by===staffId) return {ok:false,status:403,error:'creator_cannot_fulfill'};
  const customer=await repo.findBillingCustomer(env,q.organization_id); if(!customer?.provider_customer_id) return {ok:false,status:409,error:'billing_customer_required'};
  const lines=await repo.listQuoteLines(env,quoteId); if(!lines.length)return {ok:false,status:422,error:'quote_has_no_lines'};
  const {stripeRequest}=await import('./billing-stripe.js');
  const invoice=await stripeRequest(env,'POST','/invoices',{customer:customer.provider_customer_id,currency:q.currency,collection_method:'send_invoice',days_until_due:14,auto_advance:false,pending_invoice_items_behavior:'exclude',metadata:{lummet_quote_id:quoteId,founder_license:'1',organization_id:q.organization_id}},{idempotencyKey:`founder-license:${quoteId}`});
  for(const line of lines) await stripeRequest(env,'POST','/invoiceitems',{customer:customer.provider_customer_id,invoice:invoice.id,currency:q.currency,description:line.description,quantity:line.quantity,unit_amount:line.unit_amount_cents,metadata:{lummet_quote_id:quoteId,founder_license:'1'}},{idempotencyKey:`founder-license-line:${quoteId}:${line.id}`});
  return {ok:true,providerInvoiceId:invoice.id,organizationId:q.organization_id,draft:true,reason:String(reason||'').trim()};
}

export async function grantFounderLicenseFromPaidInvoice(env,invoice) {
  if(invoice?.metadata?.founder_license!=='1') return {handled:false};
  const organizationId=invoice.metadata.organization_id; const quoteId=invoice.metadata.lummet_quote_id; if(!organizationId||!quoteId) throw new Error('founder license invoice missing metadata');
  const lines=await repo.listQuoteLines(env,quoteId); const entitlements={};
  for(const line of lines){ try { const p=await repo.entitlementRowsForPlanKey(env,line.plan_key); for(const x of p) entitlements[x.key]={type:x.value_type,value:x.value}; } catch {} }
  await repo.upsertFounderLicense(env,{organizationId,quoteId,providerInvoiceId:invoice.id,entitlements,grantedBy:'billing_webhook'}); return {handled:true,organizationId};
}

export async function listTaxChecklist(env){return repo.listTaxChecklist(env)}
export async function updateTaxChecklist(env,{jurisdiction,status,evidenceUrl,notes,staffId}){if(!jurisdiction||!['unknown','pending','verified','not_applicable'].includes(status)||!staffId)return {ok:false,status:422,error:'invalid_tax_checklist'};await repo.upsertTaxChecklist(env,{id:id(),jurisdiction:String(jurisdiction).slice(0,100),status,evidenceUrl:evidenceUrl?String(evidenceUrl).slice(0,1000):null,notes:String(notes||'').slice(0,2000),updatedBy:staffId});return {ok:true};}
// ---- v2.5.2.2 ----
// Credit-pack refund reversal. The reversed amount follows the refunded share of the charge and only ever grows,
// so duplicate, replayed and out-of-order refund webhooks converge on the same result.
export async function reverseCreditPackForRefund(env, charge) {
  const paymentIntent = charge?.payment_intent;
  if (!paymentIntent) return { handled: false };
  const grant = await repo.findCreditGrantByPayment(env, String(paymentIntent));
  if (!grant) return { handled: false };
  const captured = Number(charge.amount_captured ?? charge.amount);
  const refunded = Number(charge.amount_refunded);
  if (!Number.isSafeInteger(captured) || captured <= 0 || !Number.isSafeInteger(refunded) || refunded <= 0) return { handled: true, reversed: 0 };
  const target = refunded >= captured ? grant.credits : Math.floor((grant.credits * refunded) / captured);
  if (target > 0) await repo.raiseCreditReversal(env, { grantId: grant.id, organizationId: grant.organization_id, credits: target });
  const balance = await repo.selectNetCreditBalance(env, grant.organization_id);
  return { handled: true, organizationId: grant.organization_id, reversed: target, balance: Number(balance?.credits || 0) };
}
export async function getNetCreditBalance(env, organizationId) {
  return Number((await repo.selectNetCreditBalance(env, organizationId))?.credits || 0);
}
// Dunning queue and reason-required actions. Callers must audit-log with the staff reason.
export async function listDunningQueue(env, { limit = 50, offset = 0 } = {}) {
  return repo.selectDunningQueue(env, Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
}
export async function extendGrace(env, subscriptionId, { days, reason, staffId, now = new Date() }) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 30) return { ok: false, status: 422, error: "invalid_grace_days" };
  const cleanReason = String(reason || "").trim();
  if (!cleanReason || !staffId) return { ok: false, status: 422, error: "reason_required" };
  const sub = await repo.findSubscriptionForDunning(env, subscriptionId);
  if (!sub) return { ok: false, status: 404, error: "subscription_not_found" };
  if (sub.status !== "past_due") return { ok: false, status: 409, error: "subscription_not_past_due" };
  const base = Math.max(now.getTime(), Date.parse(sub.grace_ends_at) || 0);
  const until = new Date(base + d * 86400000).toISOString();
  const updated = await repo.extendGraceIfPastDue(env, subscriptionId, until, "past_due");
  if (!(updated.meta?.changes > 0)) return { ok: false, status: 409, error: "subscription_state_changed" };
  await repo.insertDunningAction(env, { id: id(), subscriptionId, organizationId: sub.organization_id, action: "extend_grace", reason: cleanReason.slice(0, 500), staffId, detail: until });
  return { ok: true, graceEndsAt: until, organizationId: sub.organization_id };
}
export async function resendDunningNotice(env, subscriptionId, { reason, staffId, now = new Date() }) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason || !staffId) return { ok: false, status: 422, error: "reason_required" };
  const sub = await repo.findSubscriptionForDunning(env, subscriptionId);
  if (!sub) return { ok: false, status: 404, error: "subscription_not_found" };
  if (!["past_due", "restricted"].includes(sub.status)) return { ok: false, status: 409, error: "subscription_not_in_dunning" };
  const owners = await repo.selectVerifiedOwnerEmails(env, sub.organization_id);
  const recipients = [];
  for (const email of owners) {
    const hash = await emailHash(email);
    if (!(await repo.isEmailSuppressed(env, hash))) recipients.push({ email, hash });
  }
  if (!recipients.length) return { ok: false, status: 409, error: "no_eligible_recipient" };
  for (const r of recipients) {
    const queued = await queueEmail(env, {
      to: r.email, template: "notification", organizationId: sub.organization_id,
      dedupeKey: `dunning-resend:${subscriptionId}:${day(now)}:${r.hash.slice(0, 16)}`,
      vars: { subject: "Action needed: update your payment method", message: "We could not collect your latest payment. Please sign in to your Lummet account and update your payment method to keep your sites running." }
    });
    if (!queued.ok) return { ok: false, status: 503, error: "notice_queue_failed" };
  }
  await repo.insertDunningAction(env, { id: id(), subscriptionId, organizationId: sub.organization_id, action: "resend_notice", reason: cleanReason.slice(0, 500), staffId });
  return { ok: true, organizationId: sub.organization_id };
}

// Comp: staff forgive ONE open invoice of a subscription that is in dunning by voiding it in Stripe. Nothing is charged or
// refunded, and the local invoice/subscription state still changes only when Stripe's webhook confirms it. The claim row is
// written first (unique per subscription+invoice) so a double click or two staff members create exactly one void; a Stripe
// failure removes the claim so the action can be retried, and the Stripe idempotency key makes a retry safe either way.
export async function requestCompApproval(env, subscriptionId, { invoiceId, reason, staffId } = {}) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason || !staffId) return { ok: false, status: 422, error: "reason_required" };
  const sub = await repo.findSubscriptionForDunning(env, subscriptionId);
  if (!sub) return { ok: false, status: 404, error: "subscription_not_found" };
  if (!["past_due", "restricted"].includes(sub.status)) return { ok: false, status: 409, error: "subscription_not_in_dunning" };
  const open = await repo.selectOpenInvoicesForSubscription(env, subscriptionId);
  const target = invoiceId ? open.find((i) => i.id === String(invoiceId)) : (open.length === 1 ? open[0] : null);
  if (!target) return { ok: false, status: open.length > 1 && !invoiceId ? 422 : 404, error: open.length > 1 && !invoiceId ? "invoice_id_required" : "open_invoice_not_found" };
  if (!Number.isSafeInteger(target.amount_due_cents) || target.amount_due_cents <= 0) return { ok: false, status: 422, error: "nothing_to_comp" };
  const requestId = id();
  try {
    await repo.insertApprovalRequest(env, { id: requestId, kind: "dunning_comp", organizationId: sub.organization_id, amount: target.amount_due_cents, currency: target.currency, payloadJson: JSON.stringify({ subscriptionId, invoiceId: target.id }), reason: cleanReason.slice(0, 1000), requestedBy: staffId });
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) return { ok: false, status: 409, error: "comp_already_requested", organizationId: sub.organization_id };
    throw error;
  }
  // A comp is always decided by a second staff member: the amount threshold does not apply to forgiving an invoice.
  return { ok: true, requestId, status: "pending", needsSecondApprover: true, organizationId: sub.organization_id, invoiceId: target.id, amountDueCents: target.amount_due_cents };
}
// Executor only: reached through an approved request, never directly from a route.
async function compInvoice(env, subscriptionId, { invoiceId, reason, staffId, stripe = stripeRequest } = {}) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason || !staffId) return { ok: false, status: 422, error: "reason_required" };
  const sub = await repo.findSubscriptionForDunning(env, subscriptionId);
  if (!sub) return { ok: false, status: 404, error: "subscription_not_found" };
  if (!["past_due", "restricted"].includes(sub.status)) return { ok: false, status: 409, error: "subscription_not_in_dunning" };
  const open = await repo.selectOpenInvoicesForSubscription(env, subscriptionId);
  const target = invoiceId ? open.find((i) => i.id === String(invoiceId)) : (open.length === 1 ? open[0] : null);
  if (!target) return { ok: false, status: open.length > 1 && !invoiceId ? 422 : 404, error: open.length > 1 && !invoiceId ? "invoice_id_required" : "open_invoice_not_found" };
  const actionId = id();
  const claim = await repo.insertCompAction(env, { id: actionId, subscriptionId, organizationId: sub.organization_id, reason: cleanReason.slice(0, 500), staffId, invoiceId: target.id });
  if (!(claim.meta?.changes > 0)) return { ok: false, status: 409, error: "invoice_already_comped" };
  try {
    await stripe(env, "POST", `/v1/invoices/${encodeURIComponent(target.provider_invoice_id)}/void`, {}, { idempotencyKey: `dunning-comp:${subscriptionId}:${target.id}` });
  } catch (error) {
    await repo.deleteCompAction(env, actionId);
    return { ok: false, status: 502, error: "stripe_void_failed", organizationId: sub.organization_id };
  }
  return { ok: true, organizationId: sub.organization_id, invoiceId: target.id, amountDueCents: target.amount_due_cents, currency: target.currency };
}

// Four-eyes approvals. FOUR_EYES_THRESHOLD_CENTS is owner-set; when it is missing or invalid every request needs a
// second staff member (fail closed). A requester can never approve or reject their own request.
export function fourEyesThreshold(env) {
  const raw = env?.FOUR_EYES_THRESHOLD_CENTS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
export async function requestApproval(env, { kind, organizationId, amount, currency = null, paymentId = null, reason, staffId }) {
  const cleanReason = String(reason || "").trim();
  if (!["refund", "credit_adjustment"].includes(kind) || !organizationId || !staffId || !cleanReason) return { ok: false, status: 422, error: "invalid_approval_request" };
  if (!Number.isSafeInteger(amount) || amount === 0 || (kind === "refund" && amount < 0)) return { ok: false, status: 422, error: "invalid_amount" };
  let payload = {};
  if (kind === "refund") {
    const payment = paymentId ? await repo.findPaymentForRefund(env, String(paymentId)) : null;
    if (!payment || payment.organization_id !== organizationId) return { ok: false, status: 404, error: "payment_not_found" };
    const already = await repo.selectRefundedCents(env, payment.id);
    if (amount + already > payment.amount_cents) return { ok: false, status: 422, error: "refund_exceeds_payment" };
    payload = { paymentId: payment.id };
    currency = payment.currency;
  }
  const requestId = id();
  await repo.insertApprovalRequest(env, { id: requestId, kind, organizationId, amount, currency, payloadJson: JSON.stringify(payload), reason: cleanReason.slice(0, 1000), requestedBy: staffId });
  const needsSecondApprover = Math.abs(amount) >= fourEyesThreshold(env);
  if (needsSecondApprover) {
    const staff = await repo.listActiveStaffEmails(env,staffId);
    for (const a of staff) await queueEmail(env,{to:a.email,template:'notification',organizationId:null,dedupeKey:`approval:${requestId}:${a.email}`,vars:{subject:`Lummet approval required: ${kind}`,message:`Approval request ${requestId} needs a second staff decision. Amount: ${amount} ${currency||''}. Reason: ${cleanReason.slice(0,500)}.`}});
  }
  return { ok: true, requestId, status: "pending", needsSecondApprover };
}
async function executeApproval(env, req, deciderId = null) {
  try {
    if (req.kind === "dunning_comp") {
      const payload = JSON.parse(req.payload_json || "{}");
      const result = await compInvoice(env, payload.subscriptionId, { invoiceId: payload.invoiceId, reason: `approved request ${req.id}: ${req.reason}`, staffId: deciderId || req.decided_by || "approver" });
      if (!result.ok) throw new Error(result.error);
    } else if (req.kind === "credit_adjustment") {
      await repo.insertCreditAdjustment(env, { organizationId: req.organization_id, amount: req.amount, key: `approval:${req.id}`, note: `staff approval ${req.id}` });
    } else {
      const payload = JSON.parse(req.payload_json || "{}");
      const payment = await repo.findPaymentForRefund(env, payload.paymentId);
      if (!payment) throw new Error("payment_not_found");
      await stripeRequest(env, "POST", "/refunds", { charge: payment.provider_payment_id, amount: req.amount, metadata: { lummet_approval_request: req.id, organization_id: req.organization_id } }, { idempotencyKey: `staff-refund:${req.id}` });
    }
    await repo.markApprovalExecuted(env, req.id);
    return { ok: true, status: "executed" };
  } catch (e) {
    await repo.markApprovalFailed(env, req.id, String(e?.message || "execution_failed").replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 100));
    return { ok: false, status: 502, error: "approval_execution_failed" };
  }
}
export async function decideApproval(env, requestId, { decision, staffId, reason }) {
  if (!["approve", "reject"].includes(decision) || !staffId) return { ok: false, status: 422, error: "invalid_decision" };
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) return { ok: false, status: 422, error: "reason_required" };
  const req = await repo.findApprovalRequest(env, requestId);
  if (!req) return { ok: false, status: 404, error: "approval_not_found" };
  if (req.requested_by === staffId) return { ok: false, status: 403, error: "self_approval_forbidden" };
  const won = await repo.decideApprovalIfPending(env, { id: requestId, status: decision === "approve" ? "approved" : "rejected", decidedBy: staffId, decisionReason: cleanReason.slice(0, 1000) });
  if (!(won.meta?.changes > 0)) return { ok: false, status: 409, error: "approval_not_pending" };
  if (decision === "reject") return { ok: true, status: "rejected", organizationId: req.organization_id };
  const executed = await executeApproval(env, req, staffId);
  return { ...executed, organizationId: req.organization_id };
}
export async function listApprovals(env, { status = null, limit = 50, offset = 0 } = {}) {
  const st = ["pending", "approved", "rejected", "executed", "failed"].includes(status) ? status : null;
  return repo.listApprovalRequests(env, st, Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
}

// Accepted quote -> DRAFT Stripe invoice. Nothing is sent to the customer and no entitlement or subscription is
// granted; staff review and finalise the draft in Stripe. The person who created the quote cannot also fulfil it.
export async function fulfillQuote(env, quoteId, { staffId, reason }) {
  const cleanReason = String(reason || "").trim();
  if (!staffId || !cleanReason) return { ok: false, status: 422, error: "reason_required" };
  const q = await repo.findQuote(env, quoteId);
  if (!q) return { ok: false, status: 404, error: "quote_not_found" };
  if (q.status === "invoiced" && q.stripe_invoice_id) return { ok: true, quoteId, providerInvoiceId: q.stripe_invoice_id, alreadyFulfilled: true, organizationId: q.organization_id };
  if (q.status !== "accepted") return { ok: false, status: 409, error: "quote_not_accepted" };
  if (!q.organization_id) return { ok: false, status: 409, error: "quote_has_no_organization" };
  if (q.created_by && q.created_by === staffId) return { ok: false, status: 403, error: "creator_cannot_fulfill" };
  const customer = await repo.findBillingCustomer(env, q.organization_id);
  if (!customer?.provider_customer_id) return { ok: false, status: 409, error: "billing_customer_required" };
  const lines = await repo.listQuoteLines(env, quoteId);
  if (!lines.length) return { ok: false, status: 422, error: "quote_has_no_lines" };
  const claimed = await repo.claimQuoteFulfillment(env, quoteId);
  if (!(claimed.meta?.changes > 0)) return { ok: false, status: 409, error: "fulfillment_in_progress" };
  try {
    const invoice = await stripeRequest(env, "POST", "/invoices", {
      customer: customer.provider_customer_id, currency: q.currency, collection_method: "send_invoice", days_until_due: 14,
      auto_advance: false, pending_invoice_items_behavior: "exclude",
      metadata: { lummet_quote_id: quoteId, organization_id: q.organization_id }
    }, { idempotencyKey: `quote-invoice:${quoteId}` });
    for (const line of lines) {
      await stripeRequest(env, "POST", "/invoiceitems", {
        customer: customer.provider_customer_id, invoice: invoice.id, currency: q.currency, description: line.description,
        quantity: line.quantity, unit_amount: line.unit_amount_cents,
        metadata: { lummet_quote_id: quoteId, quote_line_id: line.id }
      }, { idempotencyKey: `quote-invoice-line:${quoteId}:${line.id}` });
    }
    await repo.markQuoteFulfilled(env, { quoteId, staffId, providerInvoiceId: invoice.id });
    return { ok: true, quoteId, providerInvoiceId: invoice.id, draft: true, organizationId: q.organization_id };
  } catch (e) {
    // Stripe idempotency keys make a retry reuse the same draft invoice and items, so releasing the claim is safe.
    await repo.releaseQuoteFulfillmentClaim(env, quoteId);
    return { ok: false, status: 502, error: "quote_invoice_failed", organizationId: q.organization_id };
  }
}

export async function confirmAddonIntentsFromSubscription(env, subscription, providerObject) {
  const items=providerObject?.items?.data||[]; const intents=await repo.listPendingAddonIntents(env,subscription.id); let confirmed=0;
  for(const i of intents){ const item=items.find(x=>x.price?.id===i.stripe_price_id); if(!item) continue; const qty=Number(item.quantity||i.to_quantity); await repo.upsertSubscriptionAddon(env,{subscriptionId:subscription.id,addonId:i.addon_id,quantity:qty}); await repo.updateAddonIntent(env,i.id,{status:'confirmed',provider_subscription_item_id:item.id}); confirmed++; }
  return confirmed;
}
export async function reconcileCreditPacks(env,{limit=100}={}){const grants=await repo.listCreditGrants(env,Math.min(100,Math.max(1,Number(limit)||100)),0);const {stripeRequest}=await import('./billing-stripe.js');const findings=[];for(const g of grants){try{const pi=await stripeRequest(env,'GET',`/payment_intents/${encodeURIComponent(g.provider_payment_id)}`);const amount=Number(pi?.amount_received ?? pi?.amount);const currency=String(pi?.currency||g.currency||'usd').toLowerCase();const ok=Number.isSafeInteger(amount)&&amount===Number(g.price_cents)&&currency===String(g.currency).toLowerCase();const f={id:id(),grantId:g.id,providerPaymentId:g.provider_payment_id,expectedAmountCents:Number(g.price_cents),providerAmountCents:Number.isSafeInteger(amount)?amount:null,currency,status:ok?'match':'mismatch',detail:ok?null:'provider payment does not match catalog pack'};await repo.upsertCreditPackReconciliation(env,f);findings.push(f);}catch(e){const f={id:id(),grantId:g.id,providerPaymentId:g.provider_payment_id,expectedAmountCents:Number(g.price_cents),providerAmountCents:null,currency:g.currency,status:'unavailable',detail:'provider lookup failed'};await repo.upsertCreditPackReconciliation(env,f);findings.push(f);}}return {ok:findings.every(x=>x.status==='match'),checked:findings.length,findings};}

// Re-export: worker/index.js calls commercial.latestActiveSubscriptionId (save-offer endpoint); it lives in the repository module.
export const latestActiveSubscriptionId = (env, organizationId) => repo.latestActiveSubscriptionId(env, organizationId);
