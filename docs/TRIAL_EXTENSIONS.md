# One free trial, trial extensions, and pausing sites when a trial ends

## Rules
- **One free trial per organization, ever.** Once an organization has had a trial (any subscription row with a trial end, or an expired one), it cannot start another: `POST /api/organizations/:id/trial` answers `409 trial_already_used_by_organization`, and Stripe Checkout is created with no trial (the customer is charged at once). This holds whatever `BILLING_ENFORCE` is.
- **Extension instead of restart.** On the customer's Billing page the "Start trial" buttons disappear and a card "Your free trial has ended" offers **Request a trial extension** (message + optional days). One open request per organization (also enforced by a unique index). Only organization admins can send it.
- **Staff decide** in the staff console: Customer care > **Trial extensions**. *Approve* with 1-90 days (a new local trial of that length is created, the lapsed one is closed, paused sites go live again) or *Decline* with a required comment. The customer gets a dashboard announcement and an email either way. Every decision is audited.
- **Sites pause when the trial ends.** With `BILLING_TRIAL_END_SITES=on` (Platform settings > Billing, default **off**), the five-minute sweep pauses every active site of an organization whose trial ended and that has no paid/active subscription. Reason: `billing: free trial ended`. Paying (Stripe webhook), an approved extension, or the sweep's own self-heal restores them. Sites staff or the customer suspended are never touched or restored by this feature. Organizations that never had a trial, and running trials, are untouched.

## API
| Who | Route | Notes |
| --- | --- | --- |
| Customer admin | `POST /api/organizations/:id/trial-extension` `{message, wantedDays?}` | 409 `trial_still_running`, `request_already_pending`, `no_trial_to_extend`; 422 `message_required`, `invalid_days` |
| Staff | `POST /api/platform/saas/trial-extensions/:id/approve` `{days, comment?}` | 409 `already_decided`; 422 `invalid_days` |
| Staff | `POST /api/platform/saas/trial-extensions/:id/decline` `{comment}` | 422 `comment_required` |

## Data and code
Migration `0110_trial_extensions.sql` (additive). `worker/trial-extensions.js` (rules, sweep gate), `worker/repositories/trial-extensions.js`, `worker/views/pages/trial-extensions-admin.js`, customer card in `worker/views/customer-pages/billing.js`. Tests: `test/trial-extensions.test.js`.

## Turning it on
1. Deploy (the migration runs with the deploy).
2. Platform settings > Billing > `BILLING_TRIAL_END_SITES` = on. Note: sites are only *paused in the control plane and pushed to the site* when the existing site-access push is working (see Site access).
