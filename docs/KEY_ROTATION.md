# Secrets rotation runbook (roadmap 2.4)

Read this once now, not for the first time during an incident. Nothing here
was run against live Cloudflare or Stripe from the build environment; do a
practice rotation on a staging copy first.

## 1. `CREDENTIAL_KEK` (the encryption key)

It encrypts: tenant Super API credentials, webhook signing secrets, two-factor
(TOTP) secrets, SSO client secrets, queued email bodies, and the control-plane
database backups in R2. The console page **SaaS > Key rotation** shows the
current and previous key ids (a short fingerprint, never the key) and progress.

### Planned rotation (the key is not known to be exposed)

1. **Take a fresh control-plane backup first** (SaaS > DB backups > Back up now)
   and verify it.
2. Generate a new key: `openssl rand -base64 32`. Store it in your password
   manager before using it.
3. Set the secrets together, then deploy:
   - `wrangler secret put CREDENTIAL_KEK_PREVIOUS` = the OLD key
   - `wrangler secret put CREDENTIAL_KEK` = the NEW key
   From now on new data uses the new key; old data is still readable.
4. Open **SaaS > Key rotation**. Click **Re-encrypt now** repeatedly (200 values
   per click) until every row shows "under another key: 0".
5. Wait for the page to say **"CREDENTIAL_KEK_PREVIOUS can be removed now."**
   Retained database backups also need the old key: they are replaced by new
   backups over about 14 days, and the page counts them. Do not remove the old
   key before then unless you accept losing those older backups.
6. `wrangler secret delete CREDENTIAL_KEK_PREVIOUS`, deploy, and confirm
   webhooks, email and logins still work.
7. Keep the old key in your password manager, marked retired, until the last
   backup that used it has expired.

If anything looks wrong in steps 3 to 5, put the old key back as
`CREDENTIAL_KEK` and the new one as `CREDENTIAL_KEK_PREVIOUS`; both keep
working.

### If the key may have been exposed

Rotating the key does **not** un-leak ciphertext someone already copied. Do the
planned rotation above, and ALSO replace the secrets it protected:
- Tenant Super API credentials: rotate each tenant's credential (existing
  rotate action in the tenant registry), then update the tenant Worker.
- Webhook signing secrets: customers rotate them in API keys & webhooks
  (or staff can disable the webhook).
- Two-factor secrets: affected users re-enrol; SSO client secrets: re-issue at
  the identity provider and re-save.

### Failure modes

- **"Failed" values on the rotation page / `failed` in the run result:** a value
  was written with a key that is neither current nor previous. Re-add that key
  as `CREDENTIAL_KEK_PREVIOUS` (only one previous key is supported at a time:
  finish one rotation before starting another).
- **Restoring an old backup:** run the restore script with both
  `CREDENTIAL_KEK` and `CREDENTIAL_KEK_PREVIOUS` set if the backup predates the
  rotation.
- **Adding a new encrypted column later:** add it to `ENCRYPTED_TARGETS` in
  `worker/key-rotation.js`. A test fails if you forget.

## 2. Other secrets (no re-encryption needed, but order matters)

| Secret | How to rotate | Watch out for |
|--------|---------------|---------------|
| `STRIPE_SECRET_KEY` | Roll the key in the Stripe dashboard, `wrangler secret put`, deploy, then expire the old key. | A short window where in-flight calls use whichever key the deployed Worker has. |
| `STRIPE_WEBHOOK_SECRET` | In Stripe, roll the endpoint's signing secret and keep the old one valid for an overlap. Set the OLD value as `STRIPE_WEBHOOK_SECRET_PREVIOUS` and the new one as `STRIPE_WEBHOOK_SECRET`, deploy, then after the overlap delete `..._PREVIOUS`. | Fixed in this pass: during an overlap Stripe sends two signatures and the old verifier could reject valid events. It now accepts either. |
| `CF_API_TOKEN` | Create a replacement token with the same permissions, `wrangler secret put`, deploy, then delete the old token. | Provisioning jobs running at the moment of the swap may need a retry. |
| `RESEND_API_KEY` | New key in Resend, `wrangler secret put`, deploy, delete the old key. | Queued emails retry automatically. |
| `ALERT_WEBHOOK_URL` | Create a new incoming webhook, update the secret, delete the old one. | Send a test via SaaS > Alerts > Run check now. |
| `ALERT_CHECK_TOKEN` | Change the secret AND the pinger's Authorization header at the same time. | Checks pause until both match; the stale-backup alert covers a long gap. |
| Customer API keys | Customers revoke and create keys themselves; staff can revoke from SaaS > API keys. | Only the key prefix is stored; a lost key cannot be recovered. |

## 3. Cadence

- Rotate `CREDENTIAL_KEK` at least yearly and immediately when anyone with
  access to the Worker secrets leaves.
- Calendar a practice restore of a control-plane backup at the same time.
