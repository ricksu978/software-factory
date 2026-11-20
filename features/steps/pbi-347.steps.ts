// Step definitions for features/pbi-347-main-green-after-8e6bd45.feature. Each check the scenarios name maps to the
// command .github/workflows/ci.yml runs for it, read from the workflow itself, so a scenario runs what CI runs:
// - "the typecheck": npm run typecheck
// - "the AppHost's compile and lint": npx tsc -p tsconfig.apphost.json --noEmit && npx eslint apphost.mts, in
//   aspire-apphost, after npm ci there and aspire restore with the Aspire CLI version the workflow pins
// - "the unit tests": npm test
// - "the scenarios that aren't tagged @local": npm run bdd -- --tags "not @local"
// The scenarios about CI's run read it from GitHub's Actions API: the latest run of the "ci" workflow on the commit this
// checkout's HEAD is at, through the proxy the environment names. The When waits for a run on HEAD that's still going. A
// commit CI hasn't run on, or a run that still hasn't finished, fails the Then that reads it.
// Where aspire restore can't reach NuGet (a factory cell), the AppHost's compile and lint come from CI's run on HEAD, which
// runs them the same way (appHostAsCiRanIt).
// Under Actions the scenarios run inside CI's run on HEAD, which can't finish before they do, so they read that run as it
// will have finished once they pass (settledThisRun).
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
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

type Ctx = {
  ci?: CiRun;
  installed?: Ran;
  restored?: Ran & { version: string; nugetUnreachable: boolean };
  appHost?: { compile: Ran; lint: Ran };
  ran?: Ran;
};
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

/**
 * Reaches GitHub through the proxy the environment names, if any. A factory cell's commands get HTTPS_PROXY but not
 * NODE_USE_ENV_PROXY, so fetch() would go direct, and a cell has no direct egress: the agent uses the proxy itself.
 */
const ghAgent = new https.Agent({ keepAlive: false, proxyEnv: process.env });

function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = https.get(url, { agent: ghAgent, headers, timeout: 30_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      res.on("error", fail);
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", fail);
  });
}

async function gh<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "software-factory-bdd",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  // A network error or a 5xx gets up to two more tries; a 4xx doesn't.
  for (let attempt = 1; ; attempt++) {
    const res = await get(`https://api.github.com${path}`, headers).catch((e: Error) => ({ status: 0, body: e.message }));
    if (res.status >= 200 && res.status < 300) return JSON.parse(res.body) as T;
    if ((res.status >= 400 && res.status < 500) || attempt >= 3) throw new Error(`GET ${path}: ${res.status || "network error"} ${res.body}`);
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
}

/**
 * The run of the "ci" workflow these scenarios run inside, when they run under Actions: GITHUB_RUN_ID names it. Its bdd
 * step is the one running them, so the run can't have finished while they read it.
 */
function isThisRun(run: GhRun): boolean {
  return process.env.GITHUB_ACTIONS === "true" && String(run.id) === process.env.GITHUB_RUN_ID;
}

/**
 * The run of the "ci" workflow on `sha`, with its jobs, or what stopped us reading it: the run these scenarios run
 * inside, if they run inside one on `sha`, else the latest.
 */
async function ciRunOn(sha: string): Promise<CiRun> {
  try {
    const r = ghRepo();
    const { workflow_runs } = await gh<{ workflow_runs: GhRun[] }>(`/repos/${r}/actions/runs?head_sha=${sha}&per_page=100`);
    const runs = workflow_runs.filter((w) => w.path === workflowPath || w.name === "ci").sort((a, b) => b.run_number - a.run_number);
    const run = runs.find(isThisRun) ?? runs[0];
    if (!run) return { sha };
    const { jobs } = await gh<{ jobs: GhJob[] }>(`/repos/${r}/actions/runs/${run.id}/jobs?per_page=100`);
    return { sha, run, jobs };
  } catch (e) {
    return { sha, error: (e as Error).message };
  }
}

/** Whether a step GitHub lists by its name ("Run <command>") is the one CI runs for `check`. */
function stepIs(check: string, step: GhStep): boolean {
  return checks[check]({ run: step.name.replace(/^Run /, "") });
}

/**
 * The run these scenarios run inside, as it will have finished once they pass. Every other job, and every step before
 * the scenarios' own, must have finished. The scenarios' step is still running, and only the job's post steps may wait
 * after it. That step's result is the scenarios' own: it passes only when every scenario passes, this one included,
 * and when it fails the job and the run fail with it. So it counts as passed here, and the job's and the run's
 * conclusions follow from the steps.
 */
function settledThisRun(run: GhRun, jobs: GhJob[]): { run: GhRun; jobs: GhJob[] } {
  const scenarios = "the scenarios that aren't tagged @local";
  const open = jobs.filter((j) => j.status !== "completed");
  assert.deepEqual(open.map((j) => j.name), [process.env.GITHUB_JOB ?? "ci"], `in CI's run ${run.html_url}, which runs these scenarios, only their own job may still be running`);
  const own = open[0];
  const steps = own.steps ?? [];
  const at = steps.findIndex((s) => s.status === "in_progress");
  assert.ok(at >= 0 && stepIs(scenarios, steps[at]), `in CI's run ${run.html_url}, the step running is ${steps[at]?.name ?? "none"}, not the one that runs ${scenarios}`);
  const unfinishedBefore = steps.slice(0, at).filter((s) => s.status !== "completed");
  assert.deepEqual(unfinishedBefore.map((s) => s.name), [], `in CI's run ${run.html_url}, steps before the scenarios haven't finished`);
  const after = steps.slice(at + 1).filter((s) => s.status !== "completed" && !/^Post /.test(s.name) && s.name !== "Complete job");
  assert.deepEqual(after.map((s) => s.name), [], `in CI's run ${run.html_url}, checks after the scenarios haven't run`);
  const ownSteps = [...steps.slice(0, at), { ...steps[at], status: "completed", conclusion: "success" }];
  const ownJob: GhJob = { ...own, status: "completed", conclusion: ownSteps.every((s) => s.conclusion === "success" || s.conclusion === "skipped") ? "success" : "failure", steps: ownSteps };
  const settled = jobs.map((j) => (j === own ? ownJob : j));
  const conclusion = settled.every((j) => j.conclusion === "success") ? "success" : "failure";
  return { run: { ...run, status: "completed", conclusion }, jobs: settled };
}

/**
 * CI's finished run on this commit: the Thens fail when there's none, or it hasn't finished. Under Actions, the run
 * these scenarios run inside can't finish before they do, so they read it as it will have finished (settledThisRun).
 */
function finishedRun(c: Ctx): { run: GhRun; jobs: GhJob[] } {
  const ci = c.ci;
  assert.ok(ci, "no step read CI's run");
  assert.ok(!ci.error, `couldn't read CI's run on ${ci.sha}: ${ci.error}`);
  assert.ok(ci.run && ci.jobs, `CI has no run of ${workflowPath} on commit ${ci.sha}`);
  if (isThisRun(ci.run)) return settledThisRun(ci.run, ci.jobs);
  assert.equal(ci.run.status, "completed", `CI's run on ${ci.sha} (${ci.run.html_url}) hasn't finished: it's ${ci.run.status}`);
  return { run: ci.run, jobs: ci.jobs };
}

function everyStep(jobs: GhJob[]): { job: string; step: GhStep }[] {
  return jobs.flatMap((j) => (j.steps ?? []).map((step) => ({ job: j.name, step })));
}

/** How long the When waits for CI's run on HEAD to finish, when it has one that's still going. */
const ciWait = { totalMs: 15 * 60_000, everyMs: 20_000 };

When("CI has finished its run on the commit this checkout is at", { timeout: ciWait.totalMs + 120_000 }, async function () {
  const sha = git("rev-parse", "HEAD");
  const until = Date.now() + ciWait.totalMs;
  let ci = await ciRunOn(sha);
  // A run still going on HEAD (not the one these scenarios run inside) is waited for; the Thens judge it once it ends.
  while (ci.run && ci.run.status !== "completed" && !isThisRun(ci.run) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, ciWait.everyMs));
    ci = await ciRunOn(sha);
  }
  ctx(this).ci = ci;
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

// The restore needs NuGet, which a factory cell's egress allowlist doesn't reach, so this records how it ended; the
// compile's Then reports a failed restore along with the compile's errors.
Given("the Aspire CLI version CI pins has restored the AppHost's generated modules", long, function () {
  const version = pinnedAspireVersion();
  const installed = sh("aspire --version", repo, 60_000);
  const cli = installed.status === 0 && installed.output.includes(version) ? "aspire" : `npx -y @microsoft/aspire-cli@${version}`;
  const ran = sh(`${cli} restore --non-interactive`, repo);
  ctx(this).restored = { version, ...ran, nugetUnreachable: ran.status !== 0 && nugetUnreachable(ran.output) };
});

/** Whether a failed aspire restore failed only because it couldn't reach NuGet's service index. */
function nugetUnreachable(output: string): boolean {
  return /Unable to load the service index for source https:\/\/api\.nuget\.org\//.test(output);
}

/**
 * The AppHost's compile and lint as CI ran them on HEAD, for a checkout that can't restore the AppHost's generated
 * modules because it can't reach NuGet (a factory cell). CI's run on HEAD restores them and runs the same command, so
 * its "aspire restore" step and its compile-and-lint step stand in for the compile here. They count only for a clean
 * checkout, since CI ran the commit, not the working tree. Under Actions NuGet is reachable, so this never stands in.
 */
async function appHostAsCiRanIt(): Promise<{ compile: Ran; lint: Ran }> {
  const failed = (output: string): { compile: Ran; lint: Ran } => ({ compile: { status: 1, output }, lint: { status: 1, output } });
  const dirty = git("status", "--porcelain");
  if (dirty) return failed(`NuGet is unreachable here, and CI's run on HEAD doesn't cover the uncommitted edits:\n${dirty}`);
  const ci = await ciRunOn(git("rev-parse", "HEAD"));
  if (ci.error) return failed(`NuGet is unreachable here, and CI's run on ${ci.sha} couldn't be read: ${ci.error}`);
  if (!ci.run || !ci.jobs) return failed(`NuGet is unreachable here, and CI has no run of ${workflowPath} on ${ci.sha}`);
  const steps = ci.jobs.find((j) => j.name === "ci")?.steps ?? [];
  const restore = steps.find((s) => /^Run aspire restore\b/.test(s.name));
  // GitHub names a step "Run <command>" and doesn't list its working directory, so the command alone picks it out.
  const command = stepFor("the AppHost's compile and lint").run!.trim();
  const check = steps.find((s) => s.name === `Run ${command}`);
  const seen = (s: GhStep | undefined, what: string): Ran =>
    !s
      ? { status: 1, output: `CI's run ${ci.run!.html_url} has no step that runs ${what}` }
      : s.status !== "completed"
        ? { status: 1, output: `in CI's run ${ci.run!.html_url}, "${s.name}" hasn't finished: it's ${s.status}` }
        : { status: s.conclusion === "success" ? 0 : 1, output: `in CI's run ${ci.run!.html_url}, "${s.name}" ended ${s.conclusion}` };
  const restored = seen(restore, "aspire restore");
  const ran = seen(check, "the AppHost's compile and lint");
  const both = { status: restored.status === 0 && ran.status === 0 ? 0 : 1, output: `${restored.output}\n${ran.output}` };
  return { compile: both, lint: both };
}

When("the AppHost's compile and lint run as CI runs them", long, async function () {
  const step = stepFor("the AppHost's compile and lint");
  const cwd = join(repo, step["working-directory"]!);
  // CI's command joins the two with &&; they run apart here so each Then sees its own result.
  const [compile, lint] = step.run!.split("&&").map((part) => part.trim());
  const local = { compile: sh(compile, cwd), lint: sh(lint, cwd) };
  const c = ctx(this);
  if (process.env.GITHUB_ACTIONS === "true" || !c.restored?.nugetUnreachable || local.compile.status === 0) {
    c.appHost = local;
    return;
  }
  // The compile can't see the modules NuGet would have given it, so CI's run on HEAD reports it. The lint still runs
  // here as well, and has to pass in both places.
  const ci = await appHostAsCiRanIt();
  c.appHost = {
    compile: { status: ci.compile.status, output: `the compile here can't pass without NuGet:\n${tail(local.compile.output, 10)}\n${ci.compile.output}` },
    lint: local.lint.status === 0 ? ci.lint : local.lint,
  };
});

Then("the AppHost compiles with no errors", function () {
  const c = ctx(this);
  assert.ok(c.appHost, "the AppHost's compile didn't run");
  const r = c.restored;
  const restore = r && r.status !== 0 && c.appHost.compile.status !== 0 ? `\n(aspire restore with CLI ${r.version} exited ${r.status}:\n${tail(r.output, 15)})` : "";
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
