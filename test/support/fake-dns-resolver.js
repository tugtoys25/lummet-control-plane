// test/support/fake-dns-resolver.js
//
// Implements dns-provider.js's contract with no network calls. A
// test controls what "DNS" answers by calling _setTXTRecords()
// before verifyDns() runs -- modeling the real-world fact that DNS
// propagation is eventual (a lookup can return nothing yet, then
// later return the record once the customer's DNS has propagated).

export function createFakeDnsResolver() {
  const records = new Map(); // hostname -> string[]
  const calls = [];

  return {
    _calls: calls,
    _setTXTRecords(hostname, values) {
      records.set(hostname, values);
    },
    async lookupTXT(hostname) {
      calls.push({ method: "lookupTXT", hostname });
      return records.get(hostname) || [];
    }
  };
}
