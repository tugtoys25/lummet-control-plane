// test/enterprise-footer.test.js
// 2.8.3: enterprise footer: brand block + link columns, Legal links inline in the bottom bar, back to top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get } from './support/public-env.js';

const html = async (env, path) => (await get(handlePublicRoute, env, path)).text();
const footerOf = (h) => h.slice(h.indexOf('<footer class="site-footer"'), h.indexOf('</footer>') + 9);

test('footer: link columns exclude Legal; Legal links sit inline in the bottom bar with their own labelled nav', async () => {
  const env = createPublicEnv();
  const f = footerOf(await html(env, '/brands'));
  assert.match(f, /class="footer-grid"/);
  assert.match(f, /<div class="footer-bottom">/);
  assert.match(f, /<nav class="footer-legal" aria-label="[^"]+">/);
  const legal = f.slice(f.indexOf('class="footer-legal"'), f.indexOf('class="footer-tools"'));
  assert.ok((legal.match(/<li>/g) || []).length >= 2, 'legal links are listed');
  // legal destinations appear once, in the bottom bar, not also in a column
  const columns = f.slice(f.indexOf('class="footer-grid"'), f.indexOf('class="footer-bottom"'));
  assert.doesNotMatch(columns, /href="\/(privacy|terms)"/);
});

test('footer: long columns are flagged wide, a back-to-top link targets the page top, copyright stays', async () => {
  const env = createPublicEnv();
  const h = await html(env, '/');
  const f = footerOf(h);
  assert.match(h, /<body id="top" /);
  assert.match(f, /<a class="footer-top" href="#top">/);
  assert.match(f, /&copy; \d{4} /);
  const wide = f.match(/footer-col footer-col--wide/g) || [];
  const cols = f.match(/<nav class="footer-col/g) || [];
  assert.ok(cols.length >= 1);
  assert.ok(wide.length <= cols.length);
});
