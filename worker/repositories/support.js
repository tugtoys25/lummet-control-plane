// Storage for support tickets and their messages.
const STATUS_SQL = { open: "open", answered: "answered", closed: "closed" };

export async function openCount(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE organization_id = ? AND status != 'closed'`).bind(organizationId).first();
  return r?.n || 0;
}
export async function answeredCount(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE organization_id = ? AND status = 'answered'`).bind(organizationId).first();
  return r?.n || 0;
}
export async function siteInOrganization(env, organizationId, siteId) {
  return env.LUMMET_DB.prepare(`SELECT id FROM sites WHERE id = ? AND organization_id = ?`).bind(siteId, organizationId).first();
}
export async function insertWithMessage(env, { id, organizationId, customerUserId, siteId, subject, category, priority, authorLabel, body }) {
  await env.LUMMET_DB.batch([
    env.LUMMET_DB.prepare(`INSERT INTO support_tickets (id, organization_id, customer_user_id, site_id, subject, category, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, organizationId, customerUserId || null, siteId || null, subject, category, priority),
    env.LUMMET_DB.prepare(`INSERT INTO support_messages (id, ticket_id, author_type, author_label, body) VALUES (?, ?, 'customer', ?, ?)`).bind(crypto.randomUUID(), id, authorLabel, body),
  ]);
}
export async function listForOrganization(env, organizationId, status) {
  const s = STATUS_SQL[status];
  const r = await env.LUMMET_DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count FROM support_tickets t WHERE t.organization_id = ?${s ? " AND t.status = ?" : ""} ORDER BY (t.status = 'closed'), t.updated_at DESC LIMIT 200`
  ).bind(...(s ? [organizationId, s] : [organizationId])).all();
  return r.results || [];
}
export async function getForOrganization(env, organizationId, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM support_tickets WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first();
}
export async function messages(env, ticketId) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, author_type, author_label, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY created_at, rowid`).bind(ticketId).all();
  return r.results || [];
}
/** Adds a message and sets the ticket's status in one step (a customer reply re-opens, a staff reply answers or closes). */
export async function addMessage(env, { ticketId, authorType, authorLabel, body, status }) {
  await env.LUMMET_DB.batch([
    env.LUMMET_DB.prepare(`INSERT INTO support_messages (id, ticket_id, author_type, author_label, body) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), ticketId, authorType, authorLabel, body),
    env.LUMMET_DB.prepare(`UPDATE support_tickets SET status = ?, closed_at = ${status === "closed" ? "CURRENT_TIMESTAMP" : "NULL"}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, ticketId),
  ]);
}
export async function setStatus(env, ticketId, status) {
  await env.LUMMET_DB.prepare(`UPDATE support_tickets SET status = ?, closed_at = ${status === "closed" ? "CURRENT_TIMESTAMP" : "NULL"}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, ticketId).run();
}
export async function organizationIdOf(env, ticketId) {
  const r = await env.LUMMET_DB.prepare(`SELECT organization_id FROM support_tickets WHERE id = ?`).bind(ticketId).first();
  return r ? r.organization_id : null;
}
export async function listAll(env, { status, limit, offset }) {
  const s = STATUS_SQL[status];
  const r = await env.LUMMET_DB.prepare(
    `SELECT t.id, t.subject, t.category, t.priority, t.status, t.created_at, t.updated_at, t.organization_id, o.name AS organization,
            (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM support_tickets t LEFT JOIN organizations o ON o.id = t.organization_id${s ? " WHERE t.status = ?" : ""}
      ORDER BY (t.status = 'open') DESC, (t.priority = 'high') DESC, t.updated_at DESC LIMIT ? OFFSET ?`
  ).bind(...(s ? [s, limit + 1, offset] : [limit + 1, offset])).all();
  return r.results || [];
}
export async function getForStaff(env, id) {
  return env.LUMMET_DB.prepare(
    `SELECT t.*, o.name AS organization, u.email AS customer_email FROM support_tickets t LEFT JOIN organizations o ON o.id = t.organization_id LEFT JOIN customer_users u ON u.id = t.customer_user_id WHERE t.id = ?`
  ).bind(id).first();
}
export async function openTotal(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'`).first();
  return r?.n || 0;
}
/** Removes a person's name or address from the messages they wrote (the conversation itself stays with the organization). */
export async function anonymiseCustomerMessages(env, userId) {
  await env.LUMMET_DB.prepare(`UPDATE support_messages SET author_label = '[erased]' WHERE author_type = 'customer' AND ticket_id IN (SELECT id FROM support_tickets WHERE customer_user_id = ?)`).bind(userId).run();
}
