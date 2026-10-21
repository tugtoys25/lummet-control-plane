// Liveness probe (v7J). Answers only whether the database responds.
export async function ping(env) {
  await env.LUMMET_DB.prepare("SELECT 1 AS ok").first();
  return true;
}
