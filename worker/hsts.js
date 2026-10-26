// =====================================================
// HSTS WITH PRELOAD (Round 6.3C)
//
// Default (HSTS_PRELOAD unset or anything but "on"): the header every release since 2.1 has sent, one year plus
// includeSubDomains, no preload. Nothing changes until the owner turns the flag on.
//
// HSTS_PRELOAD=on adds `preload` and raises max-age to two years. Preload submission is the owner's act and is hard to
// undo (removal from browser lists takes months), and includeSubDomains then covers EVERY subdomain of the registrable
// domain, including customer-site hostnames under PLATFORM_DOMAIN_SUFFIX. See docs/HSTS_PRELOAD.md. config-check also
// requires HSTS_PRELOAD_APPROVED=yes before production may run with the flag on.
//
// checkPreloadEligibility() is a pure function over a header value (and, optionally, whether http:// redirects to the
// same host over https). It encodes the published hstspreload.org header requirements as understood when this was
// written (max-age of at least one year, includeSubDomains, preload); re-read the live requirements before submitting.
// =====================================================

export const HSTS_DEFAULT = "max-age=31536000; includeSubDomains";
export const HSTS_PRELOAD_VALUE = "max-age=63072000; includeSubDomains; preload";
export const HSTS_PRELOAD_MIN_MAX_AGE = 31536000;

/** "on" only for the exact word (any case, surrounding spaces ignored); everything else is "off". */
export function hstsPreloadMode(env) {
  return String(env?.HSTS_PRELOAD ?? "").trim().toLowerCase() === "on" ? "on" : "off";
}

/**
 * The value to send. `existing` is a value a route already set: it is kept only when it is at least as strong
 * (max-age not lower, includeSubDomains present, preload present whenever ours has it); otherwise ours replaces it.
 */
export function hstsHeaderValue(env, existing) {
  const ours = hstsPreloadMode(env) === "on" ? HSTS_PRELOAD_VALUE : HSTS_DEFAULT;
  if (typeof existing !== "string" || existing.trim() === "") return ours;
  const a = parseHsts(ours); const b = parseHsts(existing);
  const atLeastAsStrong = b.maxAge !== null && b.maxAge >= a.maxAge && b.includeSubDomains && (b.preload || !a.preload);
  return atLeastAsStrong ? existing : ours;
}

/** { maxAge: number|null, includeSubDomains, preload } from a Strict-Transport-Security value. */
export function parseHsts(value) {
  const out = { maxAge: null, includeSubDomains: false, preload: false };
  if (typeof value !== "string") return out;
  for (const raw of value.split(";")) {
    const part = raw.trim().toLowerCase();
    if (part === "includesubdomains") out.includeSubDomains = true;
    else if (part === "preload") out.preload = true;
    else {
      const m = part.match(/^max-age\s*=\s*"?(\d+)"?$/);
      if (m) out.maxAge = Number(m[1]);
    }
  }
  return out;
}

/**
 * @param {string|null} value  the Strict-Transport-Security header served over HTTPS on the registrable domain
 * @param {{httpRedirectsToHttps?: boolean}} [facts]  true/false when known; leave undefined when not checked
 * @returns {{eligible: boolean, problems: string[], unchecked: string[]}}
 *   eligible is true only when every check passed AND nothing was left unchecked.
 */
export function checkPreloadEligibility(value, facts = {}) {
  const problems = []; const unchecked = [];
  if (value === null || value === undefined || String(value).trim() === "") {
    problems.push("Strict-Transport-Security header is missing");
  } else {
    const h = parseHsts(value);
    if (h.maxAge === null) problems.push("max-age is missing or not a number");
    else if (h.maxAge < HSTS_PRELOAD_MIN_MAX_AGE) problems.push(`max-age ${h.maxAge} is below ${HSTS_PRELOAD_MIN_MAX_AGE} (one year)`);
    if (!h.includeSubDomains) problems.push("includeSubDomains is missing");
    if (!h.preload) problems.push("preload is missing");
  }
  if (facts.httpRedirectsToHttps === false) problems.push("http:// does not redirect to https:// on the same host");
  else if (facts.httpRedirectsToHttps !== true) unchecked.push("http:// to https:// redirect was not checked");
  return { eligible: problems.length === 0 && unchecked.length === 0, problems, unchecked };
}
