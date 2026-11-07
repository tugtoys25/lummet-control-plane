// Tenant template releases and the template line of products and sites.
// (Repository: all SQL for tenant_template_releases, plus the products.template_line lookups.)
// A "line" is one application (casino = lummet-tenant, brokerage = luminousagents); see worker/template-lines.js.

export async function findByVersion(env, version) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenant_template_releases WHERE version = ?`).bind(version).first();
}

export async function findActive(env, line) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM tenant_template_releases WHERE status = 'active' AND template_line = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(line).first();
}

export async function list(env, line = null) {
  const where = line ? `WHERE template_line = ?` : ``;
  const stmt = env.LUMMET_DB.prepare(
    `SELECT id, version, template_line, migration_count, size_bytes, sha256, notes, status, created_by, created_at
       FROM tenant_template_releases ${where} ORDER BY created_at DESC, rowid DESC LIMIT 50`
  );
  return (await (line ? stmt.bind(line) : stmt).all()).results;
}

/** Inserts a release and makes it the line's only active one (the older active release stays, as a rollback target). */
export async function insertActive(env, { id, version, line, storageKey, migrationCount, sizeBytes, sha256, notes, createdBy }) {
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'superseded' WHERE status = 'active' AND template_line = ?`).bind(line).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenant_template_releases (id, version, template_line, storage_key, migration_count, size_bytes, sha256, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, version, line, storageKey, migrationCount, sizeBytes, sha256, notes, createdBy).run();
}

/** Makes an existing release the line's active one (rollback). Returns false when the version is unknown. */
export async function activate(env, version) {
  const row = await findByVersion(env, version);
  if (!row) return null;
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'superseded' WHERE status = 'active' AND template_line = ?`).bind(row.template_line).run();
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'active' WHERE id = ?`).bind(row.id).run();
  return row;
}

/** The template line of the product a site runs. A missing site or product falls back to the default line. */
export async function lineOfSite(env, siteId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT p.template_line AS line FROM sites s JOIN products p ON p.id = s.product_id WHERE s.id = ?`
  ).bind(siteId).first();
  return row && row.line ? row.line : "casino";
}

export async function lineOfProduct(env, productId) {
  const row = await env.LUMMET_DB.prepare(`SELECT template_line AS line FROM products WHERE id = ?`).bind(productId).first();
  return row && row.line ? row.line : null;
}
