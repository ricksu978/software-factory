// Step definitions for features/pbi-210-cell-image-rebuild.feature. Apart from the @local scenario, the factory runs
// against fakes:
// - `main` is a bare git repo in a temp directory, and the operator's checkout is a clone of it, so a scenario can give
//   the checkout edits, a branch or local commits of its own.
// - The image builder is a fake Docker. It snapshots the files in the build context it's given and the image's labels,
//   and points the tag at that image.
// - The cell launcher resolves the tag as each cell starts, as `docker run factory-cell:local` does, and records the
//   image the cell runs.
// The scheduler, the event log and Floor are the real ones, on PBI 4's shared database. Items are PBI 17's. Floor is
// opened through PBI 89's control plane. Commits are named in the scenarios ("aaa111"), and the steps map each name to
// its real sha.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { tick } from "../../src/scheduler/scheduler.ts";
import {
  BUILD_FAILED_EVENT, CELL_IMAGE, REBUILT_EVENT, REVISION_LABEL, pollCellImage, startCellImage, type CellImageDeps,
} from "../../src/worker/cell-image.ts";
import { open, startControlPlane, ctx as p89 } from "./pbi-89.steps.ts";
import { ctx as p17, freshDb } from "./pbi-17.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Image = { id: string; labels: Record<string, string>; files: Map<string, string> };
type Cell = { name: string; itemId: string; image: Image | null };

type Ctx = {
  root: string;
  origin: string;
  /** Pushes new commits to `main`, as a merged PR does. */
  seed: string;
  checkout: string;
  shas: Map<string, string>;
  /** The fake Docker's images by id, and the tags that point at them. */
  images: Map<string, Image>;
  tags: Map<string, string>;
  /** The builds since the factory started, the start-up build left out. */
  builds: number;
  /** Errors the next builds throw, in order. Once used up, builds succeed. `always` makes every build throw. */
  failures: string[];
  always: string | null;
  cells: Map<string, Cell>;
  stopped: string[];
  /** When the scenario began, so the event log is read from then on. */
  since: Date;
  exits: unknown[];
  /** Whether the factory has polled yet. Steps whose wording is both a Given and a Then set up before it, and check after. */
  polled: boolean;
  checkoutEdit?: { path: string; text: string };
  /** Set by the @local scenario, which runs against the owner's real factory. */
  local?: { merged: string; before: string; imageBefore: string };
};

function ctx(world: object): Ctx {
  const c = (world as { pbi210?: Ctx }).pbi210;
  assert.ok(c, "the Background hasn't set up the fake main");
  return c;
}

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "pbi-210", GIT_AUTHOR_EMAIL: "pbi-210@test", GIT_COMMITTER_NAME: "pbi-210", GIT_COMMITTER_EMAIL: "pbi-210@test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

// Cell-side files, control plane and worker files, and code both sides share.
const FILES = [
  "README.md", "sop/sop.yml", "policy/dor.md", "cell/Dockerfile", "cell/claude/agents/factory-pr-reviewer.md", "src/cell/engine.ts",
  "src/scheduler/scheduler.ts", "src/worker/main.ts", "src/control/cell-api.ts", "src/core/states.ts",
];

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Commits a change to each of `paths` in `dir`, named `name`, and records its sha. */
function commit(c: Ctx, dir: string, name: string, paths: string[]): string {
  for (const p of paths) write(dir, p, `${readOr(join(dir, p))}${name} changed ${p}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", name);
  const sha = git(dir, "rev-parse", "HEAD");
  c.shas.set(name, sha);
  return sha;
}

function readOr(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const sha = (c: Ctx, name: string) => {
  const s = c.shas.get(name);
  assert.ok(s, `no commit is named ${name}`);
  return s;
};

/** Every file in `dir`, by its path relative to it, leaving out .git. */
function snapshot(dir: string, under = dir, files = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(under)) {
    if (name === ".git") continue;
    const p = join(under, name);
    if (statSync(p).isDirectory()) snapshot(dir, p, files);
    else files.set(relative(dir, p).split("\\").join("/"), readFileSync(p, "utf8"));
  }
  return files;
}

function deps(c: Ctx): CellImageDeps {
  return {
    pool: need().pool,
    checkout: c.checkout,
    builder: {
      async build({ tag, context, labels }) {
        c.builds++;
        const failure = c.always ?? c.failures.shift();
        if (failure) throw new Error(failure);
        const image: Image = { id: `sha256:image${c.images.size + 1}`, labels: { ...labels }, files: snapshot(context) };
        c.images.set(image.id, image);
        c.tags.set(tag, image.id);
      },
      async revision(tag) {
        return current(c, tag)?.labels[REVISION_LABEL] ?? null;
      },
    },
    tag: CELL_IMAGE,
    log: { log: () => {}, error: () => {} },
  };
}

const current = (c: Ctx, tag = CELL_IMAGE): Image | null => {
  const id = c.tags.get(tag);
  return id ? c.images.get(id) ?? null : null;
};

const describe = (i: Image | null) => (i ? `${i.id}, labelled ${JSON.stringify(i.labels)}` : "no image");

/** Asserts `image` records commit `name` and holds exactly that commit's files. */
function builtFrom(c: Ctx, image: Image | null, name: string) {
  const want = sha(c, name);
  assert.ok(image, `there is no image, where one built from ${name} was expected`);
  assert.equal(image.labels[REVISION_LABEL], want, `the image records ${image.labels[REVISION_LABEL] ?? "no commit"}, not ${name} (${want})`);
  const tracked = git(c.origin, "ls-tree", "-r", "--name-only", want).split("\n").filter(Boolean);
  for (const p of tracked) {
    assert.equal(image.files.get(p), git(c.origin, "show", `${want}:${p}`) + "\n", `the image's ${p} isn't the one in ${name}`);
  }
}

After({ tags: "@pbi-210", ...long }, async function () {
  const w = this as { pbi210?: Ctx; pbi89?: unknown };
  const c = w.pbi210;
  if (w.pbi89) {
    const control = p89(this);
    await control.close?.();
    if (control.server) {
      control.server.closeAllConnections();
      await new Promise<void>((resolve) => control.server!.close(() => resolve()));
    }
  }
  if (c?.root) rmSync(c.root, { recursive: true, force: true });
});

// ---- the Background ----

// The Background's Given and a Then share this wording. Before the factory has polled, it sets the factory up.
// Afterwards it checks the image.
Given("the cell image {string} was built from commit {string}", long, async function (tag: string, name: string) {
  const w = this as { pbi210?: Ctx };
  if (w.pbi210) {
    assert.ok(w.pbi210.polled, "the scenario checks the cell image before the factory has polled");
    return builtFrom(w.pbi210, current(w.pbi210, tag), name);
  }
  assert.equal(tag, CELL_IMAGE);
  await startFactory(this, name);
});

/** A fresh database, `main` at commit `name`, the operator's checkout cloned from it, and the factory's start-up build. */
async function startFactory(world: object, name: string) {
  // Two cells can run at once, so PBI 210's side-by-side scenario can start one beside the one already running.
  await freshDb(world, 2);
  const since = (await need().pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0].now;
  const root = mkdtempSync(join(tmpdir(), "pbi210-"));
  const c: Ctx = {
    root, origin: join(root, "origin.git"), seed: join(root, "seed"), checkout: join(root, "checkout"), shas: new Map(),
    images: new Map(), tags: new Map(), builds: 0, failures: [], always: null, cells: new Map(), stopped: [], since, exits: [], polled: false,
  };
  (world as { pbi210?: Ctx }).pbi210 = c;
  git(root, "init", "-q", "--bare", "-b", "main", c.origin);
  git(root, "init", "-q", "-b", "main", c.seed);
  for (const p of FILES) write(c.seed, p, `${p}\n`);
  commit(c, c.seed, name, []);
  git(c.seed, "remote", "add", "origin", c.origin);
  git(c.seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", c.origin, c.checkout);
  // The factory's start-up build. Only the builds after it are counted.
  await startCellImage(deps(c));
  c.builds = 0;
}

Given("the factory last saw `main` at commit {string}", function (name: string) {
  const c = ctx(this);
  assert.equal(git(c.origin, "rev-parse", "main"), sha(c, name), `main isn't at ${name}`);
});

// ---- main and the operator's checkout ----

function gains(world: object, name: string, paths: string[]) {
  const c = ctx(world);
  commit(c, c.seed, name, paths);
  git(c.seed, "push", "-q", "origin", "main");
}

Given("`main` gains commit {string} that changes only {string}", function (name: string, path: string) {
  gains(this, name, [path]);
});

Given("`main` then gains commit {string} that changes only {string}", function (name: string, path: string) {
  gains(this, name, [path]);
});

Given("`main` gains commit {string} that changes {string}", function (name: string, path: string) {
  gains(this, name, [path]);
});

Given("`main` gains commit {string} that changes {string} and {string}", function (name: string, a: string, b: string) {
  gains(this, name, [a, b]);
});

Given("`main` is still at commit {string}", function (name: string) {
  const c = ctx(this);
  assert.equal(git(c.origin, "rev-parse", "main"), sha(c, name), `main isn't at ${name}`);
});

Given("the operator's checkout has an uncommitted edit to {string}", function (path: string) {
  const c = ctx(this);
  const text = `${readOr(join(c.checkout, path))}the operator's uncommitted edit\n`;
  write(c.checkout, path, text);
  c.checkoutEdit = { path, text };
});

Given("the operator's checkout is on branch {string} at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  git(c.checkout, "checkout", "-q", "-b", branch);
  commit(c, c.checkout, name, ["README.md"]);
});

Given("the operator's checkout holds a local commit {string} that changes {string} and isn't on `main`", function (name: string, path: string) {
  const c = ctx(this);
  commit(c, c.checkout, name, [path]);
});

// ---- building ----

Given("building the cell image fails with {string}", function (error: string) {
  ctx(this).always = error;
});

Given("building the cell image fails once with {string}, then succeeds", function (error: string) {
  ctx(this).failures = [error];
});

// ---- cells ----

function launcher(c: Ctx) {
  return {
    // As `docker run factory-cell:local` does, the tag is resolved as the cell starts.
    async start(env: Record<string, string>) {
      const name = `cell-${c.cells.size + 1}`;
      c.cells.set(name, { name, itemId: env.ITEM_ID, image: current(c) });
      return name;
    },
    async stop(name: string) {
      c.stopped.push(name);
    },
  };
}

Given("item {string} is running in cell {string} on the cell image built from commit {string}", long, async function (item: string, cell: string, _name: string) {
  const c = ctx(this);
  const s = p17(this);
  const source = await need().pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const r = await need().pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, 'InProgress', 1, 1, $4, now() + interval '1 hour') returning id`,
    [source.rows[0].id, item, `item ${item}`, cell],
  );
  s.items[item] = r.rows[0].id;
  await s.backlog?.seed({ externalId: item, repo: "ricksu978/software-factory" });
  await need().pool.query("insert into run (item_id, next_stage, execution_name, branch) values ($1, 'green', $2, 'factory/pbi-x-r1')", [r.rows[0].id, cell]);
  // The cell started on whatever image the tag pointed at then: the one the start-up build made.
  c.cells.set(cell, { name: cell, itemId: r.rows[0].id, image: current(c) });
});

When("the scheduler starts a cell for item {string}", long, async function (_item: string) {
  const c = ctx(this);
  const s = p17(this);
  const backlog = s.backlog!.adapter as never;
  await tick({
    pool: need().pool, launcher: launcher(c), now: new Date(), killFlag: false,
    repoHost: s.repoHost as never, backlogFor: () => backlog,
    secret: "scenario-secret", controlUrl: "http://control.test:7400", sopVersion: "default@1",
  });
});

function cellFor(world: object, item: string): Cell {
  const c = ctx(world);
  const id = p17(world).items[item];
  const cell = [...c.cells.values()].find((x) => x.itemId === id);
  assert.ok(cell, `no cell started for item ${item}`);
  return cell;
}

Then("the cell for item {string} runs the cell image built from commit {string}", function (item: string, name: string) {
  builtFrom(ctx(this), cellFor(this, item).image, name);
});

Then("cell {string} has not been stopped or restarted", function (cell: string) {
  const c = ctx(this);
  assert.ok(!c.stopped.includes(cell), `${cell} was stopped`);
  assert.equal([...c.cells.keys()].filter((n) => n === cell).length, 1, `${cell} was started again`);
});

Then("cell {string} still runs the cell image built from commit {string}", function (cell: string, name: string) {
  const c = ctx(this);
  const running = c.cells.get(cell);
  assert.ok(running, `there's no cell ${cell}`);
  builtFrom(c, running.image, name);
});

// ---- polling ----

async function poll(world: object) {
  const c = ctx(world);
  c.polled = true;
  if (c.local) return waitForLocalRebuild(c);
  // A restart of the worker or the control plane would end this process, so an exit is recorded instead of taken.
  const exit = process.exit;
  process.exit = ((code?: number) => {
    c.exits.push(code);
  }) as typeof process.exit;
  try {
    await pollCellImage(deps(c));
  } finally {
    process.exit = exit;
  }
}

When("the factory polls once", long, async function () {
  await poll(this);
});

When("the factory polls again", long, async function () {
  await poll(this);
});

// ---- the image ----

Then("the cell image {string} has been rebuilt from commit {string}", function (tag: string, name: string) {
  const c = ctx(this);
  assert.ok(c.builds > 0, "the cell image hasn't been rebuilt");
  builtFrom(c, current(c, tag), name);
});

Then("the cell image has been built exactly once", function () {
  assert.equal(ctx(this).builds, 1, "the cell image wasn't built exactly once");
});

Then("the cell image has been built twice", function () {
  assert.equal(ctx(this).builds, 2, "the cell image wasn't built twice");
});

Then("the cell image has not been built", function () {
  assert.equal(ctx(this).builds, 0, "the cell image was built");
});

Then("the image {string} records that it was built from commit {string}", function (tag: string, name: string) {
  const c = ctx(this);
  const image = current(c, tag);
  assert.equal(image?.labels[REVISION_LABEL], sha(c, name), `${tag} is ${describe(image)}, which doesn't record ${name}`);
});

Then("the image's {string} matches commit {string}, not the checkout's edit", function (path: string, name: string) {
  const c = ctx(this);
  const file = current(c)?.files.get(path);
  assert.equal(file, git(c.origin, "show", `${sha(c, name)}:${path}`) + "\n", `the image's ${path} isn't the one in ${name}`);
  assert.notEqual(file, c.checkoutEdit?.text, `the image's ${path} is the checkout's edit`);
});

Then("the image's {string} matches commit {string}, not commit {string}", function (path: string, name: string, other: string) {
  const c = ctx(this);
  const file = current(c)?.files.get(path);
  assert.equal(file, git(c.origin, "show", `${sha(c, name)}:${path}`) + "\n", `the image's ${path} isn't the one in ${name}`);
  assert.notEqual(file, git(c.checkout, "show", `${sha(c, other)}:${path}`) + "\n", `the image's ${path} is the one in ${other}`);
});

// ---- the operator's checkout ----

Then("the operator's checkout still has its uncommitted edit to {string}", function (path: string) {
  const c = ctx(this);
  assert.equal(readOr(join(c.checkout, path)), c.checkoutEdit?.text, `the checkout's ${path} lost its edit`);
  // Read untrimmed: git() trims, which would drop the leading space that marks an edit not staged.
  const status = execFileSync("git", ["status", "--porcelain", "--", path], { cwd: c.checkout, env: gitEnv, encoding: "utf8" });
  assert.match(status, /^ M /, `the checkout's ${path} no longer shows as edited`);
});

Then("the operator's checkout is still on branch {string} at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  assert.equal(git(c.checkout, "branch", "--show-current"), branch);
  assert.equal(git(c.checkout, "rev-parse", "HEAD"), sha(c, name));
});

// ---- no restart ----

async function restartPrepared(): Promise<boolean> {
  const r = await need().pool.query("select 1 from override where scope = 'factory' and kind = 'restart'");
  return (r.rowCount ?? 0) > 0;
}

Then("the control plane has not restarted", long, async function () {
  assert.deepEqual(ctx(this).exits, [], "the poll ended the process");
  assert.equal(await restartPrepared(), false, "the poll prepared a restart");
});

Then("the worker has not restarted", long, async function () {
  assert.deepEqual(ctx(this).exits, [], "the poll ended the process");
  assert.equal(await restartPrepared(), false, "the poll prepared a restart");
});

// ---- the event log ----

async function events(c: Ctx, kind: string): Promise<Record<string, string>[]> {
  const r = await need().pool.query<{ payload: Record<string, string> }>("select payload from event where kind = $1 and at >= $2 order by at", [kind, c.since]);
  return r.rows.map((x) => x.payload);
}

Then("the event log holds one cell image rebuild event", long, async function () {
  const rebuilds = await events(ctx(this), REBUILT_EVENT);
  assert.equal(rebuilds.length, 1, `the event log holds ${rebuilds.length} cell image rebuild events`);
});

Then("that event names old commit {string} and new commit {string}", long, async function (from: string, to: string) {
  const c = ctx(this);
  const [e] = await events(c, REBUILT_EVENT);
  assert.ok(e, "the event log holds no cell image rebuild event");
  assert.equal(e.from, sha(c, from), `the rebuild event's old commit is ${e.from}, not ${from}`);
  assert.equal(e.to, sha(c, to), `the rebuild event's new commit is ${e.to}, not ${to}`);
});

Then("the event log holds a cell image rebuild event naming old commit {string} and new commit {string}", long, async function (from: string, to: string) {
  const c = ctx(this);
  const rebuilds = await events(c, REBUILT_EVENT);
  assert.ok(rebuilds.some((e) => e.from === sha(c, from) && e.to === sha(c, to)), `no rebuild event names ${from} and ${to}: ${JSON.stringify(rebuilds)}`);
});

Then("the event log holds a failed cell image build event for commit {string} naming {string}", long, async function (name: string, error: string) {
  const c = ctx(this);
  const failed = await events(c, BUILD_FAILED_EVENT);
  assert.ok(failed.some((e) => e.commit === sha(c, name) && String(e.error).includes(error)), `no failed build event for ${name} names "${error}": ${JSON.stringify(failed)}`);
});

// ---- Floor ----

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Floor's lines, as text, read afresh through the control plane. */
async function floorLines(world: object): Promise<string[]> {
  const control = p89(world);
  if (!control.server) {
    // PBI 89's control plane adds a board of its own, which an earlier scenario's left behind.
    await need().pool.query("delete from backlog_source where url = 'pbi-89'");
    await startControlPlane(world);
    await need().pool.query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'pbi210-viewer', 'pbi210-viewer', 'viewer') on conflict do nothing`);
    control.login = "pbi210-viewer";
  }
  await open(control, "/");
  assert.equal(control.status, 200, "Floor didn't open");
  return control.html!.split(/<\/p>|<\/li>|<\/div>|\n/).map((l) => unescape(l.replace(/<[^>]*>/g, "")).trim()).filter(Boolean);
}

const imageLines = (lines: string[]) => lines.filter((l) => /cell image/i.test(l));
const short = (s: string) => s.slice(0, 7);

// Both a Given and a Then. Before the factory polls, Floor shows what the Background's start-up build recorded, so the
// Given checks Floor against that build's commit, and the Thens check it against the rebuild's.
Then("Floor shows the cell image was built from commit {string}", long, async function (name: string) {
  const c = ctx(this);
  const want = short(sha(c, name));
  const lines = imageLines(await floorLines(this));
  assert.ok(lines.some((l) => /built from/i.test(l) && l.includes(want)), `Floor doesn't show the cell image was built from ${name} (${want}): ${JSON.stringify(lines)}`);
});

Then("Floor says a restart is needed to pick up commit {string}", long, async function (name: string) {
  const want = short(sha(ctx(this), name));
  const lines = await floorLines(this);
  assert.ok(lines.some((l) => /restart/i.test(l) && /need/i.test(l) && l.includes(want)), `Floor doesn't say a restart is needed to pick up ${name} (${want})`);
});

Then("Floor doesn't say a restart is needed", long, async function () {
  const lines = await floorLines(this);
  assert.ok(imageLines(lines).length > 0, "Floor shows nothing about the cell image");
  const asks = lines.filter((l) => /restart/i.test(l) && /need/i.test(l));
  assert.deepEqual(asks, [], "Floor says a restart is needed");
});

// ---- @local: the owner runs this against the factory `npm run factory` started, and the PR records the run ----

const APPHOST = "--apphost . --non-interactive --nologo";
const sh = (cmd: string) => spawnSync(cmd, { shell: true, encoding: "utf8" });
const label = () => sh(`docker image inspect ${CELL_IMAGE} --format "{{index .Config.Labels \\"${REVISION_LABEL}\\"}}"`).stdout.trim();
const imageId = () => sh(`docker image inspect ${CELL_IMAGE} --format "{{.Id}}"`).stdout.trim();
/** The resources' details from `aspire describe`, which name each one's start time, so a restart changes them. */
const session = () => sh(`aspire describe --format Json ${APPHOST}`).stdout.replace(/"(value|FACTORY_[A-Z_]+|CELL_SECRET|GITHUB_[A-Z_]+)"\s*:\s*"[^"]*"/g, "");

Given("the factory is running under `aspire run`", long, function () {
  const before = session();
  assert.match(before, /"name"\s*:\s*"worker/, "`aspire run` isn't running the factory");
  // The Background's fakes stay unused: from here on the scenario runs against the owner's factory.
  ctx(this).local = { merged: "", before, imageBefore: imageId() };
});

// The owner merges such a PR just before the run. This finds it as `main`'s newest commit.
Given("a commit that changes only {string} is merged to `main`", long, function (path: string) {
  const c = ctx(this);
  assert.equal(sh("git fetch -q origin main").status, 0, "git fetch failed");
  const merged = sh("git rev-parse origin/main").stdout.trim();
  const changed = sh(`git diff --name-only ${merged}~1 ${merged}`).stdout.trim().split("\n");
  assert.deepEqual(changed, [path], `main's newest commit, ${merged}, changes ${changed.join(", ")}`);
  c.local!.merged = merged;
});

/** Waits for the factory's own poll to rebuild the image, for up to ten minutes. The Thens check what it did. */
async function waitForLocalRebuild(c: Ctx) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline && label() !== c.local!.merged) await new Promise((r) => setTimeout(r, 5_000));
}

Then("the Docker image {string} carries the merged commit", function (tag: string) {
  assert.equal(tag, CELL_IMAGE);
  assert.equal(label(), ctx(this).local!.merged, `${tag} doesn't carry the merged commit`);
});

Then("the `aspire run` session is the one that was already running", function () {
  assert.equal(session(), ctx(this).local!.before, "the `aspire run` session's resources have restarted");
});

// The owner queues an item for this step, and it waits up to ten minutes for the factory to start its cell.
Then("the next cell the factory starts runs that image", { timeout: 660_000 }, async function () {
  const want = imageId();
  assert.notEqual(want, ctx(this).local!.imageBefore, "the image wasn't replaced");
  const cells = () => sh(`docker ps -a --filter network=factory-cells --format "{{.ID}}"`).stdout.trim().split("\n").filter(Boolean);
  const seen = new Set(cells());
  const deadline = Date.now() + 600_000;
  let fresh: string | undefined;
  while (!fresh && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    fresh = cells().find((id) => !seen.has(id) && !/egress/.test(sh(`docker inspect ${id} --format "{{.Name}}"`).stdout));
  }
  assert.ok(fresh, "the factory started no cell within ten minutes");
  assert.equal(sh(`docker inspect ${fresh} --format "{{.Image}}"`).stdout.trim(), want, "the new cell doesn't run the rebuilt image");
});
