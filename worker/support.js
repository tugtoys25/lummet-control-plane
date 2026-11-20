// =====================================================
// SUPPORT: a customer's conversations with the platform team.
//
// A ticket is one thread. Status says whose turn it is: "open" = waiting for the team, "answered" = waiting for the customer, "closed".
// A customer reply re-opens an answered or closed ticket; a team reply marks it answered and emails the person who wrote the ticket.
// Every member of the organization can read its tickets and write new ones; the thread only shows the author's name or email.
// =====================================================
import { queueEmail, portalLink } from "./email.js";
import * as repo from "./repositories/support.js";

export const CATEGORIES = { question: "Question", problem: "Something is not working", billing: "Billing", feature: "Feature request" };
export const PRIORITIES = { low: "Low", normal: "Normal", high: "High" };
export const STATUSES = ["open", "answered", "closed"];
export const MAX_OPEN_PER_ORG = 25;
export const LIMITS = { subject: 140, body: 5000 };

const text = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export async function createTicket(env, { organizationId, customerUserId, authorLabel, siteId, subject, body, category, priority }) {
  const s = text(subject, LIMITS.subject).replace(/\s+/g, " "); const b = text(body, LIMITS.body);
  if (s.length < 3) return { ok: false, status: 422, error: "subject_required" };
  if (b.length < 5) return { ok: false, status: 422, error: "message_required" };
  const cat = CATEGORIES[category] ? category : "question"; const pri = PRIORITIES[priority] ? priority : "normal";
  if ((await repo.openCount(env, organizationId)) >= MAX_OPEN_PER_ORG) return { ok: false, status: 429, error: "too_many_open_tickets" };
  let site = null;
  if (siteId) { site = await repo.siteInOrganization(env, organizationId, siteId); if (!site) return { ok: false, status: 422, error: "invalid_site" }; }
  const id = crypto.randomUUID();
  await repo.insertWithMessage(env, { id, organizationId, customerUserId, siteId: site ? site.id : null, subject: s, category: cat, priority: pri, authorLabel: text(authorLabel, 120) || "Customer", body: b });
  return { ok: true, id };
}

export const listTickets = (env, organizationId, { status } = {}) => repo.listForOrganization(env, organizationId, status);

export async function getTicket(env, organizationId, id) {
  const t = await repo.getForOrganization(env, organizationId, id);
  return t ? { ...t, messages: await repo.messages(env, id) } : null;
}

export async function customerReply(env, organizationId, id, { authorLabel, body }) {
  if (!(await repo.getForOrganization(env, organizationId, id))) return { ok: false, status: 404, error: "not_found" };
  const b = text(body, LIMITS.body);
  if (b.length < 2) return { ok: false, status: 422, error: "message_required" };
  await repo.addMessage(env, { ticketId: id, authorType: "customer", authorLabel: text(authorLabel, 120) || "Customer", body: b, status: "open" });
  return { ok: true };
}

/** The customer closes their own ticket, or re-opens it. */
export async function customerSetStatus(env, organizationId, id, status) {
  if (!["open", "closed"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
  if (!(await repo.getForOrganization(env, organizationId, id))) return { ok: false, status: 404, error: "not_found" };
  await repo.setStatus(env, id, status);
  return { ok: true };
}

export const openCountForOrg = (env, organizationId) => repo.answeredCount(env, organizationId);

// ---- staff side ----
export const listAllTickets = (env, { status = "", limit = 100, offset = 0 } = {}) => repo.listAll(env, { status, limit, offset });
export const ticketOrganizationId = (env, id) => repo.organizationIdOf(env, id);

export async function getTicketForStaff(env, id) {
  const t = await repo.getForStaff(env, id);
  return t ? { ...t, messages: await repo.messages(env, id) } : null;
}

export async function staffReply(env, id, { staffLabel, body, close = false }) {
  const t = await getTicketForStaff(env, id);
  if (!t) return { ok: false, status: 404, error: "not_found" };
  const b = text(body, LIMITS.body);
  if (b.length < 2) return { ok: false, status: 422, error: "message_required" };
  await repo.addMessage(env, { ticketId: id, authorType: "staff", authorLabel: text(staffLabel, 120) || "Lummet support", body: b, status: close ? "closed" : "answered" });
  // Tell the person who wrote the ticket. Best effort: a missing address or an unconfigured mailer never blocks the reply.
  try {
    if (t.customer_email) {
      await queueEmail(env, {
        to: t.customer_email, template: "notification", organizationId: t.organization_id,
        vars: { subject: `Reply to your support request: ${t.subject}`.slice(0, 120), message: `${b.slice(0, 600)}${b.length > 600 ? "…" : ""}`, link: portalLink(env, `/app/support/${id}`) },
      });
    }
  } catch { /* ignore */ }
  return { ok: true };
}

export async function staffSetStatus(env, id, status) {
  if (!STATUSES.includes(status)) return { ok: false, status: 422, error: "invalid_status" };
  if (!(await repo.getForStaff(env, id))) return { ok: false, status: 404, error: "not_found" };
  await repo.setStatus(env, id, status);
  return { ok: true };
}

export const openTicketCount = (env) => repo.openTotal(env);
export const anonymiseCustomer = (env, userId) => repo.anonymiseCustomerMessages(env, userId);
