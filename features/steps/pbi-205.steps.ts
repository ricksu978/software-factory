// Step definitions for features/pbi-205-apphost-pull-and-docker.feature. Apart from the @local scenarios, they run the
// AppHost's start, startAppHost() in src/apphost/start.ts, against fakes:
// - The checkout is a real clone of a bare `origin` in a temp directory, so a scenario can give it edits, a branch, a
//   detached HEAD or local commits of its own. A seed clone pushes the remote's new commits to `origin`'s `main`.
// - Git runs for real in the checkout, through a recorder that notes each command and when it finished. A scenario can
//   make the pull fail with a message of its own instead.
// - Docker is a fake that answers, or doesn't, by the fake clock: once Docker Desktop is launched it answers after the
//   delay the scenario names, or never.
// - The clock is fake: sleep() moves it on at once.
// - The resources are fakes: starting them records, for migrate, control and the worker, the checkout's HEAD.
// PBI 206's scenarios share these fakes, and pbi-206.steps.ts reads them through appHostCtx(). For PBI 206 the fake
// Aspire starts the resources the start hands it as Aspire does: each starts once everything it waits for has
// finished, several at once, and one whose wait failed never starts. A fake Docker records each build, and takes the
// time the scenario gives it on the fake clock.
// Commits are named in the scenarios ("aaa111"), and the steps map each name to its real sha.
// The @local scenarios run the owner's real `aspire run`, Docker Desktop and secrets, so the owner runs them.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StartStopped, startAppHost, type AppHostResource, type GitResult, type StartDeps } from "../../src/apphost/start.ts";
import type { DockerBuild } from "../../src/apphost/cell-image.ts";

const RESOURCES = ["migrate", "control", "worker"] as const;
type Resource = (typeof RESOURCES)[number];
const DESKTOP = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";

/** What the fake Docker saw of one build, as it began. */
export type BuildSeen = {
  build: DockerBuild;
  /** The context and Dockerfile, resolved against the checkout. */
  context: string;
  dockerfile: string;
  /** The Dockerfile's text, and the files the context held, as the build read them. */
  dockerfileText: string | null;
  files: Record<string, string>;
  head: string;
  /** `git status --porcelain` in the checkout as the build began. */
  status: string;
  /** The status the build ended with, once it has. */
  exit: number | null;
};

/** An image in the fake Docker. */
export type Image = { labels: Record<string, string>; files: Record<string, string> };

export type Event =
  | { kind: "git"; args: string[]; status: number; stderr: string }
  | { kind: "docker"; answered: boolean }
  | { kind: "launch"; exe: string; at: number }
  | { kind: "start"; resource: string; commit: string; at: number }
  | { kind: "build-start"; seen: BuildSeen; at: number }
  | { kind: "build-end"; seen: BuildSeen; at: number }
  | { kind: "resource-end"; resource: string; state: string; at: number }
  /** git asked for an answer at the console, as a remote that wants a username and password makes it (PBI 208). */
  | { kind: "prompt"; args: string[] };

/** A resource as the fake Aspire's dashboard shows it. */
export type Shown = { state: "Waiting" | "Running" | "Finished" | "Failed"; log: string[] };

/** The files the fake Docker copies into an image from the build's context. */
const IMAGE_FILES = ["sop/sop.yml", "src/main.ts"];

export type Ctx = {
  root: string;
  origin: string;
  seed: string;
  checkout: string;
  shas: Map<string, string>;
  /** git's message for a failed pull, when the scenario makes the pull fail. */
  pullFailure: string | null;
  /** What the scenario wrote to each uncommitted edit. */
  edits: Map<string, string>;
  docker: { answers: "always" | "after-launch"; installed: boolean; delayMs: number | null };
  /** The fake clock, in milliseconds. */
  clock: number;
  launchedAt: number | null;
  events: Event[];
  said: string[];
  warned: string[];
  stopped: StartStopped | null;
  stoppedAt: number | null;
  ran: boolean;
  /** Docker answers the start's check, then stops answering before any build. */
  dockerStopsAfterCheck: boolean;
  /** How long a build takes on the fake clock, and the error it fails with, if it fails. */
  build: { ms: number; failure: string | null };
  images: Map<string, Image>;
  dashboard: Map<string, Shown>;
  /** The environment the AppHost starts with (PBI 208). */
  env: { FACTORY_FLOAT_PORTS?: string };
  /** The remote asks for a username and password before it answers (PBI 208). */
  remoteAsks: boolean;
};

export function appHostCtx(world: object): Ctx {
  return ctx(world);
}

function ctx(world: object): Ctx {
  const c = (world as { pbi205?: Ctx }).pbi205;
  assert.ok(c, "the fake checkout wasn't set up");
  return c;
}

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "pbi-205", GIT_AUTHOR_EMAIL: "pbi-205@test", GIT_COMMITTER_NAME: "pbi-205", GIT_COMMITTER_EMAIL: "pbi-205@test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitRun = (cwd: string, args: string[]): GitResult => {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Commits a change to each of `paths` in `dir`, named `name`, and records its sha. */
export function commit(c: Ctx, dir: string, name: string, paths = [`notes/${name}.txt`]): string {
  for (const p of paths) {
    const file = join(dir, p);
    write(dir, p, `${existsSync(file) ? readFileSync(file, "utf8") : ""}${name} changed ${p}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", name);
  const sha = git(dir, "rev-parse", "HEAD");
  c.shas.set(name, sha);
  return sha;
}

export const sha = (c: Ctx, name: string) => {
  const s = c.shas.get(name);
  assert.ok(s, `no commit named ${name}`);
  return s;
};
export const head = (c: Ctx) => git(c.checkout, "rev-parse", "HEAD");
export { git, pushToRemote };
/** Brings the seed clone to `origin`'s `main`, commits `name` there and pushes it. */
function pushToRemote(c: Ctx, name: string, paths?: string[]) {
  git(c.seed, "fetch", "-q", "origin");
  git(c.seed, "reset", "-q", "--hard", "origin/main");
  commit(c, c.seed, name, paths);
  git(c.seed, "push", "-q", "origin", "HEAD:main");
}

Before({ tags: "(@pbi-205 or @pbi-206 or @pbi-208) and not @local" }, function () {
  const root = mkdtempSync(join(tmpdir(), "pbi-205-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-B", "main");
  const c: Ctx = {
    root, origin, seed, checkout, shas: new Map(), pullFailure: null, edits: new Map(),
    docker: { answers: "always", installed: true, delayMs: null },
    clock: Date.UTC(2026, 10, 15, 9, 0, 0), launchedAt: null, events: [], said: [], warned: [],
    stopped: null, stoppedAt: null, ran: false,
    dockerStopsAfterCheck: false, build: { ms: 30_000, failure: null }, images: new Map(), dashboard: new Map(),
    env: {}, remoteAsks: false,
  };
  commit(c, seed, "base", ["sop/sop.yml", "src/main.ts", "cell/Dockerfile"]);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, checkout);
  (this as { pbi205?: Ctx }).pbi205 = c;
});

After({ tags: "(@pbi-205 or @pbi-206 or @pbi-208) and not @local" }, function () {
  const c = (this as { pbi205?: Ctx }).pbi205;
  if (c) rmSync(c.root, { recursive: true, force: true });
});

// ---- Givens: the checkout and the remote ----

Given("the checkout is on branch {string} at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  git(c.checkout, "checkout", "-q", "-B", branch);
  commit(c, c.checkout, name);
  // A commit on main is main's commit: the remote has it too, unless a later step moves the remote on.
  if (branch === "main") git(c.checkout, "push", "-q", "origin", "main");
});

Given("the checkout is on branch {string} with a local commit {string} the remote doesn't have", function (branch: string, name: string) {
  const c = ctx(this);
  git(c.checkout, "checkout", "-q", "-B", branch);
  commit(c, c.checkout, name);
});

Given("the checkout is on no branch, at commit {string}", function (name: string) {
  const c = ctx(this);
  commit(c, c.checkout, name);
  git(c.checkout, "checkout", "-q", "--detach");
});

Given("the checkout has an uncommitted edit to {string}", function (path: string) {
  const c = ctx(this);
  const text = `${readFileSync(join(c.checkout, path), "utf8")}an operator's uncommitted edit\n`;
  writeFileSync(join(c.checkout, path), text);
  c.edits.set(path, text);
});

Given("the remote's {string} is at commit {string}, which fast-forwards from {string}", function (branch: string, name: string, from: string) {
  const c = ctx(this);
  assert.equal(branch, "main");
  pushToRemote(c, name);
  assert.equal(git(c.seed, "rev-parse", "HEAD~1"), sha(c, from), `${name} doesn't fast-forward from ${from}`);
});

Given("the remote's {string} is at commit {string}, which doesn't fast-forward from {string}", function (branch: string, name: string, from: string) {
  const c = ctx(this);
  assert.equal(branch, "main");
  pushToRemote(c, name);
  assert.notEqual(gitRun(c.seed, ["merge-base", "--is-ancestor", sha(c, from), "HEAD"]).status, 0, `${name} fast-forwards from ${from}`);
});

Given("the remote's {string} is at commit {string}, which also changes {string}", function (branch: string, name: string, path: string) {
  const c = ctx(this);
  assert.equal(branch, "main");
  pushToRemote(c, name, [path]);
});

Given("the remote's {string} is at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  assert.equal(branch, "main");
  pushToRemote(c, name);
});

Given("the remote's {string} is also at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  assert.equal(git(c.checkout, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0], sha(c, name));
});

Given("git's pull fails with the message {string}", function (message: string) {
  ctx(this).pullFailure = message;
});

// ---- Givens: Docker ----

Given("Docker answers", function () {
  ctx(this).docker.answers = "always";
});

Given("Docker doesn't answer", function () {
  ctx(this).docker.answers = "after-launch";
});

Given("Docker Desktop is installed", function () {
  ctx(this).docker.installed = true;
});

Given("Docker Desktop is not installed", function () {
  ctx(this).docker.installed = false;
});

Given("Docker will answer {int} seconds after Docker Desktop is launched", function (s: number) {
  ctx(this).docker.delayMs = s * 1000;
});

Given("Docker will answer {int} minutes {int} seconds after Docker Desktop is launched", function (m: number, s: number) {
  ctx(this).docker.delayMs = (m * 60 + s) * 1000;
});

Given("Docker will not answer after Docker Desktop is launched", function () {
  ctx(this).docker.delayMs = null;
});

// ---- When ----

function deps(c: Ctx): StartDeps {
  const startedAt = c.clock;
  return {
    env: { ...c.env },
    git(args) {
      // A remote that wants credentials makes git ask at the console. The fake records the ask, then fails as git does
      // when no one answers.
      if (c.remoteAsks && /^(pull|fetch|ls-remote|push)$/.test(args[0] ?? "")) {
        c.events.push({ kind: "prompt", args: [...args] });
        const r = { status: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" };
        c.events.push({ kind: "git", args: [...args], status: r.status, stderr: r.stderr });
        return r;
      }
      const r = args[0] === "pull" && c.pullFailure !== null
        ? { status: 1, stdout: "", stderr: `${c.pullFailure}\n` }
        : gitRun(c.checkout, args);
      c.events.push({ kind: "git", args: [...args], status: r.status, stderr: r.stderr });
      return r;
    },
    async dockerAnswers() {
      const d = c.docker;
      const checked = c.events.some((e) => e.kind === "docker");
      if (checked && c.dockerStopsAfterCheck) {
        c.events.push({ kind: "docker", answered: false });
        return false;
      }
      const answered = d.answers === "always"
        || (c.launchedAt !== null && d.delayMs !== null && c.clock >= c.launchedAt + d.delayMs);
      c.events.push({ kind: "docker", answered });
      return answered;
    },
    findDockerDesktop: () => (c.docker.installed ? DESKTOP : null),
    launch(exe) {
      c.launchedAt ??= c.clock;
      c.events.push({ kind: "launch", exe, at: c.clock });
    },
    async sleep(ms) {
      c.clock += ms;
      // A start that never stops waiting would hang the scenario, so the fake clock gives up after an hour.
      if (c.clock - startedAt > 3_600_000) throw new Error("the start waited more than an hour on the fake clock");
    },
    now: () => c.clock,
    say: (line) => void c.said.push(line),
    warn: (line) => void c.warned.push(line),
    dockerBuild: (build, log) => fakeDockerBuild(c, build, log),
    startResources: (resources) => fakeAspire(c, resources),
  };
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** The fake Docker's build: it reads the context as it begins, takes the scenario's time, then tags the image. */
async function fakeDockerBuild(c: Ctx, build: DockerBuild, log: (line: string) => void): Promise<number> {
  const context = join(c.checkout, build.context);
  const files: Record<string, string> = {};
  for (const f of IMAGE_FILES) {
    const text = read(join(context, f));
    if (text !== null) files[f] = text;
  }
  const seen: BuildSeen = {
    build: structuredClone(build), context, dockerfile: join(c.checkout, build.dockerfile),
    dockerfileText: read(join(c.checkout, build.dockerfile)), files, head: head(c),
    status: git(c.checkout, "status", "--porcelain"), exit: null,
  };
  c.events.push({ kind: "build-start", seen, at: c.clock });
  // Lets whatever else is starting go first, as a real build would, before the fake clock moves on.
  await new Promise((r) => setImmediate(r));
  if (c.dockerStopsAfterCheck) {
    log("ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    seen.exit = 1;
  } else {
    c.clock += c.build.ms;
    if (c.build.failure !== null) {
      log(`ERROR: ${c.build.failure}`);
      seen.exit = 1;
    } else {
      c.images.set(build.tag, { labels: { ...build.labels }, files });
      seen.exit = 0;
    }
  }
  c.events.push({ kind: "build-end", seen, at: c.clock });
  return seen.exit;
}

/**
 * The fake Aspire. A resource starts once every resource it waits for has finished, and never when one of them failed.
 * Several start at once. One with work of its own finishes or fails with it. migrate finishes once started, and the
 * rest run. 205's resources come from the same graph, so it records each one's start with the checkout's HEAD.
 */
async function fakeAspire(c: Ctx, resources: AppHostResource[]): Promise<void> {
  for (const r of resources) c.dashboard.set(r.name, { state: "Waiting", log: [] });
  const shown = (name: string) => c.dashboard.get(name);
  const running = new Set<Promise<void>>();
  /** Starts one resource whose waits have all finished, and says whether there was one. */
  const startOne = (): boolean => {
    const r = resources.find((x) => shown(x.name)!.state === "Waiting" && x.waitsFor.every((w) => shown(w)?.state === "Finished"));
    if (!r) return false;
    const s = shown(r.name)!;
    s.state = "Running";
    c.events.push({ kind: "start", resource: r.name, commit: head(c), at: c.clock });
    if (!r.run) {
      if (r.name === "migrate") s.state = "Finished";
      return true;
    }
    const p: Promise<void> = r.run((line) => void s.log.push(line)).then(
      () => void (s.state = "Finished"),
      (e: unknown) => {
        s.state = "Failed";
        s.log.push(e instanceof Error ? e.message : String(e));
      },
    ).finally(() => {
      c.events.push({ kind: "resource-end", resource: r.name, state: s.state, at: c.clock });
      running.delete(p);
    });
    running.add(p);
    return true;
  };
  const startReady = () => {
    while (startOne());
  };
  startReady();
  while (running.size > 0) {
    await Promise.race(running);
    startReady();
  }
}

/** Runs the AppHost's start against the fakes, recording where it stopped, if it did. */
export async function runStart(c: Ctx): Promise<void> {
  try {
    await startAppHost(deps(c));
  } catch (e) {
    if (!(e instanceof StartStopped)) throw e;
    c.stopped = e;
    c.stoppedAt = c.clock;
  }
  c.ran = true;
}

When("the AppHost starts", async function () {
  await runStart(ctx(this));
});

// ---- Thens ----

const starts = (c: Ctx) => c.events.filter((e): e is Extract<Event, { kind: "start" }> => e.kind === "start");
const pulls = (c: Ctx) => c.events.filter((e): e is Extract<Event, { kind: "git" }> => e.kind === "git" && e.args[0] === "pull");
const firstStart = (c: Ctx) => c.events.findIndex((e) => e.kind === "start");
/** Everything the start showed: its lines, its warnings and the message it stopped with. */
const shown = (c: Ctx) => [...c.said, ...c.warned, ...(c.stopped ? [c.stopped.message] : [])].join("\n");
const resource = (name: string): Resource => (name === "the worker" ? "worker" : (name as Resource));

Then("the checkout is at commit {string}", function (name: string) {
  const c = ctx(this);
  assert.equal(head(c), sha(c, name), `the checkout isn't at ${name}`);
});

Then("the checkout is still at commit {string}", function (name: string) {
  const c = ctx(this);
  assert.equal(head(c), sha(c, name), `the checkout moved off ${name}`);
});

Then("the checkout is still on branch {string} at commit {string}", function (branch: string, name: string) {
  const c = ctx(this);
  assert.equal(git(c.checkout, "branch", "--show-current"), branch);
  assert.equal(head(c), sha(c, name), `the checkout moved off ${name}`);
});

Then(/^(migrate|control|the worker) started on commit "([^"]*)"$/, function (name: string, commitName: string) {
  const c = ctx(this);
  const s = starts(c).find((e) => e.resource === resource(name));
  assert.ok(s, `${name} didn't start`);
  assert.equal(s.commit, sha(c, commitName), `${name} started on another commit than ${commitName}`);
});

Then(/^the pull of "([^"]*)" finished before (migrate|control|the worker) started$/, function (branch: string, name: string) {
  const c = ctx(this);
  const pull = c.events.findIndex((e) => e.kind === "git" && e.args[0] === "pull");
  assert.ok(pull >= 0, `the start ran no pull of ${branch}`);
  const start = c.events.findIndex((e) => e.kind === "start" && e.resource === resource(name));
  assert.ok(start >= 0, `${name} didn't start`);
  assert.ok(pull < start, `${name} started before the pull of ${branch} finished`);
});

Then("the start ran a fast-forward-only pull of {string} before any resource started", function (branch: string) {
  const c = ctx(this);
  const i = c.events.findIndex((e) => e.kind === "git" && e.args[0] === "pull");
  assert.ok(i >= 0, `the start ran no pull of ${branch}`);
  const args = (c.events[i] as Extract<Event, { kind: "git" }>).args;
  assert.ok(args.includes("--ff-only"), `the pull wasn't fast-forward-only: git ${args.join(" ")}`);
  assert.ok(!args.some((a) => /^--(no-ff|rebase|ff)$/.test(a)), `the pull may merge or rebase: git ${args.join(" ")}`);
  const named = args.slice(1).filter((a) => !a.startsWith("-"));
  assert.ok(named.length === 0 || named.at(-1) === branch, `the pull didn't pull ${branch}: git ${args.join(" ")}`);
  const first = firstStart(c);
  assert.ok(first < 0 || i < first, "a resource started before the pull finished");
});

Then("control, the worker and migrate all started", function () {
  const c = ctx(this);
  const started = starts(c).map((e) => e.resource);
  for (const r of RESOURCES) assert.ok(started.includes(r), `${r} didn't start`);
});

Then("control, the worker and migrate all started on commit {string}", function (name: string) {
  const c = ctx(this);
  for (const r of RESOURCES) {
    const s = starts(c).find((e) => e.resource === r);
    assert.ok(s, `${r} didn't start`);
    assert.equal(s.commit, sha(c, name), `${r} started on another commit than ${name}`);
  }
});

Then("the start stops with git's message about the failed pull", function () {
  const c = ctx(this);
  assert.ok(c.stopped, "the start didn't stop");
  const failed = pulls(c).find((p) => p.status !== 0);
  assert.ok(failed, "the start ran no pull that failed");
  const lines = failed.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, "git's failed pull said nothing");
  for (const l of lines) assert.ok(shown(c).includes(l), `the start didn't show git's line "${l}"`);
});

Then("the start stops", function () {
  assert.ok(ctx(this).stopped, "the start didn't stop");
});

Then("the start did not stop", function () {
  const c = ctx(this);
  assert.equal(c.stopped, null, `the start stopped: ${c.stopped?.message}`);
});

Then("the start shows {string}", function (text: string) {
  // PBI 326's "the start shows" is a subagent's start on its transcript page, which it hands over through the world.
  const hook = (this as { startShows?: (text: string) => void }).startShows;
  if (hook) return hook(text);
  const c = ctx(this);
  assert.ok(shown(c).includes(text), `the start didn't show "${text}". It showed: ${JSON.stringify(shown(c))}`);
});

Then("no resource has started", function () {
  const c = ctx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  assert.deepEqual(starts(c).map((e) => e.resource), [], "a resource started");
});

Then("the checkout has no merge commit", function () {
  const c = ctx(this);
  assert.equal(git(c.checkout, "rev-list", "--merges", "HEAD"), "", "the checkout has a merge commit");
});

Then("the checkout still has its uncommitted edit to {string}", function (path: string) {
  const c = ctx(this);
  assert.equal(readFileSync(join(c.checkout, path), "utf8"), c.edits.get(path), `the uncommitted edit to ${path} changed`);
  assert.match(git(c.checkout, "status", "--porcelain", "--", path), /^ ?M/, `${path} is no longer an uncommitted edit`);
});

Then("the start shows a warning that it is on branch {string}, not {string}, so it runs as it is", function (branch: string, main: string) {
  const c = ctx(this);
  const w = c.warned.find((l) => l.includes(branch) && l.includes(main));
  assert.ok(w, `the start warned of no branch ${branch}, not ${main}. Warnings: ${JSON.stringify(c.warned)}`);
  assert.match(w, /as it is/, `the warning doesn't say it runs as it is: ${w}`);
});

Then("the start shows a warning that it is not on {string}, so it runs as it is", function (main: string) {
  const c = ctx(this);
  const w = c.warned.find((l) => l.includes(main) && /\bnot\b/i.test(l));
  assert.ok(w, `the start warned of not being on ${main}. Warnings: ${JSON.stringify(c.warned)}`);
  assert.match(w, /as it is/, `the warning doesn't say it runs as it is: ${w}`);
});

Then("the start ran no pull", function () {
  const c = ctx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  const changing = c.events.filter((e) => e.kind === "git" && /^(pull|fetch|merge|rebase|reset|checkout|switch|stash)$/.test(e.args[0] ?? ""));
  assert.deepEqual(changing, [], "the start pulled or changed the checkout");
});

Then("the start checked that Docker answers before any resource started", function () {
  const c = ctx(this);
  const i = c.events.findIndex((e) => e.kind === "docker");
  assert.ok(i >= 0, "the start never checked Docker");
  const first = firstStart(c);
  assert.ok(first < 0 || i < first, "a resource started before the start checked Docker");
});

Then("the start did not launch Docker Desktop", function () {
  const c = ctx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  assert.deepEqual(c.events.filter((e) => e.kind === "launch"), [], "the start launched Docker Desktop");
});

Then("the start shows that it is starting Docker Desktop", function () {
  const c = ctx(this);
  assert.match(shown(c), /starting docker desktop/i, `the start didn't show it was starting Docker Desktop: ${JSON.stringify(shown(c))}`);
});

Then("the start launched Docker Desktop once", function () {
  const c = ctx(this);
  const launches = c.events.filter((e): e is Extract<Event, { kind: "launch" }> => e.kind === "launch");
  assert.equal(launches.length, 1, `the start launched Docker Desktop ${launches.length} times`);
  assert.equal(launches[0]!.exe, DESKTOP);
});

Then("no resource started before Docker answered", function () {
  const c = ctx(this);
  const answered = c.events.findIndex((e) => e.kind === "docker" && e.answered);
  const first = firstStart(c);
  assert.ok(first < 0 || (answered >= 0 && answered < first), "a resource started before Docker answered");
});

Then("the start stops after waiting {int} minutes", function (minutes: number) {
  const c = ctx(this);
  assert.ok(c.stopped, "the start didn't stop");
  assert.ok(c.launchedAt !== null, "the start never launched Docker Desktop");
  const waited = c.stoppedAt! - c.launchedAt;
  // It checks Docker every few seconds, so it may stop a little past the deadline, but never before it.
  assert.ok(waited >= minutes * 60_000, `the start stopped after waiting only ${waited / 1000} seconds`);
  assert.ok(waited <= minutes * 60_000 + 10_000, `the start waited ${waited / 1000} seconds`);
});

// ---- @local: the owner runs these on their machine, and the PR records the run ----
// Steps record what they see and assert only in Then, as PBI 6's do.

const repo = process.cwd();
const APPHOST = "--apphost . --non-interactive --nologo";
const local = { timeout: 600_000 };
const sh = (cmd: string) => spawnSync(cmd, { cwd: repo, shell: true, encoding: "utf8" });
const until = async (ok: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return ok();
};
/** The resources `aspire describe` shows, by name, with their state. Names and states only: describe shows secrets. */
function resources(): Map<string, string> {
  const out = sh(`aspire describe --format Json ${APPHOST}`).stdout ?? "";
  try {
    const doc = JSON.parse(out.slice(out.indexOf("{"))) as { resources?: Record<string, unknown>[] };
    return new Map((doc.resources ?? []).map((r) => [String(r.displayName ?? r.name), String(r.state ?? "")]));
  } catch {
    return new Map();
  }
}

export type Local = { branch: string; behind: number; remote: string; dockerUp: boolean; run: ChildProcess | null; headAtFirstResource: string | null };
export const lctx = (world: object): Local => {
  const w = world as { pbi205local?: Local };
  w.pbi205local ??= { branch: "", behind: -1, remote: "", dockerUp: false, run: null, headAtFirstResource: null };
  return w.pbi205local;
};

After({ tags: "(@pbi-205 or @pbi-206 or @pbi-208) and @local" }, function () {
  const l = (this as { pbi205local?: Local }).pbi205local;
  if (l?.run) {
    sh(`aspire stop ${APPHOST}`);
    l.run.kill();
  }
});

Given("the owner's checkout is on branch {string}, one merged commit behind the remote's {string}", function (_branch: string, main: string) {
  const l = lctx(this);
  sh(`git fetch -q origin ${main}`);
  l.branch = (sh("git branch --show-current").stdout ?? "").trim();
  l.behind = Number((sh(`git rev-list --count HEAD..origin/${main}`).stdout ?? "").trim());
  l.remote = (sh(`git rev-parse origin/${main}`).stdout ?? "").trim();
});

Given("the owner has quit Docker Desktop", function () {
  lctx(this).dockerUp = sh("docker version").status === 0;
});

When("the owner starts {string}", function (cmd: string) {
  const l = lctx(this);
  l.run = spawn(cmd, { cwd: repo, shell: true, stdio: "ignore" });
});

Then("the checkout is at the remote's {string} commit before any resource shows as starting in the Aspire dashboard", local, async function (main: string) {
  const l = lctx(this);
  assert.equal(l.branch, main, `the owner's checkout was on ${l.branch}, not ${main}`);
  assert.equal(l.behind, 1, `the owner's checkout was ${l.behind} commits behind origin/${main}, not 1`);
  const seen = await until(() => resources().size > 0, 300_000);
  l.headAtFirstResource = (sh("git rev-parse HEAD").stdout ?? "").trim();
  assert.ok(seen, "no resource showed in the Aspire dashboard within 5 minutes");
  assert.equal(l.headAtFirstResource, l.remote, `the checkout wasn't at origin/${main} when the first resource showed`);
});

Then("control, the worker and migrate run that commit", local, async function () {
  const l = lctx(this);
  const up = await until(() => {
    const r = resources();
    return r.get("migrate") === "Finished" && r.get("control") === "Running" && r.get("worker") === "Running";
  }, 300_000);
  assert.ok(up, `control, the worker and migrate didn't all come up: ${JSON.stringify([...resources()])}`);
  assert.equal((sh("git rev-parse HEAD").stdout ?? "").trim(), l.remote, "the checkout moved off the pulled commit");
});

Then("Docker Desktop starts", local, async function () {
  const l = lctx(this);
  assert.equal(l.dockerUp, false, "Docker was already running, so this proves nothing");
  assert.ok(await until(() => sh("docker version").status === 0, 240_000), "Docker didn't come up");
});

Then("Postgres, Azurite, migrate, control and the worker all come up in the Aspire dashboard", local, async function () {
  const up = await until(() => {
    const r = resources();
    const running = (re: RegExp) => [...r].some(([n, s]) => re.test(n) && s === "Running");
    return running(/^pg(-|$)/) && running(/^storage(-|$)/) && r.get("migrate") === "Finished" && running(/^control(-|$)/) && running(/^worker(-|$)/);
  }, 420_000);
  assert.ok(up, `not everything came up: ${JSON.stringify([...resources()])}`);
});
