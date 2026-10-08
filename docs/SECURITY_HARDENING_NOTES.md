# Control Plane Security Hardening — Password Comparison + RBAC/Security Test Suite

**Scope of this change:** `lummet-control-plane` only. `lummet-tenant` was not
modified (confirmed by diff after every step).

---

## 1. What changed in production code

**File:** `worker/auth.js` (only production file touched)

`verifyPassword()` previously compared the computed password hash to the
stored hash with `===`:

```js
return computedHex === hashHex;
```

`===` on strings short-circuits at the first differing character, which is a
classic (if narrow, given network jitter) timing side-channel. This codebase
already had a correct, hand-rolled constant-time comparison for Super API
HMAC signatures (`signing.js` / tenant `super/auth.js`), so the fix reuses
that exact pattern for passwords instead of introducing a second one.

```js
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // Still walk equal-ish length to avoid a cheap length-based
    // timing signal, then return false regardless.
    let dummy = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dummy |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function verifyPassword(password, storedHash) {
  // ...unchanged PBKDF2 (100k iterations, SHA-256) derivation...
  return constantTimeEqual(computedHex, hashHex);
}
```

**Not changed:** the PBKDF2 scheme itself (100,000 iterations, SHA-256,
16-byte salt, `saltHex:hashHex` storage format), `hashPassword()`, session
handling, rate limiting, or any other function in the file.

`constantTimeEqual` is exported as a plain, immutable named export — purely
so the test suite can exercise its edge-case behavior (equal length,
unequal length, non-string input) directly. `verifyPassword()` calls the
module-level function directly; production code has no dependency on the
export or on any test-only indirection.

---

## 2. New test suite

**Location:** `lummet-control-plane/test/` (new — this repo previously had
zero automated tests). `package.json` was added at the repo root purely to
give `npm test` an entry point, matching the tenant repo's existing
zero-dependency convention (`node:test` + built-in `node:sqlite`, Node
≥22.5, no packages to install).

Run it with:

```sh
cd lummet-control-plane
npm test
```

### Files

| File | Purpose |
|---|---|
| `test/support/d1-shim.js` | In-memory `node:sqlite`-backed D1-compatible shim. Runs the **real** migrations from `/migrations` against a fresh DB per test run, so tests exercise the actual schema, not a hand-maintained copy of it. |
| `test/support/fixtures.js` | Seeds two tenants (`tenant-a`, `tenant-b`) and four admins: a super admin, a staff admin scoped to `tenant-a` only with `casinos.read`+`casinos.update` (deliberately *not* `delete`, *not* `users`), a staff admin with zero grants, and a disabled admin. |
| `test/auth-password.test.js` | Correct/incorrect password, malformed stored hashes, PBKDF2 format regression, `constantTimeEqual` helper behavior, `authenticateAdmin` end-to-end (session creation, disabled accounts, rate limiting). |
| `test/rbac.test.js` | `hasPermission`, `hasAnyPermissionInArea`, `canAccessTenant`, `isSuperAdmin`, `listAccessibleTenants`, and the `loadPermissionMap`/`mapAllows` nav-filtering path — explicitly proven to be a separate, non-authoritative code path from the real `hasPermission` enforcement. |
| `test/tenant-isolation.test.js` | Cross-tenant access rejection regardless of which request field an attacker-supplied tenant id arrives in (URL param / body / query — the guard function has no field-specific logic to bypass), injection-shaped ids, `requestTenant()` fail-closed behavior for nonexistent/disabled tenants and missing credentials, plus a structural regression check that the dispatcher gates on server-side session state (`admin.activeTenantId`). |
| `test/tenant-switching.test.js` | Authorized/unauthorized switch, confirmation that a **failed switch never alters the session's active tenant**, super-admin switching, clearing the active tenant. |
| `test/super-api-hmac.test.js` | The Control Plane's real signer (`signing.js`) tested against the **tenant's real verifier** (`lummet-tenant/en/worker/super/auth.js`) — valid request, bad signature, wrong secret, expired timestamp, nonce replay, tampered body/path/method, unknown credential, missing headers. Also verifies the credentials list page never emits secret material. **Requires `lummet-tenant` checked out as a sibling directory of `lummet-control-plane`** (as in this repo layout); skips gracefully if it isn't found rather than failing the suite. |
| `test/audit.test.js` | Successful mutations recorded with `success=1`; denied/failed operations recorded with `success=0` (never coerced); a rejected login leaves no session or misleading audit row; structural check that the permission guard itself never calls `logAudit`. |

### Results (last run)

- **Control Plane: 81/81 passing**
- **Tenant (regression check, unmodified): 559/559 passing**
- `node --check` clean on all new/changed files
- No ESLint or TypeScript config exists in either repo — none to run

---

## 3. Documented policy decision (not a code change)

> Control Plane permissions are tenant-wide within the tenant(s) assigned to
> the administrator; tenant-level `item_access` scopes remain a tenant-user
> authorization mechanism.

The Control Plane's own RBAC (`rbac.js`) checks `area + resource + action`
only — there is no own/assigned/all scope dimension for CP admins
themselves, because the Super API credential the CP uses is tenant-wide
equivalent by design. This is proven by `rbac.test.js`'s
`loadPermissionMap`/`mapAllows` tests, not just asserted. If own/assigned/all
scoping for CP admins is wanted later, it should be a deliberate RBAC
enhancement, not something introduced incidentally.

---

## 4. Files touched, precisely

```
lummet-control-plane/worker/auth.js        (modified — the fix above)
lummet-control-plane/package.json          (new — test entry point)
lummet-control-plane/test/**               (new — the suite above)
```

`lummet-tenant` — untouched.
