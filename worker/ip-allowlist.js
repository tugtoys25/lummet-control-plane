// =====================================================
// IP ALLOWLIST: pure parsing and matching  (Round 6.4C, release 2.6.0.11)
//
// No I/O, no environment, no database. Everything an organization allowlist needs to decide "is this address inside this list":
//   - parseIp         strict IPv4 / IPv6 parsing (no zone ids, no leading zeros, no ports, no lists). IPv4-mapped IPv6 collapses to IPv4.
//   - normalizeAllowlist  validates and canonicalizes what an owner submits (the only form that is ever stored).
//   - ipAllowed       the match. Fails closed: anything it cannot read never matches.
//   - clientIpFromRequest  which header names the client. ONLY CF-Connecting-IP.
//
// Why only CF-Connecting-IP: this Worker is reached through Cloudflare, which sets that header itself and replaces any value the client
// sent. X-Forwarded-For, X-Real-IP, Forwarded and True-Client-IP are plain request headers a caller can write, so trusting them would let
// anyone walk past an allowlist. If the Worker is ever placed behind another proxy, this is the one function to change (OPEN_ITEMS_v2.6.0.11).
// =====================================================

export const MAX_ENTRIES = 50;           // default and documented limit; the service may pass a different bound (IP_ALLOWLIST_MAX_ENTRIES)
const MAX_ENTRY_LENGTH = 64;
const FAMILY_BITS = { 4: 32, 6: 128 };

function parseV4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part[0] === "0") return null; // 01.2.3.4 is ambiguous (octal in some parsers): refuse rather than guess
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(text) {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(":::")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const last = halves.length === 2 ? tail : head;
  if (last.length && last[last.length - 1].includes(".")) { // an embedded IPv4 tail such as ::ffff:203.0.113.5
    const v4 = parseV4(last[last.length - 1]);
    if (v4 === null) return null;
    last.splice(last.length - 1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
  }
  const all = [...head, ...tail];
  if (all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const fill = halves.length === 2 ? new Array(8 - all.length).fill("0") : [];
  const groups = [...head, ...fill, ...tail];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(parseInt(g, 16));
  return value;
}

/** Parses one address. Returns { family: 4 | 6, value: BigInt } or null. An IPv4-mapped IPv6 address returns the IPv4 it carries. */
export function parseIp(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 45) return null;
  if (text.includes(":")) {
    const value = parseV6(text);
    if (value === null) return null;
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn }; // ::ffff:a.b.c.d
    return { family: 6, value };
  }
  const v4 = parseV4(text);
  return v4 === null ? null : { family: 4, value: v4 };
}

function maskOf(family, prefix) {
  const bits = BigInt(FAMILY_BITS[family]);
  return ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
}

/** One CIDR (or a bare address, which is /32 or /128) to { family, network, prefix }. /0 is refused: it would mean "everyone". */
function parseCidr(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH) return null;
  const pieces = entry.split("/");
  if (pieces.length > 2) return null;
  const addr = parseIp(pieces[0]);
  if (!addr) return null;
  let prefix = FAMILY_BITS[addr.family];
  if (pieces.length === 2) {
    if (!/^(0|[1-9]\d{0,2})$/.test(pieces[1])) return null;
    let p = Number(pieces[1]);
    if (addr.family === 4 && pieces[0].includes(":")) { // a prefix written against a mapped literal counts from bit 0 of the 128-bit form
      if (p < 96) return null;
      p -= 96;
    }
    if (p < 1 || p > FAMILY_BITS[addr.family]) return null;
    prefix = p;
  }
  return { family: addr.family, network: addr.value & maskOf(addr.family, prefix), prefix };
}

function v4Text(value) {
  return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join(".");
}
function v6Text(value) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}
function cidrText(c) {
  return `${c.family === 4 ? v4Text(c.network) : v6Text(c.network)}/${c.prefix}`;
}

/**
 * Validates what an owner submits and returns the canonical list that gets stored: masked networks, lower-case compressed IPv6, duplicates
 * removed, IPv4 before IPv6, each sorted numerically. { ok: true, list } or { ok: false, error } with error one of
 * invalid_allowlist (not an array), too_many_entries, invalid_allowlist_entry. An empty list is valid and means "no allowlist".
 */
export function normalizeAllowlist(input, { max = MAX_ENTRIES } = {}) {
  if (!Array.isArray(input)) return { ok: false, error: "invalid_allowlist" };
  if (input.length > max) return { ok: false, error: "too_many_entries" };
  const seen = new Map();
  for (const entry of input) {
    const cidr = parseCidr(entry);
    if (!cidr) return { ok: false, error: "invalid_allowlist_entry" };
    seen.set(cidrText(cidr), cidr);
  }
  const sorted = [...seen.values()].sort((a, b) => (a.family !== b.family ? a.family - b.family : a.network < b.network ? -1 : a.network > b.network ? 1 : a.prefix - b.prefix));
  return { ok: true, list: sorted.map(cidrText) };
}

/** True only when the address parses and lies inside at least one readable entry. An unreadable address, an empty list or a corrupt entry never allows. */
export function ipAllowed(ip, list) {
  const addr = parseIp(ip);
  if (!addr || !Array.isArray(list)) return false;
  for (const entry of list) {
    const cidr = parseCidr(entry);
    if (cidr && cidr.family === addr.family && (addr.value & maskOf(cidr.family, cidr.prefix)) === cidr.network) return true;
  }
  return false;
}

/** The client address for an allowlist decision, or null (the caller then fails closed). Only CF-Connecting-IP is read. */
export function clientIpFromRequest(request) {
  const raw = request && request.headers ? request.headers.get("CF-Connecting-IP") : null;
  return parseIp(raw) ? raw : null;
}
