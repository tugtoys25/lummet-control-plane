// =====================================================
// DNS-OVER-HTTPS RESOLVER
//
// Real implementation of dns-provider.js's contract, using
// Cloudflare's own public DoH JSON endpoint — a plain,
// unauthenticated HTTPS GET, no third-party SDK, no dedicated
// DNS socket support needed (Workers don't have one).
//
// HONESTY NOTE (same as billing-stripe.js/infra-cloudflare.js):
// this has not been exercised against the live endpoint in
// this environment (no network access here). The response
// shape (JSON with an "Answer" array of {name, type, data})
// is Cloudflare's documented, stable DoH JSON format.
// =====================================================

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const TXT_RECORD_TYPE = 16;

export async function lookupTXT(hostname) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=TXT`;
  const response = await fetch(url, { headers: { Accept: "application/dns-json" } });

  if (!response.ok) return [];

  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.Answer)) return [];

  return data.Answer.filter((record) => record.type === TXT_RECORD_TYPE).map((record) =>
    // DoH JSON wraps TXT values in literal double quotes; strip them
    // so callers compare against the plain token value they issued.
    String(record.data || "").replace(/^"|"$/g, "")
  );
}


/**
 * A and AAAA addresses a hostname resolves to, through the same DoH endpoint. Returns
 * { ok: true, addresses: ["203.0.113.5", ...] } or { ok: false } when the lookup itself failed (as opposed to
 * a name that simply has no addresses, which is { ok: true, addresses: [] }).
 */
export async function lookupAddresses(hostname, fetchImpl = fetch) {
  const one = async (type) => {
    const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error(`doh_${response.status}`);
    const data = await response.json();
    // CNAME answers (type 5) sit in the same list; only address records count.
    return (Array.isArray(data.Answer) ? data.Answer : []).filter((r) => r.type === (type === "A" ? 1 : 28)).map((r) => String(r.data || ""));
  };
  try {
    const [a, aaaa] = await Promise.all([one("A"), one("AAAA")]);
    return { ok: true, addresses: [...a, ...aaaa].filter(Boolean) };
  } catch (_) {
    return { ok: false };
  }
}
