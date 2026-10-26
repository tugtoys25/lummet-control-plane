#!/usr/bin/env node
/** Structural validator for the OpenAPI 3.1 document served at /openapi.json (no network, no dependencies).
 *  Checks: version, info, unique operationIds, every $ref resolves, every {path} parameter is declared, every operation
 *  has responses, security schemes exist, webhook operations are well formed. Usage: node scripts/validate-openapi.mjs */
import { fileURLToPath } from "node:url";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function validateOpenApi(spec) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!spec || typeof spec !== "object") return ["document is not an object"];
  if (!/^3\.1\.\d+$/.test(String(spec.openapi))) bad("openapi must be 3.1.x");
  if (!spec.info || !spec.info.title || !spec.info.version) bad("info.title and info.version are required");
  if (!spec.paths || typeof spec.paths !== "object" || !Object.keys(spec.paths).length) bad("paths must not be empty");
  const resolve = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
    return ref.slice(2).split("/").reduce((node, key) => (node && typeof node === "object" ? node[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), spec);
  };
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string" && resolve(node.$ref) === undefined) bad(`${where}: unresolved $ref ${node.$ref}`);
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  walk(spec, "#");
  const ids = new Set();
  const schemes = Object.keys(spec.components?.securitySchemes || {});
  const checkOp = (op, where, path) => {
    if (!op.operationId) bad(`${where}: operationId missing`);
    else if (ids.has(op.operationId)) bad(`${where}: duplicate operationId ${op.operationId}`);
    else ids.add(op.operationId);
    if (!op.responses || !Object.keys(op.responses).length) bad(`${where}: responses missing`);
    for (const req of op.security || []) for (const name of Object.keys(req)) if (!schemes.includes(name)) bad(`${where}: unknown security scheme ${name}`);
    if (path) {
      const declared = new Set((op.parameters || []).filter((p) => p.in === "path").map((p) => p.name));
      for (const m of path.matchAll(/\{([^}]+)\}/g)) if (!declared.has(m[1])) bad(`${where}: path parameter {${m[1]}} is not declared`);
      for (const p of op.parameters || []) if (p.in === "path" && p.required !== true) bad(`${where}: path parameter ${p.name} must be required`);
    }
  };
  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!path.startsWith("/")) bad(`path ${path} must start with /`);
    for (const m of METHODS) if (item[m]) checkOp(item[m], `${m.toUpperCase()} ${path}`, path);
  }
  for (const [name, item] of Object.entries(spec.webhooks || {})) for (const m of METHODS) if (item[m]) checkOp(item[m], `webhook ${name} ${m}`, null);
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { buildOpenApiSpec } = await import("../worker/public-site/openapi.js");
  const errors = validateOpenApi(buildOpenApiSpec());
  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log("OpenAPI document is structurally valid.");
}
