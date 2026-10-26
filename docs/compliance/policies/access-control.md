# Access control policy (Draft)

**Status: Draft, not approved**

This is a starting draft written from the repository as it stands. It is not a policy of the company until the owner approves it. It does not claim SOC 2 compliance, attestation or an auditor opinion, and nothing here is a promise to customers.

Policy owner: [OPEN]
Approved by: [OPEN]
Approval date: [OPEN]
Effective date: [OPEN]
Review interval: [OPEN]
Version: draft 0.1 (Round 6.5C, release 2.6.0.14)

## Purpose and scope (draft wording, owner to confirm)
Who may reach which system and data, how access is granted, reviewed and removed. Staff, customer users and automated callers are all in scope; the exact list is [OPEN].

## What the repository does today (STATIC REVIEW)
- Staff accounts use passwords with an optional authenticator-app step (`docs/STAFF_2FA.md`); platform routes can sit behind Cloudflare Access (`docs/CLOUDFLARE_ACCESS.md`).
- Customer roles are enforced in code (`worker/customer-rbac.js`); organization-level security policy settings exist behind flags that default to off (`docs/CONFIGURATION.md`).
- Money actions above an owner-set amount need a second approver (`worker/commercial.js`); when the amount is unset every request needs one. This covers only the action types built so far.
- Every staff action is audited (`worker/audit.js`).
- Code owner review is not in force: the owner file is a template until the owner supplies a handle (`.github/CODEOWNERS`, `docs/release-owner.json`).

## Decisions the owner must make before this can be approved
- [OPEN] Who approves staff access, and how often is it reviewed?
- [OPEN] Must two-factor be required for every staff account, and is Cloudflare Access required in production?
- [OPEN] Rules for shared or break-glass accounts, and for removing access when someone leaves.
- [OPEN] Whether the second-approver rule should cover more action types.

## Known gaps
- No access review has been run and no review evidence exists yet (evidence tooling is Round 7.4A).
- Identity-provider behavior is NOT VERIFIED.
