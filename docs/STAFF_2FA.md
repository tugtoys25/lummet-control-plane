# Staff two-factor authentication

Staff accounts can reach every customer, so a stolen password alone should
not be enough. This adds an authenticator-app code (TOTP) as a second step.

## How it works

- **Set up:** signed-in admin opens **Two-factor** (top bar) or `/account/2fa`,
  generates a key, adds it to an authenticator app (manual key entry or the
  setup link), and enters a code to confirm. Nothing changes until that code
  is accepted. 10 single-use backup codes are shown once.
- **Log in:** the password step no longer creates a session for an account
  with 2FA. It creates a 5 minute challenge; a valid code (or backup code)
  completes it. A challenge allows 5 wrong tries, wrong codes also count against
  the per-IP limit, and a code that was already accepted cannot be reused.
- **API:** `POST /api/auth/login` returns `{ mfaRequired: true, challengeId }`
  with no cookie; then `POST /api/auth/login/mfa` with `{ challengeId, code }`
  (or `backupCode`).
- **Secrets** are encrypted with `CREDENTIAL_KEK` and covered by key rotation.
  Every setup, disable, reset and MFA login (including backup-code use) is in
  the audit log.

## Making it mandatory

Set `STAFF_2FA_REQUIRED=true`. Admins without 2FA can then only reach the 2FA
setup, change-password and log-out pages until they enrol. It is OFF by
default so that turning this feature on cannot lock out the only admin during a
deploy. Recommended order: deploy, enrol every admin, then set the variable.
Without it, un-enrolled admins see a banner on every page.

## Lost phone

1. Another **super admin** opens **Platform > Admins** and clicks **Reset 2FA**
   on that account. It removes the factor and signs that admin out; they then
   log in with their password and enrol again.
2. If the **only** super admin is locked out and has no backup codes, nothing in
   the app can help (by design). Use the database:
   `wrangler d1 execute <db> --remote --command "DELETE FROM lummet_admin_totp WHERE admin_id = 1"`
   (find the id with `SELECT id, email FROM lummet_admins`). Anyone who can run
   this already controls your database; keep that access tight.

## Behaviour to know about

- After enrolling, the code you just used is spent. Logging in within the same
  30 seconds needs the next code ("code already used" is shown otherwise).
- Authenticator apps need the device clock to be correct; one step (30
  seconds) either side is accepted.
- No QR code is drawn (no image library is available in the Worker here): the
  page shows the key and an `otpauth://` link.
- Hardware keys / passkeys for staff are not included (customers have WebAuthn;
  extending it to staff is a separate piece of work).
- Not tested against real authenticator apps from the build environment. Test
  with your own app once.
