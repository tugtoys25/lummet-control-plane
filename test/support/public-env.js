// test/support/public-env.js
// Builds an env for the public site tests: the REAL migrations (incl. the
// 0007 seed) in an in-memory DB, and an ASSETS binding that serves the
// real files from /public, exactly like Workers Assets does in production.
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, applyMigrations } from './d1-shim.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html' };

export function createAssets() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
      try {
        const body = await readFile(join(PUBLIC_DIR, rel));
        const ext = rel.slice(rel.lastIndexOf('.'));
        return new Response(body, { status: 200, headers: { 'content-type': TYPES[ext] || 'application/octet-stream' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
  };
}

export function createPublicEnv({ contactEmail = 'hello@example.test' } = {}) {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: contactEmail, db };
}

export async function get(handle, env, path, init = {}) {
  const request = new Request(`https://lummet.test${path}`, { method: 'GET', ...init });
  const res = await handle({ request, env, ctx: { waitUntil() {} } });
  return res;
}

/** POST a urlencoded form to the public router. Returns the Response. */
export async function post(handle, env, path, fields = {}, { headers = {}, ctx } = {}) {
  const body = new URLSearchParams(fields).toString();
  const request = new Request(`https://lummet.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://lummet.test', ...headers },
    body
  });
  return handle({ request, env, ctx: ctx || { waitUntil() {} } });
}
