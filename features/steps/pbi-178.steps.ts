// Step definitions for features/pbi-178-clear-usage-pause.feature. PBI 178 builds on PBI 175's Configuration page and
// PBI 176's reasons, so its scenarios share their hooks and steps (pbi-175.steps.ts and pbi-176.steps.ts run their hooks
// for @pbi-178 too), and this file adds only what PBI 178 says new: clearing an active usage pause.
//
// The contract these steps add to PBI 175's and PBI 176's:
// - Clearing the usage pause is POST /configuration with `setting` = `usage_pause`, an empty `value` and a `reason`.
//   It answers as any other change does, and the stored usage_paused_until becomes null.
// - A clear with no reason answers 4xx with "Give a reason for the change."; a clear with no usage pause stored answers
//   4xx with "There's no usage pause to clear."; a change of the usage pause to any value but empty answers 4xx with
//   "The usage pause can only be cleared." None of them stores anything or logs an event.
// - While a usage pause is set, an operator's Configuration page has a <button> in the "usage pause" row of the runtime
//   settings, inside a form that sends `setting` = `usage_pause`. With no usage pause, that row has no button.
// - The Activity page shows a clear as one <tr> that names who cleared it, "usage pause" and the reason.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as schedulerCtx, newItem } from "./pbi-17.steps.ts";
import { activityRows, change, ctx as configCtx, settingRow } from "./pbi-175.steps.ts";

type Ctx = {
  /** The usage pause the scenario set, as stored. */
  pausedUntil?: Date;
};

function ctx(world: object): Ctx {
  const w = world as { pbi178?: Ctx };
  w.pbi178 ??= {};
  return w.pbi178;
}

const pool = () => need().pool;

async function storedPause(): Promise<Date | null> {
  return (await pool().query<{ v: Date | null }>("select usage_paused_until as v from wip_policy limit 1")).rows[0].v;
}

// ---- the usage pause ----

Given("the factory is paused for usage until an hour from now", long, async function () {
  const until = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000);
  await pool().query("update wip_policy set usage_paused_until = $1", [until]);
  ctx(this).pausedUntil = until;
});

Then("the factory is still paused for usage until the same time", long, async function () {
  const until = ctx(this).pausedUntil;
  assert.ok(until, "the scenario never paused the factory for usage");
  const now = await storedPause();
  assert.ok(now, "the WIP policy has no usage pause");
  assert.equal(now.getTime(), until.getTime(), `the usage pause moved from ${until.toISOString()} to ${now.toISOString()}`);
});

Then("the factory's WIP policy still has no usage pause", long, async function () {
  const now = await storedPause();
  assert.equal(now, null, `the WIP policy has a usage pause until ${now?.toISOString()}`);
});

// ---- clearing it ----

When(/^"([^"]*)" clears (.+) on the Configuration page, without giving a reason$/, long, async function (login: string, name: string) {
  await change(this, login, name, "");
});

// ---- the button ----

/** The "usage pause" row's markup on the page that came back last, which must be a 200. */
function pauseRow(world: object): string {
  const c = configCtx(world);
  return settingRow(c, "runtime", "usage pause").html;
}

Then("the page has a button to clear the usage pause", function () {
  const row = pauseRow(this);
  assert.ok(/<button\b/i.test(row), "the usage pause row has no button");
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(row);
  assert.ok(form, "the usage pause row has no form");
  assert.ok(/\bname\s*=\s*"setting"[^>]*\bvalue\s*=\s*"usage_pause"|\bvalue\s*=\s*"usage_pause"[^>]*\bname\s*=\s*"setting"/i.test(form[1]),
    "the usage pause row's form doesn't send setting=usage_pause");
  assert.ok(/<button\b/i.test(form[1]), "the usage pause row's button isn't in its form");
});

Then("the page has no button to clear the usage pause", function () {
  const row = pauseRow(this);
  assert.ok(!/<button\b/i.test(row), "the usage pause row has a button");
});

// ---- the Activity page ----

Then(/^the Activity page shows that "([^"]*)" cleared the usage pause because "(.*)"$/, long, async function (login: string, reason: string) {
  const all = await activityRows(this, login);
  const why = reason.replace(/\s+/g, " ").trim();
  const found = all.filter((r) => r.includes(login) && r.toLowerCase().includes("usage pause") && r.includes(why));
  assert.equal(found.length, 1, `the Activity page has ${found.length} rows of ${login} clearing the usage pause because "${reason}":\n${all.join("\n")}`);
});

// ---- the scheduler ----

Given("one item is queued and none is in progress", long, async function () {
  const s = schedulerCtx(this);
  s.backlog = fakeBacklog();
  s.repoHost = fakeRepoHost();
  s.repoHost.heads.set("ricksu978/software-factory", "c0ffee0");
  await pool().query("insert into repo (host_adapter, url) values ('github', 'https://github.com/ricksu978/software-factory')");
  await newItem(s, "queued", "Queued");
});
