// Step definitions for features/pbi-261-default-policies-from-main.feature. The worker runs against fakes:
// - `main` is PBI 210's: a bare git repo in a temp directory, and the operator's checkout is a clone of it. Here `main`
//   also holds the factory's default policies under policy/, so a scenario can merge a change to one, or give the
//   checkout an edit or a local commit of its own. The worker's fetch of `main` is PBI 210's cell image poll, which
//   runs before each board poll, and its image builder is PBI 210's fake Docker.
// - The board, the repo host and the readiness judge are PBI 12's poller harness, so its "the poller runs once" and
//   PBI 149's history steps read the same context. The judge records each dor.md line it's asked about.
// The worker runs from the operator's checkout, so the code's own policy directory is the checkout's policy/. The code
// under test here runs from this repo, so FACTORY_POLICY_DIR points it at the fake checkout's policy/ instead.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy, type PolicyName } from "../../src/policy/policy.ts";
import { readinessFingerprint } from "../../src/watcher/poller.ts";
import { mainDefaults } from "../../src/worker/main-defaults.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { baseFiles, baseline, ctx as pollCtx, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { gateIntoNotReady, moves } from "./pbi-149.steps.ts";
import { freshDb } from "./pbi-17.steps.ts";
import {
  cellFor, commit, ctx as mainCtx, current, endFactory, git, poll as pollMain, readOr, runningIn, sha, startMain, write, type Ctx as MainCtx,
} from "./pbi-210.steps.ts";
import { REVISION_LABEL } from "../../src/worker/cell-image.ts";

type Ctx = {
  /** The board's external id of each item a scenario names. */
  names: Map<string, string>;
  /** FACTORY_POLICY_DIR as it was before the scenario. */
  env: string | undefined;
  /** The fingerprint taken by "the readiness fingerprint ... was taken". */
  fingerprint?: string;
  /** The line the last "holds the line" or "adds the line" step named, for "replaces that line". */
  line?: string;
  /** The text of each default a cell loaded, by file name. */
  loaded: Map<string, string>;
};

function ctx(world: object): Ctx {
  const c = (world as { pbi261?: Ctx }).pbi261;
  assert.ok(c, "the Background hasn't set up the factory");
  return c;
}

/** The factory's default policies on the fake `main` at the Background's commit. */
const DEFAULTS: Record<string, string> = {
  "policy/dor.md": "# Definition of Ready: factory default\n\n- [ ] Size is 5 or less\n",
  "policy/scenarios.md": "# Scenarios: factory default\n\nKeep each scenario short.\n",
  "policy/pr-review.md": "# PR review: factory default\n\n- [ ] Names every changed file\n",
  "policy/risk.md": "# Risk: factory default\n\nLow means docs only.\n",
};

/** dor.md and pr-review.md lines are criteria. The other defaults' lines are prose. */
const asLine = (file: string, line: string) => (file === "dor.md" || file === "pr-review.md" ? `- [ ] ${line}\n` : `${line}\n`);

/** The commit the checkout's remote-tracking `main` names: the one the worker last fetched. */
const fetched = (c: MainCtx) => git(c.checkout, "rev-parse", "refs/remotes/origin/main");

/** A file's text at a commit of `main`, as the fake writes it. git() trims, which drops the last newline. */
const atCommit = (c: MainCtx, name: string, path: string) => `${git(c.origin, "show", `${sha(c, name)}:${path}`)}\n`;

Before({ tags: "@pbi-261", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-261", ...long }, async function () {
  const c = (this as { pbi261?: Ctx }).pbi261;
  if (c) {
    if (c.env === undefined) delete process.env.FACTORY_POLICY_DIR;
    else process.env.FACTORY_POLICY_DIR = c.env;
  }
  await endFactory(this);
});

/** Puts `repo` on the fake repo host with a dod.md and a config.yml but no policy file a default stands in for. */
async function serve(c: PollCtx, repo: string): Promise<void> {
  for (const path of [".factory/dod.md", ".factory/config.yml"]) c.host!.files.set(`${repo}@w1:${path}`, baseFiles[path]);
  c.host!.heads.set(repo, "w1");
  await need().pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${repo}`]);
}

// ---- the Background ----

Given("the factory serves repo {string}, which has no policy files of its own", long, async function (repo: string) {
  // PBI 17's database, which the scheduler of the @ac-4 scenarios reads, then PBI 12's board and repo host on it.
  await freshDb(this, 2);
  const c = pollCtx(this);
  assert.ok(await setup(c), "the fake board or the test database isn't there");
  c.askedLines = new Map();
  await serve(c, repo);
  (this as { pbi261?: Ctx }).pbi261 = { names: new Map(), env: process.env.FACTORY_POLICY_DIR, loaded: new Map() };
});

Given("the factory also serves repo {string}, which has no policy files of its own", long, async function (repo: string) {
  await serve(pollCtx(this), repo);
});

Given("the worker last fetched `main` at commit {string}", long, async function (name: string) {
  await startMain(this, name, DEFAULTS);
  const m = mainCtx(this);
  // The worker runs from the checkout, so the policy directory beside its code is the checkout's.
  process.env.FACTORY_POLICY_DIR = join(m.checkout, "policy");
  const c = pollCtx(this);
  const world = this;
  // The worker fetches `main` on each poll. A failed fetch is logged and the poll goes on.
  c.beforePoll = async () => {
    try {
      await pollMain(world);
    } catch {
      // The worker's loop logs it and tries again on the next poll.
    }
  };
  c.defaults = mainDefaults({ checkout: m.checkout });
  assert.equal(fetched(m), sha(m, name), `the worker last fetched ${fetched(m)}, not ${name}`);
});

Given("the default {string} at commit {string} holds the line {string}", function (file: string, name: string, line: string) {
  const m = mainCtx(this);
  const text = atCommit(m, name, `policy/${file}`);
  assert.ok(text.includes(line), `the default ${file} at ${name} doesn't hold "${line}":\n${text}`);
  ctx(this).line = line;
});

// ---- main and the operator's checkout ----

function mainGains(world: object, name: string, file: string, change: (text: string) => string) {
  const m = mainCtx(world);
  const path = `policy/${file}`;
  write(m.seed, path, change(readOr(join(m.seed, path))));
  commit(m, m.seed, name, []);
  git(m.seed, "push", "-q", "origin", "main");
}

Given("`main` gains commit {string} whose default {string} adds the line {string}", function (name: string, file: string, line: string) {
  mainGains(this, name, file, (text) => `${text}${asLine(file, line)}`);
  ctx(this).line = line;
});

Given("`main` gains commit {string} whose default {string} replaces that line with {string}", function (name: string, file: string, line: string) {
  const old = ctx(this).line;
  assert.ok(old, "no earlier step named the line to replace");
  mainGains(this, name, file, (text) => {
    assert.ok(text.includes(old), `the default ${file} doesn't hold "${old}"`);
    return text.replace(old, line);
  });
  ctx(this).line = line;
});

Given("`main` can't be fetched", function () {
  const m = mainCtx(this);
  git(m.checkout, "remote", "set-url", "origin", join(m.root, "gone.git"));
});

When("the worker fetches `main`", long, async function () {
  await pollMain(this);
});

Given("the operator's checkout has an uncommitted edit to {string} that adds the line {string}", function (path: string, line: string) {
  const m = mainCtx(this);
  const text = `${readOr(join(m.checkout, path))}${asLine(path.split("/").pop()!, line)}`;
  write(m.checkout, path, text);
  m.checkoutEdit = { path, text };
});

// A Given in one scenario and a When in another.
Given("the operator's checkout gains an uncommitted edit to {string}", function (path: string) {
  const m = mainCtx(this);
  const text = `${readOr(join(m.checkout, path))}the operator's uncommitted edit\n`;
  write(m.checkout, path, text);
  m.checkoutEdit = { path, text };
});

Given("the operator's checkout holds a local commit {string} that isn't on `main` and adds the line {string} to {string}", function (name: string, line: string, path: string) {
  const m = mainCtx(this);
  write(m.checkout, path, `${readOr(join(m.checkout, path))}${asLine(path.split("/").pop()!, line)}`);
  const local = commit(m, m.checkout, name, []);
  assert.notEqual(git(m.origin, "rev-parse", "main"), local, `${name} is on main`);
});

Given("the operator's checkout still holds the default {string} from commit {string}", function (file: string, name: string) {
  const m = mainCtx(this);
  assert.equal(readOr(join(m.checkout, "policy", file)), atCommit(m, name, `policy/${file}`), `the checkout's ${file} isn't the one in ${name}`);
});

// ---- the board ----

Given("a new item {string} in repo {string} arrives on the board", long, async function (name: string, repo: string) {
  const c = pollCtx(this);
  const ext = await c.fake!.seed({ labels: ["factory"], repo, title: `item ${name}` });
  c.extIds = [ext];
  ctx(this).names.set(name, ext);
});

/** Seeds `n` items in `repo` and gates them into `state` with a failing judge while `main` is at commit `name`. */
async function holds(world: object, n: number, repo: string, state: string, name: string) {
  const m = mainCtx(world);
  assert.equal(fetched(m), sha(m, name), `the worker last fetched ${fetched(m)}, not ${name}`);
  const c = pollCtx(world);
  c.extIds = [];
  for (let i = 0; i < n; i++) c.extIds.push(await c.fake!.seed({ labels: ["factory"], repo }));
  await gateIntoNotReady(world, c, state);
  c.askedLines?.clear();
}

Given("the factory holds two items in repo {string} in state {string}, checked against commit {string}", long, async function (repo: string, state: string, name: string) {
  await holds(this, 2, repo, state, name);
});

Given("the factory holds an item in repo {string} in state {string}, checked against commit {string}", long, async function (repo: string, state: string, name: string) {
  await holds(this, 1, repo, state, name);
});

Given("neither the items nor the repo's own files change", long, async function () {
  const c = pollCtx(this);
  polled(c);
  assert.ok(c.baseline, "the setup recorded no baseline to compare against");
  assert.deepEqual(await baseline(c), c.baseline, "an item or the repo's own files changed after the setup");
});

// ---- the judge ----

Given("the readiness judge fails the line {string} because {string}", function (line: string, reason: string) {
  const c = pollCtx(this);
  c.judge = "fail";
  c.failText = { text: line, reason };
});

Then("the readiness judge was asked about the line {string} for item {string}", function (line: string, name: string) {
  const c = pollCtx(this);
  polled(c);
  const ext = ctx(this).names.get(name);
  assert.ok(ext, `no item ${name}`);
  const asked = c.askedLines?.get(ext) ?? [];
  assert.ok(asked.includes(line), `the judge wasn't asked about "${line}" for item ${name}, only about ${JSON.stringify(asked)}`);
});

Then("the readiness judge was not asked about the line {string}", function (line: string) {
  const c = pollCtx(this);
  polled(c);
  const all = [...(c.askedLines?.values() ?? [])].flat();
  assert.ok(all.length > 0, "the judge was asked about no line at all");
  assert.ok(!all.includes(line), `the judge was asked about "${line}"`);
});

Then("the item's history shows no move {string}", long, async function (event: string) {
  const c = pollCtx(this);
  polled(c);
  assert.equal(c.extIds.length, 1, `the scenario holds ${c.extIds.length} items`);
  assert.equal(await moves(c, c.extIds[0], event), 0);
});

// ---- the fingerprint ----

async function fingerprint(world: object, repo: string): Promise<string> {
  const c = pollCtx(world);
  return readinessFingerprint({ pool: need().pool, repoHost: c.host!, repo, ...(c.defaults ? { defaults: c.defaults } : {}) });
}

Given("the readiness fingerprint for repo {string} was taken with `main` at commit {string}", long, async function (repo: string, name: string) {
  const m = mainCtx(this);
  assert.equal(fetched(m), sha(m, name), `the worker last fetched ${fetched(m)}, not ${name}`);
  ctx(this).fingerprint = await fingerprint(this, repo);
});

Then("the readiness fingerprint for repo {string} is unchanged", long, async function (repo: string) {
  const before = ctx(this).fingerprint;
  assert.ok(before, "no fingerprint was taken");
  assert.equal(await fingerprint(this, repo), before, "the fingerprint changed");
});

Then("the readiness fingerprint for repo {string} differs from the one taken at commit {string}", long, async function (repo: string, _name: string) {
  const before = ctx(this).fingerprint;
  assert.ok(before, "no fingerprint was taken");
  assert.notEqual(await fingerprint(this, repo), before, "the fingerprint is the one taken before");
});

// ---- cells ----

Given("item {string} is running in a cell on the cell image built from commit {string}", long, async function (item: string, name: string) {
  const m = mainCtx(this);
  assert.equal(current(m)?.labels[REVISION_LABEL], sha(m, name), `the cell image wasn't built from ${name}`);
  await runningIn(this, item, `cell-${item}`);
});

// A cell runs the factory's code from its image, so its policy directory is the image's policy/.
When("the cell for item {string} loads its default {string}", async function (item: string, file: string) {
  const m = mainCtx(this);
  const image = cellFor(this, item).image;
  assert.ok(image, `the cell for item ${item} runs no image`);
  const dir = mkdtempSync(join(m.root, "cell-"));
  for (const [path, text] of image.files) write(dir, path, text);
  const before = process.env.FACTORY_POLICY_DIR;
  process.env.FACTORY_POLICY_DIR = join(dir, "policy");
  try {
    const policy = await loadPolicy(async () => null, file.replace(/\.md$/, "") as PolicyName);
    assert.ok(policy, `the cell loaded no ${file}`);
    ctx(this).loaded.set(file, policy.text);
  } finally {
    if (before === undefined) delete process.env.FACTORY_POLICY_DIR;
    else process.env.FACTORY_POLICY_DIR = before;
  }
});

function loaded(world: object, file: string): string {
  const text = ctx(world).loaded.get(file);
  assert.ok(text !== undefined, `no cell loaded ${file}`);
  return text;
}

Then("the cell's {string} holds the line {string}", function (file: string, line: string) {
  assert.ok(loaded(this, file).includes(line), `the cell's ${file} doesn't hold "${line}"`);
});

Then("the cell's {string} doesn't hold the line {string}", function (file: string, line: string) {
  assert.ok(!loaded(this, file).includes(line), `the cell's ${file} holds "${line}"`);
});
