-- =====================================================
-- SSO — OIDC, not SAML (master prompt Phase 7 lists "SSO
-- architecture")
--
-- DELIBERATE PROTOCOL CHOICE: this implements OpenID Connect,
-- not SAML. Both are legitimate enterprise SSO protocols, but
-- SAML's security depends entirely on correct XML Digital
-- Signature verification, which requires XML canonicalization
-- (C14N) — a notoriously easy area to get subtly wrong (the
-- majority of real-world SAML vulnerabilities are signature-
-- wrapping attacks rooted in exactly this). There is no XML
-- parsing or canonicalization library available in this
-- Workers environment, and hand-rolling C14N correctly is a
-- fundamentally different risk category than the rest of this
-- codebase's cryptography. OIDC's security instead rests on
-- JWT signature verification — ordinary RSA/ECDSA over a
-- fixed byte string, ordinary Web Crypto, the same category of
-- primitive already used correctly elsewhere in this codebase
-- (billing-stripe.js, totp.js). Every major enterprise IdP
-- (Okta, Azure AD, Google Workspace, Auth0, OneLogin) supports
-- OIDC alongside SAML, so this covers the same real-world need
-- through the safer protocol. A future SAML implementation
-- should bring in a real, audited XML-security library rather
-- than extend this schema.
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organization_sso_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'oidc',
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    encrypted_client_secret TEXT NOT NULL,
    client_secret_iv TEXT NOT NULL,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    jwks_uri TEXT NOT NULL,
    default_role TEXT NOT NULL DEFAULT 'viewer',  -- role granted to a member provisioned just-in-time via SSO
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row per in-progress OAuth/OIDC redirect round trip — the
-- `id` doubles as the `state` parameter. Single-use, short-lived,
-- holds the PKCE code_verifier and the nonce the returned ID
-- token's `nonce` claim must match (replay protection for the
-- authorization code flow).
CREATE TABLE IF NOT EXISTS sso_login_states (
    id TEXT PRIMARY KEY,                          -- uuid; also the OAuth `state` value
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sso_login_states_org ON sso_login_states(organization_id);
