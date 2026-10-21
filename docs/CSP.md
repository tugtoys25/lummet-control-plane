# Content Security Policy (v7E)

## What it protects against
If an attacker gets HTML into a page (a name, a note, a title that was not escaped somewhere), the browser must not run
their script. v7E makes the control plane (staff console, customer portal, public site) refuse any script that did not
come from our own templates.

## The policy
Every HTML response gets:

    frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; connect-src 'self';
    frame-src 'none'; worker-src 'none'; manifest-src 'none'; img-src 'self' data: https:;
    script-src 'nonce-<random per response>'; script-src-attr 'none'

`style-src` is not restricted (inline styles are still used widely); that is a known, documented limit.

## How it works
1. **Nonce.** Templates write `<script nonce="${nonceToken()}">`. `nonceToken()` is a random secret that lives only in
   this isolate's memory. `finalizeResponse()` swaps it for the real per-response nonce on the way out. An injected
   script cannot contain the token because it never appears in anything an attacker can read: the response carries the
   swapped nonce, and the token is also stripped from JSON/text responses. A script without it gets no nonce and does
   not run. (Rewriting the final HTML would be unsafe if it nonced every script; it only replaces a secret that
   attackers do not have.)
2. **No inline handlers.** `onclick="..."` cannot carry a nonce, so it is not used. Templates call
   `onClick("fn", [args], {confirm, prevent})`, `onSubmit`, `onChange`, `onInput`, which emit
   `data-onclick="fn" data-args="[...]"`. One static runtime (`UI_RUNTIME`, added automatically to pages that use these
   attributes) listens at the document and calls `window[fn]`. Data travels only as escaped JSON; it is never code.
   Tokens in args: `"$el"` (the element), `"$ev"` (the event), `"$value"` (its current value).
3. **Browser-built HTML.** Page scripts that build markup with handlers use `lummetAttrs('click', 'fn', [args])`
   (include `${BROWSER_HELPER}` in the script) and `lummetEscAttr()` for attribute values.
4. **Never cache a page that contains `nonceToken()`.** A cached page would reuse one nonce for everyone and carry a
   token from another isolate. Public pages have no executable scripts (only JSON-LD) and are edge-cached; a test
   enforces that `public-site/` never uses `nonceToken`.

## Pages that bring their own policy
The public site sets its own `Content-Security-Policy` (`script-src 'self'`, because it loads its scripts as same-origin files
from `/static/js/`). `finalizeResponse()` leaves a response that already has a policy exactly as it is. (v7E replaced it with
the nonce-only policy, which would have blocked those scripts under `CSP_MODE=enforce`; fixed in v7G and covered by tests that
render the real public site.)

## Rollout (the one thing to do before enforcing)
`CSP_MODE` is `report-only` unless set to `enforce`. In report-only the baseline is enforced as before and the script
policy is only reported to `POST /api/csp-report`, which logs `{"csp_violation":true,"directive":...,"blocked":...,
"document":...}` (query strings dropped, nothing stored). Browse every page type on staging, check the Worker logs, and
once there are no violations set `CSP_MODE=enforce` in production. The staff SaaS overview shows a red banner in
production until it is `enforce`.

This was verified by tests that render real pages through the Worker and run the runtime against a stub browser. It was
**not** run in a real browser, which is why report-only is the default.

## Rules for new code
- Never write `on<event>="..."`, `javascript:` URLs or `<script>` without the nonce. Tests fail if you do.
- A function named in `onClick(...)` must be a top-level `function name(...)` in a script on that page.
- Do not put user data inside script code. Pass it as args (JSON) or read it from the DOM.

## DNS-aware outbound check (also v7E)
See `url-safety.js` (`checkOutboundUrlResolved`). Used for webhook URLs (on save and on every delivery attempt) and SSO
token / key-set endpoints. `OUTBOUND_DNS_CHECK=off` disables it; `on` forces it outside production.
