-- Round 6.4A (release 2.6.0.9): per-organization security policy. One additive table; nothing is altered or backfilled.
-- No row means "no policy": every control is off. A row is created only when an owner changes a setting (audited, with a reason).
--
-- require_2fa        0/1. Round 6.4A enforces it (flag ORG_SECURITY_POLICY=off|shadow|enforce, default off).
-- require_sso        0/1. Stored only. NOT enforced before Round 6.4C (the SSO requirement stays a flagged stub until an IdP is chosen).
-- ip_allowlist_json  JSON array of CIDR strings. Stored only. NOT enforced and not written by any 6.4A code before Round 6.4C.
-- updated_at         set by the writer on every change.
CREATE TABLE IF NOT EXISTS organization_security_policies (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  require_2fa INTEGER NOT NULL DEFAULT 0 CHECK (require_2fa IN (0, 1)),
  require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1)),
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ip_allowlist_json)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
