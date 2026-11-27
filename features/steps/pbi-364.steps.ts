// Step definitions for features/pbi-364-feature-change-request.feature.
//
// The cell scenarios run PBI 18's engine harness through PBI 152's steps: item 482's feature files locked at a fresh
// lock commit, every push the origin receives logged, and the agent scripted call by call. "A run for item 482 that
// resumes at ..." is PBI 152's step (PBI 142's for open-pr), as are the self-reviewer's rounds, the summary pass's edit,
// the Thens on the branch and the PR, and "the owner is asked no question". On top of them, this file scripts each
// stage's agent to edit a locked feature file and to ask, in its report, to change it.
//
// The contract these steps set up, which the code reads:
// - A stage's agent asks to change a locked feature file with one line in its report per file, in the form
//   `FEATURE CHANGE: <path>: <reason>` (src/core/feature-change.ts). The self-reviewer writes it before its last line,
//   the verdict, and every other agent at the end of its answer. Each stage's agent is the one whose answer is the
//   stage's report: red's and green's, self-review's reviewer and its fix pass, open-pr's summary pass, the addresser.
// - The cell sends the request as a transition whose event is `feature_change_requested`, which moves an InProgress item
//   to FeatureChangeRequest. Its body's `featureChange` lists each file: its `path`, the stage's `reason`, its text at the
//   lock commit as `before`, and the version the agent proposed as `after`.
// - The factory handles the move by posting the request on the PBI with mirrorFeatureChange in src/control/board.ts,
//   keyed on the move's event, onto a fake board holding item "482". The comment names each file's path. Below each,
//   up to the next file's path, a line the request takes out starts with "-" and a line it puts in starts with "+",
//   as in a diff, and the reason follows.
// - On the item page the request is a section headed <h2>Feature change request</h2>. Each file is an <h3> holding its
//   path, followed, up to the next <h3>, by its changed lines: each line before in an element with data-side="before",
//   each line after in one with data-side="after", and the reason in an element with a data-reason attribute.
// - The item page scenarios store the request with requestFeatureChange in src/store/feature-change.ts, on PBI 4's
//   shared test database, for an InProgress item 482 whose run locked the feature files, as the cell API does when a
//   cell sends the request. The page is the dashboard's /items/<id>, opened in UTC by the signed-in owner.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { mirrorFeatureChange } from "../../src/control/board.ts";
import type { FeatureChangeFile } from "../../src/core/feature-change.ts";
import { next, type ItemEvent } from "../../src/core/states.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { requestFeatureChange } from "../../src/store/feature-change.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { runTheCell } from "./pbi-18.steps.ts";
import { at, commit, ensure, featureText, lockText, mine as pbi152, pushedHead, ranClean } from "./pbi-152.steps.ts";
import { text } from "./pbi-189.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const ORDERS = "features/pbi-482-orders.feature";
const CODE = "export const holdEmptyOrders = true;\n";
const EVENT = "feature_change_requested";
const OWNER = "olive";
const LOCK_SHA = "6e1c5b4000000000000000000000000000000000";

type Role = "red" | "green" | "reviewer" | "fix" | "summary" | "address";

type Ctx = {
  wrapped: boolean;
  /** The report lines each role writes on its nth call. */
  reports: { role: Role; n: number; line: string }[];
  /** The version of each locked file the agent left, as it proposed it. */
  proposed: Map<string, string>;
  board?: ReturnType<typeof fakeBacklog>;
  /** The item page scenarios: the request's files, and the item and page once they're made. */
  files: FeatureChangeFile[];
  itemId?: string;
  sourceId?: string;
  server?: Server;
  close?: () => Promise<void>;
  page?: { status: number; html: string };
  /** The move a "has moved to FeatureChangeRequest" step made, without a cell. */
  moved?: FeatureChangeFile[];
};

function mine(world: object): Ctx {
  const w = world as { pbi364?: Ctx };
  w.pbi364 ??= { wrapped: false, reports: [], proposed: new Map(), files: [] };
  return w.pbi364;
}

const roleOf = (stage: string): Role => {
  const r = ({ red: "red", green: "green", "self-review": "reviewer", "open-pr": "summary", address: "address" } as Record<string, Role>)[stage];
  assert.ok(r, `no agent role for the ${stage} stage`);
  return r;
};

/**
 * PBI 152's harness, with each role's answer carrying the report lines the scenario gives it. The wrapper reads the
 * call PBI 152's agent just recorded for its role and count.
 */
function harness(world: object): { c: CellCtx; m: ReturnType<typeof pbi152>; x: Ctx } {
  const { c, m } = ensure(world);
  const x = mine(world);
  if (x.wrapped) return { c, m, x };
  x.wrapped = true;
  const inner = c.agent!;
  c.agent = async (a, base) => {
    const r = await inner(a, base);
    const seen = m.seen.at(-1);
    const lines = seen ? x.reports.filter((p) => p.role === seen.role && p.n === seen.n).map((p) => p.line) : [];
    if (lines.length) {
      const all = String(r.text ?? "").split("\n");
      r.text = seen!.role === "reviewer" ? [...all.slice(0, -1), ...lines, ...all.slice(-1)].join("\n") : [...all, "", ...lines].join("\n");
    }
    return r;
  };
  return { c, m, x };
}

/** The lock commit's text of `path` with its first Then line changed, or `from` changed to `to` when given. */
function propose(text: string, path: string, from?: string, to?: string): string {
  if (from !== undefined && to !== undefined) return text.replace(from, to);
  const after = path.includes("refunds") ? "Then the refund needs the order's number" : "Then the order is held for review";
  return text.replace(/^( {4})Then .*$/m, `$1${after}`);
}

function edit(x: Ctx, cwd: string, path: string, from?: string, to?: string) {
  const file = join(cwd, path);
  const now = existsSync(file) ? readFileSync(file, "utf8") : featureText(path);
  const proposed = propose(now, path, from, to);
  writeFileSync(file, proposed);
  x.proposed.set(path, proposed);
}

function act(world: object, role: Role, fn: (cwd: string, x: Ctx) => void) {
  const { m, x } = harness(world);
  m.actions.push({ role, n: 1, act: (cwd) => fn(cwd, x) });
}

function asks(world: object, role: Role, path: string, reason: string) {
  harness(world).x.reports.push({ role, n: 1, line: `FEATURE CHANGE: ${path}: ${reason}` });
}

// ---- the run and its agents ----

Given("item {int} is InProgress", async function (_item: number) {
  // PBI 430's scenarios set up a numbered item on PBI 89's control plane instead, through `numberedIs`.
  const own = (this as { numberedIs?: (n: number, state: string) => Promise<void> }).numberedIs;
  if (own) return own(_item, "InProgress");
  // A cell runs only for a claimed item, so the run PBI 152's step set up is InProgress: claimed after sign-off, its
  // feature files locked, at a stage after sign-off, and not yet run.
  const { c } = harness(this);
  assert.equal(next("Queued", "claimed"), "InProgress");
  assert.ok(c.lockSha, "the run has no lock commit, so it was never signed off");
  assert.ok(c.lockedFiles.length > 0, "the run locked no feature file");
  assert.ok(["red", "green", "self-review", "open-pr", "address"].includes(c.nextStage), `the run resumes at ${c.nextStage}, not a stage after sign-off`);
  assert.equal(c.result, null, "the cell already ran for this claim");
  assert.equal(transitions(c).length, 0, "the run already moved the item out of InProgress");
});

Given("the {word} agent changes {string} to {string} in {string}", function (stage: string, from: string, to: string, path: string) {
  act(this, roleOf(stage), (cwd, x) => edit(x, cwd, path, from, to));
});

Given("the {word} agent's report asks to change {string} because {string}", function (stage: string, path: string, reason: string) {
  asks(this, roleOf(stage), path, reason);
});

Given("the green agent edits both {string} and {string}", function (a: string, b: string) {
  act(this, "green", (cwd, x) => { edit(x, cwd, a); edit(x, cwd, b); });
});

Given("the green agent edits {string} and {string} in one commit", function (feature: string, code: string) {
  act(this, "green", (cwd, x) => {
    edit(x, cwd, feature);
    mkdirSync(dirname(join(cwd, code)), { recursive: true });
    writeFileSync(join(cwd, code), CODE);
    commit(cwd, "green: hold empty orders, and the scenario");
  });
});

Given("the fix pass changes {string} to {string} in {string}", function (from: string, to: string, path: string) {
  act(this, "fix", (cwd, x) => { edit(x, cwd, path, from, to); commit(cwd, "fix: the finding, and the scenario"); });
});

Given("the fix pass's report asks to change {string} because {string}", function (path: string, reason: string) {
  asks(this, "fix", path, reason);
});

Given("the open-pr report asks to change no feature file", function () {
  // The summary pass's answer is the default one, which names no feature change, and no earlier step queued one.
  const { x } = harness(this);
  const queued = x.reports.filter((p) => p.role === "summary" && /^FEATURE CHANGE:/.test(p.line));
  assert.deepEqual(queued, [], `the summary pass's report already asks for a feature change: ${queued.map((p) => p.line).join("; ")}`);
});

// ---- the cell's request ----

function transitions(c: CellCtx): Record<string, any>[] {
  return c.calls.filter((x) => x.route === "/transition").map((x) => x.body);
}

function request(c: CellCtx): Record<string, any> {
  ranClean(c);
  const t = transitions(c).find((b) => b.event === EVENT);
  assert.ok(t, `the cell sent no feature change request; its transitions: ${transitions(c).map((b) => b.event).join(", ") || "none"}`);
  return t;
}

function filesOf(t: Record<string, any>): FeatureChangeFile[] {
  assert.ok(Array.isArray(t.featureChange) && t.featureChange.length > 0, `the request names no file: ${JSON.stringify(t)}`);
  return t.featureChange;
}

Then("item {int} moves from InProgress to FeatureChangeRequest", function (_item: number) {
  const c = harness(this).c;
  ranClean(c);
  const last = transitions(c).at(-1);
  assert.ok(last, "the cell sent no transition");
  assert.equal(next("InProgress", last.event as ItemEvent), "FeatureChangeRequest", `the item's last move was ${last.event}, which doesn't take InProgress to FeatureChangeRequest`);
  assert.equal(last.event, EVENT);
});

Then("item {int} has a feature change request", function (_item: number) {
  filesOf(request(harness(this).c));
});

Then("the request names {string} with the reason {string}", function (path: string, reason: string) {
  const { c, x } = harness(this);
  const files = filesOf(request(c));
  const f = files.find((y) => y.path === path);
  assert.ok(f, `the request doesn't name ${path}; it names ${files.map((y) => y.path).join(", ")}`);
  assert.equal(f.reason, reason, `the reason the request gives for ${path}`);
  assert.equal(f.before, lockText(c, path), `the request's before for ${path} isn't its text at the lock commit`);
  assert.equal(f.after, x.proposed.get(path), `the request's after for ${path} isn't the version the agent proposed`);
});

Then("{string} on the pushed branch matches the lock commit", function (path: string) {
  const c = harness(this).c;
  ranClean(c);
  assert.equal(at(c.dir, pushedHead(c), path), lockText(c, path), `${path} as pushed differs from the lock commit`);
});

Then("the green agent's change to {string} is on the pushed branch", function (path: string) {
  const c = harness(this).c;
  ranClean(c);
  assert.equal(at(c.dir, pushedHead(c), path), CODE, `${path} as pushed doesn't hold the green agent's change`);
});

Then("the PR is not opened", function () {
  const c = harness(this).c;
  ranClean(c);
  assert.equal(c.prBodies.length, 0, "a PR was opened");
  assert.ok(!transitions(c).some((b) => b.event === "pr_opened"), "the item moved to InReview");
});

Then("item {int} is not in FeatureChangeRequest", function (_item: number) {
  const c = harness(this).c;
  ranClean(c);
  const moved = transitions(c).filter((b) => b.event === EVENT || next("InProgress", b.event as ItemEvent) === "FeatureChangeRequest");
  assert.deepEqual(moved.map((b) => b.event), [], "the item moved to FeatureChangeRequest");
});

// ---- the comment on the PBI ----

function board(world: object): ReturnType<typeof fakeBacklog> {
  const x = mine(world);
  if (!x.board) {
    x.board = fakeBacklog();
    void x.board.seed({ externalId: "482" });
  }
  return x.board;
}

When("the cell runs and the factory handles the move", { timeout: 60_000 }, async function () {
  const { c } = harness(this);
  const b = board(this);
  await runTheCell(this);
  const t = transitions(c).find((y) => y.event === EVENT);
  // No request, no move to handle: the Thens say what's missing.
  if (t) await mirrorFeatureChange(b.adapter, "482", { eventId: "move-1", featureChange: t.featureChange ?? [] });
});

Given("item {int} has moved to FeatureChangeRequest with a request to change {string}", function (_item: number, path: string) {
  board(this);
  const before = featureText(path);
  mine(this).moved = [{ path, reason: "An empty order is held, not refused", before, after: propose(before, path) }];
});

When("the factory handles the move twice", async function () {
  const x = mine(this);
  assert.ok(x.moved, "no move was set up");
  for (let i = 0; i < 2; i++) await mirrorFeatureChange(board(this).adapter, "482", { eventId: "move-1", featureChange: x.moved });
});

/** The comments on item 482 that are about a feature change request: those that name a feature file. */
async function requestComments(world: object): Promise<string[]> {
  const all = await board(world).comments("482");
  return all.filter((body) => /\bfeatures\/\S+\.feature\b/.test(body) || /feature change/i.test(body));
}

async function theComment(world: object): Promise<string> {
  const found = await requestComments(world);
  assert.equal(found.length, 1, `item 482 has ${found.length} comments for the feature change request`);
  return found[0];
}

Then("item {int} on the board has one new comment for the feature change request", async function (_item: number) {
  await theComment(this);
});

Then("item {int} on the board has exactly one comment for the feature change request", async function (_item: number) {
  await theComment(this);
});

const PATH = /features\/[\w./-]+\.feature/g;

/** The comment from the first time it names `path` up to the first time it names another file. */
function commentPart(comment: string, path: string): string {
  const i = comment.indexOf(path);
  assert.ok(i >= 0, `the comment doesn't name ${path}:\n${comment}`);
  const rest = comment.slice(i + path.length);
  const other = [...rest.matchAll(PATH)].find((m) => m[0] !== path && !comment.slice(0, i).includes(m[0]));
  return comment.slice(i, other ? i + path.length + other.index! : comment.length);
}

const diffLines = (part: string, sign: "-" | "+") => part.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1).trim());

Then("the comment names {string}", async function (path: string) {
  commentPart(await theComment(this), path);
});

Then("the comment shows {string} as the line before and {string} as the line after", async function (before: string, after: string) {
  const comment = await theComment(this);
  const part = commentPart(comment, ORDERS);
  assert.ok(diffLines(part, "-").includes(before), `the comment doesn't show "${before}" as a line taken out:\n${part}`);
  assert.ok(diffLines(part, "+").includes(after), `the comment doesn't show "${after}" as a line put in:\n${part}`);
});

Then("the comment gives the reason {string}", async function (reason: string) {
  const part = commentPart(await theComment(this), ORDERS);
  assert.ok(part.includes(reason), `the comment doesn't give the reason "${reason}" for ${ORDERS}:\n${part}`);
});

Then("the comment shows the change to {string} with the reason {string}", async function (path: string, reason: string) {
  const part = commentPart(await theComment(this), path);
  assert.ok(diffLines(part, "-").length > 0 && diffLines(part, "+").length > 0, `the comment shows no change to ${path}:\n${part}`);
  assert.ok(part.includes(reason), `the comment doesn't give the reason "${reason}" for ${path}:\n${part}`);
});

// ---- the item page ----

const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

Before({ tags: "@pbi-364 and @db", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-364 and @db", ...long }, async function () {
  const x = (this as { pbi364?: Ctx }).pbi364;
  if (!x?.server) return;
  await x.close?.();
  x.server.closeAllConnections();
  await new Promise<void>((resolve) => x.server!.close(() => resolve()));
});

/** The feature files locked at sign-off: PBI 152's step names two, and every scenario locks the orders file. */
function locked(world: object): string[] {
  return (world as { pbi152?: { lockedFiles: string[] } }).pbi152?.lockedFiles ?? [ORDERS];
}

Given("item {int} is in FeatureChangeRequest", long, async function (item: number) {
  const x = mine(this);
  const source = await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  x.sourceId = source.rows[0].id;
  const it = await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, 'Orders', 'InProgress') returning id", [x.sourceId, String(item)]);
  x.itemId = it.rows[0].id;
  await pool().query(
    `insert into run (item_id, run_number, next_stage, scenarios_sha, features_lock_sha, locked_files) values ($1, 1, 'green', $2, $2, $3)`,
    [x.itemId, LOCK_SHA, locked(this)],
  );
});

Given("its request asks to change {string} because {string}", function (path: string, reason: string) {
  const before = featureText(path);
  mine(this).files.push({ path, reason, before, after: propose(before, path) });
});

Given("the proposed version changes {string} to {string}", function (from: string, to: string) {
  const f = mine(this).files.at(-1);
  assert.ok(f, "the request names no file yet");
  f.after = propose(f.before, f.path, from, to);
});

When("the owner opens item {int}'s page", long, async function (_item: number) {
  const x = mine(this);
  assert.ok(x.itemId && x.sourceId, "item 482 wasn't set up");
  const runId = (await pool().query<{ id: string }>("select id from run where item_id = $1", [x.itemId])).rows[0].id;
  await withTx(pool(), (c) => requestFeatureChange(c, runId, x.files));
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  x.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  const origin = `http://127.0.0.1:${(x.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin, adapter: fakeBacklog().adapter, sourceId: x.sourceId });
  x.close = handler.close;
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'owner') on conflict (provider, subject) do nothing`, [OWNER]);
  const r = await fetch(`${origin}/items/${x.itemId}`, { headers: { ...headers(OWNER), cookie: "tz=UTC" }, redirect: "manual" });
  x.page = { status: r.status, html: await r.text() };
});

function html(world: object): string {
  const p = mine(world).page;
  assert.ok(p, "no item page was opened");
  assert.equal(p.status, 200, `the item page answered ${p.status}: ${p.html.slice(0, 300)}`);
  return p.html;
}

/** The page's "Feature change request" section: what follows its <h2>, up to the next <h2>. */
function requestPart(world: object): string {
  const page = html(world);
  for (const part of page.split(/<h2\b[^>]*>/i).slice(1)) {
    const end = part.search(/<\/h2>/i);
    if (text(part.slice(0, end)) === "Feature change request") return part.slice(end + 5);
  }
  assert.fail(`the item page has no "Feature change request" section: ${text(page).slice(0, 600)}`);
}

/** Each file's entry in the section: its <h3>'s text, and the HTML after it up to the next <h3>. */
function entries(world: object): { heading: string; html: string }[] {
  return requestPart(world).split(/<h3\b[^>]*>/i).slice(1).map((part) => {
    const end = part.search(/<\/h3>/i);
    return { heading: text(part.slice(0, end)), html: part.slice(end + 5) };
  });
}

function entry(world: object, path: string): string {
  const all = entries(world);
  const e = all.find((y) => y.heading === path);
  assert.ok(e, `the Feature change request section has no heading "${path}"; its headings: ${all.map((y) => y.heading).join(", ") || "none"}`);
  return e.html;
}

/** The text of each element in `h` that carries `attr`, as `data-side="before"` or `data-reason`. */
function marked(h: string, attr: string): string[] {
  const re = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\b${attr}[^>]*>([\\s\\S]*?)</\\1>`, "gi");
  return [...h.matchAll(re)].map((m) => text(m[2]));
}

const before = (h: string) => marked(h, 'data-side="before"');
const after = (h: string) => marked(h, 'data-side="after"');
const reasons = (h: string) => marked(h, "data-reason");

function lastHeading(world: object): string {
  const p = (world as { pbi364Heading?: string }).pbi364Heading;
  assert.ok(p, "no heading was read");
  return entry(world, p);
}

Then("the page shows the heading {string}", function (path: string) {
  entry(this, path);
  (this as { pbi364Heading?: string }).pbi364Heading = path;
});

Then("under it the page shows {string} as the line before", function (line: string) {
  const lines = before(lastHeading(this));
  assert.ok(lines.includes(line), `the entry doesn't show "${line}" as a line before; it shows: ${lines.join(" | ") || "none"}`);
});

Then("under it the page shows {string} as the line after", function (line: string) {
  const lines = after(lastHeading(this));
  assert.ok(lines.includes(line), `the entry doesn't show "${line}" as a line after; it shows: ${lines.join(" | ") || "none"}`);
});

Then("under it the page shows the reason {string}", function (reason: string) {
  const shown = reasons(lastHeading(this));
  assert.ok(shown.includes(reason), `the entry doesn't show the reason "${reason}"; it shows: ${shown.join(" | ") || "none"}`);
});

Then("the page shows the change to {string} with the reason {string}", function (path: string, reason: string) {
  const h = entry(this, path);
  assert.ok(before(h).length > 0 && after(h).length > 0, `the entry for ${path} shows no line before and after`);
  assert.ok(reasons(h).includes(reason), `the entry for ${path} doesn't show the reason "${reason}"; it shows: ${reasons(h).join(" | ") || "none"}`);
});

Then("the page shows the text {string} as the line after", function (line: string) {
  const lines = entries(this).flatMap((e) => after(e.html));
  assert.ok(lines.includes(line), `the request shows no line after reading "${line}"; it shows: ${lines.join(" | ") || "none"}`);
});

Then("the page shows the text {string} as the reason", function (reason: string) {
  const shown = entries(this).flatMap((e) => reasons(e.html));
  assert.ok(shown.includes(reason), `the request shows no reason reading "${reason}"; it shows: ${shown.join(" | ") || "none"}`);
});

Then("the page holds no script or bold text from the request", function () {
  const page = html(this);
  assert.ok(!page.includes("<script>alert(1)</script>"), "the page holds the proposed line's script as markup");
  assert.ok(!/<b>held<\/b>/i.test(page), "the page holds the reason's bold text as markup");
});
