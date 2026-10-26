// =====================================================
// AI GATEWAY (master prompt section 16)
//
// Customer-facing AI goes through here and nowhere else:
//   request -> task registry (fixed, validated tasks; no free-form
//   tool/DB access) -> entitlement -> rate limit -> credit
//   reservation -> provider -> settle/refund -> usage + audit.
// Providers are pluggable objects { name, model, complete(prompt) }.
// =====================================================
import * as entitlementsService from "./entitlements.js";
import { reserveCredits, settleCredits, refundCredits, grantMonthlyAllocation } from "./ai-credits.js";
import { recordUsage } from "./usage.js";
import { evaluateWriteGate, refusalFor } from "./access.js";

const MAX_INPUT_CHARS = 8000;
const RATE_LIMIT_PER_MINUTE = 20;

// The whole "tool registry": each task is a template + input schema.
// Adding a capability = adding an entry, never widening data access.
export const TASKS = {
  seo_meta: {
    credits: 2, required: ["title", "summary"],
    prompt: (i) => `Write an SEO meta title (max 60 chars) and meta description (max 155 chars) for this page.\nTitle: ${i.title}\nSummary: ${i.summary}\nReturn JSON: {"title":"","description":""}`
  },
  summarize: {
    credits: 1, required: ["text"],
    prompt: (i) => `Summarize the following in 3 concise sentences:\n\n${i.text}`
  },
  draft_article: {
    credits: 5, required: ["topic"],
    prompt: (i) => `Draft a short, factual news article about: ${i.topic}. Do not invent statistics or quotes.`
  }
};

export function workersAiProvider(env, model = "@cf/meta/llama-3.1-8b-instruct") {
  return {
    name: "workers-ai", model,
    async complete(prompt) {
      if (!env.AI) throw new Error("ai_provider_not_configured");
      const out = await env.AI.run(model, { messages: [{ role: "user", content: prompt }] });
      return { text: out.response || "", tokensIn: out.usage?.prompt_tokens ?? null, tokensOut: out.usage?.completion_tokens ?? null, costMicros: null };
    }
  };
}

export async function runAiTask(env, { organizationId, siteId = null, userId = null, task, input = {}, provider }) {
  const accessGate = await evaluateWriteGate(env, { organizationId, method: "POST", subPath: "/ai/gateway" });
  if (accessGate.blocked) return { ok: false, status: 402, ...refusalFor(accessGate.access) };
  const def = TASKS[task];
  if (!def) return { ok: false, status: 400, error: "unknown_task" };
  for (const f of def.required) {
    if (typeof input[f] !== "string" || !input[f].trim()) return { ok: false, status: 400, error: `missing_${f}` };
    if (input[f].length > MAX_INPUT_CHARS) return { ok: false, status: 400, error: "input_too_long" };
  }
  if (!(await entitlementsService.requireEntitlement(env, organizationId, "ai.enabled"))) return { ok: false, status: 403, error: "ai_not_enabled" };

  const recent = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM ai_credit_ledger WHERE organization_id = ? AND kind = 'reserve' AND created_at >= datetime('now','-1 minute')`
  ).bind(organizationId).first();
  if (recent.n >= RATE_LIMIT_PER_MINUTE) return { ok: false, status: 429, error: "rate_limited" };

  await grantMonthlyAllocation(env, organizationId); // idempotent per month
  const reserved = await reserveCredits(env, { organizationId, siteId, userId, amount: def.credits, task });
  if (!reserved.ok) return { ok: false, status: 402, error: reserved.error };

  let out;
  try {
    out = await provider.complete(def.prompt(input));
  } catch (e) {
    await refundCredits(env, { organizationId, reservationId: reserved.reservationId });
    return { ok: false, status: 502, error: "provider_error" }; // provider detail not exposed
  }
  const settled = await settleCredits(env, {
    organizationId, reservationId: reserved.reservationId, actual: def.credits,
    provider: provider.name, model: provider.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, costMicros: out.costMicros
  });
  await recordUsage(env, { organizationId, siteId, userId, metric: "ai_credits", quantity: settled.charged || def.credits, idempotencyKey: `ai:${reserved.reservationId}`, metadata: { task } });
  return { ok: true, text: out.text, creditsCharged: settled.charged };
}
