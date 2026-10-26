// Pure helpers for the Logpush plan (no network, no env access). Used by the check script and the tests.
import { readFileSync } from "node:fs";

export const CONFIG_URL = new URL("../../config/logpush-policy.v1.json", import.meta.url);
export const loadConfig = () => JSON.parse(readFileSync(CONFIG_URL, "utf8"));

// Fields of the workers_trace_events dataset that may be requested. Anything else is refused, so a typo or a new
// field with unknown content cannot be shipped by accident.
export const ALLOWED_FIELDS = ["EventTimestampMs", "EventType", "Outcome", "ScriptName", "ScriptVersion", "Entrypoint", "CPUTimeMs", "WallTimeMs", "Truncated", "Exceptions", "Logs", "DispatchNamespace", "ScriptTags"];
// Fields that can carry URLs with tokens, headers, cookies or client addresses. Never requested.
export const FORBIDDEN_FIELDS = ["Event", "RequestHeaders", "ResponseHeaders", "Cookies", "ClientIP", "Request", "Response"];

// A destination that already contains a credential must not be committed (key=value secrets, user:pass@, signed URLs).
const SECRETISH = /(secret|token|password|passwd|signature|sig=|access[_-]?key|api[_-]?key|authorization)=|\/\/[^/\s:@]+:[^/\s@]+@|X-Amz-Signature/i;

/** Every string value in the config that still carries an [OPEN marker, as "path: text". */
export function openPlaceholders(node, trail = "") {
  if (typeof node === "string") return node.includes("[OPEN") ? [`${trail}: ${node}`] : [];
  if (Array.isArray(node)) return node.flatMap((value, index) => openPlaceholders(value, `${trail}[${index}]`));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([key, value]) => openPlaceholders(value, trail ? `${trail}.${key}` : key));
  return [];
}

/** Structural and safety checks on the config file itself. Returns a list of problems. */
export function validateConfig(config) {
  const errors = [];
  if (!config || config.version !== 1) errors.push("version must be 1");
  const job = config?.job;
  if (!job || typeof job !== "object") return [...errors, "job is missing"];
  if (job.dataset !== "workers_trace_events") errors.push("job.dataset must be workers_trace_events");
  if (!Array.isArray(job.fields) || !job.fields.length) errors.push("job.fields must list the requested fields (an allowlist, never \"all\")");
  for (const field of job.fields || []) {
    if (FORBIDDEN_FIELDS.includes(field)) errors.push(`job.fields requests ${field}, which can carry URLs with tokens, headers, cookies or client addresses`);
    else if (!ALLOWED_FIELDS.includes(field)) errors.push(`job.fields requests ${field}, which is not on the reviewed allowlist`);
  }
  for (const field of FORBIDDEN_FIELDS.slice(0, 5)) if (!(job.neverInclude || []).includes(field)) errors.push(`job.neverInclude must list ${field}`);
  if (job.enabled !== false) errors.push("job.enabled must stay false in the repository; the owner enables the job in Cloudflare");
  if (typeof job.destination !== "string" || SECRETISH.test(job.destination)) errors.push("job.destination must be a placeholder or a plain address with no credential in it");
  if (!(config.auditRows?.requires || []).includes("LOG_REDACTION=on")) errors.push("auditRows.requires must include LOG_REDACTION=on");
  return errors;
}

/** What the owner would create in Cloudflare. The destination is never echoed, only whether it is still a placeholder. */
export function renderPlan(config) {
  const job = config.job;
  return {
    job: { name: job.name, dataset: job.dataset, enabled: job.enabled, fields: job.fields, filter: { scriptName: job.scriptName }, sampleRate: job.sampleRate, retention: job.retention, destination: String(job.destination).includes("[OPEN") ? "[OPEN] not supplied" : "(supplied; not shown)" },
    workerSettings: { LOG_REDACTION: "on before the job is enabled", AUDIT_LOG_STREAM: "on only together with LOG_REDACTION=on" },
    auditRows: config.auditRows
  };
}
