# Runbook: mistaken suspension

Sites that should be live are suspended: a billing sweep acted on stale or wrong information, a payment provider incident
looked like non-payment, or a staff action hit the wrong sites. This runbook restores them through the **one audited path**
the platform has: the staff bulk reactivation. There is no other supported way. Never edit `sites.status` in the database
and never patch the tenant directly ([site access gate](../SITE_ACCESS_GATE.md)).

## The path

- Route: `POST /api/platform/saas/sites/reactivate-bulk` (staff session only; the staff page is `/platform/saas/site-access`).
- Body: `{"siteIds": ["<site id>", ...], "reason": "<why>"}`.
- **Limit: 1 to 100 distinct site ids per call.** An empty list or more than 100 is refused with 422 `invalid_site_ids`. For more
  than 100 sites, make several calls, each with its own reason and its own audit row.
- A reason is required (422 `reason_required` if blank). Use a reason that names the cause and the incident id, never a secret.
- Only a site whose status is `suspended` is changed. Anything else is reported as `site_not_suspended` and left alone.
- Each reactivated site gets a status event (`suspended` to `active`, actor `lummet_admin`, the staff member, the reason) and a
  queued `serving` push to the tenant. If the push cannot be queued, that site is rolled back to `suspended` and reported failed.
- The call writes **one** `bulk_reactivate` audit row for the whole call, success or not. Its `resource_id` is the sorted,
  de-duplicated list of site ids in the request (capped at 1000 characters) and its `reason` is the reason you entered.
- Result codes: 200 every site reactivated; 207 some sites failed (the audit row says `partial_failure` and `success` is 0);
  422 refused; 401 not signed in as staff. A 207 is partial, not success. Read `results` for each site.
- Four-eyes approval is **not** built into this route. Who must approve a bulk reactivation is **[OPEN]** (see below); until the
  owner decides, a second person should read the site list and reason before the call is made, and the incident record says who.

## Trigger

- Several customers report their site is down with a maintenance or suspended page, and the staff sites view shows them `suspended`.
- `site_access_push_failed`, `plan_change_stuck`, `failed_billing_webhooks` or a Stripe incident preceded a burst of suspensions
  ([Stripe outage](stripe-outage.md), [webhook backlog](webhook-backlog.md)).
- A staff action suspended the wrong sites.

## First 15 minutes

1. **Stop the cause first.** If `BILLING_SUSPEND_SITES` is `enforce`, decide with the owner whether to move it to `shadow` so
   the next sweep cannot suspend them again (a recorded configuration change and redeploy; see [enforcement cutover](../ENFORCEMENT_CUTOVER.md)).
   Reactivating while the cause is live just feeds the loop. Do not change the default permanently.
2. Open the incident record ([template](../RUNBOOKS.md#incident-record)) and write the UTC time of the first wrong suspension.
3. Find the suspended sites and why (read-only):

```sql
SELECT s.id, s.organization_id, s.status, e.from_status, e.to_status, e.actor_type, substr(e.reason, 1, 120) AS reason, e.created_at
FROM sites s JOIN site_status_events e ON e.site_id = s.id
WHERE s.status = 'suspended' AND e.id = (SELECT MAX(id) FROM site_status_events WHERE site_id = s.id)
ORDER BY e.created_at DESC LIMIT 200;
```

4. Separate the sites that are **wrongly** suspended from those that are **correctly** suspended (a real non-payment, an
   abuse case, an organization suspended by staff). Check the organization too: a site whose organization is suspended or closed
   stays denied by the access push even when the site row is `active`, so reactivating it would not help and is not the right fix.
5. Write the list of site ids and the agreed reason in the incident record **before** the call. Someone else reads it.

## Do not

- Do not reactivate sites you have not individually confirmed were suspended by mistake. A bulk call is not a way to clear a list.
- Do not run the call while the cause is still active (step 1).
- Do not reuse one call for different causes; one reason, one audit row, one set of sites.
- Do not UPDATE `sites`, `site_status_events` or `lummet_audit_logs` by hand, and do not call the tenant's site-access route yourself.
- Do not put customer names, emails or secrets in the reason. Site ids and the incident id are enough.
- Do not treat a 207 as done. Retry the failed sites only after reading why they failed.

## Recovery and verification

1. Send the call with the list and the reason from the incident record. Keep the response body in the record.
2. If the response is 207, read each `results` entry: `site_not_suspended` means someone already fixed it or it was never suspended;
   `push_queue_failed` means the site is suspended again and the push queue is unhealthy ([durable jobs](../DURABLE_JOBS.md)).
3. **Evidence that it was audited**, in this order:

```sql
SELECT id, admin_id, action, success, status_code, error_message, resource_id, substr(reason, 1, 200) AS reason, request_id, created_at
FROM lummet_audit_logs WHERE action = 'bulk_reactivate' ORDER BY id DESC LIMIT 10;
```

   The newest row must name your staff member, your reason and exactly your site ids in `resource_id`.

4. **Evidence per site**:

```sql
SELECT site_id, from_status, to_status, actor_type, actor_id, substr(reason, 1, 160) AS reason, created_at
FROM site_status_events WHERE site_id IN ('<site id 1>', '<site id 2>') ORDER BY id DESC LIMIT 50;
```

   Each site shows `suspended` to `active`, actor `lummet_admin`, the same staff id as the audit row, and `staff bulk reactivate: <your reason>`.

5. **The tenant caught up**: check `site_access_push_jobs` for those sites has a `serving` job that reaches `succeeded`
   (`pending` and `running` are normal for a few minutes). The `site_access_push_failed` alert means five attempts failed; use the
   push failures view on `/platform/saas/site-access` and the retry action there, with a reason. The tenant fails open after a long
   outage of the push channel, so a green push is the evidence, not the absence of complaints.
6. Open the customer's site (or the canary) and confirm it serves. Tell support which customers are back; do not claim a cause
   you have not confirmed.
7. Put `BILLING_SUSPEND_SITES` back only after the cause is fixed, the reconciliation is clean and the owner approves; record the time.

## Rollback

If sites were reactivated that should have stayed suspended, suspend them again with the existing audited staff site status action
(`POST /api/platform/saas/sites/:id/status` with `status: suspended` and a reason), one site at a time, and record each audit row.
There is no bulk suspend. A bulk reactivation is not undone by deleting its audit row or events; the history stays, and the
correcting action adds its own rows. If the same sweep keeps suspending them, go back to step 1.

## Record the incident

First wrong suspension (UTC), cause, settings changed and restored with times, the exact site ids and reason sent, response code
and counts (reactivated, failed), the audit row id and request id, who reviewed the list, push job outcomes, customers told (count),
and what was left suspended on purpose and why.

## Who and how (placeholders)

**[OPEN]** Who may authorize a bulk reactivation, whether a second approver is required, and the largest batch the owner will
accept are not supplied (`docs/PLACEHOLDERS.md`, Round 6.5B). The hard 100-site limit per call is in code; any lower
limit or four-eyes rule is an owner decision. Who is paged and the customer wording are also **[OPEN]**.

## Evidence status

TESTED LOCALLY: the route requires staff, requires a reason, caps the list, writes one audit row per call naming the sites, and
records the staff actor and reason on each site event (`test/runbooks-restore-drill-6-5b.test.js`, fake database and fake
tenant client). NOT VERIFIED: no real suspension, push to a tenant, or Cloudflare behaviour was exercised. The queries are STATIC
REVIEW against the migrations and have not been run against a live database.
