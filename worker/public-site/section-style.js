// Per-section style options for homepage sections, next to the background colour (backgrounds.js).
// Each option is a fixed list; "default" (or anything not on the list) adds nothing, so the section keeps the site's look and a bad
// edit can never inject a class name or CSS. The CSS for every class below lives in public/static/css/components.css ("Section style options").
export const SECTION_STYLE_OPTIONS = {
  heading_font: { prefix: "sec-hfont", values: ["default", "serif", "mono"] },
  body_font: { prefix: "sec-bfont", values: ["default", "serif", "mono"] },
  text_align: { prefix: "sec-align", values: ["default", "center"] },
  content_width: { prefix: "sec-width", values: ["default", "narrow", "wide"] },
  spacing: { prefix: "sec-space", values: ["default", "compact", "spacious"] },
  grid_columns: { prefix: "sec-cols", values: ["default", "1", "2", "3", "4"] }
};

/** The extra class names for a section row, with a leading space (empty string when everything is on default). */
export function sectionStyleClasses(row) {
  let out = "";
  for (const [field, { prefix, values }] of Object.entries(SECTION_STYLE_OPTIONS)) {
    const v = String(row?.[field] ?? "default");
    if (v !== "default" && values.includes(v)) out += ` ${prefix}-${v}`;
  }
  return out;
}
