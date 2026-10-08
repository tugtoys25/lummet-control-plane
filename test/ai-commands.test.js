import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommandRegistry,
  parseArgs,
  parseCommandLine,
  fuzzyMatchCommand,
  buildIntentFromCommand,
  resolveCommandIntent,
  renderHelp
} from "../worker/ai/commands.js";
import { RESOURCES } from "../worker/resources.js";

describe("ai/commands.js buildCommandRegistry (generated from resources.js, never hand-maintained)", () => {
  const registry = buildCommandRegistry();

  test("every resource gets list/get/schema/update commands", () => {
    for (const key of Object.keys(RESOURCES)) {
      assert.ok(registry[`lu-list-${key}`], `missing lu-list-${key}`);
      assert.ok(registry[`lu-get-${key}`], `missing lu-get-${key}`);
      assert.ok(registry[`lu-schema-${key}`], `missing lu-schema-${key}`);
      assert.ok(registry[`lu-update-${key}`], `missing lu-update-${key}`);
    }
  });

  test("lu-delete-offers does NOT exist — offers is intentionally non-deletable", () => {
    assert.equal(RESOURCES.offers.supportsDelete, false);
    assert.equal(registry["lu-delete-offers"], undefined);
  });

  test("lu-create/-delete only exist where the resource actually supports it", () => {
    for (const [key, config] of Object.entries(RESOURCES)) {
      assert.equal(!!registry[`lu-create-${key}`], !!config.supportsCreate, `lu-create-${key} mismatch`);
      assert.equal(!!registry[`lu-delete-${key}`], !!config.supportsDelete, `lu-delete-${key} mismatch`);
    }
  });

  test("get/update/delete commands require an id; list/create/schema do not", () => {
    assert.equal(registry["lu-get-casinos"].requiresId, true);
    assert.equal(registry["lu-update-casinos"].requiresId, true);
    assert.equal(registry["lu-list-casinos"].requiresId, false);
    assert.equal(registry["lu-schema-casinos"].requiresId, false);
    if (registry["lu-create-casinos"]) assert.equal(registry["lu-create-casinos"].requiresId, false);
  });
});

describe("ai/commands.js parseArgs", () => {
  test("plain key=value pairs", () => {
    const { args, positional } = parseArgs("tenant=freewin.xyz rating=4.8");
    assert.deepEqual(args, { tenant: "freewin.xyz", rating: "4.8" });
    assert.equal(positional, null);
  });

  test("double-quoted value with spaces", () => {
    const { args } = parseArgs('name="New Casino" slug=new-casino');
    assert.equal(args.name, "New Casino");
    assert.equal(args.slug, "new-casino");
  });

  test("single-quoted value with spaces", () => {
    const { args } = parseArgs("bonus_title='Welcome Bonus' rating=4");
    assert.equal(args.bonus_title, "Welcome Bonus");
  });

  test("a bare token with no '=' is captured as the positional (id shorthand)", () => {
    const { args, positional } = parseArgs("123 tenant=freewin.xyz");
    assert.equal(positional, "123");
    assert.deepEqual(args, { tenant: "freewin.xyz" });
  });

  test('"key: value" works as an alias for key=value', () => {
    const { args } = parseArgs("id: 5 rating: 4.8");
    assert.deepEqual(args, { id: "5", rating: "4.8" });
  });

  test("phone-autocorrected \"I'd: 1\" is read as id=1", () => {
    assert.deepEqual(parseArgs("I'd: 1").args, { id: "1" });
    assert.deepEqual(parseArgs("I\u2019d: 1").args, { id: "1" });
  });

  test("a URL value after = is not mistaken for colon syntax", () => {
    const { args } = parseArgs("affiliate_url=https://example.com/x name=\"A B\"");
    assert.equal(args.affiliate_url, "https://example.com/x");
    assert.equal(args.name, "A B");
  });

  test("empty input yields no args and no positional", () => {
    const { args, positional } = parseArgs("");
    assert.deepEqual(args, {});
    assert.equal(positional, null);
  });
});

describe("ai/commands.js parseCommandLine", () => {
  test("returns null for an ordinary (non-command) message", () => {
    assert.equal(parseCommandLine("show me all casinos"), null);
  });

  test("parses a command name and lowercases it", () => {
    const cmd = parseCommandLine("/Lu-List-Casinos tenant=freewin.xyz");
    assert.equal(cmd.name, "lu-list-casinos");
    assert.deepEqual(cmd.args, { tenant: "freewin.xyz" });
  });

  test("a bare command with no args still parses", () => {
    const cmd = parseCommandLine("/help");
    assert.equal(cmd.name, "help");
    assert.equal(cmd.positional, null);
  });
});

describe("ai/commands.js fuzzyMatchCommand", () => {
  const names = Object.keys(buildCommandRegistry());

  test("catches a small typo", () => {
    assert.equal(fuzzyMatchCommand("lu-lst-casinos", names), "lu-list-casinos");
  });

  test("returns null for something too far off to guess safely", () => {
    assert.equal(fuzzyMatchCommand("completely-unrelated-xyz", names), null);
  });
});

describe("ai/commands.js buildIntentFromCommand", () => {
  const registry = buildCommandRegistry();

  test("read command: tenant/id pulled out, rest becomes filters", () => {
    const intent = buildIntentFromCommand(registry["lu-list-casinos"], { tenant: "freewin.xyz", country: "Rwanda" }, null);
    assert.equal(intent.operation, "read");
    assert.equal(intent.resource, "casinos");
    assert.equal(intent.tenantHint, "freewin.xyz");
    assert.deepEqual(intent.filters, { country: "Rwanda" });
  });

  test("update command: remaining args become fields, not filters", () => {
    const intent = buildIntentFromCommand(registry["lu-update-casinos"], { id: "123", rating: "4.8" }, null);
    assert.equal(intent.operation, "update");
    assert.equal(intent.recordId, "123");
    assert.deepEqual(intent.fields, { rating: "4.8" });
  });

  test("positional value fills in id when the command requires one and id= wasn't given", () => {
    const intent = buildIntentFromCommand(registry["lu-get-casinos"], {}, "123");
    assert.equal(intent.recordId, "123");
  });

  test("a requiresId command with neither id= nor a positional asks for clarification, not a guess", () => {
    const intent = buildIntentFromCommand(registry["lu-get-casinos"], {}, null);
    assert.equal(intent.recordId, null);
    assert.ok(intent.clarificationNeeded);
  });
});

describe("ai/commands.js resolveCommandIntent", () => {
  test("a real command resolves to an intent", () => {
    const result = resolveCommandIntent("lu-list-casinos", { tenant: "freewin.xyz" }, null);
    assert.ok(result.intent);
    assert.equal(result.intent.resource, "casinos");
  });

  test("an unknown command reports isUnknown with a suggestion when there is one", () => {
    const result = resolveCommandIntent("lu-lst-casinos", {}, null);
    assert.equal(result.isUnknown, true);
    assert.equal(result.suggestion, "lu-list-casinos");
  });
});

describe("ai/commands.js renderHelp", () => {
  test("bare /help lists every resource and the general commands", () => {
    const text = renderHelp(null);
    assert.match(text, /casinos:/);
    assert.match(text, /lu-agent/);
    assert.match(text, /tenant=<name>/);
  });

  test("/help <command> shows fields for that specific command", () => {
    const text = renderHelp("lu-create-casinos");
    assert.match(text, /Fields:/);
    assert.match(text, /slug/);
  });

  test("/help <unknown> suggests the closest real command", () => {
    const text = renderHelp("lu-creat-casinos");
    assert.match(text, /No such command/);
  });
});
