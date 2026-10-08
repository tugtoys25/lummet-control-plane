// =====================================================
// PUBLIC SITE TEMPLATE ENGINE
//
// A small, dependency-free template engine for the HTML files in
// public/templates/. Same look and feel as the tenant's engine
// ({{var}}, {{{raw}}}, {{#if}}), with three differences chosen for
// safety and for keeping markup out of JavaScript:
//
//   {{name}}         HTML-ESCAPED by default (the tenant's engine
//                    escapes only listed field names).
//   {{{name}}}       raw output. Only used for values that were
//                    sanitized or built by this codebase.
//   {{#if x}}..{{else}}..{{/if}}       nested, with optional else
//   {{#unless x}}..{{/unless}}
//   {{#each items}}..{{/each}}          loops; @index @first @last
//   {{> layout/header}}                 partials, loaded from assets
//
// Variable lookup walks the current context, then parent contexts,
// and supports dotted paths (brand.name). An empty array, empty
// string, 0, null, undefined and false are all falsy.
// =====================================================

const TOKEN_RE =
  /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*>\s*([\w./-]+)\s*\}\}|\{\{\s*(#if|#unless|#each)\s+([^}]+?)\s*\}\}|\{\{\s*(else|\/if|\/unless|\/each)\s*\}\}|\{\{\s*([^}#/>][^}]*?)\s*\}\}/g;

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -----------------------------------------------------
// Parse: template string -> AST
// -----------------------------------------------------

export function parse(source) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let last = 0;
  let match;
  TOKEN_RE.lastIndex = 0;

  const push = (node) => stack[stack.length - 1].children.push(node);
  const currentBranch = () => {
    const top = stack[stack.length - 1];
    return top.type === "if" || top.type === "unless" || top.type === "each"
      ? top.inElse ? top.elseChildren : top.children
      : top.children;
  };
  const add = (node) => currentBranch().push(node);

  while ((match = TOKEN_RE.exec(source))) {
    if (match.index > last) add({ type: "text", value: source.slice(last, match.index) });
    last = TOKEN_RE.lastIndex;

    const [, raw, partial, openKind, openArg, closeKind, variable] = match;
    if (raw !== undefined) {
      add({ type: "raw", path: raw.trim() });
    } else if (partial !== undefined) {
      add({ type: "text", value: "" }); // partials are expanded before parsing
    } else if (openKind) {
      const node = { type: openKind.slice(1), path: openArg.trim(), children: [], elseChildren: [], inElse: false };
      add(node);
      stack.push(node);
    } else if (closeKind === "else") {
      const top = stack[stack.length - 1];
      if (top.type !== "if" && top.type !== "unless" && top.type !== "each") {
        throw new Error("Template error: {{else}} outside a block");
      }
      top.inElse = true;
    } else if (closeKind) {
      const expected = closeKind.slice(1);
      const top = stack.pop();
      if (!top || top.type !== expected) {
        throw new Error(`Template error: unexpected {{${closeKind}}}`);
      }
    } else if (variable !== undefined) {
      add({ type: "var", path: variable.trim() });
    }
  }
  if (last < source.length) add({ type: "text", value: source.slice(last) });
  if (stack.length !== 1) throw new Error(`Template error: unclosed {{#${stack[stack.length - 1].type}}}`);
  return root;
}

// -----------------------------------------------------
// Render: AST + context stack -> string
// -----------------------------------------------------

function lookup(path, scopes) {
  if (path === "this") return scopes[scopes.length - 1].value;
  const meta = path.startsWith("@") ? path : null;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (meta) {
      if (scope.meta && meta in scope.meta) return scope.meta[meta];
      continue;
    }
    let cur = scope.value;
    let found = true;
    for (const key of path.split(".")) {
      if (cur !== null && typeof cur === "object" && key in cur) {
        cur = cur[key];
      } else {
        found = false;
        break;
      }
    }
    if (found) return cur;
  }
  return undefined;
}

function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderNodes(nodes, scopes) {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "var": {
        const v = lookup(node.path, scopes);
        out += escapeHtml(v);
        break;
      }
      case "raw": {
        const v = lookup(node.path, scopes);
        out += v === undefined || v === null ? "" : String(v);
        break;
      }
      case "if":
        out += renderNodes(truthy(lookup(node.path, scopes)) ? node.children : node.elseChildren, scopes);
        break;
      case "unless":
        out += renderNodes(truthy(lookup(node.path, scopes)) ? node.elseChildren : node.children, scopes);
        break;
      case "each": {
        const list = lookup(node.path, scopes);
        if (!Array.isArray(list) || list.length === 0) {
          out += renderNodes(node.elseChildren, scopes);
          break;
        }
        list.forEach((item, index) => {
          const scope = {
            value: item,
            meta: { "@index": index, "@number": index + 1, "@first": index === 0, "@last": index === list.length - 1 }
          };
          out += renderNodes(node.children, [...scopes, scope]);
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function renderSource(source, data = {}) {
  return renderNodes(parse(source).children, [{ value: data, meta: null }]);
}

// -----------------------------------------------------
// Loader: templates are static assets (public/templates/**),
// fetched through the ASSETS binding exactly like the tenant does.
// Partials ({{> path}}) are expanded textually before parsing.
// Templates only change on deploy, and a deploy restarts the
// isolate, so a module-level cache is safe.
// -----------------------------------------------------

const sourceCache = new Map();
const MAX_PARTIAL_DEPTH = 8;

async function fetchTemplateSource(env, name) {
  if (sourceCache.has(name)) return sourceCache.get(name);
  const promise = (async () => {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local/templates/${name}.html`));
    if (!res.ok) throw new Error(`Template not found: ${name}`);
    return res.text();
  })();
  sourceCache.set(name, promise);
  try {
    return await promise;
  } catch (err) {
    sourceCache.delete(name);
    throw err;
  }
}

async function expandPartials(env, source, depth = 0) {
  if (depth > MAX_PARTIAL_DEPTH) throw new Error("Template error: partials nested too deeply");
  const re = /\{\{\s*>\s*([\w./-]+)\s*\}\}/g;
  const names = [...new Set([...source.matchAll(re)].map((m) => m[1]))];
  if (!names.length) return source;
  const loaded = await Promise.all(
    names.map(async (n) => [n, await expandPartials(env, await fetchTemplateSource(env, n), depth + 1)])
  );
  const map = new Map(loaded);
  return source.replace(re, (_, n) => map.get(n));
}

const astCache = new Map();

export async function renderTemplate(env, name, data = {}) {
  let ast = astCache.get(name);
  if (!ast) {
    const expanded = await expandPartials(env, await fetchTemplateSource(env, name));
    ast = parse(expanded);
    astCache.set(name, ast);
  }
  return renderNodes(ast.children, [{ value: data, meta: null }]);
}

/** Test helper: forget cached templates so a test can swap assets. */
export function clearTemplateCache() {
  sourceCache.clear();
  astCache.clear();
}
