// =====================================================
// AI COMMANDS (shortcuts)
// A command is just a faster, deterministic way to produce
// the SAME normalized intent shape intent.js's NL parser
// produces -- it is not a second pipeline. Once built, a
// command's intent goes through the exact same
// resolveAction -> executeRead / buildWritePreview path as
// a natural-language message. A command can never execute a
// write directly; create/update/delete commands still only
// ever produce a preview, same as typing it in English.
//
// The registry is GENERATED from schema.js on every call,
// never hand-maintained -- so a resource that's
// non-deletable (supportsDelete:false) simply has no
// lu-delete-<resource> command at all, rather than having
// one that exists and then gets rejected. Add a resource to
// resources.js and its commands exist automatically; nothing
// here needs updating.
// =====================================================

import { listResourceKeys, getSchema, describeResource } from "./schema.js";

export function buildCommandRegistry() {
  const commands = {};

  for (const resourceKey of listResourceKeys()) {
    const config = getSchema(resourceKey);

    commands[`lu-list-${resourceKey}`] = {
      resource: resourceKey,
      operation: "read",
      requiresId: false,
      description: `List ${config.label}`
    };
    commands[`lu-get-${resourceKey}`] = {
      resource: resourceKey,
      operation: "read",
      requiresId: true,
      description: `Get one ${config.label} record by id`
    };
    commands[`lu-schema-${resourceKey}`] = {
      resource: resourceKey,
      operation: "schema",
      requiresId: false,
      description: `Show the fields ${config.label} has`
    };
    if (config.supportsCreate) {
      commands[`lu-create-${resourceKey}`] = {
        resource: resourceKey,
        operation: "create",
        requiresId: false,
        description: `Create a new ${config.label} record`
      };
    }
    commands[`lu-update-${resourceKey}`] = {
      resource: resourceKey,
      operation: "update",
      requiresId: true,
      description: `Change fields on one ${config.label} record`
    };
    if (config.supportsDelete) {
      commands[`lu-delete-${resourceKey}`] = {
        resource: resourceKey,
        operation: "delete",
        requiresId: true,
        description: `Delete one ${config.label} record (destructive -- still requires confirmation)`
      };
    }
  }

  return commands;
}

/**
 * Hand-rolled on purpose instead of a regex split: needs to support
 * `key="a value with spaces"` and `key='...'` as well as bare
 * `key=value`, which a naive `\S+`-based split cannot do correctly
 * once a quoted value contains a space.
 */
export function parseArgs(rest) {
  const args = {};
  let positional = null;
  const s = rest || "";
  const n = s.length;
  let i = 0;

  const isSpace = (c) => c === " " || c === "\t";

  while (i < n) {
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) break;

    const wordStart = i;
    while (i < n && s[i] !== "=" && !isSpace(s[i])) i++;
    const word = s.slice(wordStart, i);

    if (i < n && s[i] === "=") {
      i++; // consume '='
      let value;
      if (s[i] === '"' || s[i] === "'") {
        const quote = s[i];
        i++;
        const valStart = i;
        while (i < n && s[i] !== quote) i++;
        value = s.slice(valStart, i);
        if (i < n) i++; // consume closing quote
      } else {
        const valStart = i;
        while (i < n && !isSpace(s[i])) i++;
        value = s.slice(valStart, i);
      }
      if (word) args[word] = value;
    } else if (word && /:$/.test(word) && word.length > 1) {
      // "key: value" alias for "key=value". Phone keyboards autocorrect
      // "id=1" into "I'd: 1", so normalize that spelling back to "id".
      let key = word.slice(0, -1).toLowerCase().replace(/[\u2019`]/g, "'");
      if (key === "i'd") key = "id";
      while (i < n && isSpace(s[i])) i++;
      let value;
      if (s[i] === '"' || s[i] === "'") {
        const quote = s[i];
        i++;
        const valStart = i;
        while (i < n && s[i] !== quote) i++;
        value = s.slice(valStart, i);
        if (i < n) i++;
      } else {
        const valStart = i;
        while (i < n && !isSpace(s[i])) i++;
        value = s.slice(valStart, i);
      }
      if (key && value !== "") args[key] = value;
    } else if (word && positional === null) {
      positional = word;
    }
  }

  return { args, positional };
}

/** @returns {{name, args, positional} | null} null if the message isn't a command at all. */
export function parseCommandLine(message) {
  const trimmed = String(message || "").trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1);
  const { args, positional } = parseArgs(rest);

  return { name, args, positional, rest };
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function fuzzyMatchCommand(name, knownNames) {
  let best = null;
  let bestDist = Infinity;
  for (const candidate of knownNames) {
    const dist = levenshtein(name, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  // A generous-but-bounded threshold: enough to catch a typo like
  // "lu-cretae-casino", not so loose it suggests something unrelated
  // for a genuinely different word.
  return bestDist <= 3 ? best : null;
}

/**
 * Turns a resolved command entry + raw args into the SAME intent
 * shape intent.js's normalizeIntent produces. tenant=/id= are
 * pulled out as the recognized tenantHint/recordId; everything else
 * becomes filters (read) or fields (create/update) -- exactly the
 * fields the AI would have put there from natural language.
 */
export function buildIntentFromCommand(entry, argsIn, positional) {
  const args = { ...argsIn };
  const tenantHint = args.tenant || null;
  delete args.tenant;

  let recordId = args.id != null ? String(args.id) : null;
  delete args.id;
  if (entry.requiresId && !recordId && positional) {
    recordId = String(positional);
  }

  if (entry.requiresId && !recordId) {
    return {
      operation: entry.operation,
      resource: entry.resource,
      tenantHint,
      recordId: null,
      filters: {},
      fields: {},
      requestedFields: [],
      clarificationNeeded: `Which ${entry.resource} record? Give an id, e.g. "id=123" or just the id right after the command.`
    };
  }

  if (entry.operation === "read") {
    return { operation: "read", resource: entry.resource, tenantHint, recordId, filters: args, fields: {}, requestedFields: [], clarificationNeeded: null };
  }
  if (entry.operation === "schema") {
    return { operation: "schema", resource: entry.resource, tenantHint, recordId: null, filters: {}, fields: {}, requestedFields: [], clarificationNeeded: null };
  }
  // create / update / delete
  return { operation: entry.operation, resource: entry.resource, tenantHint, recordId, filters: {}, fields: args, requestedFields: [], clarificationNeeded: null };
}

/**
 * @returns {{intent} | {isUnknown:true, suggestion} } — never throws,
 * never resolves to a resource/operation the registry doesn't
 * actually contain.
 */
export function resolveCommandIntent(name, args, positional) {
  const registry = buildCommandRegistry();
  const entry = registry[name];
  if (!entry) {
    return { isUnknown: true, suggestion: fuzzyMatchCommand(name, Object.keys(registry)) };
  }
  return { intent: buildIntentFromCommand(entry, args, positional) };
}

export function renderHelp(topic) {
  const registry = buildCommandRegistry();

  if (!topic) {
    const byResource = {};
    for (const [name, entry] of Object.entries(registry)) {
      (byResource[entry.resource] ||= []).push(name);
    }
    const lines = ["Shortcut commands — use \"/help <command>\" for details on one:", ""];
    for (const resourceKey of Object.keys(byResource).sort()) {
      lines.push(`${resourceKey}: ${byResource[resourceKey].sort().join(", ")}`);
    }
    lines.push(
      "",
      "General:",
      "  /help                      this list",
      "  /help <command>            fields/example for one command",
      "  /lu-agent <goal>           bounded think/search/act mode (still previews any write)",
      "",
      'Add tenant=<name> to any command to target a tenant other than the active one:',
      "  /lu-list-casinos tenant=freewin.xyz country=Rwanda"
    );
    return lines.join("\n");
  }

  const key = topic.replace(/^\//, "");
  const entry = registry[key];
  if (!entry) {
    const suggestion = fuzzyMatchCommand(key, Object.keys(registry));
    return suggestion
      ? `No such command: /${key}. Did you mean /${suggestion}? Try /help for the full list.`
      : `No such command: /${key}. Try /help for the full list.`;
  }

  const schema = describeResource(entry.resource);
  const fieldLines = schema.fields
    .map((f) => `  ${f.name} (${f.type}${f.required ? ", required" : ""}${f.lockOnEdit ? ", locked after create" : ""})`)
    .join("\n");
  const exampleArgs = [entry.requiresId ? "id=123" : null, "tenant=<name>"].filter(Boolean).join(" ");

  return `/${key} — ${entry.description}\n\nFields:\n${fieldLines}\n\nExample: /${key} ${exampleArgs} ...`;
}
