// Round 6.4C (release 2.6.0.11): pure IPv4 / IPv6 / CIDR parsing and matching, and the one rule for which header names the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIp, normalizeAllowlist, ipAllowed, clientIpFromRequest, MAX_ENTRIES } from '../worker/ip-allowlist.js';

const req = (headers) => new Request('https://cp.test/x', { headers });

test('parseIp: plain IPv4 and IPv6 parse; junk, ambiguous and zoned forms do not', () => {
  assert.ok(parseIp('203.0.113.5'));
  assert.ok(parseIp('2001:db8::1'));
  assert.ok(parseIp('::1'));
  for (const bad of ['', ' ', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.04', '01.2.3.4', '0x7f.0.0.1', '1.2.3.4 ', ' 1.2.3.4', '1.2.3.4,5.6.7.8',
    'fe80::1%eth0', '2001:db8::g', '2001:db8:::1', '1:2:3:4:5:6:7:8:9', '12345::1', '1.2.3.4/24', null, undefined, 42]) {
    assert.equal(parseIp(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseIp: an IPv4-mapped IPv6 address is the same address as its IPv4 form', () => {
  assert.deepEqual(parseIp('::ffff:203.0.113.5'), parseIp('203.0.113.5'));
  assert.deepEqual(parseIp('::FFFF:cb00:7105'), parseIp('203.0.113.5'));
  assert.notDeepEqual(parseIp('2001:db8::cb00:7105'), parseIp('203.0.113.5'));
});

test('normalizeAllowlist: canonical CIDRs, host bits masked, duplicates removed, a bare address becomes /32 or /128', () => {
  const r = normalizeAllowlist(['203.0.113.5', '198.51.100.77/24', '2001:db8::1', '2001:db8:0:0::/48', '203.0.113.5/32', '::ffff:192.0.2.9']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.list, ['192.0.2.9/32', '198.51.100.0/24', '203.0.113.5/32', '2001:db8::/48', '2001:db8::1/128']);
});

test('normalizeAllowlist: refuses allow-everything, bad prefixes, non-strings, empty entries and oversized lists', () => {
  for (const bad of [['0.0.0.0/0'], ['::/0'], ['1.2.3.4/33'], ['::1/129'], ['1.2.3.4/-1'], ['1.2.3.4/'], ['1.2.3.4/x'], ['nope'], [''], [5], [null], ['1.2.3.4', 'oops']]) {
    const r = normalizeAllowlist(bad);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.equal(r.error, 'invalid_allowlist_entry');
  }
  assert.equal(normalizeAllowlist('1.2.3.4').error, 'invalid_allowlist');
  assert.equal(normalizeAllowlist({}).error, 'invalid_allowlist');
  const tooMany = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250 + 1}`);
  assert.equal(normalizeAllowlist(tooMany).error, 'too_many_entries');
  assert.equal(normalizeAllowlist(tooMany.slice(0, MAX_ENTRIES)).ok, true);
});

test('normalizeAllowlist: an empty list is valid (it means no allowlist)', () => {
  assert.deepEqual(normalizeAllowlist([]), { ok: true, list: [] });
});

test('ipAllowed: IPv4 inside and outside a range, edges of a /24, a /32', () => {
  const list = normalizeAllowlist(['198.51.100.0/24', '203.0.113.5']).list;
  assert.equal(ipAllowed('198.51.100.0', list), true);
  assert.equal(ipAllowed('198.51.100.255', list), true);
  assert.equal(ipAllowed('198.51.101.0', list), false);
  assert.equal(ipAllowed('198.51.99.255', list), false);
  assert.equal(ipAllowed('203.0.113.5', list), true);
  assert.equal(ipAllowed('203.0.113.6', list), false);
});

test('ipAllowed: IPv6 ranges, and an IPv6 client never matches an IPv4 rule or the other way round', () => {
  const list = normalizeAllowlist(['2001:db8:abcd::/48', '203.0.113.0/24']).list;
  assert.equal(ipAllowed('2001:db8:abcd:1::7', list), true);
  assert.equal(ipAllowed('2001:db8:abce::1', list), false);
  assert.equal(ipAllowed('2001:db8:abcd:ffff:ffff:ffff:ffff:ffff', list), true);
  assert.equal(ipAllowed('::ffff:203.0.113.9', list), true, 'a mapped address is treated as the IPv4 address it carries');
  assert.equal(ipAllowed('::ffff:198.51.100.9', list), false);
  assert.equal(ipAllowed('2001:db8:abcd::1', ['203.0.113.0/24']), false);
});

test('ipAllowed: fails closed on anything it cannot read, and on an empty list', () => {
  const list = normalizeAllowlist(['203.0.113.0/24']).list;
  for (const bad of [null, undefined, '', 'garbage', '203.0.113.5, 198.51.100.1', '203.0.113.5%x']) assert.equal(ipAllowed(bad, list), false);
  assert.equal(ipAllowed('203.0.113.5', []), false);
  assert.equal(ipAllowed('203.0.113.5', ['not-a-cidr']), false, 'a corrupt stored entry never allows anyone');
});

test('clientIpFromRequest: only CF-Connecting-IP counts; forwarding headers a client can set are ignored', () => {
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': '203.0.113.5' })), '203.0.113.5');
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': '2001:db8::1' })), '2001:db8::1');
  assert.equal(clientIpFromRequest(req({ 'X-Forwarded-For': '203.0.113.5' })), null);
  assert.equal(clientIpFromRequest(req({ 'X-Real-IP': '203.0.113.5' })), null);
  assert.equal(clientIpFromRequest(req({ Forwarded: 'for=203.0.113.5' })), null);
  assert.equal(clientIpFromRequest(req({ 'True-Client-IP': '203.0.113.5' })), null);
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '203.0.113.5' })), '198.51.100.1', 'a spoofed X-Forwarded-For cannot override it');
  assert.equal(clientIpFromRequest(req({})), null);
});

test('clientIpFromRequest: an unreadable or multi-valued CF-Connecting-IP is null (so the caller fails closed)', () => {
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': 'not an ip' })), null);
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': '203.0.113.5, 198.51.100.1' })), null);
  assert.equal(clientIpFromRequest(req({ 'CF-Connecting-IP': '  ' })), null);
});
