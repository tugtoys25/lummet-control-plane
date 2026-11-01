#!/usr/bin/env node
// Turns a downloaded control-plane backup into a SQL file you can load into a
// FRESHLY MIGRATED, empty D1 database.
//
//   1. Download the backup folder from the R2 bucket (manifest.json and every
//      part-NNNN.json) into one local directory, e.g. ./restore-in
//   2. Create a new D1 database and apply all migrations to it
//      (node scripts/migrate.mjs, pointed at the new database)
//   3. CREDENTIAL_KEK=<the key> [CREDENTIAL_KEK_PREVIOUS=<older key>] node scripts/restore-control-plane.mjs ./restore-in > restore.sql
//   4. wrangler d1 execute <new-db> --remote --file restore.sql
//
// Tables are written parents-first. Uses INSERT OR REPLACE, so seeded catalog
// rows from the migrations are replaced by the backed-up versions.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { decryptSecret } from "../worker/crypto.js";
import { rowToSql, backupPartAad } from "../worker/cp-backup.js";

const dir = process.argv[2];
if (!dir || !process.env.CREDENTIAL_KEK) {
  console.error("Usage: CREDENTIAL_KEK=<base64 key> node scripts/restore-control-plane.mjs <backup-dir> > restore.sql");
  process.exit(2);
}
// CREDENTIAL_KEK_PREVIOUS is optional: set it when the backup predates a key rotation.
const env = { CREDENTIAL_KEK: process.env.CREDENTIAL_KEK, CREDENTIAL_KEK_PREVIOUS: process.env.CREDENTIAL_KEK_PREVIOUS };
const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
const files = new Set(await readdir(dir));

const byTable = new Map(manifest.tables.map((t) => [t, []]));
for (const p of manifest.parts) {
  const name = path.basename(p.key);
  if (!files.has(name)) { console.error(`Missing part file: ${name}`); process.exit(1); }
  const body = await readFile(path.join(dir, name), "utf8");
  if (createHash("sha256").update(body).digest("hex") !== p.sha256) { console.error(`Hash mismatch (corrupted download?): ${name}`); process.exit(1); }
  const part = JSON.parse(body);
  // p.key is the part's original object key, so a v2 part is checked against its own backup id and part name.
  const plain = await decryptSecret(env, part.data, part.iv, backupPartAad(p.key));
  for (const line of plain.split("\n")) { const { t, r } = JSON.parse(line); byTable.get(t).push(r); }
}

const out = [`-- Control-plane restore generated from backup ${manifest.backupId} (${manifest.createdAt})`];
for (const t of manifest.tables) {
  const rows = byTable.get(t);
  if (rows.length !== manifest.rowCounts[t]) { console.error(`Row count mismatch for ${t}`); process.exit(1); }
  for (const r of rows) out.push(rowToSql(t, r));
}
process.stdout.write(out.join("\n") + "\n");
