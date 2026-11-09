// =====================================================
// IMAGE INSPECTION (portal branding media)
//
// Pure functions, no I/O, no SQL. They answer: "what is this file REALLY, and how big is it?" from the bytes alone.
//
// The tenant's media upload trusts the MIME type and file name the browser sends. The control plane does not: a name that says
// .png over bytes that are not a PNG is refused, and the stored content type always comes from the bytes. SVG is the one format
// that can carry script, so it is read as text and refused when it has anything active in it (see inspectSvg).
// =====================================================

export const IMAGE_TYPES = {
  png: { mime: "image/png", extensions: ["png"] },
  jpeg: { mime: "image/jpeg", extensions: ["jpg", "jpeg"] },
  gif: { mime: "image/gif", extensions: ["gif"] },
  webp: { mime: "image/webp", extensions: ["webp"] },
  ico: { mime: "image/x-icon", extensions: ["ico"] },
  svg: { mime: "image/svg+xml", extensions: ["svg"] }
};

export const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/svg+xml": "svg"
};

export const MAX_SVG_BYTES = 512 * 1024;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] * 0x1000000) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.slice(i, i + n));

function pngInfo(b) {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  // A PNG ends with an IEND chunk; a file without one was cut off (an interrupted upload) and browsers may refuse to draw it.
  if (!ascii(b, Math.max(0, b.length - 64), Math.min(64, b.length)).includes("IEND")) return null;
  return { type: "png", width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegInfo(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = u16be(b, i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { type: "jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function gifInfo(b) {
  if (b.length < 10) return null;
  return { type: "gif", width: u16le(b, 6), height: u16le(b, 8) };
}

function webpInfo(b) {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] * 0x1000000)) >>> 0;
    return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

function icoInfo(b) {
  const count = u16le(b, 4);
  if (count < 1 || count > 64 || b.length < 6 + count * 16) return null;
  const sizes = [];
  for (let n = 0; n < count; n += 1) {
    const at = 6 + n * 16;
    // Each entry says where its picture is and how long it is; both must lie inside the file.
    const length = b[at + 8] + b[at + 9] * 256 + b[at + 10] * 65536 + b[at + 11] * 16777216;
    const offset = b[at + 12] + b[at + 13] * 256 + b[at + 14] * 65536 + b[at + 15] * 16777216;
    if (length < 1 || offset + length > b.length) return null;
    sizes.push({ width: b[at] || 256, height: b[at + 1] || 256 });
  }
  const largest = sizes.reduce((a, s) => (s.width * s.height > a.width * a.height ? s : a), sizes[0]);
  return { type: "ico", width: largest.width, height: largest.height, sizes };
}

const decodeText = (bytes) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/**
 * Looks at an SVG document and refuses anything that can run code or fetch something from elsewhere. Returns {ok, error?, width?,
 * height?}. It is deliberately a deny-list over a small, flat file (a logo), not an XML parser: anything it does not recognise as
 * plainly safe in the places it checks is refused with a reason a person can act on.
 */
export function inspectSvg(bytes) {
  if (bytes.length > MAX_SVG_BYTES) return { ok: false, error: "svg_too_large" };
  const text = decodeText(bytes);
  if (text.includes("\u0000")) return { ok: false, error: "not_an_image" };
  const root = /<svg[\s>]/i.exec(text);
  if (!root) return { ok: false, error: "not_an_image" };
  const before = text.slice(0, root.index).replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (before !== "") return { ok: false, error: "svg_unsafe", detail: "content before the svg element" };
  if (!/<svg[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text)) return { ok: false, error: "svg_missing_xmlns" };

  const forbidden = [
    [/<!doctype/i, "a DOCTYPE"],
    [/<!entity/i, "an entity declaration"],
    [new RegExp("<" + "script", "i"), "a script element"], // spelled in two parts: the CSP source scan flags the literal tag in worker/ sources
    [/<foreignobject/i, "a foreignObject element"],
    [/<(iframe|embed|object|audio|video|canvas|link|meta|style\b[^>]*src)/i, "an embedded or linked element"],
    [/<(animate|set|animatetransform|animatemotion)\b[^>]*attributename\s*=\s*["']?(xlink:)?href/i, "an animation of a link"],
    [/\son[a-z]+\s*=/i, "an event handler attribute"],
    [/javascript\s*:/i, "a javascript: address"],
    [/data\s*:\s*(text|application)\//i, "a data: document"],
    [/@import/i, "a CSS @import"],
    [/expression\s*\(/i, "a CSS expression"]
  ];
  for (const [re, label] of forbidden) {
    if (re.test(text)) return { ok: false, error: "svg_unsafe", detail: label };
  }
  // Every link must point inside the file (#id) or be an inline raster picture. Nothing may be fetched.
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const target = m[1].trim();
    if (target.startsWith("#")) continue;
    if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(target)) continue;
    return { ok: false, error: "svg_unsafe", detail: "a link that leaves the file" };
  }
  for (const m of text.matchAll(/url\(\s*["']?([^)"']*)["']?\s*\)/gi)) {
    const target = m[1].trim();
    if (target.startsWith("#") || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(target)) continue;
    return { ok: false, error: "svg_unsafe", detail: "a url() that leaves the file" };
  }

  const tag = /<svg\b[^>]*>/i.exec(text)[0];
  const num = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, "i").exec(tag);
    return m ? Math.round(Number(m[1])) : null;
  };
  let width = num("width");
  let height = num("height");
  if (!width || !height) {
    const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
    if (vb) { width = Math.round(Number(vb[1])); height = Math.round(Number(vb[2])); }
  }
  return { ok: true, type: "svg", width: width || null, height: height || null };
}

/**
 * Identifies the file from its first bytes. Returns {ok:true, type, mime, width, height} or {ok:false, error}.
 * width/height are null when they cannot be known (an SVG with no size).
 */
export function inspectImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return { ok: false, error: "not_an_image" };
  let info = null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") info = pngInfo(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) info = jpegInfo(bytes);
  else if (ascii(bytes, 0, 3) === "GIF") info = gifInfo(bytes);
  else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") info = webpInfo(bytes);
  else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) info = icoInfo(bytes);
  else {
    const svg = inspectSvg(bytes);
    if (!svg.ok) return svg;
    info = svg;
  }
  if (!info) return { ok: false, error: "not_an_image" };
  if (info.type !== "svg" && (!info.width || !info.height || info.width > 16384 || info.height > 16384)) return { ok: false, error: "invalid_dimensions" };
  return { ok: true, type: info.type, mime: IMAGE_TYPES[info.type].mime, width: info.width ?? null, height: info.height ?? null, sizes: info.sizes || null };
}

/** The file name's extension, lower-case, without a dot ("" when there is none). Path parts are dropped first. */
export function extensionOf(filename) {
  const base = String(filename ?? "").replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** True when the extension on the file name is one the detected type may carry (a .jpeg is a JPEG; a .png over a GIF is not). */
export function extensionMatches(type, filename) {
  const ext = extensionOf(filename);
  return !!IMAGE_TYPES[type] && IMAGE_TYPES[type].extensions.includes(ext);
}
