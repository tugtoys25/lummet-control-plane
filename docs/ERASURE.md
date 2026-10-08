# Account and data deletion (roadmap 1.3)

Built so the legal question becomes a short review of one file
(`worker/retention-policy.js`), not a code change. **The defaults are a draft
for your lawyer, not legal advice.**

## What a person can do

- **Download my data** (`/app/account`, `GET /api/customer/account/export`): profile,
  memberships, sign-in methods (never secrets), API keys they created, invitations they sent,
  recent activity.
- **Delete my account** (`POST /api/customer/account/delete`): needs the email typed again and
  the password (SSO-managed accounts skip the password). Refused while they are the **only owner**
  of an organization that is not already scheduled for deletion; they delete or hand over the
  organization first. Sessions, authenticator and passkey data, memberships, invitations they sent
  and queued emails go. The user row stays as an anonymous tombstone
  (`deleted-<id>@deleted.invalid`) so invoices and audit rows keep working, and the email address
  can be registered again.
- **Delete an organization** (owner, `/app/account` or `POST .../request-deletion`): cancels the
  subscription, starts a grace period (see `organizations.js`), can be undone until it ends.

## What happens when the grace period ends

`erasure.purgeDueOrganizations` runs from the Cron Trigger or the pinger tick (up to 3
organizations per run). For each organization, in this order:

1. **External resources first:** custom hostnames, the tenant Worker script, then its database,
   key-value namespace and storage bucket, then stored backup files. **If any step fails, nothing in
   the database is touched**, the attempt is logged as `partial` in `erasure_log`, and the next run
   retries (steps that already succeeded are not repeated; "not found" counts as done).
2. Database rows are removed (see `ORG_DELETE` / `SITE_DELETE`), the tenant registry entry is
   removed, people who exist only through this organization's SSO are erased, personal content in
   audit rows is scrubbed (IP hash removed, messages containing an email replaced).
3. The organization and its sites become anonymous tombstones.
4. **Billing records stay** for `FINANCIAL_RETENTION_YEARS` (draft: 7), then
   `sweepExpiredFinancialRecords` removes them.

Every erasure writes a row to `erasure_log` (ids and counts only, never content).

## Questions for your lawyer (change them in `retention-policy.js`)

1. How long must invoices and subscription history be kept, per country you sell in?
2. Are audit logs with the IP hash and action history removed, kept, or kept without the user id?
   (Today: kept, with personal content scrubbed.)
3. Do you owe customers a confirmation of erasure, and within what time? (Not built: there is no
   email on completion.)
4. Do backups outside this system need a deletion process? (Control-plane database backups in R2
   still contain an erased person's data until they age out after about 14 days. Stripe, Resend and
   Cloudflare each hold their own copies and have their own deletion processes; this code does
   **not** ask them to delete anything except Cloudflare resources.)
5. Is a 30-day style grace period acceptable, and who may cancel it?

## Known gaps

- **Stripe, Resend and other processors are not told to erase** the person or organization.
- **Control-plane backups keep data until they expire** (about 14 days); stored customer-site
  backup files are deleted.
- **Not tested against real Cloudflare**; the deletion calls are exercised with a fake provider and
  the Cloudflare module only gained one new call (`deleteWorkerScript`). Run it once on staging.
- **No confirmation email** and no staff screen for `erasure_log` yet (query the table).
- **The tenant site's own content** lives in its D1 database, which is deleted with the resources;
  there is no per-record deletion inside it.
- A new table that mentions an organization, site, user or email **fails a test** until it is added
  to the policy file, so this list cannot silently go stale.


## v7C: public inquiries
Contact/demo inquiries (`lummet_inquiries`) are not linked to an account, so they are matched by email address:
erasing a person deletes inquiries sent with their address, and erasing an organization deletes inquiries sent with its
billing email. Submissions made with any other address are still deleted by staff in Site Forms > Inquiries.
