// =====================================================
// D1 SESSIONS (performance, release 2.6.0.16)
//
// Every page used to read the control-plane database from a single primary location, so a visitor far from it paid a long
// round trip PER query. With D1 read replication enabled on the database (see docs/PERFORMANCE.md), reads can be served by
// the nearest replica instead. The Sessions API is how a Worker uses replicas without ever reading stale data after its own
// write:
//
//   - a browser that has just written carries the "bookmark" of that write in a cookie; its next reads are served by a
//     replica that has caught up to it (sequential consistency per browser),
//   - anything that is not a GET/HEAD (writes, webhooks, form posts) starts on the primary,
//   - a first, anonymous read may use any replica.
//
// If replication is not enabled on the database, the same calls simply run on the primary, so this is safe to ship before
// the switch is flipped. D1_READ_SESSIONS=off restores the plain binding. The binding is wrapped, never replaced: every
// call site keeps using env.LUMMET_DB unchanged (prepare and batch go through the session; anything else, such as exec,
// goes to the database itself).
// =====================================================

const COOKIE = "lm_bm";
const MAX_AGE_SECONDS = 600;

export function d1SessionsEnabled(env) {
  return String(env?.D1_READ_SESSIONS || "on").toLowerCase() !== "off" && typeof env?.LUMMET_DB?.withSession === "function";
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// A bookmark is opaque, but it is also user-supplied input here (a cookie), so only a conservative shape is accepted.
const BOOKMARK_SHAPE = /^[A-Za-z0-9_.:-]{8,256}$/;

/** Returns { env, session }. session is null when sessions are not in use (env is then the original object). */
export function withD1Session(env, request) {
  if (!d1SessionsEnabled(env)) return { env, session: null, incoming: null };
  const method = request.method.toUpperCase();
  const safe = method === "GET" || method === "HEAD";
  const cookie = readCookie(request, COOKIE);
  const incoming = cookie && BOOKMARK_SHAPE.test(cookie) ? cookie : null;
  let session;
  try {
    session = env.LUMMET_DB.withSession(safe ? incoming || "first-unconstrained" : "first-primary");
  } catch (_) {
    return { env, session: null, incoming: null };
  }
  const base = env.LUMMET_DB;
  const db = {
    prepare: (sql) => session.prepare(sql),
    batch: (statements) => session.batch(statements),
    exec: (sql) => base.exec(sql),
    dump: () => base.dump(),
    withSession: (constraint) => base.withSession(constraint)
  };
  return { env: { ...env, LUMMET_DB: db }, session, incoming };
}

/** Adds the bookmark cookie when the database position moved, never to a response that a shared cache may keep. */
export function applyD1Bookmark(response, state) {
  try {
    if (!state || !state.session) return response;
    const bookmark = state.session.getBookmark && state.session.getBookmark();
    if (!bookmark || bookmark === state.incoming || !BOOKMARK_SHAPE.test(bookmark)) return response;
    const cacheControl = response.headers.get("Cache-Control") || "";
    if (/\bpublic\b/i.test(cacheControl)) return response;
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", `${COOKIE}=${bookmark}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (_) {
    return response;
  }
}
