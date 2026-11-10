import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicRoute } from "../worker/public-site/router.js";
import { createPublicEnv } from "./support/public-env.js";
import { SECTION_STYLE_OPTIONS, sectionStyleClasses } from "../worker/public-site/section-style.js";
import { CMS_RESOURCES } from "../worker/cms-resources.js";

async function home(env) {
  const res = await handlePublicRoute({ request: new Request("https://lummet.test/"), env, ctx: { waitUntil() {} } });
  return res.text();
}
const section = (html, key) => html.match(new RegExp(`<section class="[^"]*" id="${key}"`))?.[0] || "";

test("section style: all-default rows add no classes, so existing sections render exactly as before", () => {
  assert.equal(sectionStyleClasses({}), "");
  assert.equal(sectionStyleClasses({ heading_font: "default", text_align: "default", grid_columns: "default" }), "");
});

test("section style: only listed values become classes; anything else is ignored", () => {
  assert.equal(sectionStyleClasses({ heading_font: "serif", text_align: "center", content_width: "narrow", spacing: "compact", grid_columns: "4", body_font: "mono" }),
    " sec-hfont-serif sec-bfont-mono sec-align-center sec-width-narrow sec-space-compact sec-cols-4");
  assert.equal(sectionStyleClasses({ heading_font: 'x" onload="1', grid_columns: "99", spacing: "<b>", text_align: null }), "");
});

test("section style: CMS offers exactly the options the renderer accepts, defaulting to default", () => {
  for (const [field, { values }] of Object.entries(SECTION_STYLE_OPTIONS)) {
    const f = CMS_RESOURCES.homepage_sections.fields.find((x) => x.name === field);
    assert.ok(f, `CMS field ${field}`);
    assert.deepEqual(f.options, values, `${field} options match the renderer`);
    assert.equal(f.default, "default");
  }
});

test("section style: the migration gives every existing section the default", async () => {
  const env = createPublicEnv();
  const { results } = await env.db.prepare("SELECT heading_font, body_font, text_align, content_width, spacing, grid_columns FROM lummet_homepage_sections").all();
  assert.ok(results.length > 5);
  for (const r of results) for (const v of Object.values(r)) assert.equal(v, "default");
});

test("section style: classes reach the page, and a section left on default is unchanged", async () => {
  const env = createPublicEnv();
  const before = await home(env);
  const key = (await env.db.prepare("SELECT section_key FROM lummet_homepage_sections WHERE kind = 'features' AND status = 'published' LIMIT 1").first()).section_key;
  const other = (await env.db.prepare("SELECT section_key FROM lummet_homepage_sections WHERE kind = 'checklist' AND status = 'published' LIMIT 1").first()).section_key;
  await env.db.prepare("UPDATE lummet_homepage_sections SET heading_font='serif', text_align='center', spacing='spacious', grid_columns='2', content_width='narrow' WHERE section_key = ?").bind(key).run();
  const after = await home(env);
  assert.match(section(after, key), /class="section bg-\w+ sec-hfont-serif sec-align-center sec-width-narrow sec-space-spacious sec-cols-2"/);
  assert.equal(section(after, other), section(before, other), "other sections are untouched");
});

test("section style: a hostile value in the database cannot reach the markup", async () => {
  const env = createPublicEnv();
  const key = (await env.db.prepare("SELECT section_key FROM lummet_homepage_sections WHERE kind = 'features' AND status = 'published' LIMIT 1").first()).section_key;
  await env.db.prepare("UPDATE lummet_homepage_sections SET heading_font = ?, grid_columns = ? WHERE section_key = ?").bind('x" onload="alert(1)', "<script>", key).run();
  const html = await home(env);
  assert.doesNotMatch(html, /onload="alert/);
  assert.doesNotMatch(section(html, key), /sec-/);
});
