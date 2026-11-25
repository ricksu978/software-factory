// Step definitions for features/pbi-206-apphost-cell-image-resource.feature. Apart from the @local scenarios, they run
// the AppHost's start, startAppHost() in src/apphost/start.ts, against the fakes in pbi-205.steps.ts, which also holds
// the steps the two features share ("When the AppHost starts", the checkout's branch, commits and edits):
// - The checkout is a real clone of a bare `origin` in a temp directory.
// - Docker is a fake that records each build: what the build's context and Dockerfile held as it began, the checkout's
//   HEAD and status then, and when it began and ended on the fake clock. A build that succeeds tags the image with the
//   build's labels and the context's files. A scenario can make a build slow or fail, or make Docker stop answering.
// - Aspire is a fake: it starts each resource the start hands it once everything it waits for has finished, shows each
//   one's state and log in its dashboard, and records when each started.
// The @local scenarios run the owner's real `aspire run` and Docker Desktop, so the owner runs them.
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REVISION_LABEL } from "../../src/apphost/cell-image.ts";
import { appHostCtx, commit, git, sha, type BuildSeen, type Ctx, type Event } from "./pbi-205.steps.ts";

// ---- Givens ----

Given("the checkout is at commit {string} with no uncommitted edits", function (name: string) {
  const c = appHostCtx(this);
  git(c.checkout, "checkout", "-q", "-B", "main");
  commit(c, c.checkout, name);
  git(c.checkout, "push", "-q", "origin", "main");
  assert.equal(git(c.checkout, "status", "--porcelain"), "", "the checkout has uncommitted edits");
});

Given("the checkout is on branch {string} at commit {string} with no uncommitted edits", function (branch: string, name: string) {
  const c = appHostCtx(this);
  git(c.checkout, "checkout", "-q", "-B", branch);
  commit(c, c.checkout, name);
  assert.equal(git(c.checkout, "status", "--porcelain"), "", "the checkout has uncommitted edits");
});

Given("the checkout's {string} differs from the one on {string}", function (path: string, main: string) {
  const c = appHostCtx(this);
  git(c.checkout, "checkout", "-q", "-B", "my-dockerfile");
  commit(c, c.checkout, "dockerfile-change", [path]);
  assert.notEqual(readFileSync(join(c.checkout, path), "utf8"), git(c.checkout, "show", `origin/${main}:${path}`) + "\n");
});

Given("the image {string} already exists, built from commit {string}", function (tag: string, name: string) {
  const c = appHostCtx(this);
  const old = randomBytes(20).toString("hex");
  c.shas.set(name, old);
  c.images.set(tag, { labels: { [REVISION_LABEL]: old }, files: {} });
});

Given("building {string} takes {int} minutes", function (_tag: string, minutes: number) {
  appHostCtx(this).build.ms = minutes * 60_000;
});

Given("building {string} fails with the error {string}", function (_tag: string, error: string) {
  appHostCtx(this).build.failure = error;
});

Given("building {string} fails", function (_tag: string) {
  appHostCtx(this).build.failure = 'failed to solve: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1';
});

Given("Docker stops answering after the AppHost's Docker check", function () {
  appHostCtx(this).dockerStopsAfterCheck = true;
});

// ---- Thens ----

type BuildStart = Extract<Event, { kind: "build-start" }>;
type Start = Extract<Event, { kind: "start" }>;

/** The build of `tag`, with where its start and end sit among the events. */
function buildOf(c: Ctx, tag: string): { seen: BuildSeen; startAt: number; startIdx: number; endIdx: number } {
  assert.ok(c.ran, "the AppHost didn't start");
  const startIdx = c.events.findIndex((e) => e.kind === "build-start" && e.seen.build.tag === tag);
  assert.ok(startIdx >= 0, `the start never built ${tag}`);
  const start = c.events[startIdx] as BuildStart;
  const endIdx = c.events.findIndex((e) => e.kind === "build-end" && e.seen === start.seen);
  assert.ok(endIdx >= 0, `the build of ${tag} never finished`);
  return { seen: start.seen, startAt: start.at, startIdx, endIdx };
}

const workerStart = (c: Ctx): { idx: number; e: Start | null } => {
  const idx = c.events.findIndex((e) => e.kind === "start" && e.resource === "worker");
  return { idx, e: idx >= 0 ? (c.events[idx] as Start) : null };
};

function shown(c: Ctx, name: string) {
  assert.ok(c.ran, "the AppHost didn't start");
  const s = c.dashboard.get(name);
  assert.ok(s, `the dashboard shows no resource named ${name}. It shows: ${JSON.stringify([...c.dashboard.keys()])}`);
  return s;
}

function image(c: Ctx, tag: string) {
  const i = c.images.get(tag);
  assert.ok(i, `Docker has no image ${tag}`);
  return i;
}

/** That `resource` ran the build of `tag`: it started before the build began and ended after it did. */
function ranBuild(c: Ctx, resource: string, tag: string) {
  shown(c, resource);
  const b = buildOf(c, tag);
  const started = c.events.findIndex((e) => e.kind === "start" && e.resource === resource);
  const ended = c.events.findIndex((e) => e.kind === "resource-end" && e.resource === resource);
  assert.ok(started >= 0 && started < b.startIdx, `${resource} hadn't started when the build of ${tag} began`);
  assert.ok(ended > b.endIdx, `${resource} didn't run the build of ${tag} to its end`);
  return b;
}

Then("the dashboard shows a resource named {string}", function (name: string) {
  shown(appHostCtx(this), name);
});

Then("{string} built {string} from the checkout's files at commit {string}", function (resource: string, tag: string, name: string) {
  const c = appHostCtx(this);
  const { seen } = ranBuild(c, resource, tag);
  assert.equal(resolve(seen.context), resolve(c.checkout), `the build's context was ${seen.context}, not the checkout`);
  assert.equal(seen.head, sha(c, name), `the checkout wasn't at ${name} when the build began`);
  assert.equal(seen.status, "", `the checkout had uncommitted edits when the build began: ${seen.status}`);
});

Then("{string} built {string} with the checkout's {string}", function (resource: string, tag: string, path: string) {
  const c = appHostCtx(this);
  const { seen } = ranBuild(c, resource, tag);
  assert.equal(resolve(seen.dockerfile), resolve(join(c.checkout, path)), `the build used ${seen.dockerfile}, not the checkout's ${path}`);
  assert.equal(seen.dockerfileText, readFileSync(join(c.checkout, path), "utf8"), `the build's ${path} isn't the checkout's`);
});

Then("the image {string} records commit {string}", function (tag: string, name: string) {
  const c = appHostCtx(this);
  assert.equal(image(c, tag).labels[REVISION_LABEL], sha(c, name), `${tag} doesn't record ${name}`);
});

Then("the image {string} still records commit {string}", function (tag: string, name: string) {
  const c = appHostCtx(this);
  assert.equal(image(c, tag).labels[REVISION_LABEL], sha(c, name), `${tag} no longer records ${name}`);
});

Then("the image {string} records no commit", function (tag: string) {
  const c = appHostCtx(this);
  buildOf(c, tag);
  const labels = image(c, tag).labels;
  assert.equal(labels[REVISION_LABEL], undefined, `${tag} records commit ${labels[REVISION_LABEL]}`);
});

Then("the image {string} holds the edited {string}", function (tag: string, path: string) {
  const c = appHostCtx(this);
  buildOf(c, tag);
  const edited = c.edits.get(path);
  assert.ok(edited, `the scenario made no edit to ${path}`);
  assert.equal(image(c, tag).files[path], edited, `${tag} doesn't hold the edited ${path}`);
});

Then("{string} shows as finished in the dashboard", function (name: string) {
  const s = shown(appHostCtx(this), name);
  assert.equal(s.state, "Finished", `${name} shows as ${s.state}`);
});

Then("{string} shows as failed in the dashboard", function (name: string) {
  const s = shown(appHostCtx(this), name);
  assert.equal(s.state, "Failed", `${name} shows as ${s.state}`);
});

Then("the log of {string} shows {string}", function (name: string, text: string) {
  const s = shown(appHostCtx(this), name);
  assert.ok(s.log.some((l) => l.includes(text)), `the log of ${name} doesn't show "${text}". It shows: ${JSON.stringify(s.log)}`);
});

Then("the build of {string} finished before the worker started", function (tag: string) {
  const c = appHostCtx(this);
  const b = buildOf(c, tag);
  const w = workerStart(c);
  assert.ok(w.e, "the worker didn't start");
  assert.ok(b.endIdx < w.idx, `the worker started before the build of ${tag} finished`);
});

Then("the worker started after the build of {string} finished", function (tag: string) {
  const c = appHostCtx(this);
  const b = buildOf(c, tag);
  const w = workerStart(c);
  assert.ok(w.e, "the worker didn't start");
  assert.ok(b.endIdx < w.idx, `the worker started before the build of ${tag} finished`);
});

Then("the worker started", function () {
  const c = appHostCtx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  assert.ok(workerStart(c).e, "the worker didn't start");
});

Then("the worker never starts", function () {
  const c = appHostCtx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  assert.equal(workerStart(c).e, null, "the worker started");
});

Then("the worker had not started {int} minutes into the build", function (minutes: number) {
  const c = appHostCtx(this);
  const b = buildOf(c, "factory-cell:local");
  const end = c.events[b.endIdx] as Extract<Event, { kind: "build-end" }>;
  assert.ok(end.at - b.startAt > minutes * 60_000, `the build took only ${(end.at - b.startAt) / 1000} seconds`);
  const w = workerStart(c);
  assert.ok(!w.e || w.e.at >= b.startAt + minutes * 60_000, `the worker started ${((w.e?.at ?? 0) - b.startAt) / 1000} seconds into the build`);
});

Then("the pull of {string} finished before the build of {string} started", function (branch: string, tag: string) {
  const c = appHostCtx(this);
  const b = buildOf(c, tag);
  const pull = c.events.findIndex((e) => e.kind === "git" && e.args[0] === "pull");
  assert.ok(pull >= 0, `the start ran no pull of ${branch}`);
  assert.ok(pull < b.startIdx, `the build of ${tag} started before the pull of ${branch} finished`);
});

// ---- @local: the owner runs these on their machine, and the PR records the run ----
// "When the owner starts {string}" is PBI 205's, in pbi-205.steps.ts, which also stops the run afterwards.

const repo = process.cwd();
const APPHOST = "--apphost . --non-interactive --nologo";
const local = { timeout: 900_000 };
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
const FAILED = /^(Failed|FailedToStart|Exited)$/;

type Local206 = { branch: string; clean: boolean; head: string; brokenStep: boolean };
const l206 = (world: object): Local206 => {
  const w = world as { pbi206local?: Local206 };
  w.pbi206local ??= { branch: "", clean: false, head: "", brokenStep: false };
  return w.pbi206local;
};

Given("the owner's checkout is on branch {string} with no uncommitted edits", function (_branch: string) {
  const l = l206(this);
  l.branch = (sh("git branch --show-current").stdout ?? "").trim();
  l.clean = (sh("git status --porcelain").stdout ?? "").trim() === "";
});

Given("the owner's checkout is on a branch whose {string} has a step that always fails", function (path: string) {
  const l = l206(this);
  l.branch = (sh("git branch --show-current").stdout ?? "").trim();
  l.brokenStep = /^RUN\s+(false|exit 1)\b/m.test(readFileSync(join(repo, path), "utf8"));
});

Then("the Aspire dashboard shows {string} finished before the worker shows as running", local, async function (name: string) {
  const l = l206(this);
  assert.equal(l.branch, "main", `the owner's checkout was on ${l.branch}, not main`);
  assert.ok(l.clean, "the owner's checkout had uncommitted edits");
  let finishedFirst = true;
  const up = await until(() => {
    const r = resources();
    if (r.get("worker") === "Running" && r.get(name) !== "Finished") finishedFirst = false;
    return r.get(name) === "Finished" && r.get("worker") === "Running";
  }, 840_000);
  assert.ok(finishedFirst, `the worker showed as running before ${name} finished`);
  assert.ok(up, `${name} and the worker didn't both come up: ${JSON.stringify([...resources()])}`);
  l.head = (sh("git rev-parse HEAD").stdout ?? "").trim();
});

Then("the image {string} on the owner's Docker records the checkout's commit", function (tag: string) {
  const l = l206(this);
  const label = (sh(`docker image inspect --format "{{ index .Config.Labels \\"${REVISION_LABEL}\\" }}" ${tag}`).stdout ?? "").trim();
  assert.equal(label, l.head, `${tag} records ${label || "no commit"}, not the checkout's ${l.head}`);
});

Then("the Aspire dashboard shows {string} as failed, with Docker's error in its console", local, async function (name: string) {
  const l = l206(this);
  assert.ok(l.brokenStep, "the owner's cell/Dockerfile has no step that always fails, so this proves nothing");
  const failed = await until(() => FAILED.test(resources().get(name) ?? ""), 840_000);
  assert.ok(failed, `${name} didn't show as failed: ${JSON.stringify([...resources()])}`);
  const logs = sh(`aspire logs ${name} ${APPHOST}`).stdout ?? "";
  assert.match(logs, /ERROR|failed to solve|did not complete successfully/i, `${name}'s console shows no Docker error`);
});

Then("the Aspire dashboard never shows the worker as running", local, async function () {
  const ranWorker = await until(() => resources().get("worker") === "Running", 60_000);
  assert.equal(ranWorker, false, "the worker showed as running");
});
