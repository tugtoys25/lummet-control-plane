#!/usr/bin/env node
// One-time operator setup for connecting single subdomains by CNAME (docs/CUSTOM_DOMAINS.md, "Single subdomains").
//
//   CF_API_TOKEN=... CF_ZONE_ID=... PLATFORM_DOMAIN_SUFFIX=sites.example.com node scripts/setup-custom-hostnames.mjs
//   add --dry-run to only show what would be done
//
// 1. makes sure the proxied record  customers.<PLATFORM_DOMAIN_SUFFIX>  exists in the platform zone (a placeholder
//    origin: Cloudflare for SaaS only needs the name to exist and be proxied, the Worker answers the traffic),
// 2. sets it as the zone's SaaS fallback origin,
// 3. prints the fallback origin status.
// Needs Cloudflare for SaaS enabled on the zone and a token with Zone > DNS: Edit and Zone > SSL and Certificates: Edit.
// Safe to run again.
const token = process.env.CF_API_TOKEN, zone = process.env.CF_ZONE_ID, suffix = process.env.PLATFORM_DOMAIN_SUFFIX;
const dry = process.argv.includes("--dry-run");
const target = String(process.env.PLATFORM_CNAME_TARGET || (suffix ? `customers.${suffix}` : "")).toLowerCase();
if (!token || !zone || !target) { console.error("Set CF_API_TOKEN, CF_ZONE_ID and PLATFORM_DOMAIN_SUFFIX (or PLATFORM_CNAME_TARGET)."); process.exit(2); }

const api = async (method, path, body) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const fail = (what, r) => { console.error(`FAILED ${what}: HTTP ${r.status} ${r.body?.errors?.[0]?.message || ""}`); process.exit(1); };

console.log(`fallback origin / CNAME target: ${target}${dry ? "  (dry run)" : ""}`);
const existing = await api("GET", `/zones/${zone}/dns_records?name=${encodeURIComponent(target)}`);
if (!existing.body.success) fail("read DNS records", existing);
if (existing.body.result.length) console.log(`record exists: ${existing.body.result[0].type} ${existing.body.result[0].name} (proxied: ${existing.body.result[0].proxied})`);
else if (dry) console.log("would create a proxied A record 192.0.2.1 for it");
else {
  const created = await api("POST", `/zones/${zone}/dns_records`, { type: "A", name: target, content: "192.0.2.1", proxied: true, ttl: 1, comment: "Lummet: SaaS fallback origin placeholder" });
  if (!created.body.success) fail("create the record", created);
  console.log("created proxied record");
}
if (!dry) {
  const set = await api("PUT", `/zones/${zone}/custom_hostnames/fallback_origin`, { origin: target });
  if (!set.body.success) fail("set the fallback origin (is Cloudflare for SaaS enabled on this zone?)", set);
}
const now = await api("GET", `/zones/${zone}/custom_hostnames/fallback_origin`);
console.log(now.body.success ? `fallback origin: ${now.body.result?.origin} status: ${now.body.result?.status}` : "fallback origin not readable yet");
console.log("Status can take a minute to become \"active\". Customers can connect subdomains once it is.");
