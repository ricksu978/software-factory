import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const repo = process.cwd();

type Result = { status: number | null; out: string };
type Ctx = { result?: Result; scratch?: string; doc?: unknown; cleanup: string[] };

function ctx(world: object): Ctx {
  const w = world as { pbi5?: Ctx };
  w.pbi5 ??= { cleanup: [] };
  return w.pbi5;
}

// FACTORY_DB_TESTS=skip keeps nested runs off Testcontainers, because a cell has no Docker daemon. CI's own npm test still runs the DB suites.
function run(command: string, cwd: string): Result {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", env: { ...process.env, FACTORY_DB_TESTS: "skip" } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function tail(out: string): string {
  return out.split("\n").slice(-30).join("\n");
}

function read(path: string): unknown {
  const file = join(repo, path);
  return existsSync(file) ? parse(readFileSync(file, "utf8")) : null;
}

function at(doc: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), doc);
}

After(function () {
  for (const p of ctx(this).cleanup) rmSync(p, { recursive: true, force: true });
});

When("I run {string} in the repo", function (command: string) {
  ctx(this).result = run(command, repo);
});

When("I run {string} in the scratch project", function (command: string) {
  const c = ctx(this);
  assert.ok(c.scratch, "no scratch project");
  c.result = run(command, c.scratch);
});

Then("the command exits {int}", function (code: number) {
  const r = ctx(this).result;
  assert.ok(r, "no command ran");
  assert.equal(r.status, code, tail(r.out));
});

Given("a new test file {string} with one passing test named {string}", function (path: string, name: string) {
  const file = join(repo, path);
  const created = mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { test } from "node:test";\ntest(${JSON.stringify(name)}, () => {});\n`);
  ctx(this).cleanup.push(created ?? file);
});

Then("the output reports the passing test {string}", function (name: string) {
  const r = ctx(this).result;
  assert.ok(r, "no command ran");
  assert.ok(r.out.includes(name), `"${name}" not in output:\n${tail(r.out)}`);
});

Given("a scratch project with the repo's package.json, its installed packages and one passing feature file", function () {
  const c = ctx(this);
  const dir = mkdtempSync(join(tmpdir(), "pbi5-"));
  c.scratch = dir;
  c.cleanup.push(dir);
  copyFileSync(join(repo, "package.json"), join(dir, "package.json"));
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "junction");
  mkdirSync(join(dir, "features", "steps"), { recursive: true });
  writeFileSync(join(dir, "features", "scratch.feature"), "Feature: Scratch\n  Scenario: Passes\n    Given nothing\n");
  writeFileSync(join(dir, "features", "steps", "scratch.steps.ts"), 'import { Given } from "@cucumber/cucumber";\nGiven("nothing", () => {});\n');
});

Then("the scratch project's {string} holds one {string} message per scenario", function (path: string, key: string) {
  const c = ctx(this);
  assert.ok(c.scratch, "no scratch project");
  const file = join(c.scratch, path);
  assert.ok(existsSync(file), `${path} was not written`);
  const messages = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const scenarios = messages.filter((m) => "pickle" in m).length;
  assert.ok(scenarios > 0, "the report holds no scenarios");
  assert.equal(messages.filter((m) => key in m).length, scenarios);
});

When("I read the workflow {string}", function (path: string) {
  ctx(this).doc = read(path);
});

When("I read {string}", function (path: string) {
  ctx(this).doc = read(path);
});

Then("it runs on {string} and {string}", function (a: string, b: string) {
  const on = at(ctx(this).doc, "on");
  assert.ok(on, "the workflow is missing or has no triggers");
  const events = Array.isArray(on) ? on : typeof on === "object" ? Object.keys(on) : [on];
  assert.ok(events.includes(a) && events.includes(b), `triggers are ${JSON.stringify(events)}`);
});

Then("one of its jobs runs {string}, {string} and {string}", function (a: string, b: string, c: string) {
  const jobs = (at(ctx(this).doc, "jobs") ?? {}) as Record<string, { steps?: { run?: string }[] }>;
  const found = Object.values(jobs).some((job) => {
    const runs = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
    return [a, b, c].every((cmd) => runs.includes(cmd));
  });
  assert.ok(found, "no job runs all three commands");
});

Then("the workflow {string} still exists", function (path: string) {
  assert.ok(existsSync(join(repo, path)), `${path} is missing`);
});

Then("it has text values for {string}, {string}, {string}, {string} and {string}", function (a: string, b: string, c: string, d: string, e: string) {
  const doc = ctx(this).doc;
  assert.ok(doc, "the file is missing or empty");
  for (const p of [a, b, c, d, e]) {
    const v = at(doc, p);
    assert.ok(typeof v === "string" && v.trim() !== "", `${p} is not a text value`);
  }
});

Then("{string} is {string}", function (path: string, expected: string) {
  assert.equal(at(ctx(this).doc, path), expected);
});
