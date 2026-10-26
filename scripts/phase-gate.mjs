#!/usr/bin/env node
// Phase gate check. Answers one question: may this phase be approved?
//
//   node scripts/phase-gate.mjs --phase 2 [--static-only] [--json]
//
// Two kinds of check:
//   code      the release contains what the blueprint says the phase delivers (templates, webhook handlers, routes, alerts,
//             configuration and rollback documented). Computed from the files; nothing is assumed.
//   staging   things only a human can prove against real services (live Resend delivery, DNS alignment, real Stripe payloads).
//             They live in docs/PHASE_2_STAGING_RECORD.md as checkboxes; a box counts only when it is ticked AND has evidence
//             text after "evidence:". An unticked or evidence-less box is "open". The approval line needs a name and a date.
//
// Exit code 0 only when every check passes. --static-only checks code only (exit 0 when the code checks pass) and says that
// staging was not checked. The script never edits the record and never ticks anything itself.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");

// What blueprint sprint 2.1 says the templates cover, mapped to this codebase's notice kinds.
export const PHASE2_REQUIRED_KINDS = {
  "trial welcome": "trial_welcome", "trial reminders": "trial_reminder", "trial ended": "trial_ended",
  "payment failed series": "payment_failed", "card authentication required": "card_authentication", "receipt": "receipt",
  "restricted": "restricted", "suspended": "suspended", "reactivated": "reactivated", "plan changed": "plan_changed",
  "cancellation scheduled": "cancellation_scheduled", "ending soon": "ending_soon", "win-back": "win_back",
  "refund issued": "refund_issued", "deletion warnings": "deletion_warning"
};
export const PHASE2_WEBHOOK_EVENTS = [
  "customer.subscription.created", "customer.subscription.trial_will_end", "invoice.payment_action_required",
  "checkout.session.expired", "invoice.upcoming"
];
export const PHASE2_FLAGS = ["BILLING_EMAILS", "BILLING_REMINDER_DAYS", "BILLING_RENEWAL_NOTICES", "BILLING_WINBACK_EMAILS", "RESEND_WEBHOOK_SECRET"];
export const PHASE2_CHANGE_DOCS = ["docs/CHANGES_PHASE_2_1.md", "docs/CHANGES_PHASE_2_2.md", "docs/CHANGES_PHASE_2_3.md"];
export const STAGING_RECORD = "docs/PHASE_2_STAGING_RECORD.md";

const read = (root, rel) => readFile(path.join(root, rel), "utf8").catch(() => null);

/** Parses the staging record: items are lines like "- [x] id: what was checked — evidence: where it can be seen". */
export function parseStagingRecord(text) {
  const items = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s+([a-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const ticked = m[1].toLowerCase() === "x";
    const ev = m[3].match(/evidence:\s*(.*)$/i);
    const evidence = ev ? ev[1].trim() : "";
    items.push({ id: m[2], ticked, evidence, done: ticked && evidence.length >= 8 && !/^(todo|tbd|n\/a|none|-+)$/i.test(evidence) });
  }
  const field = (name) => { const m = String(text || "").match(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "im")); return m ? m[1].trim() : ""; };
  return { items, approvedBy: field("Approved by"), approvedOn: field("Approved on") };
}

export const REQUIRED_STAGING_ITEMS = [
  "spf_dkim_dmarc", "resend_live_delivery", "stripe_events_added", "stripe_cli_payloads", "welcome_and_reminder_once",
  "payment_action_required_once", "checkout_expired_releases_hold", "shadow_run_real_traffic", "at3_dunning_series",
  "resend_webhook_bounce_complaint", "bounce_rate_alert", "staff_resend_safe", "stripe_own_failed_payment_email_still_on"
];

export async function evaluatePhase2Gate(root = defaultRoot, { staticOnly = false } = {}) {
  const checks = [];
  const add = (id, kind, ok, detail) => checks.push({ id, kind, ok: !!ok, detail });

  // ---- code checks
  let kinds = [];
  try { kinds = (await import(pathToFileURL(path.join(root, "worker/billing-email-templates.js")).href)).BILLING_KINDS || []; } catch { /* reported below */ }
  const missingKinds = Object.entries(PHASE2_REQUIRED_KINDS).filter(([, k]) => !kinds.includes(k)).map(([n]) => n);
  add("templates", "code", kinds.length > 0 && !missingKinds.length, missingKinds.length ? `missing: ${missingKinds.join(", ")}` : `${kinds.length} notice kinds, all ${Object.keys(PHASE2_REQUIRED_KINDS).length} blueprint notices present`);

  const billing = await read(root, "worker/billing.js") || "";
  const missingEvents = PHASE2_WEBHOOK_EVENTS.filter((e) => !billing.includes(`"${e}"`) && !billing.includes(`'${e}'`));
  add("webhook_handlers", "code", !missingEvents.length, missingEvents.length ? `no handler for: ${missingEvents.join(", ")}` : `${PHASE2_WEBHOOK_EVENTS.length} sprint 2.2 events handled`);

  const mig = await read(root, "migrations/0051_billing_notifications.sql") || "";
  add("migration_0051", "code", /billing_notifications/.test(mig) && /dedupe_key TEXT NOT NULL UNIQUE/.test(mig) && /email_suppressions/.test(mig) && /email_hash TEXT NOT NULL UNIQUE/.test(mig), "billing_notifications (dedupe_key UNIQUE) and email_suppressions (email_hash UNIQUE)");

  const index = await read(root, "worker/index.js") || "";
  add("resend_webhook_route", "code", /\/api\/email\/webhook\/resend/.test(index), "Resend bounce and complaint endpoint");
  add("staff_notifications_view", "code", /\/platform\/saas\/notifications/.test(index) && /\/api\/platform\/saas\/notifications\/:id\/resend/.test(index), "staff list page and audited resend route");
  const notif = await read(root, "worker/billing-notifications.js") || "";
  add("resend_is_dedupe_aware", "code", /export async function resend/.test(notif) && !/insertIntent|queueEmail\(/.test(notif.slice(notif.indexOf("export async function resend"))), "resend() never inserts an intent or a message");

  const alerts = await read(root, "worker/alerts.js") || "";
  add("alerts", "code", /key: "email_bounce_rate"/.test(alerts) && /key: "billing_email_stuck"/.test(alerts), "email_bounce_rate and billing_email_stuck registered");

  const cfgDoc = await read(root, "docs/CONFIGURATION.md") || "", wr = await read(root, "wrangler.example.jsonc") || "";
  const undocumented = PHASE2_FLAGS.filter((f) => !cfgDoc.includes(f));
  const notInExample = PHASE2_FLAGS.filter((f) => f !== "RESEND_WEBHOOK_SECRET" && !wr.includes(f));
  add("configuration_documented", "code", !undocumented.length && !notInExample.length, undocumented.length || notInExample.length ? `not documented: ${[...undocumented, ...notInExample.map((f) => f + " (wrangler.example.jsonc)")].join(", ")}` : "every Phase 2 flag is in CONFIGURATION.md and the example config");

  const docs = await Promise.all(PHASE2_CHANGE_DOCS.map((d) => read(root, d)));
  const missingDocs = PHASE2_CHANGE_DOCS.filter((_, i) => !docs[i]);
  const noRollback = PHASE2_CHANGE_DOCS.filter((_, i) => docs[i] && !/^#{1,3}\s.*rollback|\brollback:/im.test(docs[i]));
  add("change_docs_and_rollback", "code", !missingDocs.length && !noRollback.length, missingDocs.length ? `missing: ${missingDocs.join(", ")}` : noRollback.length ? `no rollback section: ${noRollback.join(", ")}` : "change notes for 2.1, 2.2 and 2.3, each with a rollback");

  // ---- staging record
  if (!staticOnly) {
    const text = await read(root, STAGING_RECORD);
    if (text === null) add("staging_record", "staging", false, `${STAGING_RECORD} is missing`);
    else {
      const rec = parseStagingRecord(text);
      for (const id of REQUIRED_STAGING_ITEMS) {
        const it = rec.items.find((x) => x.id === id);
        add(`staging:${id}`, "staging", it?.done, !it ? "not in the record" : it.done ? it.evidence : it.ticked ? "ticked but no evidence written" : "open");
      }
      add("approval", "staging", !!rec.approvedBy && !!rec.approvedOn && !/^<.*>$/.test(rec.approvedBy) && /\d{4}-\d{2}-\d{2}/.test(rec.approvedOn), rec.approvedBy && rec.approvedOn ? `${rec.approvedBy}, ${rec.approvedOn}` : "Approved by / Approved on are empty");
    }
  }
  const codeOk = checks.filter((c) => c.kind === "code").every((c) => c.ok);
  const stagingOk = staticOnly ? null : checks.filter((c) => c.kind === "staging").every((c) => c.ok);
  return { phase: 2, staticOnly, codeOk, stagingOk, passed: codeOk && (staticOnly || stagingOk), checks };
}

function render(r) {
  const lines = [`Phase ${r.phase} gate${r.staticOnly ? " (code only; staging NOT checked)" : ""}`, ""];
  for (const c of r.checks) lines.push(`  ${c.ok ? "PASS" : "OPEN"}  [${c.kind}] ${c.id}: ${c.detail}`);
  const open = r.checks.filter((c) => !c.ok).length;
  lines.push("", r.passed ? (r.staticOnly ? "CODE CHECKS PASS. Staging evidence was not checked." : "GATE PASSED: the phase may be approved.") : `GATE NOT PASSED: ${open} open item(s). ${r.codeOk ? "The code is complete; what is open needs a person with access to staging." : "Code checks are failing."}`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const phase = argv[argv.indexOf("--phase") + 1];
  if (phase !== "2") { console.error("usage: node scripts/phase-gate.mjs --phase 2 [--static-only] [--json]"); process.exit(2); }
  const result = await evaluatePhase2Gate(defaultRoot, { staticOnly: argv.includes("--static-only") });
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : render(result));
  process.exit(result.passed ? 0 : 1);
}
