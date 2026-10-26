// The Phase 2 gate: the real tree passes its code checks, and the gate refuses on each way the record can be wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluatePhase2Gate, parseStagingRecord, REQUIRED_STAGING_ITEMS, PHASE2_REQUIRED_KINDS, PHASE2_WEBHOOK_EVENTS, STAGING_RECORD } from '../scripts/phase-gate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const byId = (r, id) => r.checks.find((c) => c.id === id);

test('the real tree passes every code check', async () => {
  const r = await evaluatePhase2Gate(repo, { staticOnly: true });
  assert.deepEqual(r.checks.filter((c) => !c.ok), [], JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.passed, true); assert.equal(r.stagingOk, null);
});

test('the shipped staging record is blank and the gate says so (nothing is ticked on anyone\'s behalf)', async () => {
  const text = readFileSync(path.join(repo, STAGING_RECORD), 'utf8');
  const rec = parseStagingRecord(text);
  assert.deepEqual(rec.items.map((i) => i.id).sort(), [...REQUIRED_STAGING_ITEMS].sort(), 'the record lists exactly the required checks');
  const blank = rec.items.every((i) => !i.ticked && !i.done) && !rec.approvedBy;
  if (blank) {
    const r = await evaluatePhase2Gate(repo);
    assert.equal(r.passed, false); assert.equal(r.codeOk, true); assert.equal(r.stagingOk, false);
    assert.equal(r.checks.filter((c) => c.kind === 'staging' && !c.ok).length, REQUIRED_STAGING_ITEMS.length + 1);
  }
});

test('a box counts only when ticked AND it has evidence', () => {
  const rec = parseStagingRecord([
    '- [x] a_one: did the thing — evidence: https://example.test/log/123',
    '- [x] b_two: did the thing — evidence:',
    '- [x] c_three: did the thing — evidence: tbd',
    '- [ ] d_four: not done — evidence: https://example.test/never-ticked',
    '- [X] e_five: no evidence text at all',
    'Approved by: Dana Reviewer', 'Approved on: 2026-11-02'
  ].join('\n'));
  assert.deepEqual(rec.items.map((i) => [i.id, i.done]), [['a_one', true], ['b_two', false], ['c_three', false], ['d_four', false], ['e_five', false]]);
  assert.equal(rec.approvedBy, 'Dana Reviewer'); assert.equal(rec.approvedOn, '2026-11-02');
});

function tree(mutate = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); writeFileSync(path.join(d, rel), text); };
  const kinds = Object.values(PHASE2_REQUIRED_KINDS);
  const files = {
    'worker/billing-email-templates.js': `export const BILLING_KINDS = ${JSON.stringify(kinds)};`,
    'worker/billing.js': PHASE2_WEBHOOK_EVENTS.map((e) => `case "${e}":`).join('\n'),
    'migrations/0051_billing_notifications.sql': 'CREATE TABLE billing_notifications (dedupe_key TEXT NOT NULL UNIQUE); CREATE TABLE email_suppressions (email_hash TEXT NOT NULL UNIQUE);',
    'worker/index.js': '"/api/email/webhook/resend" "/platform/saas/notifications" "/api/platform/saas/notifications/:id/resend"',
    'worker/billing-notifications.js': 'export async function resend(env, id) { return repo.requeueFailedMessage(env, id); }',
    'worker/alerts.js': 'key: "email_bounce_rate" key: "billing_email_stuck"',
    'docs/CONFIGURATION.md': 'BILLING_EMAILS BILLING_REMINDER_DAYS BILLING_RENEWAL_NOTICES BILLING_WINBACK_EMAILS RESEND_WEBHOOK_SECRET',
    'wrangler.example.jsonc': 'BILLING_EMAILS BILLING_REMINDER_DAYS BILLING_RENEWAL_NOTICES BILLING_WINBACK_EMAILS',
    'docs/CHANGES_PHASE_2_1.md': '## Rollback\n', 'docs/CHANGES_PHASE_2_2.md': '## Rollback\n', 'docs/CHANGES_PHASE_2_3.md': '## Rollback\n',
    [STAGING_RECORD]: [...REQUIRED_STAGING_ITEMS.map((id) => `- [x] ${id}: checked — evidence: run-${id}-log`), 'Approved by: Dana Reviewer', 'Approved on: 2026-11-02'].join('\n'),
    ...mutate
  };
  for (const [rel, text] of Object.entries(files)) if (text !== null) put(rel, text);
  return d;
}

test('a complete tree with a complete signed record passes', async () => {
  const d = tree();
  try { const r = await evaluatePhase2Gate(d); assert.equal(r.passed, true, JSON.stringify(r.checks.filter((c) => !c.ok))); } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the gate refuses on each missing piece', async () => {
  const cases = [
    ['templates', { 'worker/billing-email-templates.js': 'export const BILLING_KINDS = ["receipt"];' }],
    ['webhook_handlers', { 'worker/billing.js': 'case "invoice.upcoming":' }],
    ['migration_0051', { 'migrations/0051_billing_notifications.sql': 'SELECT 1;' }],
    ['resend_webhook_route', { 'worker/index.js': '"/platform/saas/notifications" "/api/platform/saas/notifications/:id/resend"' }],
    ['staff_notifications_view', { 'worker/index.js': '"/api/email/webhook/resend"' }],
    ['resend_is_dedupe_aware', { 'worker/billing-notifications.js': 'export async function resend(env, id) { return insertIntent(env, id); }' }],
    ['alerts', { 'worker/alerts.js': 'key: "email_bounce_rate"' }],
    ['configuration_documented', { 'docs/CONFIGURATION.md': 'BILLING_EMAILS' }],
    ['change_docs_and_rollback', { 'docs/CHANGES_PHASE_2_3.md': null }],
    ['change_docs_and_rollback', { 'docs/CHANGES_PHASE_2_2.md': 'no such section' }]
  ];
  for (const [id, mutate] of cases) {
    const d = tree(mutate);
    try { const r = await evaluatePhase2Gate(d); assert.equal(byId(r, id).ok, false, id); assert.equal(r.passed, false, id); } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('the gate refuses on a missing record, an open box, an evidence-less box and a blank or placeholder approval', async () => {
  const ticked = (skip, evidence = 'seen in the log') => REQUIRED_STAGING_ITEMS.map((id) => (id === skip ? `- [ ] ${id}: open — evidence:` : `- [x] ${id}: ok — evidence: ${evidence}`));
  const cases = [
    ['staging_record', { [STAGING_RECORD]: null }],
    ['staging:welcome_and_reminder_once', { [STAGING_RECORD]: [...ticked('welcome_and_reminder_once'), 'Approved by: Dana', 'Approved on: 2026-11-02'].join('\n') }],
    ['staging:bounce_rate_alert', { [STAGING_RECORD]: [...ticked(null, '-').map((l) => l), 'Approved by: Dana', 'Approved on: 2026-11-02'].join('\n') }],
    ['approval', { [STAGING_RECORD]: [...ticked(null), 'Approved by:', 'Approved on: (YYYY-MM-DD)'].join('\n') }],
    ['approval', { [STAGING_RECORD]: [...ticked(null), 'Approved by: <name>', 'Approved on: 2026-11-02'].join('\n') }]
  ];
  for (const [id, mutate] of cases) {
    const d = tree(mutate);
    try { const r = await evaluatePhase2Gate(d); assert.equal(byId(r, id).ok, false, id); assert.equal(r.passed, false, id); assert.equal(r.codeOk, true, 'code checks are unaffected: ' + id); } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('--static-only ignores the record; the CLI exits 0 only when everything passed', () => {
  const run = (...a) => spawnSync(process.execPath, ['scripts/phase-gate.mjs', '--phase', '2', ...a], { cwd: repo, encoding: 'utf8' });
  const s = run('--static-only'); assert.equal(s.status, 0, s.stdout); assert.match(s.stdout, /Staging evidence was not checked/);
  const f = run(); assert.equal(f.status, 1); assert.match(f.stdout, /GATE NOT PASSED/);
  assert.equal(spawnSync(process.execPath, ['scripts/phase-gate.mjs'], { cwd: repo, encoding: 'utf8' }).status, 2);
});
