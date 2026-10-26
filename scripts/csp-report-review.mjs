#!/usr/bin/env node
/** Review CSP violation records from Worker logs (Round 6.3C). Offline: reads files, never calls the network.
 *    node scripts/csp-report-review.mjs <log-file>... --from <ISO date> --to <ISO date> [--min-days N] [--json]
 *  Log files: `wrangler tail --format json > tail.ndjson`, a Logpush download, or the records alone. See docs/CSP_REPORTING.md.
 *  --from/--to  the observation window you actually ran (the file cannot prove it). --min-days defaults to 7 [OPEN] placeholder.
 *  Exit 0: no violations in a long-enough window. Exit 1: any other verdict. Exit 2: bad usage or unreadable file.
 *  A pass is evidence for a human review, not an approval to set CSP_MODE=enforce. */
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { extractViolations, aggregate, verdict, renderTable, DEFAULT_MIN_DAYS } from "./lib/csp-review.mjs";

const USAGE = "Usage: node scripts/csp-report-review.mjs <log-file>... --from <ISO date> --to <ISO date> [--min-days N] [--json]";

export async function main(argv, env, io = { log: console.log, error: console.error }) {
  const opt = (x) => { const i = argv.indexOf(`--${x}`); return i >= 0 ? argv[i + 1] : null; };
  const valueFlags = new Set(["--from", "--to", "--min-days"]);
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (valueFlags.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    files.push(argv[i]);
  }
  if (!files.length) { io.error(USAGE); return 2; }
  const rawMin = opt("min-days");
  const minDays = rawMin === null ? DEFAULT_MIN_DAYS : (/^\d+(\.\d+)?$/.test(rawMin) ? Number(rawMin) : NaN);
  if (!Number.isFinite(minDays)) { io.error(`REFUSED: --min-days must be a number. ${USAGE}`); return 2; }

  let text = "";
  for (const file of files) {
    try { text += (await readFile(file, "utf8")) + "\n"; }
    catch (error) { io.error(`Cannot read ${file}: ${error && error.code ? error.code : error}`); return 2; }
  }
  const found = extractViolations(text);
  const rows = aggregate(found.violations);
  const result = verdict({ violations: found.violations, suppressed: found.suppressed, lines: found.lines, from: opt("from"), to: opt("to"), minDays });
  if (argv.includes("--json")) {
    io.log(JSON.stringify({ verdict: result, lines: found.lines, skipped: found.skipped, suppressed: found.suppressed, violations: found.violations.length, rows, window: { from: opt("from"), to: opt("to"), minDays } }, null, 2));
  } else {
    io.log([renderTable(rows), "", `lines read: ${found.lines}  skipped (not JSON): ${found.skipped}  violation records: ${found.violations.length}  suppressed markers: ${found.suppressed}`, `${result.code}: ${result.message}`].join("\n"));
  }
  return result.pass ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.env));
