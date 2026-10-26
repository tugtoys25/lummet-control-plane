# Information security policy (Draft)

**Status: Draft, not approved**

This is a starting draft written from the repository as it stands. It is not a policy of the company until the owner approves it. It does not claim SOC 2 compliance, attestation or an auditor opinion, and nothing here is a promise to customers.

Policy owner: [OPEN]
Approved by: [OPEN]
Approval date: [OPEN]
Effective date: [OPEN]
Review interval: [OPEN]
Version: draft 0.1 (Round 6.5C, release 2.6.0.14)

## Purpose and scope (draft wording, owner to confirm)
How Lummet protects the control plane, the customer portal, customer sites and the data they hold. Scope, roles and the list of systems are [OPEN] decisions.

## What the repository does today (STATIC REVIEW, nothing verified live)
- Staff sign-in can require an authenticator-app code (`docs/STAFF_2FA.md`). Optional Cloudflare Access in front of platform routes (`docs/CLOUDFLARE_ACCESS.md`).
- Staff and customer actions are written to an audit table (`worker/audit.js`); a copy can be streamed to logs with secrets and personal data scrubbed (`docs/LOGPUSH.md`).
- Secrets are read from Worker settings, not repository files (`docs/CONFIGURATION.md`); rotation steps are in `docs/KEY_ROTATION.md`.
- Control-plane backups are encrypted and kept in R2 (`docs/CONTROL_PLANE_BACKUP.md`).
- Account and data deletion follows a configurable retention policy (`docs/ERASURE.md`, `worker/retention-policy.js`).
- Edge settings (rate limits, CSP, HSTS) are config as code (`docs/WAF_RATE_LIMITS.md`, `docs/CSP.md`, `docs/HSTS_PRELOAD.md`); live changes are owner-run.

## Decisions the owner must make before this can be approved
- [OPEN] Who owns information security, and who may approve exceptions?
- [OPEN] Which systems, vendors and data classes are in scope?
- [OPEN] Required security training, background checks and onboarding or offboarding steps, if any.
- [OPEN] Which of the sibling policies in this set apply together (access control, change management, incident response) and which are still to be written in Round 7.4A.

## Known gaps
- Nothing in this repository proves any control operates in production. Cloudflare, Stripe, DNS, WAF and identity-provider behavior is NOT VERIFIED.
- No penetration test has been run; it is an owner task (OPEN_ITEMS for this release).
