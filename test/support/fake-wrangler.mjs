#!/usr/bin/env node
// A stand-in for the `wrangler` CLI, used only by test/migrate.test.js.
// Understands exactly the subset of `wrangler d1 execute` that
// scripts/migrate.mjs calls, backed by a real sqlite file so the test
// exercises real SQL execution, not a mock.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "d1" || args[1] !== "execute") { console.error("unsupported"); process.exit(1); }
const dbPath = process.env.FAKE_WRANGLER_DB_PATH; // one sqlite file stands in for one D1 database
const db = new DatabaseSync(dbPath);

const fileIdx = args.indexOf("--file");
const cmdIdx = args.indexOf("--command");
const asJson = args.includes("--json");

try {
  if (fileIdx !== -1) {
    db.exec(readFileSync(args[fileIdx + 1], "utf8"));
    if (asJson) console.log(JSON.stringify([{ results: [] }]));
  } else if (cmdIdx !== -1) {
    const sql = args[cmdIdx + 1];
    if (/^\s*SELECT/i.test(sql)) {
      const rows = db.prepare(sql).all();
      if (asJson) console.log(JSON.stringify([{ results: rows }]));
    } else {
      db.exec(sql);
      if (asJson) console.log(JSON.stringify([{ results: [] }]));
    }
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
