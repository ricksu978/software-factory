// Step definitions for features/pbi-347-main-green-after-8e6bd45.feature. Each check the scenarios name maps to the
// command .github/workflows/ci.yml runs for it, read from the workflow itself, so a scenario runs what CI runs:
// - "the typecheck": npm run typecheck
// - "the AppHost's compile and lint": npx tsc -p tsconfig.apphost.json --noEmit && npx eslint apphost.mts, in
//   aspire-apphost, after npm ci there and aspire restore with the Aspire CLI version the workflow pins
// - "the unit tests": npm test
// - "the scenarios that aren't tagged @local": npm run bdd -- --tags "not @local"
// The scenarios about CI's run read it from GitHub's Actions API: the latest run of the "ci" workflow on the commit this
// checkout's HEAD is at. A commit CI hasn't run on, or a run that hasn't finished, fails the Then that reads it.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const repo = resolve(import.meta.dirname, "../..");
const workflowPath = ".github/workflows/ci.yml";
const long = { timeout: 600_000 };

// ---- The workflow ----

type Step = { name?: string; uses?: string; run?: string; "working-directory"?: string };
type Workflow = { on?: unknown; jobs?: Record<string, { steps?: Step[] }> };

function readWorkflow(path = workflowPath): Workflow {
  return parse(readFileSync(join(repo, path), "utf8")) as Workflow;
}

/** Which of a job's run steps is each check the feature names, by the command CI runs for it. */
const checks: Record<string, (s: Step) => boolean> = {
  "the typecheck": (s) => s.run?.trim() === "npm run typecheck",
  "the AppHost's compile and lint": (s) =>
    s["working-directory"] === "aspire-apphost" && /\btsc -p tsconfig\.apphost\.json --noEmit\b/.test(s.run ?? "") && /\beslint apphost\.mts\b/.test(s.run ?? ""),
  "the unit tests": (s) => s.run?.trim() === "npm test",
  "the scenarios that aren't tagged @local": (s) => /^npm run bdd -- --tags "not @local"$/.test(s.run?.trim() ?? ""),
};

function ciSteps(): Step[] {
  const steps = readWorkflow().jobs?.ci?.steps;
  assert.ok(steps, `${workflowPath} has no job "ci" with steps`);
  return steps;
}

/** The step CI runs for `check`, which the step definitions run the way CI does. */
function stepFor(check: string): Step {
  const is = checks[check];
  assert.ok(is, `no check is named "${check}"`);
  const step = ciSteps().find(is);
  assert.ok(step, `${workflowPath}'s job "ci" runs no step for ${check}`);
  return step;
}

/** The Aspire CLI version the workflow installs, from its `npm install -g @microsoft/aspire-cli@<version>` step. */
function pinnedAspireVersion(): string {
  for (const s of ciSteps()) {
    const m = /@microsoft\/aspire-cli@(\S+)/.exec(s.run ?? "");
    if (m) return m[1];
  }
  assert.fail(`${workflowPath} pins no Aspire CLI version`);
}

type Ran = { status: number | null; output: string };

function sh(command: string, cwd: string, timeout = 580_000): Ran {
  const r: SpawnSyncReturns<string> = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
}

/** Runs a check's step as CI runs it: its command, in its working directory. */
function runCheck(check: string): Ran {
  const step = stepFor(check);
  return sh(step.run!, join(repo, step["working-directory"] ?? "."));
}

function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

// ---- CI's run on this commit, from GitHub ----

type GhStep = { name: string; status: string; conclusion: string | null };
type GhJob = { name: string; status: string; conclusion: string | null; steps?: GhStep[] };
type GhRun = { id: number; name: string; path: string; status: string; conclusion: string | null; head_sha: string; run_number: number; html_url: string };
type CiRun = { sha: string; run?: GhRun; jobs?: GhJob[]; error?: string };

type Ctx = { ci?: CiRun; installed?: Ran; restored?: Ran & { version: string }; appHost?: { compile: Ran; lint: Ran }; ran?: Ran };
const ctxs = new WeakMap<object, Ctx>();
function ctx(world: object): Ctx {
  let c = ctxs.get(world);
  if (!c) ctxs.set(world, (c = {}));
  return c;
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** owner/repo: GITHUB_REPOSITORY under Actions, else the origin remote's GitHub URL. */
function ghRepo(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git("remote", "get-url", "origin");
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  assert.ok(m, `origin (${url}) isn't a GitHub repository`);
  return m[1];
}

async function gh<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The latest run of the "ci" workflow on `sha`, with its jobs, or what stopped us reading it. */
async function ciRunOn(sha: string): Promise<CiRun> {
  try {
    const r = ghRepo();
    const { workflow_runs } = await gh<{ workflow_runs: GhRun[] }>(`/repos/${r}/actions/runs?head_sha=${sha}&per_page=100`);
    const run = workflow_runs.filter((w) => w.path === workflowPath || w.name === "ci").sort((a, b) => b.run_number - a.run_number)[0];
    if (!run) return { sha };
    const { jobs } = await gh<{ jobs: GhJob[] }>(`/repos/${r}/actions/runs/${run.id}/jobs?per_page=100`);
    return { sha, run, jobs };
  } catch (e) {
    return { sha, error: (e as Error).message };
  }
}

/** CI's finished run on this commit: the Thens fail when there's none, or it hasn't finished. */
function finishedRun(c: Ctx): { run: GhRun; jobs: GhJob[] } {
  const ci = c.ci;
  assert.ok(ci, "no step read CI's run");
  assert.ok(!ci.error, `couldn't read CI's run on ${ci.sha}: ${ci.error}`);
  assert.ok(ci.run && ci.jobs, `CI has no run of ${workflowPath} on commit ${ci.sha}`);
  assert.equal(ci.run.status, "completed", `CI's run on ${ci.sha} (${ci.run.html_url}) hasn't finished: it's ${ci.run.status}`);
  return { run: ci.run, jobs: ci.jobs };
}

function everyStep(jobs: GhJob[]): { job: string; step: GhStep }[] {
  return jobs.flatMap((j) => (j.steps ?? []).map((step) => ({ job: j.name, step })));
}

When("CI has finished its run on the commit this checkout is at", { timeout: 120_000 }, async function () {
  ctx(this).ci = await ciRunOn(git("rev-parse", "HEAD"));
});

Then("the job {string} passed on that commit", function (name: string) {
  const { run, jobs } = finishedRun(ctx(this));
  const job = jobs.find((j) => j.name === name);
  assert.ok(job, `CI's run ${run.html_url} has no job "${name}"; it has ${jobs.map((j) => `"${j.name}"`).join(", ") || "none"}`);
  assert.equal(job.conclusion, "success", `the job "${name}" in ${run.html_url} ended ${job.conclusion}`);
});

Then("every check in that run passed", function () {
  const { run, jobs } = finishedRun(ctx(this));
  assert.equal(run.conclusion, "success", `CI's run ${run.html_url} ended ${run.conclusion}`);
  const bad = everyStep(jobs).filter(({ step }) => step.conclusion !== "success");
  assert.deepEqual(bad.map(({ job, step }) => `${job}: ${step.name} (${step.conclusion})`), [], `checks in ${run.html_url} didn't pass`);
});

for (const how of ["skipped", "cancelled"]) {
  Then(`no check in that run was ${how}`, function () {
    const { run, jobs } = finishedRun(ctx(this));
    const bad = [
      ...jobs.filter((j) => j.conclusion === how).map((j) => `job ${j.name}`),
      ...everyStep(jobs).filter(({ step }) => step.conclusion === how).map(({ job, step }) => `${job}: ${step.name}`),
    ];
    assert.deepEqual(bad, [], `checks in ${run.html_url} were ${how}`);
  });
}

// ---- The AppHost's compile and lint ----

Given("the AppHost's packages are installed as CI installs them", long, function () {
  const step = ciSteps().find((s) => s.run?.trim() === "npm ci" && s["working-directory"] === "aspire-apphost");
  assert.ok(step, `${workflowPath} doesn't install the AppHost's packages with npm ci in aspire-apphost`);
  const ran = sh(step.run!, join(repo, "aspire-apphost"));
  assert.equal(ran.status, 0, `npm ci in aspire-apphost failed:\n${tail(ran.output)}`);
  ctx(this).installed = ran;
});

// The restore needs NuGet, which a sandbox may not reach, so this records how it ended; the compile's Then reports a
// failed restore along with the compile's errors.
Given("the Aspire CLI version CI pins has restored the AppHost's generated modules", long, function () {
  const version = pinnedAspireVersion();
  const installed = sh("aspire --version", repo, 60_000);
  const cli = installed.status === 0 && installed.output.includes(version) ? "aspire" : `npx -y @microsoft/aspire-cli@${version}`;
  ctx(this).restored = { version, ...sh(`${cli} restore --non-interactive`, repo) };
});

When("the AppHost's compile and lint run as CI runs them", long, function () {
  const step = stepFor("the AppHost's compile and lint");
  const cwd = join(repo, step["working-directory"]!);
  // CI's command joins the two with &&; they run apart here so each Then sees its own result.
  const [compile, lint] = step.run!.split("&&").map((part) => part.trim());
  ctx(this).appHost = { compile: sh(compile, cwd), lint: sh(lint, cwd) };
});

Then("the AppHost compiles with no errors", function () {
  const c = ctx(this);
  assert.ok(c.appHost, "the AppHost's compile didn't run");
  const r = c.restored;
  const restore = r && r.status !== 0 ? `\n(aspire restore with CLI ${r.version} exited ${r.status}:\n${tail(r.output, 15)})` : "";
  assert.equal(c.appHost.compile.status, 0, `the AppHost doesn't compile:\n${tail(c.appHost.compile.output)}${restore}`);
});

Then("the AppHost's lint reports no errors", function () {
  const c = ctx(this);
  assert.ok(c.appHost, "the AppHost's lint didn't run");
  assert.equal(c.appHost.lint.status, 0, `the AppHost's lint reports errors:\n${tail(c.appHost.lint.output)}`);
});

// ---- The workflow still runs every check ----

// "When I read the workflow {string}" is pbi-5.steps.ts's; the Thens below read .github/workflows/ci.yml, the one it names.

Then("it still runs on {string} alone", function (event: string) {
  const on = readWorkflow().on;
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  assert.deepEqual(events, [event]);
});

Then("its job {string} runs these checks, in order:", function (job: string, table: { hashes(): { check: string }[] }) {
  const steps = readWorkflow().jobs?.[job]?.steps;
  assert.ok(steps, `${workflowPath} has no job "${job}"`);
  const at = table.hashes().map(({ check }) => {
    const is = checks[check];
    assert.ok(is, `no check is named "${check}"`);
    const i = steps.findIndex(is);
    assert.ok(i >= 0, `the job "${job}" doesn't run ${check}`);
    return i;
  });
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `the job "${job}" runs the checks out of order`);
});

// ---- The typecheck and the unit tests ----

When("the typecheck runs as CI runs it", long, function () {
  ctx(this).ran = runCheck("the typecheck");
});

Then("the typecheck reports no errors", function () {
  const ran = ctx(this).ran;
  assert.ok(ran, "the typecheck didn't run");
  assert.equal(ran.status, 0, `the typecheck reports errors:\n${tail(ran.output)}`);
});

When("the unit tests run as CI runs them", long, function () {
  ctx(this).ran = runCheck("the unit tests");
});

Then("every unit test passes", function () {
  const ran = ctx(this).ran;
  assert.ok(ran, "the unit tests didn't run");
  assert.equal(ran.status, 0, `the unit tests failed:\n${tail(ran.output, 80)}`);
  assert.match(ran.output, /ℹ fail 0\b/);
});

Then("the unit tests include the check that the AppHost's waits match the resources the start lists", function () {
  const ran = ctx(this).ran;
  assert.ok(ran, "the unit tests didn't run");
  assert.match(ran.output, /✔ under aspire run, apphost\.mts adds every resource appHostResources\(\) lists, with the same waits/);
});
