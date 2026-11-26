// Advertisement sliders: settings, slides and per-slide statistics (tables from migration 0109). All SQL for them lives here.
const db = (env) => env.LUMMET_DB;
const parse = (s, d) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : d; } catch (_) { return d; } };

export async function adExists(env, id) {
  return Boolean(await db(env).prepare("SELECT 1 AS ok FROM lummet_advertisements WHERE id = ?").bind(id).first());
}

/** { settings, slides: [{ key, position, start_at, end_at, ...data }] } for one advertisement, slides in order. */
export async function loadSlider(env, adId) {
  const [s, r] = await db(env).batch([
    db(env).prepare("SELECT settings_json FROM lummet_ad_settings WHERE ad_id = ?").bind(adId),
    db(env).prepare("SELECT slide_key, position, data_json, start_at, end_at FROM lummet_ad_slides WHERE ad_id = ? ORDER BY position, id").bind(adId)
  ]);
  return { settings: parse(s.results?.[0]?.settings_json, {}), slides: (r.results || []).map(toSlide) };
}

export const toSlide = (row) => ({ ...parse(row.data_json, {}), key: row.slide_key, position: row.position, start_at: row.start_at || "", end_at: row.end_at || "" });

/** SQL fragments for the homepage's one-round-trip read: the slides and settings of the first live ad of a placement. */
export const SQL_LIVE_AD_SLIDES = `SELECT s.slide_key, s.position, s.data_json, s.start_at, s.end_at FROM lummet_ad_slides s
  WHERE s.ad_id = (SELECT id FROM lummet_advertisements WHERE placement = ? AND status = 'active' AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY sort_order LIMIT 1)
  ORDER BY s.position, s.id`;
export const SQL_LIVE_AD_SETTINGS = `SELECT t.settings_json FROM lummet_ad_settings t
  WHERE t.ad_id = (SELECT id FROM lummet_advertisements WHERE placement = ? AND status = 'active' AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY sort_order LIMIT 1)`;

/** Replace the settings and all slides of an advertisement in one atomic batch. Statistics are kept. */
export async function saveSlider(env, adId, settings, slides) {
  const stmts = [
    db(env).prepare(`INSERT INTO lummet_ad_settings (ad_id, settings_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ad_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = CURRENT_TIMESTAMP`).bind(adId, JSON.stringify(settings)),
    db(env).prepare("DELETE FROM lummet_ad_slides WHERE ad_id = ?").bind(adId),
    ...slides.map(({ key, start_at, end_at, ...data }, i) => db(env).prepare("INSERT INTO lummet_ad_slides (ad_id, slide_key, position, data_json, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(adId, key, i, JSON.stringify(data), start_at || null, end_at || null)),
    db(env).prepare("UPDATE lummet_advertisements SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(adId)
  ];
  await db(env).batch(stmts);
}

/** Active advertisement ids (for beacons) and the slide keys each has. */
export async function liveAdIds(env, ids) {
  if (!ids.length) return new Set();
  const { results } = await db(env).prepare(`SELECT id FROM lummet_advertisements WHERE status = 'active' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  return new Set((results || []).map((r) => r.id));
}
export async function slideKeys(env, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { results } = await db(env).prepare(`SELECT ad_id, slide_key FROM lummet_ad_slides WHERE ad_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  for (const r of results || []) { if (!out.has(r.ad_id)) out.set(r.ad_id, new Set()); out.get(r.ad_id).add(r.slide_key); }
  return out;
}

export async function addStats(env, adId, slideKey, day, views, clicks) {
  await db(env).prepare(`INSERT INTO lummet_ad_stats (ad_id, slide_key, day, views, clicks) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ad_id, slide_key, day) DO UPDATE SET views = views + excluded.views, clicks = clicks + excluded.clicks`).bind(adId, slideKey, day, views, clicks).run();
}

/** All-time totals: { total: {views, clicks}, slides: { [key]: {views, clicks} }, last7: {views, clicks} }. */
export async function statsFor(env, adId, since) {
  const [all, week] = await db(env).batch([
    db(env).prepare("SELECT slide_key, SUM(views) AS views, SUM(clicks) AS clicks FROM lummet_ad_stats WHERE ad_id = ? GROUP BY slide_key").bind(adId),
    db(env).prepare("SELECT SUM(views) AS views, SUM(clicks) AS clicks FROM lummet_ad_stats WHERE ad_id = ? AND slide_key = '' AND day >= ?").bind(adId, since)
  ]);
  const out = { total: { views: 0, clicks: 0 }, slides: {}, last7: { views: Number(week.results?.[0]?.views) || 0, clicks: Number(week.results?.[0]?.clicks) || 0 } };
  for (const r of all.results || []) { const v = { views: Number(r.views) || 0, clicks: Number(r.clicks) || 0 }; if (r.slide_key === "") out.total = v; else out.slides[r.slide_key] = v; }
  return out;
}

export async function purge(env, adId) {
  await db(env).batch([
    db(env).prepare("DELETE FROM lummet_ad_settings WHERE ad_id = ?").bind(adId),
    db(env).prepare("DELETE FROM lummet_ad_slides WHERE ad_id = ?").bind(adId),
    db(env).prepare("DELETE FROM lummet_ad_stats WHERE ad_id = ?").bind(adId)
  ]);
}
