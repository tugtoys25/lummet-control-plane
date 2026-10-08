// =====================================================
// sanitize.js — Central HTML Sanitization Service
// =====================================================
//
// Pure-JavaScript HTML sanitizer for Cloudflare Workers.
// No DOM API required — uses regex-based tokenization.
//
// Security model:
//   1. Tag whitelist — only known-safe tags are kept
//   2. Attribute whitelist — per-tag allowed attributes
//   3. Event handler removal — all on* attributes stripped
//   4. URL sanitization — blocks javascript:, vbscript:, data: (except images)
//   5. Style sanitization — strips dangerous CSS (expression(), javascript:, etc.)
//   6. Comment removal — HTML comments can contain IE conditional scripts
//   7. CDATA removal — XML CDATA sections can hide scripts
//   8. Dangerous tag removal — script, style, object, embed, etc. removed with content
//
// The sanitizer is idempotent — already-sanitized HTML passes through unchanged.
//
// Usage:
//   import { sanitizeHtml } from './sanitize.js';
//   const clean = sanitizeHtml(userContent);
//
// =====================================================

// ── Allowed tags ─────────────────────────────────────
// Tags that are preserved in output. All other tags are
// "unwrapped" — the tag itself is removed but text content
// between them is kept.
const ALLOWED_TAGS = new Set([
  // Block structure
  'p', 'div', 'br', 'hr', 'span',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Inline formatting
  'strong', 'em', 'u', 's', 'b', 'i', 'mark', 'sup', 'sub', 'small',
  'abbr', 'cite', 'kbd', 'samp', 'var', 'code', 'time', 'address', 'wbr',
  // Links and media
  'a', 'img',
  'video', 'source', 'audio', 'track',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Quotes and code
  'blockquote', 'q', 'pre',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
  // Figures
  'figure', 'figcaption',
  // Interactive (safe)
  'details', 'summary', "button",
  // Controlled iframe (for video embeds — src is sanitized)
  'iframe',
]);

// ── Tags removed WITH their content ──────────────────
// These tags and everything inside them is stripped entirely.
// Content is NOT preserved because it is code, not user-visible text.
const STRIP_CONTENT_TAGS = new Set([
  'script', 'style', 'object', 'embed', 'applet', 'param',
  'noscript', 'template', 'slot',
  'frame', 'frameset', 'xml', 'svg', 'math', 'canvas',
  'map', 'area', 'form', 'input',  'textarea',
  'select', 'option', 'optgroup', 'label', 'fieldset', 'legend',
  'datalist', 'output', 'progress', 'meter',
  'link', 'meta', 'base', 'title', 'head', 'html', 'body',
  'basefont', 'bgsound', 'blink', 'marquee', 'isindex',
  'plaintext', 'xmp', 'listing', 'nextid', 'spacer',
]);

// ── Per-tag allowed attributes ───────────────────────
// Global attributes (class, style, id, title, dir, lang)
// are allowed on ALL tags via the '*' key.
// Tag-specific attributes are listed per tag.
const ALLOWED_ATTRS = {
  '*': ['class', 'style', 'id', 'title', 'dir', 'lang', 'role', 'tabindex', 'hidden', 'data-*'],

  'a': ['href', 'target', 'rel', 'name', 'download', 'type', 'hreflang'],
  'img': ['src', 'alt', 'width', 'height', 'loading', 'srcset', 'sizes', 'decoding', 'referrerpolicy', 'usemap', 'ismap'],
  'video': ['src', 'poster', 'controls', 'width', 'height', 'preload', 'muted', 'loop', 'autoplay', 'playsinline', 'crossorigin'],
  'audio': ['src', 'controls', 'preload', 'muted', 'loop', 'autoplay', 'crossorigin'],
  'source': ['src', 'type', 'media', 'sizes', 'srcset'],
  'track': ['src', 'kind', 'srclang', 'label', 'default'],
  'iframe': ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'loading', 'name', 'referrerpolicy', 'sandbox', 'title'],

  'table': ['border', 'cellpadding', 'cellspacing', 'summary', 'width'],
  'td': ['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'width', 'height', 'valign', 'align'],
  'th': ['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'width', 'height', 'valign', 'align', 'sorted'],
  'tr': ['valign', 'align'],
  'col': ['span', 'width'],
  'colgroup': ['span', 'width'],
  'thead': ['valign', 'align'],
  'tbody': ['valign', 'align'],
  'tfoot': ['valign', 'align'],

  'ol': ['start', 'type', 'reversed'],
  'ul': ['type'],
  'li': ['value'],
  'dl': [],
  'dt': [],
  'dd': [],

  'blockquote': ['cite'],
  'q': ['cite'],
  'pre': ['width'],
  'code': [],
  'time': ['datetime'],
  'abbr': ['title'],
  'details': ['open'],
  'summary': [],
  'figure': [],
  'figcaption': [],
  'caption': [],
  'hr': ['width', 'size', 'noshade', 'align'],
  'br': ['clear'],
  'b': [],
  'i': [],
  's': [],
  'u': [],
  'mark': [],
  'sup': [],
  'sub': [],
  'small': [],
  'strong': [],
  'em': [],
  'span': [],
  'p': ['align'],
  'div': ['align'],
  'h1': ['align'],
  'h2': ['align'],
  'h3': ['align'],
  'h4': ['align'],
  'h5': ['align'],
  'h6': ['align'],
  'address': [],
  'kbd': [],
  'samp': [],
  'var': [],
  'wbr': [],
};

// ── URL attributes that need scheme sanitization ────
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite', 'action', 'data', 'formaction', 'background', 'longdesc', 'usemap', 'profile', 'manifest', 'archive', 'codebase', 'icon', 'ping']);

// ── Allowed URL schemes ──────────────────────────────
// For general URL attributes (href, etc.)
const ALLOWED_URL_SCHEMES = new Set([
  'http', 'https', 'mailto', 'tel', 'ftp', 'ftps',
  'sms', 'geo', 'news', 'irc', 'ircs', 'xmpp',
]);

// For image src attributes, also allow data:image/ URIs
const ALLOWED_IMAGE_SCHEMES = new Set([
  'http', 'https', 'mailto', 'tel', 'ftp', 'ftps',
  'sms', 'geo', 'news', 'irc', 'ircs', 'xmpp',
  'data', // only data:image/... is allowed (checked separately)
]);

// ── Dangerous CSS patterns ───────────────────────────
// These patterns in style attribute values are stripped.
const DANGEROUS_CSS_PATTERNS = [
  /expression\s*\(/gi,
  /javascript\s*:/gi,
  /vbscript\s*:/gi,
  /-moz-binding\s*:/gi,
  /behavior\s*:/gi,
  /@import\b/gi,
  /url\s*\(\s*['"]?\s*javascript\s*:/gi,
  /url\s*\(\s*['"]?\s*vbscript\s*:/gi,
  /url\s*\(\s*['"]?\s*data\s*:/gi,
];

// ── HTML entity encoding ─────────────────────────────
/**
 * Encodes a string for safe insertion into HTML text content.
 * Encodes &, <, >, ", '.
 * @param {string} str - The string to encode.
 * @returns {string} The HTML-encoded string.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── URL sanitization ─────────────────────────────────
/**
 * Sanitizes a URL value to block dangerous schemes.
 * Allows http, https, mailto, tel, and relative URLs.
 * For image attributes, also allows data:image/ URIs.
 * @param {string} url - The URL to sanitize.
 * @param {boolean} isImage - Whether this URL is for an image attribute.
 * @returns {string} The sanitized URL, or empty string if dangerous.
 */
function sanitizeUrl(url, isImage) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (trimmed === '') return '';

  // Decode HTML entities in URL (e.g., &#106;avascript:)
  let decoded = trimmed;
  try {
    decoded = decoded
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&tab;/gi, '\t')
      .replace(/&newline;/gi, '\n')
      .replace(/&colon;/gi, ':')
      .replace(/&NewLine;/gi, '\n')
      .replace(/&lpar;/gi, '(')
      .replace(/&rpar;/gi, ')');
  } catch (e) {
    // If decoding fails, treat as suspicious
    return '';
  }

  // Remove all whitespace and control characters
  // (attackers use \t, \n, \0 to break up "javascript:")
  const cleaned = decoded.replace(/[\x00-\x20\x7f]/g, '');

  // Check for scheme
  const schemeMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();

    // For images, allow data:image/ only
    if (isImage && scheme === 'data') {
      if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)/i.test(cleaned)) {
        return trimmed;
      }
      // data: but not image — block
      return '';
    }

    // For non-image attributes, block all data: URLs
    if (scheme === 'data' && !isImage) {
      return '';
    }

    // Check against allowed schemes
    const allowed = isImage ? ALLOWED_IMAGE_SCHEMES : ALLOWED_URL_SCHEMES;
    if (!allowed.has(scheme)) {
      return '';
    }

    return trimmed;
  }

  // No scheme — relative URL (starts with /, ./, ../, #, or just a path)
  // These are safe
  if (/^(\/|\.\/|\.\.\/|#|\?)/.test(trimmed) || !/^[a-zA-Z]/.test(trimmed)) {
    return trimmed;
  }

  // Could be a protocol-relative URL (//example.com)
  if (/^\/\//.test(trimmed)) {
    return trimmed;
  }

  // Could be a domain-like string (example.com/path)
  // Treat as relative URL — safe
  return trimmed;
}

// ── Style attribute sanitization ─────────────────────
/**
 * Sanitizes a CSS style string for use in a style attribute.
 * Strips dangerous CSS patterns that can execute JavaScript.
 * @param {string} style - The CSS style string to sanitize.
 * @returns {string} The sanitized CSS style string.
 */
function sanitizeStyle(style) {
  if (typeof style !== 'string') return '';
  let cleaned = style;

  // Remove dangerous patterns
  for (const pattern of DANGEROUS_CSS_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove CSS comments (can hide dangerous content)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove backslash escapes that could bypass filters
  // (e.g., \6a\61\76... for "jav...")
  cleaned = cleaned.replace(/\\[0-9a-fA-F]{1,6}\s?/g, '');

  // Re-check after removing escapes (patterns might be revealed)
  for (const pattern of DANGEROUS_CSS_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Clean up multiple semicolons and trailing whitespace
  cleaned = cleaned.replace(/;{2,}/g, ';').replace(/;$/, '').trim();

  return cleaned;
}

// ── Attribute parsing ────────────────────────────────
/**
 * Parses an attribute string into an array of {name, value} pairs.
 * Handles double-quoted, single-quoted, and unquoted values.
 * Handles boolean attributes (value = null).
 * @param {string} attrsStr - The attribute portion of a tag (everything between tag name and >).
 * @returns {Array<{name: string, value: string|null}>} Parsed attributes.
 */
function parseAttributes(attrsStr) {
  const attrs = [];
  // Regex matches: name="value" | name='value' | name=value | name (boolean)
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrRegex.exec(attrsStr)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : null));
    attrs.push({ name, value });
  }
  return attrs;
}

// ── Attribute sanitization ───────────────────────────
/**
 * Checks if an attribute name is allowed for a given tag.
 * Supports wildcard attributes via 'data-*'.
 * @param {string} tag - The tag name (lowercase).
 * @param {string} attrName - The attribute name (lowercase).
 * @returns {boolean} True if the attribute is allowed.
 */
function isAllowedAttr(tag, attrName) {
  // Always strip event handlers
  if (/^on/i.test(attrName)) {
    return false;
  }

  // Check global attributes
  const globalAttrs = ALLOWED_ATTRS['*'] || [];
  for (const ga of globalAttrs) {
    if (ga === attrName) return true;
    // Support data-* wildcard
    if (ga === 'data-*' && /^data-/i.test(attrName)) return true;
  }

  // Check tag-specific attributes
  const tagAttrs = ALLOWED_ATTRS[tag] || [];
  for (const ta of tagAttrs) {
    if (ta === attrName) return true;
    if (ta === 'data-*' && /^data-/i.test(attrName)) return true;
  }

  return false;
}

/**
 * Sanitizes an attribute value based on attribute name and tag.
 * @param {string} tag - The tag name (lowercase).
 * @param {string} attrName - The attribute name (lowercase).
 * @param {string|null} value - The attribute value.
 * @returns {string|null} The sanitized value, or null to remove the attribute.
 */
function sanitizeAttrValue(tag, attrName, value) {
  if (value === null) {
    return null; // Boolean attribute
  }

  // URL attributes — sanitize scheme
  if (URL_ATTRS.has(attrName)) {
    const isImage = (tag === 'img' || tag === 'source') && attrName === 'src';
    const sanitized = sanitizeUrl(value, isImage);
    return sanitized || null; // Remove attr if URL is dangerous
  }

  // Style attribute — sanitize CSS
  if (attrName === 'style') {
    const sanitized = sanitizeStyle(value);
    return sanitized || null; // Remove attr if style is empty after sanitization
  }

  // For iframe src — ensure HTTPS or protocol-relative
  if (tag === 'iframe' && attrName === 'src') {
    const sanitized = sanitizeUrl(value, false);
    if (!sanitized) return null;
    // Block non-HTTPS absolute URLs for iframes
    if (/^https?:\/\//i.test(sanitized) && !/^https:\/\//i.test(sanitized)) {
      return null; // Block http: iframes
    }
    return sanitized;
  }

  // For target attribute on links — only allow safe values
  if (attrName === 'target') {
    const lower = value.toLowerCase().trim();
    if (lower === '_blank' || lower === '_self' || lower === '_parent' || lower === '_top') {
      return lower;
    }
    return null;
  }

  // For rel attribute — allow safe values
  if (attrName === 'rel') {
    const safeRels = ['alternate', 'author', 'bookmark', 'help', 'license', 'next', 'nofollow', 'noopener', 'noreferrer', 'prefetch', 'prev', 'search', 'tag', 'sponsored', 'ugc'];
    const parts = value.toLowerCase().split(/\s+/).filter(p => safeRels.includes(p));
    return parts.length > 0 ? parts.join(' ') : null;
  }

  // For boolean attributes — return empty string (presence = true)
  const booleanAttrs = new Set(['controls', 'muted', 'loop', 'autoplay', 'playsinline', 'allowfullscreen', 'default', 'open', 'hidden', 'ismap', 'noshade', 'reversed', 'crossorigin', 'async', 'defer', 'disabled', 'checked', 'selected', 'readonly', 'multiple', 'required', 'autofocus', 'novalidate', 'formnovalidate', 'download']);
  if (booleanAttrs.has(attrName)) {
    return '';
  }

  // Default — return value as-is (already parsed from quoted attribute)
  return value;
}

/**
 * Rebuilds a tag with sanitized attributes.
 * @param {string} tagName - The tag name (lowercase).
 * @param {string} attrsStr - The raw attribute string.
 * @param {boolean} isClosing - Whether this is a closing tag.
 * @param {boolean} isSelfClosing - Whether this is a self-closing tag.
 * @returns {string} The sanitized tag string.
 */
function sanitizeTag(tagName, attrsStr, isClosing, isSelfClosing) {
  tagName = tagName.toLowerCase();

  // Closing tags have no attributes
  if (isClosing) {
    return `</${tagName}>`;
  }

  // Parse and sanitize attributes
  const attrs = parseAttributes(attrsStr);
  const keptAttrs = [];

  for (const attr of attrs) {
    if (!isAllowedAttr(tagName, attr.name)) {
      continue;
    }
    const sanitizedValue = sanitizeAttrValue(tagName, attr.name, attr.value);
    if (sanitizedValue === null) {
      // Boolean attribute with no value — include as boolean
      if (attr.value === null) {
        keptAttrs.push(` ${attr.name}`);
      }
      // Value was sanitized to null — skip
      continue;
    }
    // Escape quotes in value
    const escapedValue = sanitizedValue.replace(/"/g, '&quot;');
    keptAttrs.push(` ${attr.name}="${escapedValue}"`);
  }

  const selfClose = isSelfClosing ? ' /' : '';
  return `<${tagName}${keptAttrs.join('')}${selfClose}>`;
}

// ── Dangerous tag removal ───────────────────────────
/**
 * Removes dangerous tags and their content from HTML.
 * These tags are stripped entirely — content is NOT preserved.
 * @param {string} html - The HTML string to clean.
 * @returns {string} HTML with dangerous tags removed.
 */
function stripDangerousTags(html) {
  let result = html;

  // Remove properly closed dangerous tags WITH content
  for (const tag of STRIP_CONTENT_TAGS) {
    // Match <tag ...>...</tag> (case-insensitive)
    const openCloseRegex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    result = result.replace(openCloseRegex, '');

    // Remove unclosed opening tags (just the tag, not following content)
    const openOnlyRegex = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    result = result.replace(openOnlyRegex, '');

    // Remove orphaned closing tags
    const closeOnlyRegex = new RegExp(`<\\/${tag}>`, 'gi');
    result = result.replace(closeOnlyRegex, '');
  }

  return result;
}

// ── Comment and CDATA removal ─────────────────────────
/**
 * Removes HTML comments and CDATA sections.
 * Comments can contain IE conditional comments that execute scripts.
 * @param {string} html - The HTML string to clean.
 * @returns {string} HTML with comments and CDATA removed.
 */
function stripCommentsAndCdata(html) {
  let result = html;

  // Remove HTML comments (including IE conditional comments)
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // Remove CDATA sections
  result = result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  // Remove processing instructions (<?xml ... ?>, <?php ... ?>)
  result = result.replace(/<\?[\s\S]*?\?>/g, '');

  // Remove DOCTYPE declarations
  result = result.replace(/<!DOCTYPE[^>]*>/gi, '');

  return result;
}

// ── Tag processing ────────────────────────────────────
/**
 * Processes all HTML tags in the string.
 * - Allowed tags: kept with sanitized attributes.
 * - Unknown tags: unwrapped (tag removed, content preserved).
 * @param {string} html - The HTML string to process.
 * @returns {string} HTML with all tags processed.
 */
function processTags(html) {
  // This regex matches any HTML tag: <tag ...>, </tag>, <tag ... />
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (match, slash, tagName, attrsStr) => {
    tagName = tagName.toLowerCase();

    // Check if this is a self-closing tag (ends with /)
    const isSelfClosing = /\/\s*$/.test(attrsStr);
    // Remove the trailing / from attrsStr for parsing
    const cleanAttrsStr = isSelfClosing ? attrsStr.replace(/\/\s*$/, '') : attrsStr;

    const isClosing = slash === '/';

    // If tag is in the allowed list, sanitize and keep it
    if (ALLOWED_TAGS.has(tagName)) {
      return sanitizeTag(tagName, cleanAttrsStr, isClosing, isSelfClosing && !isClosing);
    }

    // If tag is not in any list, unwrap it (remove tag, keep content)
    // For unknown tags, just remove the tag markers
    return '';
  });
}

// ── Main sanitization function ───────────────────────
/**
 * Sanitizes an HTML string to prevent XSS attacks.
 *
 * - Removes all script, style, object, embed, and other dangerous tags (with content)
 * - Removes HTML comments, CDATA sections, and processing instructions
 * - Keeps only whitelisted tags with whitelisted attributes
 * - Strips all event handler attributes (onclick, onload, etc.)
 * - Sanitizes URL attributes to block javascript:, vbscript:, and unsafe data: URLs
 * - Sanitizes style attributes to strip dangerous CSS patterns
 * - Unwraps unknown tags (removes tag but preserves text content)
 *
 * The function is idempotent — already-sanitized HTML passes through unchanged.
 *
 * @param {string} html - The HTML string to sanitize.
 * @returns {string} The sanitized HTML string.
 */
function sanitizeHtml(html) {
  if (typeof html !== 'string') return '';
  if (html === '') return '';

  let result = html;

  // Step 1: Remove comments, CDATA, processing instructions, DOCTYPE
  result = stripCommentsAndCdata(result);

  // Step 2: Remove dangerous tags and their content
  result = stripDangerousTags(result);

  // Step 3: Process all remaining tags (allow, unwrap, or sanitize)
  result = processTags(result);

  // Step 4: Clean up any remaining artifacts
  // Remove empty attribute values that might cause issues
  result = result.replace(/\s*=\s*""/g, '');

  // Remove any remaining null bytes
  result = result.replace(/\x00/g, '');

  return result;
}

// ── Exports ───────────────────────────────────────────
export { sanitizeHtml, sanitizeUrl, sanitizeStyle, escapeHtml };
