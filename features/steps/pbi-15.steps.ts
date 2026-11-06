import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();

type Folded = { ok: boolean; costUsd: number; limit: { resetsAt: number } | null; usage: { utilization: number; resetsAt: number | null } | null };
type Run = {
  foldMessages(msgs: AsyncIterable<object>): Promise<Folded>;
  agentOptions(a: { prompt: string; model: string; cwd: string; mode: "cell" | "judge"; signal: AbortSignal }): Record<string, unknown>;
};
type Ctx = { messages?: object[]; folded?: Folded | null; options?: Record<string, unknown> | null };

function ctx(world: object): Ctx {
  const w = world as { pbi15?: Ctx };
  w.pbi15 ??= {};
  return w.pbi15;
}

// Loaded lazily, so a missing module turns into a red Then instead of a crash of the whole run.
async function load(): Promise<Run | null> {
  const file = join(repo, "src/agent/run.ts");
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as Run) : null;
}

// SDK-shaped messages, with only the fields the runner reads plus the ones that identify them.
const ids = { uuid: "00000000-0000-0000-0000-000000000000", session_id: "s1" };

function modelUsage(table: DataTable): Record<string, object> {
  return Object.fromEntries(table.hashes().map((r) => [r.model, {
    inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: Number(r["cost in USD"]), contextWindow: 200_000,
  }]));
}

function result(subtype: string, isError: boolean, usage: Record<string, object>, text = "done"): object {
  return { type: "result", subtype, is_error: isError, result: text, errors: [], total_cost_usd: 0, modelUsage: usage,
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, permission_denials: [], ...ids };
}

function rateLimit(info: object): object {
  return { type: "rate_limit_event", rate_limit_info: info, ...ids };
}

Given("a run that succeeded after using these models:", function (table: DataTable) {
  ctx(this).messages = [result("success", false, modelUsage(table))];
});

Given("a run that stopped at its turn limit after using these models:", function (table: DataTable) {
  ctx(this).messages = [result("error_max_turns", true, modelUsage(table))];
});

Given("a run that hit a usage limit that resets at {int}, and then ended on the API's error", function (resetsAt: number) {
  ctx(this).messages = [
    rateLimit({ status: "rejected", resetsAt, rateLimitType: "five_hour" }),
    result("success", true, {}, "Claude AI usage limit reached"),
  ];
});

Given("a run that succeeded after a usage warning at {float} of the limit, which resets at {int}", function (utilization: number, resetsAt: number) {
  ctx(this).messages = [
    rateLimit({ status: "allowed_warning", utilization, resetsAt, rateLimitType: "five_hour" }),
    result("success", false, {}),
  ];
});

When("the factory reads the run's messages", async function () {
  const run = await load();
  const messages = ctx(this).messages ?? [];
  ctx(this).folded = run ? await run.foldMessages((async function* () { yield* messages; })()) : null;
});

function folded(world: object): Folded {
  const f = ctx(world).folded;
  assert.ok(f, "src/agent/run.ts doesn't export foldMessages yet");
  return f;
}

Then("the run is ok", function () {
  assert.equal(folded(this).ok, true);
});

Then("the run is not ok", function () {
  assert.equal(folded(this).ok, false);
});

Then("the run cost {float} USD", function (usd: number) {
  assert.equal(folded(this).costUsd, usd);
});

Then("the run stopped on a usage limit that resets at {int}", function (resetsAt: number) {
  assert.deepEqual(folded(this).limit, { resetsAt });
});

Then("the run didn't stop on a usage limit", function () {
  assert.equal(folded(this).limit, null);
});

Then("the run reports a utilization of {float}, which resets at {int}", function (utilization: number, resetsAt: number) {
  assert.deepEqual(folded(this).usage, { utilization, resetsAt });
});

async function setUp(world: object, mode: "cell" | "judge") {
  const run = await load();
  ctx(world).options = run ? run.agentOptions({ prompt: "p", model: "claude-haiku-5-5", cwd: repo, mode, signal: new AbortController().signal }) : null;
}

When("the factory sets up a judge run", async function () { await setUp(this, "judge"); });
When("the factory sets up a cell run", async function () { await setUp(this, "cell"); });

function options(world: object): Record<string, unknown> {
  const o = ctx(world).options;
  assert.ok(o, "src/agent/run.ts doesn't export agentOptions yet");
  return o;
}

Then("the run loads no settings from disk", function () {
  assert.deepEqual(options(this).settingSources, []);
});

Then("the run has no built-in tools", function () {
  assert.deepEqual(options(this).tools, []);
});

Then("the run denies every tool", function () {
  assert.deepEqual(options(this).disallowedTools, ["*"]);
});

Then("the run uses no MCP server configured on disk", function () {
  const o = options(this);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.mcpServers, undefined);
});

Then("the run sets no permission mode and no sandbox", function () {
  const o = options(this);
  assert.equal(o.permissionMode, undefined);
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.sandbox, undefined);
});

Then("the run loads settings from {string} and {string}", function (a: string, b: string) {
  assert.deepEqual(options(this).settingSources, [a, b]);
});

Then("the run bypasses permission prompts", function () {
  const o = options(this);
  assert.equal(o.permissionMode, "bypassPermissions");
  assert.equal(o.allowDangerouslySkipPermissions, true);
});
