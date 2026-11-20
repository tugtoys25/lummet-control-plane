// =====================================================
// INTEGRATIONS: connect an organization to Slack, Discord, Microsoft Teams or Telegram.
//
// The same events webhooks and automations already use (site.deployed, payment.failed, ...) are posted to the chosen chat as a short
// readable message. Nothing about the events changes: webhooks.dispatchEvent calls dispatchIntegrations() after its own work, and a
// failure here can never break the caller. The destination is a secret: it is encrypted at rest, only its host is ever shown, and each
// provider only accepts its own official hosts, so this cannot be used to make the server call an arbitrary address.
// =====================================================
import { checkOutboundUrlResolved } from "./url-safety.js";
import { encryptSecret, decryptSecret, aadFor } from "./crypto.js";
import * as repo from "./repositories/integrations.js";

export const PROVIDERS = {
  slack: { label: "Slack", help: "In Slack, create an Incoming Webhook for a channel and paste its address.", field: "url", placeholder: "https://hooks.slack.com/services/…" },
  discord: { label: "Discord", help: "In Discord: channel settings, Integrations, Webhooks, copy the webhook address.", field: "url", placeholder: "https://discord.com/api/webhooks/…" },
  teams: { label: "Microsoft Teams", help: "In Teams, add the Incoming Webhook or a Workflows webhook to a channel and paste its address.", field: "url", placeholder: "https://….webhook.office.com/…" },
  telegram: { label: "Telegram", help: "Create a bot with @BotFather, add it to your chat, then enter the bot token and the chat id.", field: "bot", placeholder: "" },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

// What each provider may point at. Teams and Workflows addresses live on a few Microsoft hosts.
const HOSTS = {
  slack: [/^hooks\.slack\.com$/],
  discord: [/^(discord|discordapp)\.com$/, /^(canary|ptb)\.discord\.com$/],
  teams: [/\.webhook\.office\.com$/, /^outlook\.office\.com$/, /\.logic\.azure\.com$/, /\.powerplatform\.com$/, /\.api\.powerplatform\.com$/],
};
const PATHS = { slack: /^\/services\//, discord: /^\/api(\/v\d+)?\/webhooks\//, teams: /^\/./ };

const EVENT_TEXT = {
  "site.created": (d) => `Site created${d.name ? `: ${d.name}` : ""}`,
  "site.provisioned": () => "A site finished setting up",
  "site.deployed": (d) => `A site was deployed${d.version ? ` (version ${d.version})` : ""}`,
  "site.failed": (d) => `A site failed${d.step ? ` at ${d.step}` : ""}${d.message ? `: ${String(d.message).slice(0, 200)}` : ""}`,
  "site.deleted": (d) => `Site deleted${d.name ? `: ${d.name}` : ""}`,
  "domain.verified": (d) => `Domain verified${d.hostname ? `: ${d.hostname}` : ""}`,
  "subscription.changed": (d) => `Subscription changed${d.status ? ` to ${d.status}` : ""}`,
  "payment.failed": () => "A payment failed",
  "integration.test": () => "This is a test message. Your integration works.",
};
export const EVENT_TYPES = Object.keys(EVENT_TEXT).filter((e) => e !== "integration.test");

export function eventText(eventType, data = {}) {
  const f = EVENT_TEXT[eventType];
  return f ? f(data || {}) : String(eventType);
}

/** The JSON body each provider expects for one short message. */
export function buildPayload(provider, text) {
  const t = String(text).slice(0, 1800);
  if (provider === "slack") return { text: `*Lummet* · ${t}` };
  if (provider === "discord") return { content: `**Lummet** · ${t}`.slice(0, 1900), allowed_mentions: { parse: [] } };
  if (provider === "teams") return { type: "message", text: `Lummet · ${t}`, attachments: [] };
  return null;
}

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** Validates what the customer typed and returns the secret to store. */
export function parseTarget(provider, input = {}) {
  if (provider === "telegram") {
    const token = clean(input.botToken, 120); const chatId = clean(input.chatId, 40);
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, error: "invalid_bot_token" };
    if (!/^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chatId)) return { ok: false, error: "invalid_chat_id" };
    return { ok: true, secret: JSON.stringify({ token, chatId }), hint: `Telegram chat ${chatId}` };
  }
  let url;
  try { url = new URL(clean(input.url, 600)); } catch { return { ok: false, error: "invalid_url" }; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { ok: false, error: "invalid_url" };
  const host = url.hostname.toLowerCase();
  if (!(HOSTS[provider] || []).some((re) => re.test(host)) || !PATHS[provider].test(url.pathname)) return { ok: false, error: "url_not_for_provider" };
  return { ok: true, secret: url.toString(), hint: host };
}

function normaliseEvents(list) {
  const arr = Array.isArray(list) ? list : [];
  const bad = arr.filter((e) => !EVENT_TYPES.includes(e));
  return { events: [...new Set(arr.filter((e) => EVENT_TYPES.includes(e)))], bad };
}

const publicRow = (r) => ({
  id: r.id, provider: r.provider, provider_label: (PROVIDERS[r.provider] || {}).label || r.provider, name: r.name, target_hint: r.target_hint,
  event_types: JSON.parse(r.event_types || "[]"), status: r.status, last_status: r.last_status, last_error: r.last_error,
  last_sent_at: r.last_sent_at, sent_count: r.sent_count, failure_count: r.failure_count, created_at: r.created_at,
});

export const MAX_PER_ORG = 20;

export async function listIntegrations(env, organizationId) {
  return (await repo.list(env, organizationId)).map(publicRow);
}

export async function createIntegration(env, { organizationId, provider, name, eventTypes, target, actorUserId }) {
  if (!PROVIDERS[provider]) return { ok: false, status: 422, error: "invalid_provider" };
  const label = clean(name, 60) || PROVIDERS[provider].label;
  const parsed = parseTarget(provider, target);
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
  const { events, bad } = normaliseEvents(eventTypes);
  if (!events.length || bad.length) return { ok: false, status: 422, error: "invalid_event_types", invalidTypes: bad };
  if ((await repo.count(env, organizationId)) >= MAX_PER_ORG) return { ok: false, status: 409, error: "too_many_integrations" };
  if (provider !== "telegram") {
    const check = await checkOutboundUrlResolved(parsed.secret, env);
    if (!check.ok) return { ok: false, status: 422, error: check.error };
  }
  const id = crypto.randomUUID();
  const { encryptedSecret, secretIv } = await encryptSecret(env, parsed.secret, aadFor("integrations", id, "encrypted_secret"));
  await repo.insert(env, { id, organizationId, provider, name: label, encryptedSecret, secretIv, targetHint: parsed.hint, eventTypes: JSON.stringify(events), createdBy: actorUserId });
  return { ok: true, id };
}

const getForOrg = (env, organizationId, id) => repo.get(env, organizationId, id);

export async function deleteIntegration(env, organizationId, id) {
  const row = await getForOrg(env, organizationId, id);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  await repo.remove(env, id);
  return { ok: true };
}

export async function updateIntegration(env, organizationId, id, { status, eventTypes, name }) {
  const row = await getForOrg(env, organizationId, id);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  let nextStatus = row.status, nextEvents = row.event_types, nextName = row.name;
  if (status !== undefined) { if (!["active", "disabled"].includes(status)) return { ok: false, status: 422, error: "invalid_status" }; nextStatus = status; }
  if (eventTypes !== undefined) { const { events, bad } = normaliseEvents(eventTypes); if (!events.length || bad.length) return { ok: false, status: 422, error: "invalid_event_types", invalidTypes: bad }; nextEvents = JSON.stringify(events); }
  if (name !== undefined) nextName = clean(name, 60) || row.name;
  await repo.update(env, id, { status: nextStatus, eventTypes: nextEvents, name: nextName });
  return { ok: true };
}

/** One message to one connection. Never throws; records the outcome on the row. */
async function sendTo(env, row, text, { fetchImpl = fetch } = {}) {
  let outcome;
  try {
    let secret;
    try { secret = await decryptSecret(env, row.encrypted_secret, row.secret_iv, aadFor("integrations", row.id, "encrypted_secret")); }
    catch { secret = null; }
    if (!secret) outcome = { ok: false, error: "secret_unavailable" };
    else {
      let url, body;
      if (row.provider === "telegram") {
        const t = JSON.parse(secret);
        url = `https://api.telegram.org/bot${t.token}/sendMessage`;
        body = { chat_id: t.chatId, text: `Lummet · ${String(text).slice(0, 3500)}`, disable_web_page_preview: true };
      } else {
        url = secret; body = buildPayload(row.provider, text);
        const check = await checkOutboundUrlResolved(url, env);
        if (!check.ok) { outcome = { ok: false, error: "url_host_not_allowed" }; }
      }
      if (!outcome) {
        const res = await fetchImpl(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        outcome = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
      }
    }
  } catch (e) {
    outcome = { ok: false, error: "network_error" };
  }
  try {
    await repo.recordOutcome(env, row.id, outcome);
  } catch { /* recording is best effort */ }
  return outcome;
}

export async function sendTest(env, organizationId, id, opts) {
  const row = await getForOrg(env, organizationId, id);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const out = await sendTo(env, row, eventText("integration.test"), opts);
  return out.ok ? { ok: true } : { ok: false, status: 502, error: out.error };
}

/** Called for every event of an organization. Never throws and never blocks the caller's own work for long. */
export async function dispatchIntegrations(env, organizationId, eventType, data, opts) {
  try {
    if (!EVENT_TYPES.includes(eventType)) return;
    const rows = (await repo.listActive(env, organizationId)).filter((x) => JSON.parse(x.event_types || "[]").includes(eventType));
    const text = eventText(eventType, data);
    await Promise.all(rows.map((row) => sendTo(env, row, text, opts)));
  } catch { /* never break the caller */ }
}
