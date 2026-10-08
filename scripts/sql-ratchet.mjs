#!/usr/bin/env node
// Counts direct SQL (".prepare(") per file under worker/, outside worker/repositories/.
//   node scripts/sql-ratchet.mjs            print counts
//   node scripts/sql-ratchet.mjs --update   write docs/sql-baseline.json (do this after converting a file)
// test/sql-boundary.test.js fails if any file's count goes UP, or a new file has any.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function countSql() {
  const out = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) { if (rel !== "worker/repositories") await walk(full); }
      else if (entry.name.endsWith(".js")) {
        const n = ((await readFile(full, "utf8")).match(/\.prepare\(/g) || []).length;
        if (n) out[rel] = n;
      }
    }
  }
  await walk(path.join(root, "worker"));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = await countSql();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (process.argv.includes("--update")) {
    await writeFile(path.join(root, "docs/sql-baseline.json"), JSON.stringify({ note: "Direct .prepare( calls per file outside worker/repositories. May only go down. See worker/repositories/README.md.", total, files: counts }, null, 2) + "\n");
    console.log(`baseline written: ${total} direct SQL calls in ${Object.keys(counts).length} files`);
  } else {
    for (const [f, n] of Object.entries(counts)) console.log(String(n).padStart(4), f);
    console.log(String(total).padStart(4), "TOTAL");
  }
}
