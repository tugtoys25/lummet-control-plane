// =====================================================
// AI AGENT (bounded think / search / act mode)
// Invoked explicitly via "/lu-agent <goal>" -- never
// triggered implicitly by ordinary chat, so an admin always
// knows when they've turned this on for one turn.
//
// SAFETY PROPERTY, BY CONSTRUCTION NOT CONVENTION: this
// module imports resolveAction, executeRead and
// buildWritePreview -- the exact same functions ordinary
// chat/commands use -- and NOTHING from confirm.js or
// crud.js's submit* functions. There is no code path in this
// file capable of writing to a tenant. The moment the model
// decides on a write, buildWritePreview produces a pending
// operation and the loop STOPS and returns it, exactly like
// any other write request -- the human still has to open the
// preview card and press Confirm. An agent "deciding" to
// write is worth exactly as much as a person typing the same
// request in the chat box: a proposal, not an action.
//
// Every read/write-propose step still goes through
// resolveAction's tenant/permission checks, so an agent
// cannot see or touch anything the calling admin couldn't
// already see or touch by hand.
// =====================================================

import { resolveAction } from "./resolver.js";
import { executeRead } from "./read.js";
import { buildWritePreview } from "./write.js";
import { listResourceKeys } from "./schema.js";
import { webSearch } from "./web-search.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_STEPS = 6;
const MAX_OBSERVATION_CHARS = 3000;

function systemPrompt() {
  return `You are a bounded research/action agent for the Lummet Control Plane, an admin dashboard for managing casino-affiliate tenant sites. An authorized administrator gave you a goal. Work toward it step by step, one tool call per turn.

Known resources (the ONLY ones you may read or write): ${listResourceKeys().join(", ")}

Respond with ONLY one raw JSON object, no markdown, no commentary outside the JSON. One of:
{"tool":"read","resource":"<key>","recordId":null,"filters":{},"tenantHint":null,"why":"<one short sentence>"}
{"tool":"web_search","query":"<text>","why":"<one short sentence>"}
{"tool":"propose_write","resource":"<key>","operation":"create|update|delete","recordId":null,"fields":{},"tenantHint":null,"why":"<one short sentence>"}
{"tool":"finish","summary":"<your answer or conclusion for the admin>"}

Rules:
- You can only READ data or PROPOSE a write. Proposing a write immediately ends your turn — you cannot execute it, see its result, or take another step afterward. Only the human admin can confirm it, in their own UI, after you're done. Never claim a write happened; you can only say you've proposed it.
- tenantHint is only ever a hint the server checks against tenants this admin is actually authorized for — never assume it will be honored.
- Use read and web_search to gather what you need BEFORE proposing a write. Don't propose a write from a guess if a read would confirm it.
- If a tool call fails or is denied, do not retry the same thing — explain what happened via finish, or try a different approach.
- Call finish as soon as you have enough to answer, or if you determine the goal needs something you don't have a tool for.`;
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

async function decideNextStep(env, goal, transcript) {
  if (!env.AI) {
    return { tool: "finish", summary: "Agent mode needs the Workers AI binding, which isn't configured in this environment.", raw: "" };
  }

  const history = transcript
    .slice(-8)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt() },
        {
          role: "user",
          content: `Goal: ${goal}\n\nProgress so far:\n${history || "(nothing yet — this is your first step)"}\n\nWhat's your next step? One JSON tool call only.`
        }
      ],
      temperature: 0.2,
      max_tokens: 350
    });

    const text = result?.response || result?.choices?.[0]?.message?.content || "";
    const parsed = extractJson(text);
    if (!parsed || typeof parsed.tool !== "string") {
      return { tool: "finish", summary: "Could not determine a next step from the model's response.", raw: text };
    }
    return { ...parsed, raw: text };
  } catch (err) {
    return { tool: "finish", summary: `Agent step failed: ${err && err.message ? err.message : String(err)}`, raw: "" };
  }
}

function truncate(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_OBSERVATION_CHARS ? text.slice(0, MAX_OBSERVATION_CHARS) + " …(truncated)" : text;
}

/**
 * @returns one of:
 *   {ok:true, kind:"agent_write_proposed", steps, preview}  — same
 *     preview shape write.js/buildWritePreview always returns; the
 *     existing chat UI already knows how to render this card.
 *   {ok:true, kind:"agent_finished", steps, summary}
 *   {ok:true, kind:"agent_step_limit", steps, summary}
 */
export async function runAgent(env, admin, { conversationId, goal }) {
  const transcript = [];
  const steps = [];

  for (let stepCount = 0; stepCount < MAX_STEPS; stepCount++) {
    const step = await decideNextStep(env, goal, transcript);
    transcript.push({ role: "agent", content: truncate(step.raw || JSON.stringify(step)) });

    if (step.tool === "read") {
      const resolved = await resolveAction(env, admin, {
        resource: step.resource,
        operation: "read",
        tenantHint: step.tenantHint || null
      });
      if (!resolved.ok) {
        steps.push({ tool: "read", why: step.why, ok: false, ...resolved });
        transcript.push({ role: "observation", content: truncate(resolved) });
        continue;
      }
      const readResult = await executeRead(env, resolved, {
        recordId: step.recordId || null,
        filters: step.filters && typeof step.filters === "object" ? step.filters : {},
        requestedFields: []
      });
      steps.push({ tool: "read", why: step.why, ok: readResult.ok, resource: step.resource });
      transcript.push({ role: "observation", content: truncate(readResult) });
      continue;
    }

    if (step.tool === "web_search") {
      const searchResult = await webSearch(env, step.query);
      steps.push({ tool: "web_search", why: step.why, query: step.query, ok: searchResult.ok });
      transcript.push({ role: "observation", content: truncate(searchResult) });
      continue;
    }

    if (step.tool === "propose_write") {
      const resolved = await resolveAction(env, admin, {
        resource: step.resource,
        operation: step.operation,
        tenantHint: step.tenantHint || null
      });
      if (!resolved.ok) {
        steps.push({ tool: "propose_write", why: step.why, ok: false, ...resolved });
        transcript.push({ role: "observation", content: truncate(resolved) });
        continue; // let the model try something else, or finish, instead
      }

      const preview = await buildWritePreview(
        env,
        admin,
        resolved,
        { operation: step.operation, recordId: step.recordId || null, fields: step.fields && typeof step.fields === "object" ? step.fields : {} },
        { conversationId }
      );

      steps.push({ tool: "propose_write", why: step.why, ok: preview.ok, resource: step.resource, operation: step.operation });

      if (!preview.ok) {
        transcript.push({ role: "observation", content: truncate(preview) });
        continue; // invalid proposal (e.g. unknown field) — let it try again or finish
      }

      // A write was successfully proposed. Stop here, unconditionally.
      return { ok: true, kind: "agent_write_proposed", steps, preview };
    }

    // "finish", or anything unrecognized — always terminates.
    steps.push({ tool: "finish", ok: true });
    return { ok: true, kind: "agent_finished", steps, summary: step.summary || "Done." };
  }

  return { ok: true, kind: "agent_step_limit", steps, summary: "Stopped after the maximum number of steps without finishing." };
}
