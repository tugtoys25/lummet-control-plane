// =====================================================
// PUBLIC SITE — link liveness
// A link must never lead to a page that would 404 or render empty.
// isLiveHref() answers "does this destination currently have
// published content?" from the same counts the pages themselves use.
// =====================================================

/** Pages served at a clean /<slug> URL (in addition to /p/<slug>). */
export const PAGE_ALIASES = new Set(["about", "security", "privacy", "terms"]);

/**
 * @param {string} href
 * @param {{counts: object, anchors?: Set<string>}} o
 *   anchors: section keys present on the homepage; when omitted, "#x" is assumed live.
 */
export function isLiveHref(href, { counts, anchors } = {}) {
  const h = String(href || "").trim();
  if (!h) return false;
  if (h.startsWith("#")) return anchors ? anchors.has(h.slice(1)) : true;
  if (/^(https?:|mailto:)/i.test(h)) return true;
  if (!h.startsWith("/")) return false;

  const [pathPart, hash] = h.split("#");
  const path = pathPart.split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/") return hash && anchors ? anchors.has(hash) : true;

  const byCount = { "/brands": counts.brands, "/updates": counts.updates, "/insights": counts.publications, "/partners": counts.partners };
  if (path in byCount) return byCount[path] > 0;
  if (path === "/contact" || path === "/demo") return counts.formKeys.has(path.slice(1));
  if (path.startsWith("/forms/")) return counts.formKeys.has(path.slice(7));
  if (path.startsWith("/p/")) return counts.pageSlugs.has(path.slice(3));
  const slug = path.slice(1);
  if (PAGE_ALIASES.has(slug)) return counts.pageSlugs.has(slug);
  return true; // other internal paths (e.g. /login) are not content-backed
}
