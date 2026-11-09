#!/usr/bin/env node
// Real-browser audit for the blue / dark background bands on the public site.
//
//   node scripts/band-audit.mjs              audit every route x band x theme, exit 1 on any failure
//   node scripts/band-audit.mjs --shots DIR  also write a screenshot of every page it audits into DIR
//
// It renders the REAL pages (the same Worker code and migrations the tests use) in Chromium, forces every homepage section
// and every page header onto the blue band, then onto the dark band, in the light and the dark theme, and checks:
//   * text contrast of every visible text node against its composited background (4.5:1, or 3:1 for large text),
//   * the hover state of every button, chip and link inside a band,
//   * the keyboard focus outline of every focusable element inside a band (3:1 against the band, WCAG 1.4.11),
//   * typed text and placeholders in form fields inside a band.
// Playwright is not a dependency of the repo. CI installs it on demand (see .github/workflows/band-audit.yml);
// locally set PLAYWRIGHT_PATH to the playwright package directory if `import 'playwright'` does not resolve.
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handlePublicRoute } from "../worker/public-site/router.js";
import { createPublicEnv } from "../test/support/public-env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const pwEntry = process.env.PLAYWRIGHT_PATH ? pathToFileURL(join(process.env.PLAYWRIGHT_PATH, "index.mjs")).href : "playwright";
const { chromium } = await import(pwEntry).then((m) => (m.chromium ? m : m.default));

const ROUTES = ["/", "/pricing", "/brands", "/brands/cluster-casino", "/demo", "/security", "/p/enterprise", "/updates", "/insights", "/faq"];
const BANDS = ["blue", "dark"];
const THEMES = ["light", "dark"];
const MIME = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg" };

function makeEnv(band) {
  const env = createPublicEnv();
  const set = (k, v) => env.db.prepare("INSERT OR REPLACE INTO lummet_site_settings (key, value) VALUES (?, ?)").bind(k, v).run();
  return Promise.all([set("section_background", band), set("page_header_background", band)])
    .then(() => env.db.prepare("UPDATE lummet_homepage_sections SET background = 'default'").run())
    .then(() => env.db.prepare("UPDATE lummet_pages SET header_background = 'default'").run())
    .then(() => env);
}

// Runs inside the page. Returns a list of problems for this page state.
function auditInPage({ inBandOnly }) {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, b2) => (t * top.a + b2 * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // Background actually painted behind an element: composite every ancestor's background-color, nearest first.
  const backdrop = (el) => {
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage.includes("gradient") && n.tagName !== "SELECT") return null; // painted by a gradient: cannot be measured
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) acc = acc.a === 0 ? bg : over(acc, bg); // nearer layers sit on top of farther ones
      if (acc.a >= 0.999) break;
    }
    if (acc.a < 0.999) acc = over(acc, parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 });
    if (acc.a < 0.999) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
    return acc;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const bandOf = (el) => el.closest(".bg-blue, .bg-dark");
  const path = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && out.length < 4; n = n.parentElement) {
      out.push(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.classList.length ? "." + [...n.classList].slice(0, 2).join(".") : ""));
    }
    return out.join(" < ");
  };
  const problems = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.nodeValue.trim();
    const el = t.parentElement;
    if (!text || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    if (inBandOnly && !bandOf(el)) continue;
    if (!visible(el) || el.closest("[aria-hidden='true']") || el.closest(".brand-marquee")) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    const bg = backdrop(el);
    if (!fg0 || !bg) continue;
    const fg = over(fg0, bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need) problems.push({ kind: "text", ratio: +r.toFixed(2), need, text: text.slice(0, 48), at: path(el) });
  }
  return problems;
}

const failures = [];
const note = (f) => failures.push(f);
const browser = await chromium.launch();

for (const band of BANDS) {
  const env = await makeEnv(band);
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    await ctx.addInitScript((t) => { try { localStorage.setItem("lummet-theme", t); } catch {} document.documentElement.dataset.theme = t; }, theme);
    await ctx.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "lummet.test") return route.abort();
      if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/favicon")) {
        try {
          const body = readFileSync(join(ROOT, "public", normalize(decodeURIComponent(url.pathname))));
          return route.fulfill({ status: 200, body, contentType: MIME[extname(url.pathname)] || "application/octet-stream" });
        } catch { return route.fulfill({ status: 404, body: "" }); }
      }
      const res = await handlePublicRoute({ request: new Request(url.href, { method: "GET" }), env, ctx: { waitUntil() {} } });
      if (!res) return route.fulfill({ status: 404, body: "" });
      const headers = {}; res.headers.forEach((v, k) => { if (!/^(content-security-policy|content-length|content-encoding)/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    });
    const page = await ctx.newPage();
    for (const route of ROUTES) {
      const tag = `${route} [${band} band, ${theme} theme]`;
      const resp = await page.goto(`https://lummet.test${route}`, { waitUntil: "load" });
      if (!resp || resp.status() >= 400) { console.log(`skip ${tag}: HTTP ${resp ? resp.status() : "none"}`); continue; }
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important} .reveal{opacity:1!important;transform:none!important}" });
      const bands = await page.locator(".bg-blue, .bg-dark").count();
      if (!bands) { console.log(`skip ${tag}: no band on this page`); continue; }
      if (shotsDir) await page.screenshot({ path: join(shotsDir, `${route.replace(/\W+/g, "_") || "home"}-${band}-${theme}.png`), fullPage: true });

      // 1. text contrast, resting state
      for (const p of await page.evaluate(auditInPage, { inBandOnly: true })) note({ tag, ...p });

      // 2. hover and 3. focus on every interactive element inside a band
      const targets = await page.locator(":is(.bg-blue, .bg-dark) :is(a, button, .btn, .chip, summary, input, select, textarea)").elementHandles();
      let n = 0;
      for (const h of targets) {
        if (n++ >= 60) break;
        if (!(await h.isVisible())) continue;
        const info = await h.evaluate((el) => ({ label: (el.innerText || el.getAttribute("aria-label") || el.placeholder || el.tagName).trim().slice(0, 40), tag: el.tagName.toLowerCase() }));
        await h.scrollIntoViewIfNeeded();
        await h.hover({ force: true }).catch(() => {});
        const hover = await h.evaluate((el) => {
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
          const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
          let acc = { r: 0, g: 0, b: 0, a: 0 };
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg && bg.a > 0) acc = acc.a === 0 ? bg : over(acc, bg); if (acc.a >= 0.999) break; }
          if (acc.a < 0.999) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
          const fg = over(parse(getComputedStyle(el).color) || { r: 0, g: 0, b: 0, a: 1 }, acc);
          const hi = Math.max(lum(fg), lum(acc)), lo = Math.min(lum(fg), lum(acc));
          return (hi + 0.05) / (lo + 0.05);
        });
        if (info.tag !== "input" && info.tag !== "select" && info.tag !== "textarea" && hover < 4.5) note({ tag, kind: "hover", ratio: +hover.toFixed(2), need: 4.5, text: info.label, at: info.tag });
        await h.focus().catch(() => {});
        await page.keyboard.press("Shift+Tab").catch(() => {}); await page.keyboard.press("Tab").catch(() => {}); // enter :focus-visible
        const focus = await h.evaluate((el) => {
          if (document.activeElement !== el) return null;
          const cs = getComputedStyle(el);
          if (cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) === 0) return { none: true };
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
          const band = el.closest(".bg-blue, .bg-dark");
          let bgc = parse(getComputedStyle(band).backgroundColor);
          const oc = parse(cs.outlineColor);
          const hi = Math.max(lum(oc), lum(bgc)), lo = Math.min(lum(oc), lum(bgc));
          return { ratio: (hi + 0.05) / (lo + 0.05) };
        });
        if (focus && !focus.none && focus.ratio < 3) note({ tag, kind: "focus outline", ratio: +focus.ratio.toFixed(2), need: 3, text: info.label, at: info.tag });
        await page.mouse.move(0, 0);
      }

      // 4. typed text and placeholder in fields inside a band
      for (const f of await page.locator(":is(.bg-blue, .bg-dark) :is(input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select)").elementHandles()) {
        if (!(await f.isVisible())) continue;
        const res = await f.evaluate((el) => {
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
          const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
          let acc = { r: 0, g: 0, b: 0, a: 0 };
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg && bg.a > 0) acc = acc.a === 0 ? bg : over(acc, bg); if (acc.a >= 0.999) break; }
          if (acc.a < 0.999) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
          const c = (col) => { const f2 = over(col, acc); const hi = Math.max(lum(f2), lum(acc)), lo = Math.min(lum(f2), lum(acc)); return (hi + 0.05) / (lo + 0.05); };
          const typed = parse(getComputedStyle(el).color);
          const ph = el.placeholder ? parse(getComputedStyle(el, "::placeholder").color) : null;
          return { typed: c(typed), placeholder: ph ? c(ph) : null, name: el.name || el.type };
        });
        if (res.typed < 4.5) note({ tag, kind: "field text", ratio: +res.typed.toFixed(2), need: 4.5, text: res.name, at: "input" });
        if (res.placeholder !== null && res.placeholder < 4.5) note({ tag, kind: "placeholder", ratio: +res.placeholder.toFixed(2), need: 4.5, text: res.name, at: "input" });
      }
    }
    await ctx.close();
  }
}
await browser.close();

if (failures.length) {
  const byKey = new Map();
  for (const f of failures) { const k = `${f.kind} | ${f.at} | ${f.text}`; if (!byKey.has(k)) byKey.set(k, { ...f, where: new Set() }); byKey.get(k).where.add(f.tag); }
  console.log(`\n${byKey.size} distinct contrast problems (${failures.length} occurrences):\n`);
  for (const f of byKey.values()) console.log(`- ${f.kind} ${f.ratio}:1 (needs ${f.need}) "${f.text}"  ${f.at}\n    ${[...f.where].slice(0, 3).join("; ")}${f.where.size > 3 ? ` (+${f.where.size - 3} more)` : ""}`);
  process.exit(1);
}
console.log("band audit ok: every route x band x theme passes text, hover, focus and field contrast");
