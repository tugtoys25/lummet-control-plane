import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const doc = await readFile(new URL("../docs/CHANGES_PHASE_2.md", import.meta.url), "utf8");

test("consolidated Phase 2 note links the three part notes and documents a rollback", () => {
  for (const f of ["CHANGES_PHASE_2_1.md", "CHANGES_PHASE_2_2.md", "CHANGES_PHASE_2_3.md"]) assert.match(doc, new RegExp(f));
  assert.match(doc, /^## Rollback/m);
});

test("consolidated Phase 2 note says the phase is not approved and names every Phase 2 flag", () => {
  assert.match(doc, /not approved/i);
  for (const flag of ["BILLING_EMAILS", "BILLING_REMINDER_DAYS", "BILLING_RENEWAL_NOTICES", "BILLING_WINBACK_EMAILS", "RESEND_WEBHOOK_SECRET"]) assert.ok(doc.includes(flag), flag);
});

test("the staging record ships honest: no box ticked without evidence", async () => {
  const rec = await readFile(new URL("../docs/PHASE_2_STAGING_RECORD.md", import.meta.url), "utf8");
  const { parseStagingRecord } = await import("../scripts/phase-gate.mjs");
  const parsed = parseStagingRecord(rec);
  assert.equal(parsed.items.length, 13);
  for (const i of parsed.items) if (i.ticked) assert.ok(i.done, `${i.id} is ticked without evidence`);
});
