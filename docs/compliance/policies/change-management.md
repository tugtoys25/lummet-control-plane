# Change management policy (Draft)

**Status: Draft, not approved**

This is a starting draft written from the repository as it stands. It is not a policy of the company until the owner approves it. It does not claim SOC 2 compliance, attestation or an auditor opinion, and nothing here is a promise to customers.

Policy owner: [OPEN]
Approved by: [OPEN]
Approval date: [OPEN]
Effective date: [OPEN]
Review interval: [OPEN]
Version: draft 0.1 (Round 6.5C, release 2.6.0.14)

## Purpose and scope (draft wording, owner to confirm)
How changes to code, configuration and the database reach production, and how they are reviewed, tested and reversed.

## What the repository does today (STATIC REVIEW)
- Pull requests run the test suite on two Node versions and static gates (`.github/workflows/ci.yml`). Pushes to the main branch run the same suite before a deploy job (`.github/workflows/deploy.yml`).
- A lockfile check rejects incomplete dependency graphs (`scripts/lockfile-check.mjs`).
- Database migrations are additive and numbered; the packaging gate checks that shipped migrations are not edited (`scripts/package-phase.mjs`).
- Each release ships a change list, verification report, open items and a manifest with checksums, and states what was not run.
- New behavior ships behind a flag that defaults to off or shadow; defaults of billing enforcement flags are not changed without a recorded owner decision.
- Rollback and forward-fix notes accompany each release; Time Travel bookmarks are recorded with `scripts/record-d1-bookmark.mjs`.

## Decisions the owner must make before this can be approved
- [OPEN] Who may approve a production release, and is a second reviewer required?
- [OPEN] Emergency change rules and how they are recorded afterward.
- [OPEN] Whether branch protection and required code-owner review are turned on (needs the real owner handle).

## Known gaps
- The checked-in lockfiles are stubs, so a clean install cannot be proven offline.
- Whether branch protection is configured in GitHub is NOT VERIFIED.
