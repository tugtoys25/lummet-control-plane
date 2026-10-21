# v7C: correctness and CI hardening on v7B

Tests: control plane 796 -> 811 (all pass on Node 22; CI now also runs Node 24), tenant 917 (unchanged).
Not run against live Cloudflare, Stripe or Resend.

## Fixed
- **Failed Stripe webhooks are retried.** A redelivered event that previously failed, or was left in `received` by a
  crashed attempt (older than 5 minutes), is claimed atomically and reprocessed, up to 5 attempts. Processed events and
  events being processed are still skipped. After 5 failures it stays `failed` and the existing alert covers it.
  A redelivered `checkout.session.completed` whose first attempt got partway no longer throws on its own subscription;
  it repeats only the idempotent steps (coupon redemption, notification). Migration `0038` adds `attempts` and
  `last_attempt_at`. SQL moved to `repositories/billing-webhooks.js` (SQL ratchet 490 -> 487).
- **Numbered `?1` placeholders** in the coupon reservation query are now plain `?`, with a test that fails if any
  `?N` placeholder appears anywhere in `worker/`.
- **`npm test` glob is quoted** (control plane and tenant) so Node expands it. Unquoted, `sh` expands `**` one level
  and a single test file added in a subfolder would have silently skipped every root-level test.
- **CI** runs the control-plane tests on Node 22 and 24 in a separate `test` job; `deploy` needs it.
- **Visitor inquiries** are deleted with the person (by email) or the organization (by billing email) they came from.
- **Public sign-in link to the customer portal** in the header and footer (migration `0039`, editable under /cms/nav_links).

## Added
- **Production configuration check** (`worker/config-check.js`): with `ENVIRONMENT=production`, missing settings (names only)
  show as a banner on the staff SaaS overview and raise a `config_incomplete` alert. An empty `PORTAL_BASE_URL` used to
  make sign-up succeed while queueing no emails.
- A wrangler config with no real ids (since consolidated into `wrangler.jsonc`).

## Could not reproduce
The dev team reported a red control-plane suite (coupon reservation, `column index out of range`) and a tenant suite that
did not finish. On Node 22.22 both pass here (796/796 and 917/917 in about 70 s). The placeholder change and the Node
matrix remove the likely cause.

## Next (see the plan): v7D durable jobs and webhook delivery retries, v7E CSP, v7F customer portal pages,
v7G annual pricing and public pricing page, v7H automation/AI/approvals/bulk, v7I SQL ratchet and observability.
