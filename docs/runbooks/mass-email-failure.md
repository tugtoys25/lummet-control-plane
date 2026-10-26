# Runbook: mass email failure

Email leaves through the `email_outbox` table: a message is queued (body encrypted), a flush sends it through the provider,
and the row becomes `sent` or, after repeated failures, `failed`. Billing notifications also have their own record
(`billing_notifications`) and a suppression list for addresses that bounced or complained.

## What the code does (STATIC REVIEW)

- A flush takes due `queued` rows, claims each one (so two flushes never send the same row twice), and sends it.
- A temporary provider failure (HTTP 429 or 5xx, or an exception) keeps the row `queued` and retries with a doubling delay.
  After 5 attempts, or on a permanent error, the row becomes `failed`.
- A failed **billing** notification keeps its encrypted body for 14 days so staff can resend that exact message. Every other
  failed message (sign-in links, password resets, invitations) has its body wiped: the customer has to ask again.
- A billing message queued before its recipient bounced or complained is not sent (`email_suppressions`).
- With no provider configured, a flush reports `not_configured` and sends nothing. Production configuration checks say so.

## Trigger

- `failed_emails`, `stale_email_queue` (queued for over 30 minutes), `email_bounce_rate` (5% or more of the last 24 hours, or
  3 or more complaints) or `billing_email_stuck` (billing notifications recorded but not queued for over 30 minutes) fires.
- Customers report no verification, reset or invitation emails; or a spike of bounces after a template or domain change.
- The provider reports an incident or suspends the sending account.

## First 15 minutes

1. Open the incident record ([template](../RUNBOOKS.md#incident-record)). Which alert, since when, and what changed (template,
   `EMAIL_FROM` domain, `RESEND_API_KEY`, DNS for the sending domain)?
2. Read-only: how bad is it?

```sql
SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status;
SELECT template, last_error, COUNT(*) AS n FROM email_outbox WHERE status IN ('queued','failed') GROUP BY template, last_error ORDER BY n DESC LIMIT 20;
SELECT MIN(created_at) AS oldest_queued FROM email_outbox WHERE status = 'queued';
```

3. Read the `last_error` pattern. `provider_http_401` or `provider_http_403`: the key or the account. `provider_http_429`: a rate
   limit or suspension. `provider_http_5xx`: the provider is failing. `delivery_exception`: our decryption or request failed
   (look at the Worker logs and `CREDENTIAL_KEK`; a key rotation without the previous key breaks decryption).
4. Bounce spike: stop the cause before resending anything. A bad template, a changed `EMAIL_FROM` or missing sending-domain
   records make every message bounce and damage the domain's reputation further.
5. Tell support which messages are affected (kinds and counts) and that customers can request a new link once it is fixed.

## Do not

- Do not delete or edit rows in `email_outbox`. Queued messages are durable; a row you remove is a message you lost.
- Do not mass-resend by script or by inserting new rows. Duplicate password-reset and invitation emails confuse customers and,
  during a bounce spike, hurt the sending domain.
- Do not switch to a different sending address or a personal mailbox to bypass the failure.
- Do not clear the suppression list to "make sure everyone gets it". Suppressed means the person bounced or complained.
- Do not put the provider key in a ticket or a chat.

## Recovery and verification

1. Fix the cause (key, sending-domain records, template, provider account). Send one message to a test address first, using the
   normal flow, and check it is delivered.
2. Let the queue drain: retries are automatic with backoff. To drain now, use the staff flush action
   (`POST /api/platform/saas/email/flush`, audited, and it reports `not_configured` if the provider is not set up).
3. Billing notifications that ended `failed`: resend from the staff notifications page, one at a time, with the dedupe-aware
   action (`POST /api/platform/saas/notifications/:id/resend`). It will not send the same notification twice. Do it before the
   14-day body retention ends.
4. `billing_email_stuck`: the notification was recorded but never queued; the resend action above is the fix, not an insert.
5. Verification messages, resets and invitations that were wiped: do not re-create them; customers request a new one.
6. Watch `email_bounce_rate` for the next 24 hours; it uses a rolling window, so it clears slowly.
7. Done when: `queued` is empty or each remaining row is explained, the alerts have resolved, a fresh test message arrives, and
   the oldest queued time is recent.

## Record the incident

First and last failing time, the error codes and counts by template, the cause, settings changed (names, not values), the
number of billing notifications resent and by whom (audit rows), the number of customers who must request a new link, and the
bounce rate before and after.

## Who and how (placeholders)

**[OPEN]** Who owns the sending domain and the email provider account, who may contact the provider, and what customers are
told are owner decisions (`docs/PLACEHOLDERS.md`, Round 6.5B). Provider limits and reputation thresholds are not in this repository.

## Evidence status

STATIC REVIEW against `worker/email.js` and the alert definitions. NOT VERIFIED: no provider outage, bounce spike or
suppression was exercised live, and the Resend behaviour described is the code's expectation, not observed.
