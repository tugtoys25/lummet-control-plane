# Incident response policy (Draft)

**Status: Draft, not approved**

This is a starting draft written from the repository as it stands. It is not a policy of the company until the owner approves it. It does not claim SOC 2 compliance, attestation or an auditor opinion, and nothing here is a promise to customers.

Policy owner: [OPEN]
Approved by: [OPEN]
Approval date: [OPEN]
Effective date: [OPEN]
Review interval: [OPEN]
Version: draft 0.1 (Round 6.5C, release 2.6.0.14)

## Purpose and scope (draft wording, owner to confirm)
How Lummet detects, handles, communicates and learns from security and availability incidents.

## What the repository does today (STATIC REVIEW)
- Alerts for failed jobs, webhooks, email, backups and server errors reach a human only through the configured alert webhook and/or email address (`docs/ALERTING.md`).
- Synthetic monitors for sign-in, checkout, a canary site and domain attach exist and are off by default (`docs/SYNTHETIC_MONITORS.md`).
- Runbooks cover webhook backlog, Stripe outage, database incident, Cloudflare incident, mass email failure and mistaken suspension (`docs/RUNBOOKS.md`). None has been exercised.
- A restore drill and report template exist; the drill has not been run (`docs/runbooks/restore-drill.md`).
- The shared rules: never fake success, audit every staff action with a reason, no secrets in tickets.

## Decisions the owner must make before this can be approved
- [OPEN] Who is paged first, by what tool, who is next, and what applies out of hours.
- [OPEN] How incidents are classified, and who may declare and close one.
- [OPEN] Customer and regulator notification rules and who approves the wording.
- [OPEN] Status-page posting rules, and the restore-time and recovery-point objectives.
- [OPEN] Whether a post-incident review is required and where it is kept.

## Known gaps
- No incident has been handled with these runbooks; they are NOT VERIFIED.
- No on-call rota exists in the repository.
