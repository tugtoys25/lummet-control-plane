# 2.7.0: platform settings in the staff console

- New: `/platform/saas/settings` and `/api/platform/saas/settings`. Staff set, change and clear non-secret platform settings with an audited reason. Precedence: console value, then `wrangler.jsonc` var, then built-in default.
- Migration 0075: `platform_settings`, `platform_setting_events` (additive).
- `worker/platform-settings.js`: allow-list of managed keys with validation and cross-setting guards; `withPlatformSettings(env)` overlays the values at `fetch`, `scheduled` and `queue`. Fail-soft.
- Not manageable by design: secrets, bindings, and lockout-prone settings (see docs/PLATFORM_SETTINGS.md).
- Tests: `test/platform-settings.test.js` (16). Migration-numbering pins in `org-security-policy.test.js` and `synthetic-monitors-6-5a.test.js` now allow 0075.
- Note: `SYNTHETIC_MONITORS=enforce` and `ORG_IP_ALLOWLIST=on` are not values the code accepts (it reads them as off); the console only offers the real values.
