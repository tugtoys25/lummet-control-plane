#!/usr/bin/env node
// Generates SQL that creates N load-test users, each with their own organization
// and an active subscription, plus one SHARED organization every user is an admin
// of (to measure write contention on a single organization). Also prints the
// matching cleanup SQL with --cleanup.
//
//   LOADTEST_PASSWORD='something-long' node scripts/loadtest-seed.mjs --users 50 > seed.sql
//   wrangler d1 execute <STAGING-DB> --remote --file seed.sql
//   ... run scripts/loadtest.mjs ...
//   node scripts/loadtest-seed.mjs --cleanup > cleanup.sql
//   wrangler d1 execute <STAGING-DB> --remote --file cleanup.sql
//
// Why SQL and not the signup API: signup/login are rate limited per IP, and a
// load test comes from one IP. Seeding directly keeps the limits switched ON,
// which is how production behaves.
//
// ONLY EVER RUN THIS AGAINST A STAGING DATABASE. Everything it creates uses
// @loadtest.invalid addresses and ids starting with lt-.
import { hashPassword } from "../worker/auth.js";

export const LT_DOMAIN = "loadtest.invalid";
export const emailFor = (i) => `lt-${i}@${LT_DOMAIN}`;
export const orgFor = (i) => `lt-org-${i}`;
export const SHARED_ORG = "lt-org-shared";

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

export async function buildSeedSql({ users, password, planId = "plan_casino_news_starter" }) {
  const hash = await hashPassword(password);          // one hash reused: the point is load, not unique salts
  const out = ["-- Load-test seed. Staging only. Cleanup: node scripts/loadtest-seed.mjs --cleanup"];
  out.push(`INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (${q(SHARED_ORG)}, 'Load test shared', ${q(SHARED_ORG)});`);
  out.push(`INSERT OR IGNORE INTO subscriptions (id, organization_id, plan_id, status, current_period_end) VALUES ('lt-sub-shared', ${q(SHARED_ORG)}, ${q(planId)}, 'active', '2099-01-01');`);
  for (let i = 0; i < users; i++) {
    const uid = `lt-user-${i}`;
    out.push(`INSERT OR IGNORE INTO customer_users (id, email, password_hash, full_name, email_verified_at) VALUES (${q(uid)}, ${q(emailFor(i))}, ${q(hash)}, 'Load Test ${i}', CURRENT_TIMESTAMP);`);
    out.push(`INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (${q(orgFor(i))}, 'Load test ${i}', ${q(orgFor(i))});`);
    out.push(`INSERT OR IGNORE INTO organization_users (organization_id, user_id, role) VALUES (${q(orgFor(i))}, ${q(uid)}, 'owner');`);
    out.push(`INSERT OR IGNORE INTO organization_users (organization_id, user_id, role) VALUES (${q(SHARED_ORG)}, ${q(uid)}, 'admin');`);
    out.push(`INSERT OR IGNORE INTO subscriptions (id, organization_id, plan_id, status, current_period_end) VALUES (${q("lt-sub-" + i)}, ${q(orgFor(i))}, ${q(planId)}, 'active', '2099-01-01');`);
  }
  return out.join("\n") + "\n";
}

export function buildCleanupSql() {
  return [
    "-- Removes everything the load test created (organizations cascade to their keys, webhooks and memberships).",
    "DELETE FROM organizations WHERE id LIKE 'lt-org-%';",
    `DELETE FROM customer_users WHERE email LIKE '%@${LT_DOMAIN}';`,
    ""
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes("--cleanup")) { process.stdout.write(buildCleanupSql()); process.exit(0); }
  const users = Number(args[args.indexOf("--users") + 1]) || 0;
  const password = process.env.LOADTEST_PASSWORD;
  if (!users || users < 1 || users > 2000 || !password || password.length < 12) {
    console.error("Usage: LOADTEST_PASSWORD='<12+ characters>' node scripts/loadtest-seed.mjs --users <1-2000> > seed.sql");
    process.exit(2);
  }
  process.stdout.write(await buildSeedSql({ users, password }));
}
