// Control-plane media library (migration 0096). All SQL for platform_media lives here.

const COLUMNS = "id, r2_key, filename, mime_type, size, width, height, alt_text, folder, sha256, uploaded_by, created_at, external_url";

export async function insert(env, row) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO platform_media (id, r2_key, filename, mime_type, size, width, height, alt_text, folder, sha256, uploaded_by, external_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.r2Key, row.filename, row.mimeType, row.size, row.width ?? null, row.height ?? null, row.altText || "", row.folder, row.sha256 ?? null, row.uploadedBy ?? null, row.externalUrl ?? null).run();
}

export async function getById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT ${COLUMNS} FROM platform_media WHERE id = ?`).bind(id).first();
}

export async function getByKey(env, r2Key) {
  return env.LUMMET_DB.prepare(`SELECT ${COLUMNS} FROM platform_media WHERE r2_key = ?`).bind(r2Key).first();
}

export async function getByExternalUrl(env, url) {
  return env.LUMMET_DB.prepare(`SELECT ${COLUMNS} FROM platform_media WHERE external_url = ?`).bind(url).first();
}

export async function findBySha(env, sha256, folder) {
  return env.LUMMET_DB.prepare(`SELECT ${COLUMNS} FROM platform_media WHERE sha256 = ? AND folder = ? ORDER BY created_at ASC LIMIT 1`).bind(sha256, folder).first();
}

/** Newest first. `search` matches file name and alt text; `mimes` narrows to those content types. */
export async function list(env, { folder = "", search = "", mimes = null, limit = 24, offset = 0 } = {}) {
  const where = [];
  const binds = [];
  if (folder) { where.push("folder = ?"); binds.push(folder); }
  if (search) {
    where.push("(filename LIKE ? ESCAPE '\\' OR alt_text LIKE ? ESCAPE '\\')");
    const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    binds.push(like, like);
  }
  if (Array.isArray(mimes) && mimes.length) {
    where.push(`mime_type IN (${mimes.map(() => "?").join(",")})`);
    binds.push(...mimes);
  }
  const sql = `SELECT ${COLUMNS} FROM platform_media ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  return (await env.LUMMET_DB.prepare(sql).bind(...binds, limit, offset).all()).results || [];
}

export async function count(env, { folder = "", search = "", mimes = null } = {}) {
  const where = [];
  const binds = [];
  if (folder) { where.push("folder = ?"); binds.push(folder); }
  if (search) {
    where.push("(filename LIKE ? ESCAPE '\\' OR alt_text LIKE ? ESCAPE '\\')");
    const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    binds.push(like, like);
  }
  if (Array.isArray(mimes) && mimes.length) {
    where.push(`mime_type IN (${mimes.map(() => "?").join(",")})`);
    binds.push(...mimes);
  }
  const row = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM platform_media ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).bind(...binds).first();
  return Number(row?.n || 0);
}

export async function listFolders(env) {
  return ((await env.LUMMET_DB.prepare("SELECT folder, COUNT(*) AS n FROM platform_media GROUP BY folder ORDER BY folder ASC").all()).results || []);
}

export async function updateMeta(env, id, { altText, folder }) {
  await env.LUMMET_DB.prepare("UPDATE platform_media SET alt_text = ?, folder = ? WHERE id = ?").bind(altText, folder, id).run();
}

export async function remove(env, id) {
  await env.LUMMET_DB.prepare("DELETE FROM platform_media WHERE id = ?").bind(id).run();
}
