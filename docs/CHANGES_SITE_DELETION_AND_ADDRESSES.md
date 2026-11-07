# Site deletion and per-domain site addresses

**NOT production ready.** Nothing here has run against live Cloudflare. Run migration `0088` before deploying this code.

## Site addresses (migration 0088)
- `sites.host_label` is the label the customer chose: `<host_label>.<platform domain>`. It is unique per platform domain among sites that are not `deleted` (unique index, plus a check in `worker/site-labels.js`). The same label on another domain is free.
- `sites.slug` is unchanged and still globally unique; it is internal (Worker, D1, KV, R2 names). A second `reviews` on another domain gets slug `reviews-2` internally and `reviews.<that domain>` publicly.
- A taken, invalid or reserved address is refused (`409 subdomain_taken` / `422 invalid_subdomain` / `422 subdomain_reserved`) with `suggestions` and `otherDomains`. Nothing is renamed or created. The old behaviour (a number appended to the customer's name) is gone.
- Held addresses: any site not `deleted` (a `deleting` site holds its address until teardown finishes) and the old address of a moved site while its redirect has not expired.
- Rules: 3 to 40 characters, a-z 0-9 and hyphens, no leading or trailing hyphen, no `--` in positions 3-4; infrastructure names are reserved (`RESERVED_LABELS`).
- `GET /api/organizations/:id/sites/name-check?label=&platformDomainId=` powers the live check on the create-site form. Any member may call it; it never says who holds an address.
- Moving a site to another domain is blocked when its label is taken on the target.

## Site deletion
- Customer: Sites page, Delete button, typed site name. `DELETE /api/organizations/:id/sites/:siteId` with `{ confirmName }`; the server checks the exact name (`422 confirmation_required`). With the approval-workflow entitlement a second admin must still approve; the teardown starts on approval.
- Staff: `POST /api/platform/saas/sites/:id/delete` with `{ confirmName, reason }` (reason of 5+ characters, audited as `staff_delete`). Staff retry of a failed `site_teardown` job works from the job page; "Re-run delete" on a site stuck in `deleting` re-queues it.
- Both create a durable `site_teardown` job (`worker/site-teardown.js`): `stop_routing`, `remove_custom_domains`, `delete_worker`, `delete_database`, `delete_kv`, `delete_r2`, `delete_backups`, `finalize`. Steps are idempotent; a resource the provider no longer has counts as gone. A failure leaves the site in `deleting` and the job sweep retries with backoff; after the retries it is dead-lettered and the `dead_jobs` alert reports it.
- `finalize` removes the site's operational rows (the `SITE_DELETE` list in `retention-policy.js`, except `site_status_events` and `site_resources`, which stay as the record), its stored backups and its tenant row with credentials, then marks the site `deleted`. The plan slot frees as soon as the site is `deleting`.
- The sweep adopts sites left in `deleting` by the old code that never had a job.
- Every site that is not already `deleted` can be deleted, including one stuck in `provisioning`, `configuring`, `deploying`, `provisioned` or `failed`. Starting a deletion cancels the site's other jobs (setup, deploys, retries), so nothing can recreate what is being removed or be retried by the sweep. Every teardown step re-runs on each attempt and only acts on what is still recorded as active, so a resource a straggling job created late is caught by `finalize` (it refuses to finish while anything is recorded active) and removed on the retry.
- New webhook event: `site.deleted`.

## Verification (merged onto the current stable tree)
- Full suite: 212 files, 2,667 tests, 2,663 pass. The 4 that do not pass fail identically on the untouched stable code: `load-d1-policies-6-5c` and `runbooks-restore-drill-6-5b` look for `PLACEHOLDERS.md` above the repository folder, `phase6-gate` expects no migration above 0072 and a `RELEASE_ID` file, and `staging-checks` passes on its own but the file-by-file runner force-exits it.
- Existing tests that created several sites with the same name were changed to use distinct names, because an address already taken on a domain is now refused (it used to get a number added).
- SQL for the new modules lives in `worker/repositories/site-labels.js` and `worker/repositories/site-teardown.js` (the repository-boundary test enforces this).

## NOT verified
- No live Cloudflare run of any teardown step. The calls are the same ones organization erasure already uses.
- The create-site address check and the delete dialog were checked by parsing the page script and by route tests, not clicked through in a browser.
