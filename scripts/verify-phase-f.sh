#!/usr/bin/env bash
# Run on a connected machine with Node 22 and 24 available. This script is fail-closed:
# npm ci failures are recorded and never hidden by a later test pass.
set -u
REPORT="${PHASE_F_REPORT:-phase-f-verification-$(node -p 'process.versions.node.replaceAll(".","-")').txt}"
: > "$REPORT"
failures=0
record() { printf '%s\n' "$*" | tee -a "$REPORT"; }
run_step() {
  label="$1"; shift
  record "\n## $label"
  "$@" 2>&1 | tee -a "$REPORT"
  status=${PIPESTATUS[0]}
  record "exit_status=$status"
  if [ "$status" -ne 0 ]; then failures=$((failures + 1)); fi
  return 0
}
major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
record "Node=$(node --version 2>&1); npm=$(npm --version 2>&1); platform=$(uname -a)"
if [ "$major" != "22" ] && [ "$major" != "24" ]; then
  record "ERROR: use Node 22 or Node 24. No checks will be marked verified for this runtime."
  exit 2
fi
run_step 'control-plane lockfile integrity' bash -lc 'cd lummet-control-plane && node scripts/lockfile-check.mjs'
run_step 'control-plane npm ci' bash -lc 'cd lummet-control-plane && npm ci --no-audit --no-fund'
run_step 'control-plane full isolated test suite' bash -lc 'cd lummet-control-plane && TEST_FILE_TIMEOUT_MS=120000 npm test'
run_step 'control-plane config check' bash -lc 'cd lummet-control-plane && npm run check:config'
run_step 'control-plane SQL ratchet' bash -lc 'cd lummet-control-plane && node scripts/sql-ratchet.mjs'
run_step 'control-plane Phase 5 static gate' bash -lc 'cd lummet-control-plane && node scripts/phase5-gate.mjs'
run_step 'tenant lockfile integrity' bash -lc 'cd lummet-tenant && node scripts/lockfile-check.mjs'
run_step 'tenant tooling npm ci' bash -lc 'cd lummet-tenant && npm ci --no-audit --no-fund'
run_step 'tenant English worker npm ci' bash -lc 'cd lummet-tenant/en && npm ci --no-audit --no-fund'
run_step 'tenant English worker full isolated test suite' bash -lc 'cd lummet-tenant/en && TEST_FILE_TIMEOUT_MS=120000 npm test'
record "\n## Final"
if [ "$failures" -eq 0 ]; then record 'RESULT=PASS'; else record "RESULT=FAIL failed_steps=$failures"; fi
record "Report=$REPORT"
exit "$failures"
