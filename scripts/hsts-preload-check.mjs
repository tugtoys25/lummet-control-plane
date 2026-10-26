#!/usr/bin/env node
/** HSTS preload-eligibility check for the control-plane hostname (Round 6.3C). Read-only; owner-run for live hosts.
 *    node scripts/hsts-preload-check.mjs --header "<Strict-Transport-Security value>" [--assume-redirect]
 *    node scripts/hsts-preload-check.mjs --url https://example.com/
 *  --header  offline: check a header value. The http-to-https redirect stays "unchecked" (and so not eligible) unless
 *            --assume-redirect says you checked it yourself.
 *  --url     fetches the https URL and the http:// twin once each (redirects are NOT followed) and checks header and redirect.
 *  Exit 0: eligible. Exit 1: not eligible, or the fetch failed. Exit 2: bad usage.
 *  A pass here is NOT submission approval: read docs/HSTS_PRELOAD.md first. Live results are NOT VERIFIED until an owner
 *  runs this against the real host and attaches the output. Domain-level facts (valid certificate, every subdomain
 *  served over HTTPS, apex coverage) cannot be checked from one URL and are listed as owner checks. */
import { fileURLToPath } from "node:url";
import { checkPreloadEligibility } from "../worker/hsts.js";

const USAGE = 'Usage: node scripts/hsts-preload-check.mjs --header "<value>" [--assume-redirect] | --url https://host/';

export async function main(argv, env, fetchImpl, io = { log: console.log, error: console.error }) {
  const has = (x) => argv.includes(`--${x}`);
  const opt = (x) => { const i = argv.indexOf(`--${x}`); return i >= 0 ? argv[i + 1] : null; };
  const header = opt("header"); const urlArg = opt("url");
  if (header === null && urlArg === null) { io.error(USAGE); return 2; }

  const ownerChecks = [
    "the certificate is valid for the apex and every subdomain",
    "every subdomain (including customer-site hostnames under the platform suffix) is served over HTTPS",
    "the header is served on the apex (registrable) domain, not only on a subdomain",
    "the owner has approved preload (HSTS_PRELOAD_APPROVED=yes) after reading docs/HSTS_PRELOAD.md"
  ];

  if (urlArg === null) {
    const result = checkPreloadEligibility(header, { httpRedirectsToHttps: has("assume-redirect") ? true : undefined });
    io.log(JSON.stringify({ source: "header", ...result, warnings: [], ownerChecks }, null, 2));
    return result.eligible ? 0 : 1;
  }

  let target;
  try { target = new URL(urlArg); } catch { io.error(`REFUSED: --url is not a valid URL. ${USAGE}`); return 2; }
  if (target.protocol !== "https:") { io.error(`REFUSED: --url must be an https:// URL. ${USAGE}`); return 2; }
  const host = target.hostname;
  const warnings = [];
  if (host.split(".").length > 2) warnings.push(`${host} looks like a subdomain: preload lists the registrable (apex) domain, so check the apex host as well (no public-suffix list is bundled, so multi-part suffixes such as .co.uk are not recognised)`);

  let value = null; let redirectOk;
  try {
    const secure = await fetchImpl(target.toString(), { method: "GET", redirect: "manual" });
    value = secure.headers.get("strict-transport-security");
    const plain = new URL(target.toString()); plain.protocol = "http:";
    const insecure = await fetchImpl(plain.toString(), { method: "GET", redirect: "manual" });
    const location = insecure.headers.get("location");
    let sameHostHttps = false;
    try { const to = new URL(location || "", plain); sameHostHttps = to.protocol === "https:" && to.hostname === host; } catch { sameHostHttps = false; }
    redirectOk = [301, 302, 307, 308].includes(insecure.status) && sameHostHttps;
  } catch (error) {
    io.error(`Fetch failed: ${error && error.message ? error.message : error}`);
    return 1;
  }
  const result = checkPreloadEligibility(value, { httpRedirectsToHttps: redirectOk });
  io.log(JSON.stringify({ source: "url", host, ...result, warnings, ownerChecks }, null, 2));
  return result.eligible ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.env, fetch));
