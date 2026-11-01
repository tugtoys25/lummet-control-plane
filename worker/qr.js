// =====================================================
// QR CODE ENCODER (release 2.6.1.6, round H.4)
//
// The 2FA enrollment page used to show only the secret and the otpauth:// link, which is no use to someone who has the authenticator
// app on a phone and the browser on a laptop. This draws the otpauth link as a QR code.
//
// No dependency and no network: the page's content-security policy allows neither a script library nor an external image service, and
// the secret in the link must never leave this Worker. Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes), which
// holds an otpauth link with room to spare. Output is the module matrix; qrPath() turns it into one SVG path so the page can draw it
// with createElementNS and no innerHTML.
//
// Verified in test/qr-code-h4.test.js by rendering the matrix to an image and decoding it with an independent decoder.
// =====================================================

// Level M. [dataCodewordsPerBlock for the first group, blocks in it, data per block in the second group, blocks in it, ecc per block]
const M_BLOCKS = {
  1: [16, 1, 0, 0, 10], 2: [28, 1, 0, 0, 16], 3: [44, 1, 0, 0, 26], 4: [32, 2, 0, 0, 18], 5: [43, 2, 0, 0, 24],
  6: [27, 4, 0, 0, 16], 7: [31, 4, 0, 0, 18], 8: [38, 2, 39, 2, 22], 9: [36, 3, 37, 2, 22], 10: [43, 4, 44, 1, 26]
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
export const MAX_VERSION = 10;

function dataCapacity(version) {
  const [d1, n1, d2, n2] = M_BLOCKS[version];
  return d1 * n1 + d2 * n2;
}

// ---- Reed-Solomon over GF(256), primitive polynomial 0x11D
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]; })();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) { next[j] ^= poly[j]; next[j + 1] ^= gmul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly;
}
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < degree; i += 1) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ---- bit helpers
function utf8(text) { return [...new TextEncoder().encode(String(text))]; }
function pushBits(bits, value, length) { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); }

function buildCodewords(bytes, version) {
  const capacityBits = dataCapacity(version) * 8;
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < dataCapacity(version); pad ^= 0xec ^ 0x11) out.push(pad);

  const [d1, n1, d2, n2, ecc] = M_BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < n1 + n2; i += 1) {
    const len = i < n1 ? d1 : d2;
    const data = out.slice(at, at + len); at += len;
    blocks.push({ data, ecc: rsRemainder(data, ecc) });
  }
  const result = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  for (let i = 0; i < ecc; i += 1) for (const b of blocks) result.push(b.ecc[i]);
  return result;
}

// ---- matrix
function bch(value, generator, bitsTotal, dataBits) {
  let v = value << (bitsTotal - dataBits);
  const genLen = generator.toString(2).length;
  for (let i = bitsTotal - 1; i >= bitsTotal - dataBits; i -= 1) if ((v >>> i) & 1) v ^= generator << (i - (genLen - 1));
  return (value << (bitsTotal - dataBits)) | v;
}
const formatBits = (mask) => bch((0b00 << 3) | mask, 0x537, 15, 5) ^ 0x5412;      // level M = 00
const versionBits = (version) => bch(version, 0x1f25, 18, 6);

function newMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark, reserve = true) => { if (r < 0 || c < 0 || r >= size || c >= size) return; modules[r][c] = dark; if (reserve) reserved[r][c] = true; };

  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr += 1) for (let dc = -1; dc <= 7; dc += 1) {
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(r0 + dr, c0 + dc, dark);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === centers[centers.length - 1]) || (c === 6 && r === centers[centers.length - 1])) continue;
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true);                                                         // the always-dark module
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  if (version >= 7) for (let i = 0; i < 6; i += 1) for (let j = 0; j < 3; j += 1) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }
  return { size, modules, reserved };
}

function placeData(m, codewords, remainder) {
  const bits = [];
  for (const cw of codewords) pushBits(bits, cw, 8);
  for (let i = 0; i < remainder; i += 1) bits.push(0);
  let idx = 0, upward = true;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let n = 0; n < m.size; n += 1) {
      const row = upward ? m.size - 1 - n : n;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (!m.reserved[row][c]) { m.modules[row][c] = idx < bits.length ? bits[idx] === 1 : false; idx += 1; }
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function applyFormat(modules, size, mask, version) {
  const fmt = formatBits(mask);
  const bit = (i) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6); modules[8][8] = bit(7); modules[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vb >>> i) & 1) === 1, a = Math.floor(i / 3), b = (i % 3) + size - 11;
      modules[a][b] = dark; modules[b][a] = dark;
    }
  }
}

function penalty(modules, size) {
  let score = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        const cur = pass ? modules[b][a] : modules[a][b], prev = pass ? modules[b - 1][a] : modules[a][b - 1];
        if (cur === prev) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
      }
    }
  }
  for (let r = 0; r < size - 1; r += 1) for (let c = 0; c < size - 1; c += 1) {
    const v = modules[r][c];
    if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
  }
  const pat = [true, false, true, true, true, false, true];
  const lineHas = (get) => {
    let hits = 0;
    for (let i = 0; i + 11 <= size; i += 1) {
      const head = pat.every((v, k) => get(i + k) === v) && [7, 8, 9, 10].every((k) => get(i + k) === false);
      const tail = [0, 1, 2, 3].every((k) => get(i + k) === false) && pat.every((v, k) => get(i + 4 + k) === v);
      if (head) hits += 1; if (tail) hits += 1;
    }
    return hits;
  };
  for (let a = 0; a < size; a += 1) { score += 40 * lineHas((i) => modules[a][i]); score += 40 * lineHas((i) => modules[i][a]); }
  let dark = 0; for (const row of modules) for (const v of row) if (v) dark += 1;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Encodes `text` (UTF-8) and returns { version, size, modules } where modules[row][col] is true for a dark module. Throws "qr_too_long". */
export function qrModules(text) {
  const bytes = utf8(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const overhead = 4 + (v <= 9 ? 8 : 16);
    if (overhead + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('qr_too_long');
  const codewords = buildCodewords(bytes, version);
  const remainder = version === 1 ? 0 : version <= 6 ? 7 : 0;

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = newMatrix(version);
    placeData(m, codewords, remainder);
    for (let r = 0; r < m.size; r += 1) for (let c = 0; c < m.size; c += 1) if (!m.reserved[r][c] && MASKS[mask](r, c)) m.modules[r][c] = !m.modules[r][c];
    applyFormat(m.modules, m.size, mask, version);
    const score = penalty(m.modules, m.size);
    if (!best || score < best.score) best = { score, modules: m.modules, size: m.size, mask };
  }
  return { version, size: best.size, modules: best.modules, mask: best.mask };
}

/** One SVG path (unit squares) for the dark modules, so a page can draw the code with a single <path d="..."> element. */
export function qrPath(qr) {
  const parts = [];
  for (let r = 0; r < qr.size; r += 1) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.modules[r][c]) { c += 1; continue; }
      let end = c; while (end < qr.size && qr.modules[r][end]) end += 1;
      parts.push(`M${c} ${r}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  }
  return parts.join('');
}

/** What the setup API returns: the grid size (without the quiet zone) and the path. The page adds the quiet zone when it draws. */
export function qrForText(text) {
  const qr = qrModules(text);
  return { size: qr.size, path: qrPath(qr) };
}
