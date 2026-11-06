# Phase 11 (control plane): no code change

**NOT production ready.** Phase 11 (T1 to T7) changed the tenant repository only. Nothing in this repository was touched except this page.

## Why nothing changed here
- No preset capability id was added or removed, so the preset list mirrored in `worker/site-setup.js` and the pinned list in `test/preset-ids-pinned.test.js` stay as they are. The tenant added dynamic ids of the form `content.custom.<slug>` (per custom content type); they are not presets and are not mirrored here.
- No migration, no Super API change, no rollout change.
- The tenant Phase 11 summary and the per-patch files are in the tenant repository, `en/docs/CHANGES_PHASE_11.md` and `CHANGES_PHASE_11A.md` to `11D.md`.

## One thing to know when rolling out
A site that already runs the "Sportsbook listing" preset is not repaired by deploying tenant patch 11A: publish its configuration again (or switch the older sportsbook setting on once) so the older `content_types_enabled` setting follows the preset. The control plane's setup retry applies a preset only to a new site, so it will not do this by itself.

## NOT VERIFIED
- Nothing was run in this repository for Phase 11 (no code changed). The statements above about the tenant come from reading the tenant patches.
- Everything listed under "NOT verified" in `docs/RELEASE_CONFIGURABLE_PLATFORM.md` still applies.
