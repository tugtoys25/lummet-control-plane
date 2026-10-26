# Enforcement cutover runbook (Sprint 1.6)

**Defaults are unchanged.** `BILLING_ENFORCE` remains `off` unless an operator deliberately changes it. Perform each step in staging first. Do not combine write-gate and serve-gate cutovers.

## Preconditions

1. Record release SHA, environment, operator, approver, UTC start time and the current `BILLING_ENFORCE` value in the change ticket.
2. Confirm `check-config.mjs` passes, migrations are current, alert delivery works, and bulk reactivation has been tested by the on-call operator.
3. Confirm the `trial_expired_still_live`, `cancel_pending_stuck`, `site_access_push_failed` and `reconcile_drift` alerts are visible and assigned.
4. Capture the current shadow report and export it with timestamps. Group findings by organization, state, entry point and reason. Every remaining difference needs a named owner and written disposition.
5. For the shadow-difference audit, export the current shadow rows with a review owner, disposition and review timestamp, then run `node scripts/report-shadow-differences.mjs shadow-findings-reviewed.json shadow-differences-report.json`. Exit code `1` means unexplained differences remain; exit code `0` means every row has a recognized disposition plus owner and review timestamp.
6. Keep `BILLING_SUSPEND_SITES=off` during write-gate cutover. It is a separate switch and must not be silently enabled.

## Write gate: off → shadow → enforce

1. **Off baseline:** set `BILLING_ENFORCE=off`; deploy to staging; run the Phase 1.4 behavioral access matrix and critical customer write smoke tests. Confirm normal behavior and no new shadow rows from the gate.
2. **Shadow:** set `BILLING_ENFORCE=shadow`; deploy to staging; exercise every listed entry point with allowed and refused states. Wait at least one normal billing sweep interval and review the shadow report. Confirm every record contains the entry-point name and a stable reason code. Resolve all unexplained differences; do not treat a zero-row report as proof unless test organizations were exercised.
3. **Approval:** attach the report and test output to the change ticket. Require approval from the service owner and on-call operator. If there are unexplained differences, stay in shadow.
4. **Enforce write gate only:** set `BILLING_ENFORCE=enforce` in staging; deploy; rerun the matrix. Verify trialing/active/past_due-in-grace mutations remain allowed and restricted/suspended/closed/trial-expired mutations return structured refusals. Verify billing, export, reactivation and deletion recovery paths remain usable.
5. Observe one complete billing sweep and a representative customer session. Only then schedule production write-gate cutover using the same report/approval procedure.

## Serve gate: shadow → enforce (separate change)

1. Leave the write gate enforced and record the baseline. Keep the tenant serve gate in shadow while exercising suspended, closed, restored and ordinary sites on a canary.
2. Confirm the signed state is pushed, cached only for its documented short TTL, and fails open when state is missing/stale or the control plane is unreachable. Verify a deny-state page and recovery latency against the agreed bound.
3. Review `site_access_push_failed`, tenant-edge state freshness and shadow differences. Ensure bulk reactivate can be used by the on-call operator and push retry reports per-site outcomes.
4. Obtain a separate approval. Enable the serve gate in staging first; test suspended/closed neutral response, ordinary site unaffected, and restoration. Then schedule production canary, followed by gradual expansion.

## Rollback

- **Write gate:** immediately set `BILLING_ENFORCE=shadow` (preferred) or `off` if shadow logging itself is unhealthy. Redeploy/restart the relevant Worker configuration. Confirm write requests no longer receive billing-gate refusals; preserve findings and audit logs. Do not mutate subscription state to “fix” a gate rollback.
- **Serve gate:** set the tenant serve-gate mode back to `shadow`, then `off` if needed. Do not clear signed settings as an emergency shortcut. Confirm public sites fail open and are serving; then inspect failed push jobs and retry with a reason.
- Open an incident if rollback fails, preserve request IDs and audit entries, and do not re-enter enforce until the owner signs off on a fresh shadow report.

## Evidence to record

- Release SHA and migration history; exact configuration change and UTC time; before/after shadow reports; test command and raw output; canary site IDs; push job outcomes; alert delivery; approver; rollback operator; final decision. Record the policy decision that restricted sites remain publicly live for seven days before suspension.
