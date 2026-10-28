// SQL-only repository for Phase 5 commercial data. Business rules live in worker/commercial.js.
export async function insertCancellationFeedback(env, row) {
  return env.LUMMET_DB.prepare(`INSERT INTO cancellation_feedback (id, organization_id, subscription_id, reason, detail, offer_shown, offer_accepted) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.organizationId, row.subscriptionId, row.reason, row.detail, row.offerShown, row.offerAccepted ? 1 : 0).run();
}
export async function upsertUsageSnapshot(env, { organizationId, day, metric, value, source }) {
  return env.LUMMET_DB.prepare(`INSERT INTO usage_snapshots (organization_id, day, metric, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(organization_id, day, metric) DO UPDATE SET value=excluded.value, source=excluded.source, captured_at=CURRENT_TIMESTAMP`)
    .bind(organizationId, day, metric, value, source).run();
}
export async function selectUsageSnapshots(env, organizationId, limit) {
  const r = await env.LUMMET_DB.prepare(`SELECT day, metric, value, source, captured_at FROM usage_snapshots WHERE organization_id=? ORDER BY day DESC, metric LIMIT ?`).bind(organizationId, limit).all();
  return r.results || [];
}
export async function selectActiveAddons(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, key, name, entitlement_key, delta_per_unit, stripe_price_id FROM addons WHERE active=1 ORDER BY name`).all();
  return r.results || [];
}
export async function insertQuote(env, q) {
  return env.LUMMET_DB.prepare(`INSERT INTO quotes (id, organization_id, contact_name, contact_email, company_name, currency, valid_until, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(q.quoteId, q.organizationId, q.name, q.email, q.company, q.currency, q.validUntil, q.notes, q.staffId).run();
}
export async function insertQuoteLine(env, q) {
  return env.LUMMET_DB.prepare(`INSERT INTO quote_lines (id, quote_id, plan_key, description, quantity, unit_amount_cents, tax_behavior, entitlement_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(q.id, q.quoteId, q.planKey, q.description, q.quantity, q.unitAmountCents, q.taxBehavior, null, q.sortOrder).run();
}
export async function findQuote(env, quoteId) { return env.LUMMET_DB.prepare(`SELECT * FROM quotes WHERE id=?`).bind(quoteId).first(); }
export async function acceptQuoteIfSent(env, { quoteId, organizationId, userId }) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET status='accepted', organization_id=COALESCE(organization_id, ?), accepted_by=?, accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sent'`)
    .bind(organizationId, userId, quoteId).run();
}
export async function insertStaffBillingNote(env, { id, organizationId, staffId, note }) {
  return env.LUMMET_DB.prepare(`INSERT INTO staff_billing_notes (id, organization_id, author_staff_id, note) VALUES (?, ?, ?, ?)`)
    .bind(id, organizationId, staffId, note).run();
}
export async function selectStaffBillingNotes(env, organizationId, limit) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, organization_id, author_staff_id, note, created_at FROM staff_billing_notes WHERE organization_id=? ORDER BY created_at DESC LIMIT ?`).bind(organizationId, limit).all();
  return r.results || [];
}
export async function findActiveCreditPack(env, packId) { return env.LUMMET_DB.prepare(`SELECT * FROM credit_packs WHERE id=? AND active=1`).bind(packId).first(); }
export async function findBillingCustomer(env, organizationId) { return env.LUMMET_DB.prepare(`SELECT provider_customer_id FROM billing_customers WHERE organization_id=? AND provider='stripe'`).bind(organizationId).first(); }
export async function findPurchasedCreditPack(env, packId) { return env.LUMMET_DB.prepare(`SELECT id, credits FROM credit_packs WHERE id=?`).bind(packId).first(); }
export async function insertCreditGrant(env, row) {
  return env.LUMMET_DB.prepare(`INSERT INTO credit_pack_grants (id, organization_id, credit_pack_id, provider_payment_id, credits) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_payment_id) DO NOTHING`)
    .bind(row.id, row.organizationId, row.packId, row.paymentId, row.credits).run();
}
export async function selectCreditBalance(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT COALESCE(SUM(credits),0) AS credits FROM credit_pack_grants WHERE organization_id=?`).bind(organizationId).first();
}
export async function selectActiveCreditPacks(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, credits, price_cents, currency FROM credit_packs WHERE active=1 ORDER BY price_cents`).all();
  return r.results || [];
}

export async function selectSubscriptionAddons(env, subscriptionId) {
  const r = await env.LUMMET_DB.prepare(`SELECT a.entitlement_key, a.delta_per_unit, sa.quantity FROM subscription_addons sa JOIN addons a ON a.id = sa.addon_id WHERE sa.subscription_id = ? AND a.active = 1`).bind(subscriptionId).all();
  return r.results || [];
}

export async function updateQuoteDraft(env, id, q) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET contact_name=?,contact_email=?,company_name=?,valid_until=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'`)
    .bind(q.name,q.email,q.company,q.validUntil,q.notes,id).run();
}
export async function editQuoteDraftAtomic(env, id, q, lines) {
  const statements = [env.LUMMET_DB.prepare(`UPDATE quotes SET contact_name=?,contact_email=?,company_name=?,valid_until=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'`)
    .bind(q.name,q.email,q.company,q.validUntil,q.notes,id)];
  if (lines) {
    statements.push(env.LUMMET_DB.prepare(`DELETE FROM quote_lines WHERE quote_id=? AND EXISTS (SELECT 1 FROM quotes WHERE id=? AND status='draft')`).bind(id,id));
    for (let i=0;i<lines.length;i++) {
      const x=lines[i];
      statements.push(env.LUMMET_DB.prepare(`INSERT INTO quote_lines (id,quote_id,plan_key,description,quantity,unit_amount_cents,tax_behavior,sort_order) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM quotes WHERE id=? AND status='draft')`)
        .bind(crypto.randomUUID(),id,String(x.plan_key).trim().slice(0,100),String(x.description).trim().slice(0,500),x.quantity||1,x.unit_amount_cents,["inclusive","exclusive","unspecified"].includes(x.tax_behavior)?x.tax_behavior:"exclusive",i,id));
    }
  }
  const results = await env.LUMMET_DB.batch(statements);
  if (!results?.[0]?.meta?.changes) return { ok: false, status: 409, error: "quote_not_editable" };
  return { ok: true };
}
export async function replaceQuoteLines(env, quoteId, lines) {
  const statements = [env.LUMMET_DB.prepare(`DELETE FROM quote_lines WHERE quote_id=?`).bind(quoteId)];
  for (let i=0;i<lines.length;i++) {
    const x=lines[i];
    statements.push(env.LUMMET_DB.prepare(`INSERT INTO quote_lines (id,quote_id,plan_key,description,quantity,unit_amount_cents,tax_behavior,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(),quoteId,String(x.plan_key).trim().slice(0,100),String(x.description).trim().slice(0,500),x.quantity||1,x.unit_amount_cents,["inclusive","exclusive","unspecified"].includes(x.tax_behavior)?x.tax_behavior:"exclusive",i));
  }
  // D1 batch is transactional: line replacement is all-or-nothing.
  return env.LUMMET_DB.batch(statements);
}
export async function listQuoteLines(env, quoteId) {
  const r=await env.LUMMET_DB.prepare(`SELECT * FROM quote_lines WHERE quote_id=? ORDER BY sort_order,id`).bind(quoteId).all();
  return r.results||[];
}
export async function markQuoteSent(env, quoteId, staffId) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET status='sent',created_by=COALESCE(created_by,?),updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'`).bind(staffId||null,quoteId).run();
}
export async function expireQuotes(env, now) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE status='sent' AND valid_until IS NOT NULL AND valid_until<=?`).bind(now).run();
}
export async function listQuotes(env, limit, offset) {
  const r=await env.LUMMET_DB.prepare(`SELECT q.id,q.organization_id,q.contact_name,q.contact_email,q.company_name,q.status,q.currency,q.valid_until,q.created_at,q.updated_at,COUNT(l.id) AS line_count FROM quotes q LEFT JOIN quote_lines l ON l.quote_id=q.id GROUP BY q.id ORDER BY q.created_at DESC,q.id LIMIT ? OFFSET ?`).bind(limit,offset).all();
  return r.results||[];
}

export async function selectCustomer360(env, organizationId) {
  const organization = await env.LUMMET_DB.prepare(`SELECT id,name,slug,status,created_at FROM organizations WHERE id=?`).bind(organizationId).first();
  if (!organization) return null;
  const [subscription, invoices, timeline, overrides, balance] = await Promise.all([
    env.LUMMET_DB.prepare(`SELECT s.id,s.status,s.current_period_end,p.key AS plan_key,p.name AS plan_name,p.price_cents FROM subscriptions s LEFT JOIN plans p ON p.id=s.plan_id WHERE s.organization_id=? ORDER BY s.created_at DESC LIMIT 1`).bind(organizationId).first(),
    env.LUMMET_DB.prepare(`SELECT id,provider_invoice_id,status,amount_due_cents,amount_paid_cents,currency,hosted_invoice_url,created_at FROM invoices WHERE organization_id=? ORDER BY created_at DESC LIMIT 20`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT e.subscription_id,e.from_status,e.to_status,e.reason,e.actor_type,e.actor_id,e.created_at FROM subscription_status_events e JOIN subscriptions s ON s.id=e.subscription_id WHERE s.organization_id=? ORDER BY e.created_at DESC LIMIT 50`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT seo.key AS entitlement_key,seo.value,seo.reason,seo.created_at FROM subscription_entitlement_overrides seo JOIN subscriptions ss ON ss.id=seo.subscription_id WHERE ss.organization_id=? ORDER BY seo.created_at DESC LIMIT 100`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT COALESCE(SUM(amount),0) AS credits FROM ai_credit_ledger WHERE organization_id=?`).bind(organizationId).first()
  ]);
  return { organization, subscription: subscription || null, invoices: invoices.results || [], timeline: timeline.results || [], overrides: overrides.results || [], credits: balance?.credits ?? null };
}

// ---- v2.5.2.2: credit-pack reversal, dunning actions, four-eyes approvals ----
export async function findCreditGrantByPayment(env, paymentId) {
  return env.LUMMET_DB.prepare(`SELECT id, organization_id, credits FROM credit_pack_grants WHERE provider_payment_id=?`).bind(paymentId).first();
}
export async function raiseCreditReversal(env, { grantId, organizationId, credits }) {
  // Monotone and order-independent: a replayed or out-of-order webhook can never lower a reversal.
  return env.LUMMET_DB.prepare(`INSERT INTO credit_pack_reversals (grant_id, organization_id, credits_reversed) VALUES (?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET credits_reversed=MAX(credits_reversed, excluded.credits_reversed), updated_at=CURRENT_TIMESTAMP`)
    .bind(grantId, organizationId, credits).run();
}
export async function selectNetCreditBalance(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT (SELECT COALESCE(SUM(credits),0) FROM credit_pack_grants WHERE organization_id=?) - (SELECT COALESCE(SUM(credits_reversed),0) FROM credit_pack_reversals WHERE organization_id=?) AS credits`).bind(organizationId, organizationId).first();
}
export async function selectDunningQueue(env, limit, offset) {
  const r = await env.LUMMET_DB.prepare(`SELECT s.id AS subscription_id, s.organization_id, o.name AS organization_name, s.status, s.grace_ends_at, s.updated_at FROM subscriptions s JOIN organizations o ON o.id=s.organization_id WHERE s.status IN ('past_due','restricted') ORDER BY s.updated_at, s.id LIMIT ? OFFSET ?`).bind(limit, offset).all();
  return r.results || [];
}
export async function findSubscriptionForDunning(env, subscriptionId) {
  return env.LUMMET_DB.prepare(`SELECT id, organization_id, status, grace_ends_at FROM subscriptions WHERE id=?`).bind(subscriptionId).first();
}
export async function selectVerifiedOwnerEmails(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT u.email FROM organization_users ou JOIN customer_users u ON u.id=ou.user_id WHERE ou.organization_id=? AND ou.role='owner' AND u.status='active' AND u.email_verified_at IS NOT NULL ORDER BY ou.id`).bind(organizationId).all();
  return (r.results || []).map((x) => x.email);
}
export async function isEmailSuppressed(env, hash) {
  return !!(await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM email_suppressions WHERE email_hash=?`).bind(hash).first());
}
export async function extendGraceIfPastDue(env, subscriptionId, graceEndsAt, expectedStatus) {
  return env.LUMMET_DB.prepare(`UPDATE subscriptions SET grace_ends_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`).bind(graceEndsAt, subscriptionId, expectedStatus).run();
}
export async function insertDunningAction(env, row) {
  return env.LUMMET_DB.prepare(`INSERT INTO dunning_actions (id, subscription_id, organization_id, action, reason, staff_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.subscriptionId, row.organizationId, row.action, row.reason, row.staffId, row.detail || null).run();
}
export async function findPaymentForRefund(env, paymentId) {
  return env.LUMMET_DB.prepare(`SELECT id, organization_id, provider_payment_id, amount_cents, currency, status FROM payments WHERE id=? AND provider='stripe'`).bind(paymentId).first();
}
export async function selectRefundedCents(env, paymentId) {
  const r = await env.LUMMET_DB.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents FROM refunds WHERE payment_id=? AND status IN ('succeeded','pending')`).bind(paymentId).first();
  return Number(r?.cents || 0);
}
export async function insertApprovalRequest(env, r) {
  return env.LUMMET_DB.prepare(`INSERT INTO staff_approval_requests (id, kind, organization_id, amount, currency, payload_json, reason, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(r.id, r.kind, r.organizationId, r.amount, r.currency || null, r.payloadJson, r.reason, r.requestedBy).run();
}
export async function findApprovalRequest(env, id) { return env.LUMMET_DB.prepare(`SELECT * FROM staff_approval_requests WHERE id=?`).bind(id).first(); }
export async function listApprovalRequests(env, status, limit, offset) {
  const r = status
    ? await env.LUMMET_DB.prepare(`SELECT id, kind, organization_id, amount, currency, reason, status, requested_by, decided_by, decided_at, created_at FROM staff_approval_requests WHERE status=? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(status, limit, offset).all()
    : await env.LUMMET_DB.prepare(`SELECT id, kind, organization_id, amount, currency, reason, status, requested_by, decided_by, decided_at, created_at FROM staff_approval_requests ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(limit, offset).all();
  return r.results || [];
}
export async function decideApprovalIfPending(env, { id, status, decidedBy, decisionReason }) {
  // The requester can never decide their own request: enforced here and again by the table CHECK.
  return env.LUMMET_DB.prepare(`UPDATE staff_approval_requests SET status=?, decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_reason=? WHERE id=? AND status='pending' AND requested_by<>?`)
    .bind(status, decidedBy, decisionReason, id, decidedBy).run();
}
export async function markApprovalExecuted(env, id) {
  return env.LUMMET_DB.prepare(`UPDATE staff_approval_requests SET status='executed' WHERE id=? AND status='approved'`).bind(id).run();
}
export async function markApprovalFailed(env, id, code) {
  return env.LUMMET_DB.prepare(`UPDATE staff_approval_requests SET status='failed', failure_code=? WHERE id=? AND status='approved'`).bind(String(code).slice(0, 100), id).run();
}
export async function insertCreditAdjustment(env, { organizationId, amount, key, note }) {
  return env.LUMMET_DB.prepare(`INSERT INTO ai_credit_ledger (organization_id, kind, amount, idempotency_key, note) VALUES (?, 'adjust', ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(organizationId, amount, key, note).run();
}

// ---- v2.5.2.2: quote fulfillment (accepted quote -> draft provider invoice) ----
export async function claimQuoteFulfillment(env, quoteId) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET fulfillment_claimed_at=CURRENT_TIMESTAMP WHERE id=? AND status='accepted' AND fulfillment_claimed_at IS NULL AND stripe_invoice_id IS NULL`).bind(quoteId).run();
}
export async function releaseQuoteFulfillmentClaim(env, quoteId) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET fulfillment_claimed_at=NULL WHERE id=? AND stripe_invoice_id IS NULL`).bind(quoteId).run();
}
export async function markQuoteFulfilled(env, { quoteId, staffId, providerInvoiceId }) {
  return env.LUMMET_DB.prepare(`UPDATE quotes SET status='invoiced', stripe_invoice_id=?, fulfilled_by=?, fulfilled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='accepted'`).bind(providerInvoiceId, staffId, quoteId).run();
}

// ---- Phase 5.7: dunning comp ----
export async function selectOpenInvoicesForSubscription(env, subscriptionId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, provider_invoice_id, status, amount_due_cents, currency FROM invoices WHERE subscription_id=? AND provider='stripe' AND status='open' ORDER BY created_at DESC`).bind(subscriptionId).all()).results || [];
}
// Returns changes=0 when this invoice was already comped (unique index), so the caller never voids twice.
export async function insertCompAction(env, row) {
  return env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO dunning_actions (id, subscription_id, organization_id, action, reason, staff_id, detail) VALUES (?, ?, ?, 'comp', ?, ?, ?)`)
    .bind(row.id, row.subscriptionId, row.organizationId, row.reason, row.staffId, row.invoiceId).run();
}
export async function deleteCompAction(env, id) {
  return env.LUMMET_DB.prepare(`DELETE FROM dunning_actions WHERE id=? AND action='comp'`).bind(id).run();
}

// ---- v2.5.2.4 Phase 5 completion ----
export async function findActiveAddon(env, addonId) { return env.LUMMET_DB.prepare(`SELECT * FROM addons WHERE id=? AND active=1`).bind(addonId).first(); }
export async function findAddonForSubscription(env, subscriptionId, addonId) { return env.LUMMET_DB.prepare(`SELECT sa.*, a.key, a.name, a.entitlement_key, a.delta_per_unit, a.stripe_price_id FROM subscription_addons sa JOIN addons a ON a.id=sa.addon_id WHERE sa.subscription_id=? AND sa.addon_id=?`).bind(subscriptionId, addonId).first(); }
export async function listAddonIntents(env, organizationId, limit=50, offset=0) { const r=await env.LUMMET_DB.prepare(`SELECT * FROM addon_change_intents WHERE organization_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(organizationId,limit,offset).all(); return r.results||[]; }
export async function insertAddonIntent(env,row){ return env.LUMMET_DB.prepare(`INSERT INTO addon_change_intents (id,organization_id,subscription_id,addon_id,from_quantity,to_quantity,status,idempotency_key) VALUES (?,?,?,?,?,?,?,?)`).bind(row.id,row.organizationId,row.subscriptionId,row.addonId,row.fromQuantity,row.toQuantity,row.status||'pending',row.idempotencyKey).run(); }
export async function findAddonIntentByKey(env,key){return env.LUMMET_DB.prepare(`SELECT * FROM addon_change_intents WHERE idempotency_key=?`).bind(key).first();}
export async function updateAddonIntent(env,id,fields){const allowed=['status','provider_subscription_item_id','last_error'];const sets=[];const vals=[];for(const k of allowed)if(fields[k]!==undefined){sets.push(`${k}=?`);vals.push(fields[k]);}if(!sets.length)return;sets.push('updated_at=CURRENT_TIMESTAMP');vals.push(id);return env.LUMMET_DB.prepare(`UPDATE addon_change_intents SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();}
export async function upsertSubscriptionAddon(env,{subscriptionId,addonId,quantity}){return env.LUMMET_DB.prepare(`INSERT INTO subscription_addons(subscription_id,addon_id,quantity) VALUES(?,?,?) ON CONFLICT(subscription_id,addon_id) DO UPDATE SET quantity=excluded.quantity,updated_at=CURRENT_TIMESTAMP`).bind(subscriptionId,addonId,quantity).run();}
export async function removeSubscriptionAddon(env,{subscriptionId,addonId}){return env.LUMMET_DB.prepare(`DELETE FROM subscription_addons WHERE subscription_id=? AND addon_id=?`).bind(subscriptionId,addonId).run();}
export async function insertSaveOffer(env,row){return env.LUMMET_DB.prepare(`INSERT INTO billing_save_offers(id,organization_id,subscription_id,offer_key,status,detail) VALUES(?,?,?,?,?,?)`).bind(row.id,row.organizationId,row.subscriptionId,row.offerKey,row.status||'shown',row.detail||null).run();}
export async function activeSaveOffer(env,subscriptionId){return env.LUMMET_DB.prepare(`SELECT * FROM billing_save_offers WHERE subscription_id=? AND status IN ('shown','accepted') ORDER BY created_at DESC LIMIT 1`).bind(subscriptionId).first();}
export async function updateSaveOffer(env,id,status,detail=null){return env.LUMMET_DB.prepare(`UPDATE billing_save_offers SET status=?,detail=COALESCE(?,detail),updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status,detail,id).run();}
export async function insertImmediateCancelDecision(env,row){return env.LUMMET_DB.prepare(`INSERT INTO immediate_cancel_decisions(id,organization_id,subscription_id,staff_id,refund_decision,refund_amount_cents,currency,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(row.id,row.organizationId,row.subscriptionId,row.staffId,row.refundDecision,row.refundAmountCents,row.currency,row.reason).run();}
export async function upsertFounderLicense(env,row){return env.LUMMET_DB.prepare(`INSERT INTO founder_license_grants(organization_id,quote_id,provider_invoice_id,entitlement_json,granted_by) VALUES(?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET quote_id=excluded.quote_id,provider_invoice_id=excluded.provider_invoice_id,entitlement_json=excluded.entitlement_json,granted_by=excluded.granted_by`).bind(row.organizationId,row.quoteId,row.providerInvoiceId,JSON.stringify(row.entitlements),row.grantedBy).run();}
export async function findFounderLicense(env,organizationId){return env.LUMMET_DB.prepare(`SELECT * FROM founder_license_grants WHERE organization_id=?`).bind(organizationId).first();}
export async function listTaxChecklist(env){const r=await env.LUMMET_DB.prepare(`SELECT * FROM tax_registration_checklist ORDER BY jurisdiction`).all();return r.results||[];}
export async function upsertTaxChecklist(env,row){return env.LUMMET_DB.prepare(`INSERT INTO tax_registration_checklist(id,jurisdiction,status,evidence_url,notes,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(jurisdiction) DO UPDATE SET status=excluded.status,evidence_url=excluded.evidence_url,notes=excluded.notes,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).bind(row.id,row.jurisdiction,row.status,row.evidenceUrl||null,row.notes||null,row.updatedBy).run();}

export async function listPendingAddonIntents(env, subscriptionId){const r=await env.LUMMET_DB.prepare(`SELECT i.*,a.stripe_price_id FROM addon_change_intents i JOIN addons a ON a.id=i.addon_id WHERE i.subscription_id=? AND i.status IN ('pending','submitted')`).bind(subscriptionId).all();return r.results||[];}

export async function upsertQuoteEntitlementGrant(env,row){return env.LUMMET_DB.prepare(`INSERT INTO quote_entitlement_grants(organization_id,quote_id,entitlement_json) VALUES(?,?,?) ON CONFLICT(quote_id) DO UPDATE SET entitlement_json=excluded.entitlement_json,granted_at=CURRENT_TIMESTAMP`).bind(row.organizationId,row.quoteId,JSON.stringify(row.entitlements)).run();}
export async function listQuoteEntitlementGrants(env,organizationId){const r=await env.LUMMET_DB.prepare(`SELECT entitlement_json FROM quote_entitlement_grants WHERE organization_id=?`).bind(organizationId).all();return r.results||[];}
export async function listCreditGrants(env,limit=100,offset=0){const r=await env.LUMMET_DB.prepare(`SELECT g.*,p.price_cents,p.currency FROM credit_pack_grants g JOIN credit_packs p ON p.id=g.credit_pack_id ORDER BY g.granted_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all();return r.results||[];}
export async function upsertCreditPackReconciliation(env,row){return env.LUMMET_DB.prepare(`INSERT INTO credit_pack_reconciliation_findings(id,grant_id,provider_payment_id,expected_amount_cents,provider_amount_cents,currency,status,detail) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET provider_amount_cents=excluded.provider_amount_cents,currency=excluded.currency,status=excluded.status,detail=excluded.detail,checked_at=CURRENT_TIMESTAMP`).bind(row.id,row.grantId,row.providerPaymentId,row.expectedAmountCents,row.providerAmountCents,row.currency,row.status,row.detail||null).run();}
export async function activeSubscriptionForOrganization(env,organizationId){return env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id=? AND status NOT IN ('canceled','expired','incomplete_expired') ORDER BY created_at DESC LIMIT 1`).bind(organizationId).first();}
export async function subscriptionForOrganization(env,subscriptionId,organizationId){return env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE id=? AND organization_id=?`).bind(subscriptionId,organizationId).first();}
export async function latestImmediateCancelDecision(env,subscriptionId,organizationId){return env.LUMMET_DB.prepare(`SELECT * FROM immediate_cancel_decisions WHERE subscription_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 1`).bind(subscriptionId,organizationId).first();}
export async function entitlementRowsForPlanKey(env,planKey){const r=await env.LUMMET_DB.prepare(`SELECT pe.key,pe.value_type,pe.value FROM plan_entitlements pe JOIN plans p ON p.id=pe.plan_id WHERE p.key=?`).bind(planKey).all();return r.results||[];}
export async function updateQuoteInvoiced(env,quoteId){return env.LUMMET_DB.prepare(`UPDATE quotes SET status='invoiced',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(quoteId).run();}
export async function listActiveStaffEmails(env,excludeId){const r=await env.LUMMET_DB.prepare(`SELECT email FROM lummet_admins WHERE status='active' AND id<>? ORDER BY created_at LIMIT 20`).bind(excludeId).all();return r.results||[];}
export async function findInvoicedQuote(env,quoteId){return env.LUMMET_DB.prepare(`SELECT id,organization_id FROM quotes WHERE id=? AND status='invoiced'`).bind(quoteId).first();}
export async function signupPlan(env,planId,period){return env.LUMMET_DB.prepare(`SELECT id,key,billing_period,status,price_cents FROM plans WHERE id=?`).bind(planId).first();}
export async function activePlanPrice(env,planId,interval){return env.LUMMET_DB.prepare(`SELECT stripe_price_id FROM plan_prices WHERE plan_id=? AND interval=? AND active=1 LIMIT 1`).bind(planId,interval).first();}
export async function latestActiveSubscriptionId(env,organizationId){return env.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE organization_id=? AND status NOT IN ('canceled','expired','incomplete_expired') ORDER BY created_at DESC LIMIT 1`).bind(organizationId).first();}
export async function customerSignupIntent(env,userId){return env.LUMMET_DB.prepare(`SELECT signup_plan_id,signup_billing_period FROM customer_users WHERE id=?`).bind(userId).first();}
export async function clearCustomerSignupIntent(env,userId){return env.LUMMET_DB.prepare(`UPDATE customer_users SET signup_plan_id=NULL,signup_billing_period=NULL WHERE id=?`).bind(userId).run();}
export async function customerLoginIdentity(env,userId){return env.LUMMET_DB.prepare(`SELECT id,email,signup_plan_id,signup_billing_period FROM customer_users WHERE id=?`).bind(userId).first();}
