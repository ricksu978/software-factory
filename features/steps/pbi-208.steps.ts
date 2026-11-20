// Step definitions for features/pbi-208-aspire-run-one-command.feature. Apart from the @local scenarios, they run the
// AppHost's start, startAppHost() in src/apphost/start.ts, against PBI 205's fakes (pbi-205.steps.ts: a fake checkout,
// fake git, fake Docker, fake clock and fake resources), or they read the repo's own files.
// - The start command comes from the README's "Run it" section. What it runs before `aspire run` begins is read from
//   the project's npm scripts and from any PowerShell script they run, up to that script's `aspire run`. That part is
//   read, not run, because scripts/factory.ps1 moves to the repo root and would pull the real checkout.
// - A test run is a start whose environment has FACTORY_FLOAT_PORTS set to "1", handed to the start as StartDeps.env.
// - The @local scenarios run the owner's real `aspire run`, Docker Desktop and secrets, so the owner runs them.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appHostCtx, commit, git, lctx, pushToRemote, runStart, type Ctx } from "./pbi-205.steps.ts";

const repo = process.cwd();
const readRepo = (path: string) => readFileSync(join(repo, path), "utf8");

// ---- The README's "Run it" section, and the plan's Task 18 ----

/** The lines of a Markdown section, from its heading to the next heading of the same level or higher. */
function section(text: string, heading: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && heading.test(l));
  assert.ok(start >= 0, `no section matching ${heading}`);
  const level = /^#+/.exec(lines[start]!)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const runIt = () => section(readRepo("README.md"), /^#+ Run it\s*$/);

/** The command in the section's first code block that starts the factory: its last line, past the clone and the cd. */
function startCommand(text: string): string | null {
  const block = /```[a-z]*\r?\n([\s\S]*?)```/.exec(text);
  if (!block) return null;
  const lines = block[1]!.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const start = lines.filter((l) => !/^(git clone|cd)\b/.test(l));
  return start.at(-1) ?? null;
}

/** The section's prose, as blocks between blank lines. A lead-in ending with ":" joins the list that follows it. */
function blocks(text: string): string[] {
  const out: string[] = [];
  for (const b of text.replace(/```[\s\S]*?```/g, "").split(/\r?\n\s*\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const prev = out.at(-1);
    if (prev !== undefined && prev.endsWith(":") && /^(\d+\.|[-*]) /.test(b)) out[out.length - 1] = `${prev}\n${b}`;
    else out.push(b);
  }
  return out;
}

const OLD_COMMANDS = ["npm run factory", "scripts/factory.ps1"];

type Docs = { text: string | null; command: string | null };
const docs = (world: object): Docs => {
  const w = world as { pbi208docs?: Docs };
  w.pbi208docs ??= { text: null, command: null };
  return w.pbi208docs;
};

When("the owner reads the README's {string} section", function (name: string) {
  const d = docs(this);
  d.text = section(readRepo("README.md"), new RegExp(`^#+ ${name}\\s*$`));
  d.command = startCommand(d.text);
});

Then("its command to start the factory is {string}", function (cmd: string) {
  const d = docs(this);
  assert.equal(d.command, cmd, `the section starts the factory with ${JSON.stringify(d.command)}`);
});

Then("the section doesn't name {string} or {string}", function (a: string, b: string) {
  const d = docs(this);
  for (const name of [a, b]) assert.ok(!d.text!.includes(name), `the section names "${name}"`);
});

Then("the section says that {string} itself pulls {string}, only when on {string}, and starts Docker Desktop", function (cmd: string, main: string, onMain: string) {
  const d = docs(this);
  const says = blocks(d.text!).find((b) =>
    b.includes(`\`${cmd}\``)
    && !OLD_COMMANDS.some((o) => b.includes(o))
    && /\b(pull|pulls|fast-forward|fast-forwards)\b/i.test(b)
    && b.includes(`\`${main}\``)
    && new RegExp(`only[^.]*\`${onMain}\``, "i").test(b)
    && /Docker Desktop/.test(b));
  assert.ok(says, `no part of the section says that ${cmd} itself pulls ${main}, only on ${onMain}, and starts Docker Desktop`);
});

When("the owner reads the step of the plan's Task 18 that starts the factory", function () {
  const d = docs(this);
  const plan = readRepo("docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md");
  const task = section(plan, /^#+ Task 18:/);
  const steps = task.split(/\r?\n(?=- \[[ x]\] \*\*Step )/).filter((s) => s.startsWith("- ["));
  d.text = steps.find((s) => /\bstart(s|ing)? (`[^`]+`|the factory)/i.test(s) && /sign-in link/i.test(s)) ?? null;
});

Then("the step names {string} as the way to start the factory", function (cmd: string) {
  const d = docs(this);
  assert.ok(d.text, "Task 18 has no step that starts the factory");
  assert.match(d.text, new RegExp(`\\bStart \`${cmd}\``), `the step doesn't start the factory with ${cmd}`);
});

Then("the step doesn't name {string} or {string}", function (a: string, b: string) {
  const d = docs(this);
  assert.ok(d.text, "Task 18 has no step that starts the factory");
  for (const name of [a, b]) assert.ok(!d.text.includes(name), `the step names "${name}"`);
});

// ---- The project's npm scripts ----

type Scripts = Record<string, string>;
const npmScripts = (): Scripts => (JSON.parse(readRepo("package.json")) as { scripts?: Scripts }).scripts ?? {};

When("the owner reads the project's npm scripts", function () {
  (this as { pbi208scripts?: Scripts }).pbi208scripts = npmScripts();
});

Then("there is no {string} script, or the {string} script runs {string} and nothing else", function (name: string, _same: string, cmd: string) {
  const scripts = (this as { pbi208scripts?: Scripts }).pbi208scripts!;
  const s = scripts[name];
  assert.ok(s === undefined || s.trim() === cmd, `the "${name}" script runs ${JSON.stringify(s)}`);
});

// ---- The start command, from the README to `aspire run` ----

/**
 * What a command runs before `aspire run` begins, one command per entry, and whether it reaches `aspire run` at all.
 * `npm run <name>` runs that npm script. `pwsh ... -File <path>` runs that script's lines up to its `aspire run`.
 */
function beforeAspire(cmd: string, depth = 0): { before: string[]; reaches: boolean } {
  assert.ok(depth < 10, `the start command ${cmd} runs itself`);
  const before: string[] = [];
  for (const part of cmd.split(/&&|;|\|\|/).map((s) => s.trim()).filter(Boolean)) {
    if (/^aspire run\b/.test(part)) return { before, reaches: true };
    const npm = /^npm run(?:-script)? ([\w:-]+)/.exec(part);
    if (npm) {
      const script = npmScripts()[npm[1]!];
      if (script === undefined) return { before, reaches: false };
      const inner = beforeAspire(script, depth + 1);
      before.push(...inner.before);
      if (inner.reaches) return { before, reaches: true };
      continue;
    }
    const ps = /^(?:pwsh|powershell)\b.*-File\s+(\S+)/i.exec(part);
    if (ps) {
      const path = ps[1]!.replace(/^["']|["']$/g, "");
      if (!existsSync(join(repo, path))) return { before, reaches: false };
      for (const raw of readRepo(path).split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) continue;
        if (/^aspire run\b/.test(line)) return { before, reaches: true };
        before.push(line);
      }
      continue;
    }
    before.push(part);
  }
  return { before, reaches: false };
}

type Command = { cmd: string | null; before: string[]; reaches: boolean };
const command = (world: object): Command => {
  const w = world as { pbi208command?: Command };
  w.pbi208command ??= { cmd: null, before: [], reaches: false };
  return w.pbi208command;
};

Given("the factory's start command, as the README's {string} section gives it", function (_name: string) {
  command(this).cmd = startCommand(runIt());
});

When("the owner starts the factory with it, on branch {string}, behind the remote's {string}", async function (branch: string, main: string) {
  const k = command(this);
  const c = appHostCtx(this);
  assert.equal(branch, "main");
  assert.equal(main, "main");
  git(c.checkout, "checkout", "-q", "-B", branch);
  commit(c, c.checkout, "aaa111");
  git(c.checkout, "push", "-q", "origin", "main");
  pushToRemote(c, "bbb222");
  if (k.cmd === null) return;
  const r = beforeAspire(k.cmd);
  k.before = r.before;
  k.reaches = r.reaches;
  // What runs before `aspire run` is read, not run. Once `aspire run` begins, the AppHost's start runs against the fakes.
  if (r.reaches) await runStart(c);
});

const pullsMain = (line: string) => /\bgit\b.*\bpull\b/i.test(line);
const checksDocker = (line: string) => /\bdocker(\.exe)?\s+(version|info|ps)\b/i.test(line);

Then("nothing pulled {string} before `aspire run` began", function (_main: string) {
  const k = command(this);
  assert.ok(k.cmd, "the README's \"Run it\" section gives no start command");
  assert.ok(k.reaches, `the start command ${k.cmd} never runs \`aspire run\``);
  const pulled = k.before.filter(pullsMain);
  assert.deepEqual(pulled, [], `${k.cmd} pulled before \`aspire run\` began`);
});

Then("nothing checked Docker before `aspire run` began", function () {
  const k = command(this);
  assert.ok(k.reaches, `the start command ${k.cmd} never runs \`aspire run\``);
  const checked = k.before.filter(checksDocker);
  assert.deepEqual(checked, [], `${k.cmd} checked Docker before \`aspire run\` began`);
});

Then("{string} was pulled once in the whole start", function (_main: string) {
  const k = command(this);
  const c = appHostCtx(this);
  const before = k.before.filter(pullsMain).length;
  const during = c.events.filter((e) => e.kind === "git" && e.args[0] === "pull").length;
  assert.equal(before + during, 1, `main was pulled ${before} times before \`aspire run\` and ${during} times by the AppHost`);
});

// ---- Test runs ----

Given(/^FACTORY_FLOAT_PORTS is (unset|set to "[^"]*")$/, function (setting: string) {
  const c = appHostCtx(this);
  const value = /^set to "([^"]*)"$/.exec(setting)?.[1];
  c.env = value === undefined ? {} : { FACTORY_FLOAT_PORTS: value };
});

Given("the remote asks for a username and password before it answers", function () {
  appHostCtx(this).remoteAsks = true;
});

When("a test run of the AppHost starts, with FACTORY_FLOAT_PORTS set to {string}", async function (value: string) {
  const c: Ctx = appHostCtx(this);
  c.env = { FACTORY_FLOAT_PORTS: value };
  await runStart(c);
});

Then("the start never asked for an answer", function () {
  const c = appHostCtx(this);
  assert.ok(c.ran, "the AppHost didn't start");
  const asked = c.events.filter((e) => e.kind === "prompt");
  assert.deepEqual(asked, [], "the start ran git that asked for an answer");
});

// ---- @local: the owner runs these on their machine, and the PR records the run ----
// Steps record what they see and assert only in Then, as PBI 6's and PBI 205's do.

const APPHOST = "--apphost . --non-interactive --nologo";
const local = { timeout: 600_000 };
const sh = (cmd: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(cmd, { cwd: repo, shell: true, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

When("the owner runs {string} from the repo root", function (cmd: string) {
  lctx(this).run = spawn(cmd, { cwd: repo, shell: true, stdio: "ignore" });
});

type Suite = { want: string; branch: string; headBefore: string; behind: number; headAfter: string; controlUp: boolean; started: boolean };
const suite = (world: object): Suite => {
  const w = world as { pbi208suite?: Suite };
  w.pbi208suite ??= { want: "", branch: "", headBefore: "", behind: -1, headAfter: "", controlUp: false, started: false };
  return w.pbi208suite;
};

Given("the owner's worktree is on branch {string}, one merged commit behind the remote's {string}", function (branch: string, main: string) {
  const s = suite(this);
  s.want = branch;
  s.branch = (sh("git branch --show-current").stdout ?? "").trim();
  sh(`git fetch -q origin ${main}`);
  s.headBefore = (sh("git rev-parse HEAD").stdout ?? "").trim();
  s.behind = Number((sh(`git rev-list --count HEAD..origin/${main}`).stdout ?? "").trim());
});

When("the PBI 6 suite starts the AppHost as a test run, with no one at the console", local, function () {
  const s = suite(this);
  // As pbi-6.steps.ts starts it: isolated, with FACTORY_FLOAT_PORTS=1, and here with nothing on stdin to answer a prompt.
  const env = { ...process.env, FACTORY_FLOAT_PORTS: "1", GIT_TERMINAL_PROMPT: "0" };
  s.started = true;
  sh(`aspire start --isolated ${APPHOST}`, env);
  s.controlUp = sh(`aspire wait control --status up --timeout 300 ${APPHOST}`, env).status === 0;
  s.headAfter = (sh("git rev-parse HEAD").stdout ?? "").trim();
  sh(`aspire stop ${APPHOST}`, env);
});

Then("the control resource answers without anyone having answered a prompt", function () {
  const s = suite(this);
  assert.ok(s.started, "the suite never started the AppHost");
  assert.ok(s.controlUp, "control didn't come up within 5 minutes");
});

Then("the worktree is still at the commit it was on before the suite started", function () {
  const s = suite(this);
  // Off the scenario's branch the start never pulls anyway, so the run would prove nothing about a test run on it.
  assert.equal(s.branch, s.want, `the worktree was on branch "${s.branch}", not "${s.want}"`);
  assert.equal(s.behind, 1, `the worktree was ${s.behind} commits behind origin/main, not 1`);
  assert.equal(s.headAfter, s.headBefore, "the suite's start moved the worktree");
});

type Suites = { ok: boolean; missing: string[]; status: number | null; out: string };
const SUITE_TAGS: Record<string, string> = { "PBI 6": "@pbi-6", "PBI 89": "@pbi-89", "PBI 156": "@pbi-156" };

Given("the owner's machine has Docker Desktop, the Aspire CLI and the factory's secrets", function () {
  const missing: string[] = [];
  if (sh("docker version").status !== 0) missing.push("Docker");
  if (sh("aspire --version").status !== 0) missing.push("the Aspire CLI");
  (this as { pbi208suites?: Suites }).pbi208suites = { ok: missing.length === 0, missing, status: null, out: "" };
});

When("the owner runs the {word} {int} scenarios that start the AppHost", { timeout: 3_600_000 }, function (word: string, n: number) {
  const s = (this as { pbi208suites?: Suites }).pbi208suites!;
  const tag = SUITE_TAGS[`${word} ${n}`];
  assert.ok(tag, `no suite named ${word} ${n}`);
  const r = sh(`npx cucumber-js --import "features/steps/**/*.ts" --tags "${tag}"`);
  s.status = r.status;
  s.out = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000);
});

Then("every one of them passes", function () {
  const s = (this as { pbi208suites?: Suites }).pbi208suites!;
  assert.ok(s.ok, `the machine lacks ${s.missing.join(" and ")}`);
  assert.equal(s.status, 0, `the suite failed:\n${s.out}`);
});
