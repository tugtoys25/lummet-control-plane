// =====================================================
// TRANSACTIONAL EMAIL (master prompt sections 7, 26, 28)
//
// Provider abstraction + durable outbox. Configure with:
//   EMAIL_PROVIDER = "resend"          (only implementation today)
//   RESEND_API_KEY  (secret)
//   EMAIL_FROM      e.g. "Lummet <no-reply@yourdomain.com>"
//   PORTAL_BASE_URL e.g. "https://app.yourdomain.com"
//
// Not configured => messages stay 'queued' and nothing is
// reported as sent (rule #5). PORTAL_BASE_URL is required to
// build links and is deliberately NOT derived from the request
// Host header (host-header poisoning of reset links).
// =====================================================
import { encryptSecret, decryptSecret } from "./crypto.js";
import * as notificationRepo from "./repositories/billing-notifications.js";

const MAX_ATTEMPTS = 5;

export function emailConfigured(env) {
  return env.EMAIL_PROVIDER === "resend" && !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
}

/** SHA-256 hex of the trimmed, lowercased address: the only form in which suppressed addresses are stored. */
export async function emailHash(email) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email || "").trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function portalLink(env, path, params = {}) {
  const base = (env.PORTAL_BASE_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  const qs = new URLSearchParams(params).toString();
  return `${base}${path}${qs ? "?" + qs : ""}`;
}

export const templates = {
  notification: ({ link, subject, message }) => ({
    subject: subject || "Notification",
    text: `${message}${link ? `\n\nOpen your dashboard: ${link}` : ""}`,
    html: `<p>${esc(message)}</p>${link ? `<p><a href="${esc(link)}">Open your dashboard</a></p>` : ""}`
  }),
  verify_email: ({ link }) => ({
    subject: "Verify your email",
    text: `Confirm your email address to finish setting up your account:\n\n${link}\n\nIf you didn't create an account, ignore this message.`,
    html: `<p>Confirm your email address to finish setting up your account:</p><p><a href="${esc(link)}">Verify email</a></p><p>If you didn't create an account, ignore this message.</p>`
  }),
  password_reset: ({ link }) => ({
    subject: "Reset your password",
    text: `Use this link to choose a new password (valid for a limited time):\n\n${link}\n\nIf you didn't request this, ignore this message — your password is unchanged.`,
    html: `<p>Use this link to choose a new password (valid for a limited time):</p><p><a href="${esc(link)}">Reset password</a></p><p>If you didn't request this, ignore this message.</p>`
  }),
  invitation: ({ link, organizationName, role }) => ({
    subject: `You're invited to join ${organizationName}`,
    text: `You've been invited to join ${organizationName} as ${role}.\n\nAccept: ${link}`,
    html: `<p>You've been invited to join <b>${esc(organizationName)}</b> as ${esc(role)}.</p><p><a href="${esc(link)}">Accept invitation</a></p>`
  })
};

/** Durably queue a message. Returns {ok, id} or {ok:false,error}. Never sends inline. */
export async function queueEmail(env, { to, template, vars = {}, organizationId = null, dedupeKey = null, message = null, from = null, replyTo = null, notificationId = null }) {
  // `message` is a finished {subject, text, html} (billing notifications build theirs); otherwise a named template is used.
  let msg = message;
  if (!msg) {
    const build = templates[template];
    if (!build) return { ok: false, error: "unknown_template" };
    if ((vars.link === null || vars.link === undefined) && template !== "notification") return { ok: false, error: "portal_base_url_not_configured" };
    msg = build(vars);
    if (vars.subject && template === "notification") msg.subject = String(vars.subject).slice(0, 120);
  }
  const id = crypto.randomUUID();
  const payload = { text: msg.text, html: msg.html };
  if (from) payload.from = from;
  if (replyTo) payload.replyTo = replyTo;
  const enc = await encryptSecret(env, JSON.stringify(payload));
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO email_outbox (id, organization_id, to_email, template, subject, body_encrypted, body_iv, dedupe_key, notification_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, organizationId, to, template, msg.subject, enc.encryptedSecret, enc.secretIv, dedupeKey, notificationId).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return { ok: true, id: null, duplicate: true };
    throw e;
  }
  return { ok: true, id };
}

async function sendViaResend(env, row, body, fetchImpl) {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": row.id },
    body: JSON.stringify({
      from: body.from || env.EMAIL_FROM, to: [row.to_email], subject: row.subject, text: body.text, html: body.html,
      ...(body.replyTo ? { reply_to: body.replyTo } : {})
    })
  });
  if (!res.ok) {
    // Never include the request (contains the link/token) in the error.
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, retryable, error: `provider_http_${res.status}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, messageId: data.id || null };
}

/** Deliver due messages. Safe to call concurrently-ish and repeatedly. */
export async function flushOutbox(env, { limit = 20, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!emailConfigured(env)) return { sent: 0, failed: 0, retried: 0, skipped: "not_configured" };
  const nowIso = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const due = await env.LUMMET_DB.prepare(
    `SELECT * FROM email_outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`
  ).bind(nowIso, limit).all();
  let sent = 0, failed = 0, retried = 0;
  for (const row of due.results) {
    // Claim by bumping attempts atomically-enough: only proceed if we changed the row.
    const claim = await env.LUMMET_DB.prepare(
      `UPDATE email_outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND attempts = ?`
    ).bind(row.id, row.attempts).run();
    if (!claim.meta.changes) continue;
    // A billing notification queued before its recipient bounced or complained is not sent.
    if (String(row.template).startsWith("billing_") && await notificationRepo.isSuppressed(env, await emailHash(row.to_email))) {
      await notificationRepo.markOutboxSuppressed(env, row.id);
      continue;
    }
    let result;
    try {
      const body = JSON.parse(await decryptSecret(env, row.body_encrypted, row.body_iv));
      result = await sendViaResend(env, row, body, fetchImpl);
    } catch (e) {
      result = { ok: false, retryable: true, error: "delivery_exception" };
    }
    if (result.ok) {
      await env.LUMMET_DB.prepare(
        `UPDATE email_outbox SET status='sent', sent_at=CURRENT_TIMESTAMP, provider_message_id=?, body_encrypted=NULL, body_iv=NULL, last_error=NULL WHERE id=?`
      ).bind(result.messageId, row.id).run();
      sent++;
    } else if (!result.retryable || row.attempts + 1 >= MAX_ATTEMPTS) {
      // A failed billing notification keeps its body (still encrypted) so staff can resend that exact message from the
      // notifications screen; the tick drops it after 14 days. Every other failed message is wiped as before.
      const keepBody = String(row.template).startsWith("billing_") && row.notification_id;
      await env.LUMMET_DB.prepare(
        keepBody
          ? `UPDATE email_outbox SET status='failed', last_error=? WHERE id=?`
          : `UPDATE email_outbox SET status='failed', last_error=?, body_encrypted=NULL, body_iv=NULL WHERE id=?`
      ).bind(result.error, row.id).run();
      failed++;
    } else {
      const next = new Date(now + Math.pow(2, row.attempts + 1) * 60000).toISOString().replace("T", " ").slice(0, 19);
      await env.LUMMET_DB.prepare(`UPDATE email_outbox SET last_error=?, next_attempt_at=? WHERE id=?`).bind(result.error, next, row.id).run();
      retried++;
    }
  }
  return { sent, failed, retried };
}

export async function outboxStats(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status`).all();
  return Object.fromEntries(r.results.map((x) => [x.status, x.n]));
}
