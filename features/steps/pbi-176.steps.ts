// Step definitions for features/pbi-176-live-settings-with-reason.feature. PBI 176 builds on PBI 175's Configuration
// page, so its scenarios share PBI 175's hooks, dashboard and steps (pbi-175.steps.ts runs its hooks for @pbi-176 too),
// and this file adds only what PBI 176 says new: a reason on each change, the event that logs it, and the Activity page
// showing it.
//
// The contract these steps add to PBI 175's:
// - A change to the page carries its reason as the form field `reason`. A change with no reason, or one of only spaces,
//   answers 4xx with "Give a reason for the change." and stores nothing.
// - The change logs a `setting` event whose actor_id is the user's id, as PBI 175's does, and whose payload holds
//   `setting` (the setting's label, such as "review capacity"), `from`, `to` and `reason`.
// - The Activity page (GET /activity) shows the change as one <tr> that names who made it, the setting, the old and new
//   values and the reason, the reason as text.
// - A usage report is a cell's POST /internal/cells/:runId/stage carrying `usage: { utilization, resetsAt }`, as the
//   cell API already takes it.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as schedulerCtx, newItem } from "./pbi-17.steps.ts";
import { activityRows, change, ctx as configCtx, dashboard, decode, escapeRe, get, headers, text, user } from "./pbi-175.steps.ts";

type Ctx = {
  /** Who opened the Activity page last, so a Then reads it as they see it. */
  activityLogin?: string;
  /** The Activity page's markup, as the last Then that read it got it. */
  activityPage?: string;
  /** The one setting change event a Then picked out. */
  event?: { by: string | null; setting: string | null; from: string | null; to: string | null; reason: string | null };
  cellServer?: Server;
};

function ctx(world: object): Ctx {
  const w = world as { pbi176?: Ctx };
  w.pbi176 ??= {};
  return w.pbi176;
}

const pool = () => need().pool;
const CELL_SECRET = "pbi-176-cell-secret";

After({ tags: "@pbi-176", ...long }, async function () {
  const s = ctx(this).cellServer;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

// ---- people ----

Given("{string} is an owner", long, async function (login: string) {
  await user(login, "owner");
});

// ---- changing a setting with a reason ----

When(/^"([^"]*)" changes (.+) to "([^"]*)" on the Configuration page, giving the reason "(.*)"$/, long,
  async function (login: string, name: string, value: string, reason: string) {
    await change(this, login, name, value, { reason });
  });

When(/^"([^"]*)" changes (.+) to "([^"]*)" on the Configuration page, without giving a reason$/, long,
  async function (login: string, name: string, value: string) {
    await change(this, login, name, value);
  });

When(/^"([^"]*)" sends a change of (.+) to "([^"]*)" with the reason "(.*)" to the Configuration page$/, long,
  async function (login: string, name: string, value: string, reason: string) {
    await change(this, login, name, value, { reason });
  });

// ---- the Activity page ----

When("{string} opens the Activity page", long, async function (login: string) {
  const c = configCtx(this);
  await dashboard(c);
  const r = await fetch(`${c.origin}/activity`, { headers: headers(login), redirect: "manual" });
  assert.equal(r.status, 200, `the Activity page answered ${r.status} for ${login}`);
  ctx(this).activityLogin = login;
});

/** The Activity page's event rows, as text, read now as whoever opened it last, or as `login`. */
async function activity(world: object, login: string): Promise<string[]> {
  const as = ctx(world).activityLogin ?? login;
  const c = configCtx(world);
  await dashboard(c);
  const r = await fetch(`${c.origin}/activity`, { headers: headers(as), redirect: "manual" });
  const page = await r.text();
  assert.equal(r.status, 200, `the Activity page answered ${r.status} for ${as}`);
  ctx(world).activityPage = page;
  return [...page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((row) => /<td\b/i.test(row)).map(text);
}

Then(/^the Activity page shows that "([^"]*)" changed (.+) from "([^"]*)" to "([^"]*)" because "(.*)"$/, long,
  async function (login: string, name: string, from: string, to: string, reason: string) {
    const all = await activity(this, login);
    const word = (s: string) => new RegExp(`(?<![\\w.])${escapeRe(s)}(?![\\w]|\\.\\d)`, "i");
    const changes = all.filter((r) => [login, name, from, to].every((v) => word(v).test(r)));
    const found = changes.filter((r) => r.includes(reason.replace(/\s+/g, " ").trim()));
    assert.equal(found.length, 1,
      `the Activity page has ${found.length} rows of ${login} changing ${name} from ${from} to ${to} because "${reason}":\n${all.join("\n")}`);
  });

Then(/^the Activity page shows no change to (.+)$/, long, async function (name: string) {
  const login = (await pool().query<{ subject: string }>(`select subject from "user" order by subject limit 1`)).rows[0]?.subject;
  assert.ok(login, "no one is allowlisted to open the Activity page");
  const all = await activityRows(this, login);
  const shown = all.filter((r) => r.toLowerCase().includes(name.trim().toLowerCase()));
  assert.deepEqual(shown, [], `the Activity page shows a change to ${name}`);
});

Then("the Activity page has no bold element from the reason", function () {
  const page = ctx(this).activityPage;
  assert.ok(page !== undefined, "the Activity page wasn't read");
  assert.ok(!/<b>urgent<\/b>/i.test(page), "the reason's bold element reached the Activity page");
  assert.ok(decode(page).includes("<b>urgent</b>"), "the Activity page doesn't show the reason as text");
});

// ---- the logged event ----

Then("the factory logged one setting change event", long, async function () {
  const r = await pool().query<{ by: string | null; setting: string | null; from: string | null; to: string | null; reason: string | null }>(
    `select u.github_login as by, e.payload->>'setting' as setting, e.payload->>'from' as "from", e.payload->>'to' as "to",
       e.payload->>'reason' as reason
     from event e left join "user" u on u.id::text = e.actor_id where e.kind = 'setting'`,
  );
  assert.equal(r.rowCount, 1, `the factory logged ${r.rowCount} setting change events: ${JSON.stringify(r.rows)}`);
  ctx(this).event = r.rows[0];
});

function event(world: object) {
  const e = ctx(world).event;
  assert.ok(e, "no setting change event was picked out");
  return e;
}

Then("that event says it was made by {string}", function (login: string) {
  assert.equal(event(this).by, login);
});

Then(/^that event says (.+) went from "([^"]*)" to "([^"]*)"$/, function (name: string, from: string, to: string) {
  const e = event(this);
  assert.equal(e.setting?.toLowerCase(), name.trim().toLowerCase());
  assert.equal(Number(e.from), Number(from), `the event's old value is ${e.from}`);
  assert.equal(Number(e.to), Number(to), `the event's new value is ${e.to}`);
});

Then("that event gives the reason {string}", function (reason: string) {
  assert.equal(event(this).reason, reason);
});

// ---- the scheduler ----

Given("two items are waiting on review and another is queued", long, async function () {
  const s = schedulerCtx(this);
  s.backlog = fakeBacklog();
  s.repoHost = fakeRepoHost();
  s.repoHost.heads.set("ricksu978/software-factory", "c0ffee0");
  await pool().query("insert into repo (host_adapter, url) values ('github', 'https://github.com/ricksu978/software-factory')");
  await newItem(s, "review-1", "InReview");
  await newItem(s, "review-2", "InReview");
  await newItem(s, "queued", "Queued");
});

Then("the queued item is still queued", long, async function () {
  const s = schedulerCtx(this);
  assert.ok(s.ticked, "the scheduler never ticked");
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [s.items.queued])).rows[0].state;
  assert.equal(state, "Queued");
});

// ---- a usage report ----

/** A running item with an open run, which a cell reports usage for, as the cell API knows it. */
async function runningCell(): Promise<{ runId: string; generation: number }> {
  const p = pool();
  const repo = (await p.query<{ id: string }>(
    "insert into repo (host_adapter, url) values ('github', 'https://github.com/ricksu978/pbi-176-' || gen_random_uuid()) returning id",
  )).rows[0].id;
  const source = (await p.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-176:' || gen_random_uuid()) returning id")).rows[0].id;
  const item = (await p.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, 'usage', 'item usage', 'InProgress', 1, 'cell-usage', now() + interval '1 hour') returning id`,
    [source],
  )).rows[0].id;
  const run = (await p.query<{ id: string }>(
    "insert into run (item_id, next_stage, execution_name, branch, repo_id, config_sha) values ($1, 'green', 'cell-usage', 'factory/pbi-x-r1', $2, 'c0ffee0') returning id",
    [item, repo],
  )).rows[0].id;
  return { runId: run, generation: 1 };
}

When(/^a usage report says (\d+)% of the limit is used, resetting at "([^"]*)"$/, long, async function (percent: string, resetsAt: string) {
  const c = ctx(this);
  const backlog = fakeBacklog();
  c.cellServer ??= await startServer([cellApi({
    pool: pool(), secret: CELL_SECRET, repoHost: fakeRepoHost() as never, backlogFor: () => backlog.adapter as never,
    stageAfter: () => null, uploadUrl: async (path) => `http://blob.test/${path}`,
    gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
  })], { port: 0 });
  const run = await runningCell();
  const r = await fetch(`http://127.0.0.1:${(c.cellServer.address() as AddressInfo).port}/internal/cells/${run.runId}/stage`, {
    method: "POST",
    headers: { authorization: `Bearer ${runToken(CELL_SECRET, run.runId, run.generation)}`, "content-type": "application/json" },
    body: JSON.stringify({
      stageId: "green", attempt: 1, status: "started", model: "claude-opus-5-5", tokensIn: 0, tokensOut: 0, costUsd: 0,
      usage: { utilization: Number(percent) / 100, resetsAt },
    }),
  });
  assert.equal(r.status, 200, `the cell API answered ${r.status}: ${await r.text()}`);
  // The runtime settings a Then reads next are the page as it is after the report, as an operator opens it.
  const operator = (await pool().query<{ subject: string }>(`select subject from "user" where role in ('operator', 'owner') order by subject limit 1`)).rows[0]?.subject;
  assert.ok(operator, "no operator to open the Configuration page");
  await get(this, "/configuration", operator);
});
