// Background choices for homepage sections and page header bands.
//   default = no band (sections) / inherit the site setting (pages)   soft = light grey   blue = solid brand blue   dark = near-black
// A value that is not one of these is treated as "default", so a bad edit can never inject a class name.
export const BACKGROUNDS = ["default", "soft", "blue", "dark"];

export function normalizeBg(value, fallback = "default") {
  return BACKGROUNDS.includes(value) ? value : fallback;
}

// A homepage section left on "default" follows the site-wide "Default section background" setting (itself "default" = no band).
export function sectionBg(rowBackground, siteDefault) {
  const own = normalizeBg(rowBackground);
  return own === "default" ? normalizeBg(siteDefault) : own;
}

// A page header band: the page's own choice, else the site-wide "Page header band" setting, else soft grey (the original look).
export function headerBg(pageBackground, siteSetting) {
  const own = normalizeBg(pageBackground);
  return own === "default" ? normalizeBg(siteSetting, "soft") : own;
}
