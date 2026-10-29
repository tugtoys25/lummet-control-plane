import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { renderShell } from "../worker/views/layout.js";
import { SHELL_CSS_URL, PORTAL_CSS_URL, SHELL_JS_URL, serveShellAsset, isShellAssetPath } from "../worker/perf/shell-bundle.js";
import { withD1Session, applyD1Bookmark } from "../worker/perf/d1-session.js";
import { versionStaticUrls } from "../worker/public-site/render.js";
import { ASSET_VERSION } from "../worker/perf/asset-version.js";
import { getCurrentAdmin } from "../worker/auth.js";
import { getCurrentCustomer } from "../worker/customer-auth.js";
import { STYLES, CLIENT_SCRIPT } from "../worker/views/shell-assets.js";

const req = (path, init = {}) => new Request(`https://cp.test${path}`, init);

describe("hashed shell assets", () => {
  test("urls are content-hashed and recognised", () => {
    for (const u of [SHELL_CSS_URL, PORTAL_CSS_URL, SHELL_JS_URL]) {
      assert.match(u, /^\/_s\/(shell|portal)\.[0-9a-f]{8}\.(css|js)$/);
      assert.ok(isShellAssetPath(u));
    }
    assert.ok(!isShellAssetPath("/static/css/base.css"));
  });

  test("served immutable with an ETag, 304 on match, 404 for a stale name, no cookies", async () => {
    const res = serveShellAsset(req(SHELL_CSS_URL));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /max-age=31536000, immutable/);
    assert.match(res.headers.get("content-type"), /text\/css/);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(await res.text(), STYLES);
    const etag = res.headers.get("etag");
    const again = serveShellAsset(req(SHELL_CSS_URL, { headers: { "if-none-match": etag } }));
    assert.equal(again.status, 304);
    assert.equal(serveShellAsset(req("/_s/shell.00000000.css")).status, 404);
    assert.equal(serveShellAsset(req(SHELL_CSS_URL, { method: "POST" })).status, 404);
    assert.equal(await serveShellAsset(req(SHELL_JS_URL)).text(), CLIENT_SCRIPT);
  });
});

describe("page shell no longer inlines the bundle", () => {
  let env;
  beforeEach(async () => {
    const db = createTestDb();
    applyMigrations(db);
    env = { LUMMET_DB: db };
    await db.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`).run();
  });

  test("links the cached stylesheet and a nonce-bearing external script", async () => {
    const html = await renderShell({ title: "T", activeKey: "dashboard", admin: { id: 1, role: "super_admin", email: "a@test.local" }, bodyHtml: "<p>x</p>", env });
    assert.ok(html.includes(`href="${SHELL_CSS_URL}"`));
    assert.match(html, new RegExp(`<script nonce="lnt[0-9a-f]+" src="${SHELL_JS_URL.replace(/\./g, "\\.")}" defer></script>`));
    assert.ok(!html.includes(".nav-collapsed") || html.length < 40000, "bundle must not be inlined");
    assert.ok(!html.includes(STYLES.slice(0, 200)));
    assert.ok(!html.includes(CLIENT_SCRIPT.slice(0, 200)));
  });
});

describe("D1 sessions", () => {
  function fakeDb() {
    const calls = [];
    let bookmark = "bm-0000000001";
    const session = {
      prepare: (sql) => ({ sql, via: "session" }),
      batch: (s) => s,
      getBookmark: () => bookmark
    };
    return {
      calls,
      setBookmark: (b) => { bookmark = b; },
      db: {
        withSession: (c) => { calls.push(c); return session; },
        exec: () => "exec-on-base",
        dump: () => "dump-on-base",
        prepare: (sql) => ({ sql, via: "base" })
      }
    };
  }

  test("plain pass-through when the binding has no withSession or when switched off", () => {
    const env = { LUMMET_DB: { prepare() {} } };
    assert.equal(withD1Session(env, req("/dashboard")).env, env);
    const f = fakeDb();
    const off = { LUMMET_DB: f.db, D1_READ_SESSIONS: "off" };
    assert.equal(withD1Session(off, req("/dashboard")).env, off);
    assert.deepEqual(f.calls, []);
  });

  test("GET starts unconstrained, writes start on the primary, a bookmark cookie wins on reads", () => {
    const f = fakeDb();
    const env = { LUMMET_DB: f.db, OTHER: 1 };
    const a = withD1Session(env, req("/dashboard"));
    assert.equal(f.calls.at(-1), "first-unconstrained");
    assert.equal(a.env.OTHER, 1);
    assert.equal(a.env.LUMMET_DB.prepare("x").via, "session");
    assert.equal(a.env.LUMMET_DB.exec(), "exec-on-base");
    withD1Session(env, req("/api/x", { method: "POST" }));
    assert.equal(f.calls.at(-1), "first-primary");
    withD1Session(env, req("/dashboard", { headers: { cookie: "a=b; lm_bm=bm-abcdef123456; c=d" } }));
    assert.equal(f.calls.at(-1), "bm-abcdef123456");
    withD1Session(env, req("/dashboard", { headers: { cookie: "lm_bm=<script>" } }));
    assert.equal(f.calls.at(-1), "first-unconstrained", "a malformed bookmark is ignored");
  });

  test("bookmark cookie is set when it moved, never on shared-cacheable or unchanged responses", () => {
    const f = fakeDb();
    const state = withD1Session({ LUMMET_DB: f.db }, req("/dashboard"));
    const res = applyD1Bookmark(new Response("ok"), state);
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /^lm_bm=bm-0000000001; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    const pub = applyD1Bookmark(new Response("ok", { headers: { "cache-control": "public, max-age=30" } }), state);
    assert.equal(pub.headers.get("set-cookie"), null);
    const same = withD1Session({ LUMMET_DB: f.db }, req("/dashboard", { headers: { cookie: "lm_bm=bm-0000000001" } }));
    assert.equal(applyD1Bookmark(new Response("ok"), same).headers.get("set-cookie"), null);
    assert.equal(applyD1Bookmark(new Response("ok"), { session: null }).headers.get("set-cookie"), null);
  });
});

describe("public static urls", () => {
  test("css and js get the version token, images and external urls do not", () => {
    const out = versionStaticUrls(`<link href="/static/css/base.css"><script src="/static/js/nav.js" defer></script><link href="/static/images/favicon.svg"><a href="/static/css/x.css?v=9">`);
    assert.ok(out.includes(`/static/css/base.css?v=${ASSET_VERSION}"`));
    assert.ok(out.includes(`/static/js/nav.js?v=${ASSET_VERSION}"`));
    assert.ok(out.includes(`/static/images/favicon.svg"`));
    assert.ok(out.includes(`/static/css/x.css?v=9"`));
  });
});

describe("single-query session lookups keep every rule", () => {
  let env, queries;
  beforeEach(async () => {
    const db = createTestDb();
    applyMigrations(db);
    queries = [];
    const prepare = db.prepare.bind(db);
    env = { LUMMET_DB: { prepare: (sql) => { queries.push(sql); return prepare(sql); }, batch: db.batch?.bind(db), exec: db.exec?.bind(db) } };
    await db.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`).run();
    await db.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role, status) VALUES (2, 'off@test.local', 'x', 'admin', 'disabled')`).run();
    const future = new Date(Date.now() + 3600e3).toISOString();
    const past = new Date(Date.now() - 3600e3).toISOString();
    await db.prepare(`INSERT INTO lummet_sessions (id, admin_id, expires_at) VALUES ('good', 1, ?)`).bind(future).run();
    await db.prepare(`INSERT INTO lummet_sessions (id, admin_id, expires_at) VALUES ('old', 1, ?)`).bind(past).run();
    await db.prepare(`INSERT INTO lummet_sessions (id, admin_id, expires_at) VALUES ('dis', 2, ?)`).bind(future).run();
    await db.prepare(`INSERT INTO customer_users (id, email, password_hash, full_name) VALUES ('u1', 'c@test.local', 'x', 'Cee')`).run();
    await db.prepare(`INSERT INTO customer_users (id, email, password_hash, status) VALUES ('u2', 'd@test.local', 'x', 'disabled')`).run();
    await db.prepare(`INSERT INTO customer_sessions (id, user_id, expires_at) VALUES ('cgood', 'u1', ?)`).bind(future).run();
    await db.prepare(`INSERT INTO customer_sessions (id, user_id, expires_at) VALUES ('cold', 'u1', ?)`).bind(past).run();
    await db.prepare(`INSERT INTO customer_sessions (id, user_id, expires_at) VALUES ('cdis', 'u2', ?)`).bind(future).run();
    env.raw = db;
    queries.length = 0;
  });

  const staffReq = (id) => req("/dashboard", { headers: { cookie: `lummet_session=${id}` } });
  const custReq = (id) => req("/app/overview", { headers: { cookie: `lummet_customer_session=${id}` } });

  test("staff: valid session in ONE query with the same shape as before", async () => {
    const admin = await getCurrentAdmin(staffReq("good"), env);
    assert.equal(queries.length, 1);
    assert.equal(admin.id, 1);
    assert.equal(admin.email, "a@test.local");
    assert.equal(admin.role, "super_admin");
    assert.equal(admin.sessionId, "good");
    assert.equal(admin.activeTenantId, null);
    assert.ok("must_change_password" in admin && "two_factor_enabled" in admin && "status" in admin);
  });

  test("staff: unknown, expired and disabled-admin sessions are refused; the last two are deleted", async () => {
    assert.equal(await getCurrentAdmin(staffReq("nope"), env), null);
    assert.equal(await getCurrentAdmin(staffReq("old"), env), null);
    assert.equal(await getCurrentAdmin(staffReq("dis"), env), null);
    assert.equal(await getCurrentAdmin(req("/dashboard"), env), null);
    for (const id of ["old", "dis"]) assert.equal(await env.raw.prepare(`SELECT 1 FROM lummet_sessions WHERE id = ?`).bind(id).first(), null);
    assert.ok(await env.raw.prepare(`SELECT 1 FROM lummet_sessions WHERE id = 'good'`).first());
  });

  test("customer: valid session in one query (plus the policy check), same shape", async () => {
    const c = await getCurrentCustomer(custReq("cgood"), env);
    assert.equal(c.id, "u1");
    assert.equal(c.email, "c@test.local");
    assert.equal(c.full_name, "Cee");
    assert.equal(c.sessionId, "cgood");
    assert.equal(c.activeOrganizationId, null);
    assert.ok("email_verified_at" in c && "status" in c);
    assert.ok(!queries.some((q) => /FROM customer_users WHERE id/.test(q)), "no separate user read");
  });

  test("customer: unknown, expired and disabled-user sessions are refused; the last two are deleted", async () => {
    assert.equal(await getCurrentCustomer(custReq("nope"), env), null);
    assert.equal(await getCurrentCustomer(custReq("cold"), env), null);
    assert.equal(await getCurrentCustomer(custReq("cdis"), env), null);
    for (const id of ["cold", "cdis"]) assert.equal(await env.raw.prepare(`SELECT 1 FROM customer_sessions WHERE id = ?`).bind(id).first(), null);
  });
});

describe("static asset version guard", () => {
  test("the recorded css/js state matches the files and the ASSET_VERSION token", async () => {
    const { verify } = await import("../scripts/check-asset-version.mjs");
    const r = verify();
    assert.ok(r.ok, r.message);
  });
});
