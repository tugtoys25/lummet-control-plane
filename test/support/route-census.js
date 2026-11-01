// Route census for the organization API (round R.4).
// worker/index.js has no route table: organization routes are an if-chain that matches `subPath` inside the `if (orgMatch)` block.
// This reads that block as text and turns every `subPath === "..."` and `subPath.match(/regex/)` into concrete example paths
// (:id stands for any identifier). A new route written in either form is picked up automatically; a `subPath` use this file does
// not understand is reported in `unparsed`, and the isolation gate fails on it, so a new route style cannot slip past the matrix.
import { readFileSync } from 'node:fs';

const START = 'if (orgMatch) {';
const END = 'if (siteMatch && method === "GET")';

/** Expands the small regex dialect used by the routes ((a|b), (?:...)?, ([^/]+), (\d+)) into example paths. */
export function expandRegex(source) {
  let s = source.replace(/^\/\^/, '').replace(/\$\/$/, '');
  let i = 0;
  function seq(stop) {
    let variants = [''];
    while (i < s.length && !stop.includes(s[i])) {
      const c = s[i];
      let opts;
      if (c === '\\') {
        const n = s[i + 1]; i += 2;
        if (n === 'd' && s[i] === '+') { i += 1; opts = ['123']; } else opts = [n];
      } else if (c === '(') {
        i += 1;
        if (s[i] === '?' && s[i + 1] === ':') i += 2;
        const alts = [];
        for (;;) { alts.push(...seq('|)')); if (s[i] === '|') { i += 1; continue; } break; }
        i += 1;                                  // the closing )
        opts = alts;
      } else if (c === '[') {
        const end = s.indexOf(']', i); i = end + 1;
        if (s[i] === '+') i += 1;
        opts = [':id'];
      } else { i += 1; opts = [c]; }
      if (s[i] === '?') { i += 1; opts = ['', ...opts]; }
      variants = variants.flatMap((v) => opts.map((o) => v + o));
    }
    return variants;
  }
  return seq('');
}

/** Reads worker/index.js and returns { routes: [path], unparsed: [text] }. */
export function censusOrgRoutes(indexPath = new URL('../../worker/index.js', import.meta.url)) {
  const src = readFileSync(indexPath, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error('route-census: could not find the organization route block in worker/index.js');
  const block = src.slice(a, b);
  const routes = new Set();

  for (const m of block.matchAll(/subPath === "(\/[^"]*)"/g)) routes.add(m[1]);
  // The regex literal may sit on the line after `subPath.match(`.
  for (const m of block.matchAll(/subPath\.match\(\s*(\/\^(?:\\\/|[^\n])*?\$\/)\s*\)/g)) {
    for (const p of expandRegex(m[1])) routes.add(p);
  }
  // `/^...$/.test(subPath)` is the same idea written as a test.
  for (const m of block.matchAll(/(\/\^(?:\\\/|[^\n])*?\$\/)\.test\(subPath\)/g)) {
    for (const p of expandRegex(m[1])) routes.add(p);
  }

  // Every other use of subPath must be one we understand; anything else is reported.
  const known = [
    /subPath === "\/[^"]*"/g, /subPath\.match\(\s*\/\^(?:\\\/|[^\n])*?\$\/\s*\)/g, /subPath\.startsWith\("\/[^"]*"\)/g,
    /(\/\^(?:\\\/|[^\n])*?\$\/)\.test\(subPath\)/g, /evaluateWriteGate\(env, \{ organizationId, method, subPath,/g,
    /const subPath = orgMatch\[2\] \|\| "";/g, /SUSPENSION_GATE_EXEMPT\.has\(subPath\)/g, /subPath\.slice\(1\)\.replace\("-", "_"\)/g
  ];
  let rest = block;
  for (const k of known) rest = rest.replace(k, '');
  const unparsed = [];
  for (const line of rest.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');                 // a comment that mentions subPath is not a route
    if (/\bsubPath\b/.test(code) && !/^\s*(\*|\/\/)/.test(code)) unparsed.push(line.trim().slice(0, 160));
  }
  return { routes: [...routes].sort(), unparsed };
}

/** Which kind of resource sits behind each :id, by the path segment before it. */
export function resourceKindFor(path, index) {
  const parts = path.split('/').filter(Boolean);
  let seen = -1;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === ':id') { seen += 1; if (seen === index) return parts[i - 1] || 'unknown'; }
  }
  return 'unknown';
}
