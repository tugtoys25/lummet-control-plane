// test/support/fake-dns-resolver.js
//
// Implements dns-provider.js's contract with no network calls. A
// test controls what "DNS" answers by calling _setTXTRecords()
// before verifyDns() runs -- modeling the real-world fact that DNS
// propagation is eventual (a lookup can return nothing yet, then
// later return the record once the customer's DNS has propagated).

export function createFakeDnsResolver() {
  const records = new Map(); // hostname -> string[]
  const nsRecords = new Map(); // domain -> string[]  (v1: what public DNS says the nameservers are)
  const cnameRecords = new Map(); // hostname -> string[]  (v1.1)
  let nsFailure = false;
  const calls = [];

  return {
    _calls: calls,
    _setTXTRecords(hostname, values) {
      records.set(hostname, values);
    },
    _setNameservers(domain, list) { nsRecords.set(domain, list); },
    _failNsLookups(v = true) { nsFailure = v; },
    _setCNAME(hostname, targets) { cnameRecords.set(hostname, targets); },
    async lookupCNAME(hostname) {
      calls.push({ method: "lookupCNAME", hostname });
      return { ok: true, targets: (cnameRecords.get(hostname) || []).slice() };
    },
    async lookupNS(domain) {
      calls.push({ method: "lookupNS", domain });
      if (nsFailure) return { ok: false };
      return { ok: true, nameServers: (nsRecords.get(domain) || []).slice().sort() };
    },
    async lookupTXT(hostname) {
      calls.push({ method: "lookupTXT", hostname });
      return records.get(hostname) || [];
    }
  };
}
