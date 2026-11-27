// Step definitions for features/pbi-320-final-stage-and-priority-claim-order.feature.
//
// Every scenario runs PBI 89's control plane on PBI 4's test database, with a fake board and a fake repo host, set up
// as PBI 265's scenarios set theirs up. PBI 265's items, pages, Production Line, Start now, Move up, Hold and Done steps are
// reused, and so are PBI 17's "waits for an unanswered sign-off", "waits for an unanswered question", "is in review" and
// `item "A" is "Queued"`. PBI 89's "the scheduler ticks once" keeps the WIP limit here, so a free slot claims an item.
//
// The contract these steps set up, which the code reads:
// - The board's Priority field reaches the factory as `fields.Priority` on the board's item, the raw text the board
//   holds, absent when it's empty. The fake board holds it there.
// - The poller writes each item's own priority to `item.board_priority`: the field's value when it's an integer from
//   1 to 5, and 3 otherwise. Null means no poll has read it yet, and counts as 3. A step that gives an item a priority
//   sets the board's field and the column alike, as a poll would.
// - "Depends on" is the board's open dependency: the fake board's `openDependencies`, by external id. A step that
//   names a dependency before both items exist has it set on the board before the next poll. A dependent whose
//   dependency a step removes still waits on an open issue outside the scenario, #999, so it isn't claimed itself.
// - A final-stage item has an open PR on the repo host and is InReview, Queued with its open run at address, or
//   InProgress at address or at the pr-review that follows address.
// - An item's page says `Priority N`. When the priority comes from an item that depends on it, it says
//   `Priority N, from #E`, where #E is that item's issue number. A final-stage item's page says `final-stage`, and
//   one in the group only because of a dependent says `final-stage because #E depends on it`. A page whose item isn't
//   final-stage doesn't have the word "final-stage" in it.
// - Floor lists each item it shows in a list entry or a table row that links to the item's page. That entry shows
//   `priority N`, or `priority N, from #E`, and `final-stage`, or `final-stage because of #E`, in the same way. Floor
//   lists every final-stage item, an item that joins the group through a dependent included, wherever it is.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as p89 } from "./pbi-89.steps.ts";
import { text } from "./pbi-175.steps.ts";
import { ctx as p265, fetchPage, inState, itemOf, newItem, openItem, orderBoard, poll } from "./pbi-265.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "octo/repo";

type Ctx = {
  /** Each item's open dependencies on the board, by the feature's names, set on the board before each poll. */
  deps: Map<string, string[]>;
  /** The dependents whose dependency a step removed, which still wait on an issue outside the scenario. */
  outside: Set<string>;
};

function ctx(world: object): Ctx {
  const w = world as { pbi320?: Ctx };
  w.pbi320 ??= { deps: new Map(), outside: new Set() };
  return w.pbi320;
}

const pool = () => need().pool;
const names = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const numbers = (list: string) => [...list.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
const LIST = `((?:"[^"]+"(?:, | and )?)+)`;
const NUMS = `(\\d+(?:(?:, | and )\\d+)*)`;
const re = (s: string) => new RegExp(`^${s}$`);
const ref = (world: object, name: string) => `#${itemOf(world, name).ext}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

Before({ tags: "@pbi-320", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  p89(this).runTick = async (once) => {
    await once();
  };
  (this as { itemIs?: (name: string, state: string) => Promise<void> }).itemIs = (name, state) => inState(this, name, state);
  (this as { finishKeepsSlotFree?: boolean }).finishKeepsSlotFree = true;
  p17(this).ticked = true;
  // PBI 17's waiting items ask their questions an hour before this, so none times out on a tick.
  p17(this).now = new Date();
});

After({ tags: "@pbi-320", ...long }, async function () {
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the board's Priority field ----

/** Sets the board's Priority field on the item to `raw`, or clears it with null. */
async function boardPriority(world: object, name: string, raw: string | null): Promise<void> {
  const fake = p89(world).fake!;
  const it = itemOf(world, name);
  const fi = await fake.adapter.getItem(it.ext);
  assert.ok(fi, `the board has no item "${name}"`);
  const fields = { ...fi.fields };
  if (raw === null) delete fields.Priority;
  else fields.Priority = raw;
  await fake.seed({ ...fi, fields });
}

/** Gives an item a priority on the board and in the factory, as a poll reading the board would. */
export async function setPriority(world: object, name: string, priority: number): Promise<void> {
  await boardPriority(world, name, String(priority));
  await pool().query("update item set board_priority = $2 where id = $1", [itemOf(world, name).id, priority]);
}

async function firstOnBoard(world: object, name: string): Promise<void> {
  const items = p265(world).items;
  const others = [...items.entries()].filter(([n]) => n !== name).sort((a, b) => a[1].rank - b[1].rank).map(([n]) => n);
  await orderBoard(world, [name, ...others]);
}

Given(re(`item "([^"]+)" is Queued with the Priority (.+) on the board`), async function (name: string, value: string) {
  await newItem(this, name, "Queued");
  await boardPriority(this, name, value === "empty" ? null : value.replace(/^"(.*)"$/, "$1"));
});

When(re(`someone sets item "([^"]+)"'s Priority to (-?\\d+) on the board`), async function (name: string, value: string) {
  await boardPriority(this, name, value);
});

When(re(`someone clears item "([^"]+)"'s Priority on the board`), async function (name: string) {
  await boardPriority(this, name, null);
});

// ---- items ----

Given(re(`item "([^"]+)" is Queued and has priority (\\d+)`), async function (name: string, p: string) {
  await newItem(this, name, "Queued");
  await setPriority(this, name, Number(p));
});

Given(re(`item "([^"]+)" is Queued, has priority (\\d+), and is first on the board`), async function (name: string, p: string) {
  await newItem(this, name, "Queued");
  await setPriority(this, name, Number(p));
  await firstOnBoard(this, name);
});

Given(re(`item "([^"]+)" is (in NeedsInput with its question answered|in SignOff with its sign-off answered) and has priority (\\d+)`), async function (name: string, state: string, p: string) {
  await inState(this, name, state);
  await setPriority(this, name, Number(p));
});

Given(re(`item "([^"]+)" is in SignOff with its sign-off answered, has priority (\\d+), and is first on the board`), async function (name: string, p: string) {
  await inState(this, name, "in SignOff with its sign-off answered");
  await setPriority(this, name, Number(p));
  await firstOnBoard(this, name);
});

Given(re(`items ${LIST} are Queued(?:, in that board order)?, with priorit(?:y|ies) ${NUMS}`), async function (list: string, ps: string) {
  const all = names(list);
  const each = numbers(ps);
  assert.ok(each.length === 1 || each.length === all.length, "the step names a different number of priorities and items");
  for (const [i, name] of all.entries()) {
    await newItem(this, name, "Queued");
    await setPriority(this, name, each.length === 1 ? each[0] : each[i]);
  }
});

Given(re(`items ${LIST} have priorities ${NUMS}`), async function (list: string, ps: string) {
  const all = names(list);
  const each = numbers(ps);
  assert.equal(each.length, all.length, "the step names a different number of priorities and items");
  for (const [i, name] of all.entries()) await setPriority(this, name, each[i]);
});

Given(re(`item "([^"]+)" is (Queued and never started|InProgress in Green, with no PR yet|Accepted, with its PR merged)`), async function (name: string, stage: string) {
  if (stage === "Queued and never started") return inState(this, name, "Queued");
  if (stage === "InProgress in Green, with no PR yet") return inState(this, name, "InProgress");
  const id = await newItem(this, name, "Accepted");
  const runId = await run(id, "green");
  await stages(runId, SO_FAR);
  const pr = await openPr(this, name, runId);
  pr.open = false;
  pr.merged = true;
  pr.mergeSha = "feedface00000000000000000000000000000000";
  await pool().query("update run set merge_sha = $2 where id = $1", [runId, pr.mergeSha]);
});

const SO_FAR = ["understand", "specify", "sign-off", "red", "green", "self-review", "open-pr", "pr-review"];

async function run(itemId: string, nextStage: string): Promise<string> {
  const repo = (await pool().query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${REPO}`])).rows[0]?.id ?? null;
  return (await pool().query<{ id: string }>(
    `insert into run (item_id, run_number, next_stage, config_sha, sop_version, scenarios_sha, repo_id) values ($1, 1, $2, 'pinned', 'default@1', 'scen', $3) returning id`,
    [itemId, nextStage, repo],
  )).rows[0].id;
}

async function stages(runId: string, passed: string[], started: string | null = null): Promise<void> {
  const attempts = new Map<string, number>();
  const add = async (stage: string, status: string) => {
    const attempt = (attempts.get(stage) ?? 0) + 1;
    attempts.set(stage, attempt);
    await pool().query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, $2, $3, $4)", [runId, stage, attempt, status]);
  };
  for (const s of passed) await add(s, "passed");
  if (started) await add(started, "started");
}

/** Opens the item's PR on the fake repo host and records it on the run. */
async function openPr(world: object, name: string, runId: string) {
  const host = p89(world).host!;
  const it = itemOf(world, name);
  const branch = `factory/pbi-${it.ext}-r1`;
  const { number, url } = await host.openOrUpdatePr({ repo: REPO, branch, base: "main", title: `Item ${name}`, body: "" });
  await pool().query("update run set pr_number = $2, pr_url = $3, branch = $4 where id = $1", [runId, number, url, branch]);
  const pr = host.prs.find((p) => p.repo === REPO && p.number === number)!;
  pr.mergeable = null;
  return pr;
}

async function lease(id: string): Promise<void> {
  await pool().query("update item set lease_generation = 1, lease_owner = 'scheduler', lease_expires = now() + interval '5 minutes' where id = $1", [id]);
}

/** An item with an open PR, at `stage` of the review loop. */
export async function finalStage(world: object, name: string, stage: string): Promise<void> {
  switch (stage) {
    case "InReview": {
      const id = await newItem(world, name, "InReview");
      const runId = await run(id, "address");
      await stages(runId, SO_FAR);
      await openPr(world, name, runId);
      return;
    }
    case "Queued to address requested changes": {
      const id = await newItem(world, name, "Queued");
      const runId = await run(id, "address");
      await stages(runId, SO_FAR);
      await openPr(world, name, runId);
      return;
    }
    case "in address": {
      const id = await newItem(world, name, "InProgress");
      await lease(id);
      const runId = await run(id, "address");
      await stages(runId, SO_FAR, "address");
      await openPr(world, name, runId);
      return;
    }
    case "in the PR review that follows address": {
      const id = await newItem(world, name, "InProgress");
      await lease(id);
      // Address passing leaves next_stage at address (stageAfter, src/config/sop.ts), and the same claim runs pr-review.
      const runId = await run(id, "address");
      await stages(runId, [...SO_FAR, "address"], "pr-review");
      await openPr(world, name, runId);
      return;
    }
  }
  throw new Error(`no review-loop stage "${stage}"`);
}

const LOOP = "InReview|Queued to address requested changes|in address|in the PR review that follows address";

Given(re(`item "([^"]+)" has an open PR and is (${LOOP})`), async function (name: string, stage: string) {
  await finalStage(this, name, stage);
});

Given(re(`item "([^"]+)" has an open PR and is InReview, with priority (\\d+)`), async function (name: string, p: string) {
  await finalStage(this, name, "InReview");
  await setPriority(this, name, Number(p));
});

Given(re(`item "([^"]+)" has an open PR, is Queued to address requested changes, and has priority (\\d+)`), async function (name: string, p: string) {
  await finalStage(this, name, "Queued to address requested changes");
  await setPriority(this, name, Number(p));
});

// ---- dependencies ----

export function depend(world: object, dependent: string, on: string): void {
  const deps = ctx(world).deps;
  const list = deps.get(dependent) ?? [];
  if (!list.includes(on)) list.push(on);
  deps.set(dependent, list);
}

Given(re(`item "([^"]+)" depends on item "([^"]+)" on the board`), function (dependent: string, on: string) {
  depend(this, dependent, on);
});

Given(re(`items "([^"]+)" and "([^"]+)" each depend on item "([^"]+)" on the board`), function (a: string, b: string, on: string) {
  depend(this, a, on);
  depend(this, b, on);
});

// The dependent stays blocked by an open issue outside the scenario, so the scenario sees only what the removed
// dependency lent the item it named. Otherwise a Queued dependent, such as the priority-1 "H" of the @ac-6 scenarios,
// would be claimable at its own priority and take the slot the scenario expects the other item to get.
When(re(`someone removes item "([^"]+)"'s dependency on item "([^"]+)" on the board`), function (dependent: string, on: string) {
  const deps = ctx(this).deps;
  deps.set(dependent, (deps.get(dependent) ?? []).filter((n) => n !== on));
  ctx(this).outside.add(dependent);
});

/** The open issue outside the scenario that a dependent whose dependency was removed still waits on. */
const OUTSIDE = "999";

/** Puts every dependency the scenario named on the board, by external id, so the next poll reads them. */
function syncDependencies(world: object): void {
  const fake = p89(world).fake!;
  const c = ctx(world);
  for (const [dependent, on] of c.deps) {
    fake.setDependencies(itemOf(world, dependent).ext, [...on.map((n) => itemOf(world, n).ext), ...(c.outside.has(dependent) ? [OUTSIDE] : [])]);
  }
}

Given(re(`the poller (?:reads|has read) the board`), long, async function () {
  syncDependencies(this);
  await poll(this);
  // PBI 311's steps learn the new issues a poll read, by name.
  await (this as { afterPoll?: () => Promise<void> }).afterPoll?.();
});

// ---- WIP ----

Given(re(`the factory has (no free WIP slot|two free WIP slots)`), async function (slots: string) {
  await pool().query("update wip_policy set current_wip = $1", [slots === "no free WIP slot" ? 0 : 2]);
});

// ---- states ----

Then(re(`item "([^"]+)" has priority (\\d+)`), async function (name: string, p: string) {
  const r = (await pool().query<{ board_priority: number | null }>("select board_priority from item where id = $1", [itemOf(this, name).id])).rows[0];
  assert.equal(r.board_priority, Number(p), `item "${name}"'s priority`);
});

Then(re(`item "([^"]+)" is still in SignOff with its sign-off answered`), async function (name: string) {
  const id = itemOf(this, name).id;
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [id])).rows[0].state;
  assert.equal(state, "SignOff", `item "${name}"`);
  const answered = (await pool().query("select 1 from question where item_id = $1 and kind = 'sign_off' and answer is not null", [id])).rowCount;
  assert.ok(answered, `item "${name}"'s sign-off isn't answered`);
});

// ---- the item page ----

type Priority = { value: number; from: string | null };

/** Every priority the text states, with the dependent it names, if any. */
function priorities(t: string): Priority[] {
  return [...t.matchAll(/\bpriority:?\s+(\d+)\b(?:\s*,\s*from\s+(#[\w-]+))?/gi)].map((m) => ({ value: Number(m[1]), from: m[2] ?? null }));
}

const finalStageIn = (t: string) => /\bfinal-stage\b/i.test(t);

function lastPage(world: object): string {
  const page = p265(world).page;
  assert.ok(page, "no page was opened");
  return text(page);
}

async function pageOf(world: object, name: string): Promise<string> {
  return text(await openItem(world, name, p89(world).login!));
}

function showsPriority(t: string, what: string, value: number, from: string | null | "own"): void {
  const found = priorities(t);
  assert.ok(found.length > 0, `${what} shows no priority: ${t.slice(0, 400)}`);
  const ok = found.some((p) => p.value === value && (from === null || (from === "own" ? p.from === null : p.from === from)));
  assert.ok(ok, `${what} shows ${found.map((p) => `priority ${p.value}${p.from ? `, from ${p.from}` : ""}`).join("; ")}, not priority ${value}${typeof from === "string" && from !== "own" ? `, from ${from}` : ""}`);
}

Then(re(`the page shows priority (\\d+)`), function (p: string) {
  showsPriority(lastPage(this), "the page", Number(p), null);
});

Then(re(`the page shows priority (\\d+), from item "([^"]+)"`), function (p: string, from: string) {
  showsPriority(lastPage(this), "the page", Number(p), ref(this, from));
});

Then(re(`item "([^"]+)"'s page shows priority (\\d+)`), async function (name: string, p: string) {
  showsPriority(await pageOf(this, name), `item "${name}"'s page`, Number(p), null);
});

Then(re(`item "([^"]+)"'s page shows priority (\\d+), its own`), async function (name: string, p: string) {
  showsPriority(await pageOf(this, name), `item "${name}"'s page`, Number(p), "own");
});

Then(re(`item "([^"]+)"'s page shows priority (\\d+), from item "([^"]+)"`), async function (name: string, p: string, from: string) {
  const t = await pageOf(this, name);
  showsPriority(t, `item "${name}"'s page`, Number(p), ref(this, from));
});

Then(re(`the page shows item "([^"]+)" is final-stage`), function (name: string) {
  itemOf(this, name);
  assert.ok(finalStageIn(lastPage(this)), `item "${name}"'s page doesn't show it as final-stage`);
});

Then(re(`the page shows item "([^"]+)" is final-stage because item "([^"]+)" depends on it`), function (name: string, dependent: string) {
  const t = lastPage(this);
  const because = new RegExp(`\\bfinal-stage because ${escape(ref(this, dependent))} depends on it\\b`, "i");
  assert.ok(because.test(t), `item "${name}"'s page doesn't show it's final-stage because item "${dependent}" depends on it: ${t.slice(0, 400)}`);
});

Then(re(`the page doesn't show item "([^"]+)" as final-stage`), function (name: string) {
  itemOf(this, name);
  assert.ok(!finalStageIn(lastPage(this)), `item "${name}"'s page shows it as final-stage`);
});

Then(re(`the page doesn't name item "([^"]+)"`), function (name: string) {
  const r = ref(this, name);
  assert.ok(!new RegExp(`${escape(r)}(?!\\d)`).test(lastPage(this)), `the page names item "${name}" (${r})`);
});

Then(re(`item "([^"]+)"'s page shows it as final-stage`), async function (name: string) {
  assert.ok(finalStageIn(await pageOf(this, name)), `item "${name}"'s page doesn't show it as final-stage`);
});

Then(re(`item "([^"]+)"'s page doesn't show it as final-stage`), async function (name: string) {
  assert.ok(!finalStageIn(await pageOf(this, name)), `item "${name}"'s page shows it as final-stage`);
});

// ---- Floor ----

function floorHtml(world: object): Promise<string> {
  return fetchPage(world, "/", p89(world).login!);
}

/** The text of each list entry and table row on Floor that links to the item's page. */
async function floorEntries(world: object, name: string, page?: string): Promise<string[]> {
  const html = page ?? (await floorHtml(world));
  const link = `href="/items/${itemOf(world, name).id}"`;
  return [...html.matchAll(/<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)].filter((m) => m[2].includes(link)).map((m) => text(m[2]));
}

async function floorShowsFinalStage(world: object, name: string, because: string | null): Promise<void> {
  const entries = await floorEntries(world, name);
  assert.ok(entries.length > 0, `Floor doesn't list item "${name}"`);
  const want = because ? new RegExp(`\\bfinal-stage because of ${escape(ref(world, because))}(?!\\d)`, "i") : /\bfinal-stage\b/i;
  assert.ok(entries.some((e) => want.test(e)), `Floor doesn't show item "${name}" as final-stage${because ? ` because of item "${because}"` : ""}: ${entries.join(" | ")}`);
}

Then(re(`Floor shows item "([^"]+)" as final-stage`), async function (name: string) {
  await floorShowsFinalStage(this, name, null);
});

Then(re(`Floor shows item "([^"]+)" as final-stage because of item "([^"]+)"`), async function (name: string, because: string) {
  await floorShowsFinalStage(this, name, because);
});

Then(re(`Floor doesn't show item "([^"]+)" as final-stage`), async function (name: string) {
  const entries = await floorEntries(this, name);
  assert.ok(!entries.some(finalStageIn), `Floor shows item "${name}" as final-stage: ${entries.join(" | ")}`);
});

async function floorShowsPriority(world: object, name: string, value: number, from: string | null, page?: string): Promise<void> {
  const entries = await floorEntries(world, name, page);
  assert.ok(entries.length > 0, `Floor doesn't list item "${name}"`);
  const found = entries.flatMap(priorities);
  assert.ok(found.length > 0, `Floor shows no priority for item "${name}": ${entries.join(" | ")}`);
  const label = (p: Priority) => `priority ${p.value}${p.from ? `, from ${p.from}` : ""}`;
  assert.deepEqual([...new Set(found.map(label))], [label({ value, from })], `item "${name}" on Floor`);
}

Then(re(`Floor shows item "([^"]+)"'s priority as (\\d+)`), async function (name: string, p: string) {
  await floorShowsPriority(this, name, Number(p), null);
});

Then(re(`Floor shows item "([^"]+)"'s priority as (\\d+), from item "([^"]+)"`), async function (name: string, p: string, from: string) {
  await floorShowsPriority(this, name, Number(p), ref(this, from));
});

// One Floor fetch for the whole table: a fetch per assertion overran the step timeout on CI.
Then(re(`Floor shows these items:`), long, async function (table: { hashes(): Record<string, string>[] }) {
  const page = await floorHtml(this);
  for (const row of table.hashes()) {
    await floorShowsPriority(this, row.item, Number(row.priority), null, page);
    const entries = await floorEntries(this, row.item, page);
    const shown = entries.some(finalStageIn);
    assert.equal(shown, row["final-stage"] === "yes", `item "${row.item}" ${shown ? "shows" : "doesn't show"} as final-stage on Floor: ${entries.join(" | ")}`);
  }
});
