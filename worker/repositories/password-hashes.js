// The only SQL that rewrites a stored password hash outside a password change (rehash on login, release 2.6.0.17).
// Each statement names its table literally: there is no table name taken from input.
export async function updateCustomerPasswordHash(env, userId, newHash) {
  await env.LUMMET_DB.prepare(`UPDATE customer_users SET password_hash = ? WHERE id = ?`).bind(newHash, userId).run();
}
export async function updateStaffPasswordHash(env, adminId, newHash) {
  await env.LUMMET_DB.prepare(`UPDATE lummet_admins SET password_hash = ? WHERE id = ?`).bind(newHash, adminId).run();
}
