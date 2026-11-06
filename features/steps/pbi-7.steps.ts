import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const featureFile = join(repo, "features/pbi-7-state-machine.feature");

// The states and events plan Task 3 names. The edges come from the feature file's Examples table, never from the code under test.
const states = ["Eligible", "NotReady", "Queued", "InProgress", "SignOff", "NeedsInput", "InReview", "Accepted", "Done", "Failed", "Abandoned"];
const events = ["readiness_failed", "item_edited", "ready", "claimed", "scenarios_written", "blocked", "pr_opened", "changes_requested", "merged", "approvals_met", "dod_verified", "dod_failed", "retries_exhausted", "timed_out", "lease_expired", "usage_limited", "policy_changed", "requeued", "reopened_signoff", "reopened_question", "criteria_changed", "withdrawn"];

type Machine = { next: (from: string, event: string) => string | null; overrideTo: (from: string, to: string) => string };
type Ctx = { machine?: Machine | null; from?: string; result?: string | null; failures?: string[]; tried?: number };

function ctx(world: object): Ctx {
  const w = world as { pbi7?: Ctx };
  w.pbi7 ??= {};
  return w.pbi7;
}

// Loaded lazily, so a missing module turns into a red Then instead of a crash of the whole run.
async function machine(c: Ctx): Promise<Machine | null> {
  if (c.machine !== undefined) return c.machine;
  const file = join(repo, "src/core/states.ts");
  c.machine = existsSync(file) ? ((await import(pathToFileURL(file).href)) as Machine) : null;
  return c.machine;
}

function tableEdges(): Set<string> {
  const rows = readFileSync(featureFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  return new Set(rows.slice(1).map((r) => r.split("|").map((x) => x.trim()).filter(Boolean)).map(([from, event]) => `${from}:${event}`));
}

Given("an item in state {string}", function (from: string) {
  ctx(this).from = from;
});

When("the event {string} happens", async function (event: string) {
  const c = ctx(this);
  const m = await machine(c);
  c.result = m ? m.next(c.from ?? "", event) : undefined;
});

Then("the item is in state {string}", function (to: string) {
  const c = ctx(this);
  assert.ok(c.machine, "src/core/states.ts doesn't exist");
  assert.equal(c.result, to);
});

When("I try every event from every state that the table above doesn't list", async function () {
  const c = ctx(this);
  const m = await machine(c);
  const listed = tableEdges();
  c.failures = [];
  c.tried = 0;
  if (!m) return;
  for (const s of states) {
    for (const e of events) {
      if (listed.has(`${s}:${e}`)) continue;
      c.tried++;
      const got = m.next(s, e);
      if (got !== null) c.failures.push(`${s} --${e}--> ${got}`);
    }
  }
});

Then("every one of those moves is refused", function () {
  const c = ctx(this);
  assert.ok(c.machine, "src/core/states.ts doesn't exist");
  assert.deepEqual(c.failures, [], `moves the table doesn't list were allowed: ${c.failures?.join(", ")}`);
});

Then("at least one move is tried", function () {
  assert.ok((ctx(this).tried ?? 0) > 0, "no unlisted move was tried");
});

When("I override every state to every state", async function () {
  const c = ctx(this);
  const m = await machine(c);
  c.failures = [];
  c.tried = 0;
  if (!m) return;
  for (const from of states) {
    for (const to of states) {
      c.tried++;
      const got = m.overrideTo(from, to);
      if (got !== to) c.failures.push(`${from} -> ${to} gave ${got}`);
    }
  }
});

Then("every override lands on its target state", function () {
  const c = ctx(this);
  assert.ok(c.machine, "src/core/states.ts doesn't exist");
  assert.equal(c.tried, states.length * states.length);
  assert.deepEqual(c.failures, []);
});
