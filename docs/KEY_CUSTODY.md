# Key custody and secret encryption

`CREDENTIAL_KEK` is the key that encrypts every stored secret: tenant API credentials, webhook secrets, customer and staff 2FA
secrets, SSO client secrets, queued email bodies and control-plane backups. Losing it makes all of those unreadable.

## What the key must be
Standard base64 of exactly 32 random bytes. Generate with: `openssl rand -base64 32`. Not all zero, not a repeated pattern.
`npm run check:config` (production) refuses anything else.

## Settings (both explicit in production)
- `CREDENTIAL_KEK_STRICT`: `off` (default) or `on`. Turn on once `check:config` passes with the real key. On, the Worker refuses to
  start encrypting or decrypting with a key that fails the rule.
- `CREDENTIAL_ENCRYPTION_FORMAT`: `v1` (default) or `v2`. v2 binds each stored value to its table, row and column (and each backup
  part to its backup and part name). Reading always accepts both formats, so setting it back to `v1` never strands data.

## Moving to v2
1. Set `CREDENTIAL_ENCRYPTION_FORMAT=v2` on staging. New secrets are written as v2.
2. Run the staff key-rotation page (re-encrypt). Check `rowsNotV2` reaches 0 in the rotation status.
3. Run a backup, verify it, and run the restore drill with the escrowed key.
4. Repeat on production. Roll back by setting the flag to `v1`; v2 rows stay readable and are kept as v2 until re-encrypted.

## Rotating the key
1. Set the new key as `CREDENTIAL_KEK` and the old one as `CREDENTIAL_KEK_PREVIOUS`.
2. Run re-encrypt until the rotation status says it is safe to remove the previous key.
3. Remove `CREDENTIAL_KEK_PREVIOUS`. The previous key is never held to the strict rule, so an old weak key can still be read
   while you rotate off it.

## Escrow (owner action, not code)
Keep an offline copy of the current key in a sealed location held by two people, and test a restore from a backup with that copy
before you rely on it. A backup is only as good as the escrowed key.
