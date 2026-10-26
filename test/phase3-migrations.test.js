import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("all control-plane migrations through 0057 apply cleanly and expose Phase 3 schema", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(root, "migrations", name), "utf8"));
    }
    for (const table of ["plan_prices","plan_change_intents","organization_billing_profiles","invoice_lines","refunds","disputes","credit_notes","reconciliation_findings","billing_payment_methods"]) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      assert.ok(row, `missing table ${table}`);
    }
    const invoiceCols = new Set(db.prepare("PRAGMA table_info(invoices)").all().map(x => x.name));
    for (const col of ["number","subtotal_cents","tax_cents","discount_cents","total_cents","pdf_url","due_at","attempt_count","next_attempt_at","provider_event_created"]) assert.ok(invoiceCols.has(col), `missing invoices.${col}`);
    const auditCols = new Set(db.prepare("PRAGMA table_info(lummet_audit_logs)").all().map(x => x.name));
    assert.ok(auditCols.has("reason"), "missing structured audit reason column");
    for (const table of ["refunds","disputes","credit_notes","organization_billing_profiles","billing_payment_methods"]) {
      const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
      assert.ok(cols.has(table === "billing_payment_methods" ? "last_event_created" : "provider_event_created"), `missing event ordering column on ${table}`);
    }
  } finally { db.close(); }
});
