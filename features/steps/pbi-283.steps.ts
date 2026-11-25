// Step definitions for features/pbi-283-scenarios-and-docs-sign-in-through-keycloak.feature.
//
// The scenarios that run another PBI's scenarios use PBI 396's steps, which run them in cucumber-js as `npm run bdd`
// does and read its message report. For every scenario of this feature, a hook here names a fresh file in
// PBI283_SIGN_INS, which those runs inherit, and features/support/sign-ins.ts writes there who each scenario signed in,
// where, through what, and which page it then opened. "Everyone it signed in" is every sign-in that file holds.
//
// The scenarios that read step definitions read their code with comments taken out, so a comment that names the code
// #281 deletes doesn't count. A step file:
// - imports or loads a module when an import, an export from or a dynamic import names it, resolved from the file;
// - loads or starts a module when a string in its code names the module's path from the repo root, as a spawn does;
// - reads the dev token or opens /dev-login when its code names devToken, devLoginCookie or /dev-login;
// - looks for a sign-in link in an output or console when its code matches a dev sign-in link, names a "sign-in link",
//   or searches a resource's logs with `aspire logs ... --search`;
// - drives the BFF, the API or the worker when it imports, loads or starts a module under src/bff/, src/api/ or
//   src/worker/;
// - asks Aspire about a resource when it waits for, describes or reads the logs of it, through `aspire wait`,
//   `aspire describe`, `aspire logs` or PBI 6's describe(), naming it;
// - waits for a resource to be up when it runs `aspire wait <name> --status up`, or runs `aspire wait ${...}` with
//   `--status up` and names the resource in a string;
// - sends a probe to the cell-api resource when every line of its code that names the probe's path also names the
//   cell API's address, by a name such as cellApi.
// This file names that code, as patterns, to look for it, so the scan of every step definition leaves it out.
import { After, Before, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGN_INS_ENV, type SignIn, type SignInRecord } from "../support/sign-ins.ts";
import { featureFiles, ON_MAIN, runSuite, suiteOf, type Case, type Suite } from "./pbi-396.steps.ts";

const repo = process.cwd();
const HERE = relative(repo, fileURLToPath(import.meta.url)).split(sep).join("/");
/** PBI 396's own runs can take many minutes. */
const SUITE = { timeout: 60 * 60_000 };

// The SHA-256 of each feature file of the step files this item moves, as it was on main before this item, at 600891a,
// with LF line ends. PBI 19's and PBI 89's change, so they aren't here.
Object.assign(ON_MAIN, {
  105: { file: "features/pbi-105-activity-log.feature", sha256: "64c13fc2652db59cd7aea64da35e07c667155ea0a7c7abc147b4db9f95d7510f" },
  117: { file: "features/pbi-117-additive-schema.feature", sha256: "d127dbb242ae3f4962fae8e6aabd853e0a43cc5f8a57a7fb05cd28b843aa8bee" },
  131: { file: "features/pbi-131-issue-links.feature", sha256: "d41ce26fa11867377f99d928a788291010074c64bc8b9d4db554e6743147c311" },
  132: { file: "features/pbi-132-readiness-cost.feature", sha256: "5f49234943ace12b6d1c6790415e614c52d383ef80a3ef806c082f8ef4d5d9f3" },
  146: { file: "features/pbi-146-signoff-scope.feature", sha256: "d0f001f5c7b78e72acf346490f8297c1b1a79d45285e1a5fe249592a45899d0d" },
  168: { file: "features/pbi-168-withdraw-before-queue.feature", sha256: "824a0a0ac0716daf0b9db95c088884b720d26d3e3bfaab4ac64f5df180b33745" },
  173: { file: "features/pbi-173-sop-move-on-resume.feature", sha256: "436a150b5dff1c4eee963de74a6bd8f9290fa1e68629b513a3fceba41b22d2ef" },
  175: { file: "features/pbi-175-configuration-page.feature", sha256: "2591066436512a1d5fa7813e35cf2686c96f80b510a3a1f941620b690309a9de" },
  187: { file: "features/pbi-187-run-detail-durations.feature", sha256: "748bd086febe60d33e5a607a54eb367edbc9790fa5fa61f9e301d0a8d58105bb" },
  190: { file: "features/pbi-190-pr-review-restate.feature", sha256: "355a84e103c1e1a289c0412aee549f459f1fcb604742f670cde429d1a5f426c4" },
  194: { file: "features/pbi-194-merged-pr-while-needs-input.feature", sha256: "64a6e113da84f3246395fc72e78c50e7e5637ff56f4dec449dc8a61a33c52ca0" },
  209: { file: "features/pbi-209-running-stage-transcript.feature", sha256: "c14402279b5c9bb7904197a00d56e62dfc113f86f7896027e2c2c482b0395203" },
  219: { file: "features/pbi-219-worker-runs-outbox.feature", sha256: "c16af44cc7e72d27bec43adef5d4d80ed3d8f9884b78eb0c6aaa79a0b998448b" },
  227: { file: "features/pbi-227-split-parent-shown.feature", sha256: "0f346c64aab7bb00259e75e042fcf43dde5d51dfd2efc2a2170df82fb30101ab" },
  237: { file: "features/pbi-237-split-children-opted-in.feature", sha256: "bd415e6f176265e28c9aa60b5a6f0294bbb4cb573c5db84c6f1a228c4dea2f7d" },
  156: { file: "features/pbi-156-worker-main.feature", sha256: "2b8b9a6c57b2f8be4968ecbe7d2af948802b1f1c2ee1f28d2191deacefba9c51" },
  222: { file: "features/pbi-222-cell-api-service.feature", sha256: "fc98df0666043f2d78aa5b76fc03a51ad90424701111bbfed2a2a69301b3e28e" },
  300: { file: "features/pbi-300-prepare-restart-stops-nothing.feature", sha256: "cb952fa93fb8477564ee0834b26ba22a211a8dd67c9d2bd1544f9bea0a264004" },
  364: { file: "features/pbi-364-feature-change-request.feature", sha256: "3f274d62a2a19ed6a5fb8a9adb749c6aa64e9e7b5673742b77b2772343573ca3" },
  365: { file: "features/pbi-365-feature-change-approve-or-changes.feature", sha256: "ff32f6a0c302330f08d723b53428f15269b8c0403edab8f1508a3b8feb1073e0" },
  395: { file: "features/pbi-395-rule-change-approval.feature", sha256: "49e59577e282f92ab6bb08884a6ff810af2ef2bd1962e461dab662e4716ceccf" },
});

type Source = { file: string; code: string };
type Ctx = { signIns?: string; dir?: string; sources?: Source[]; feature?: { file: string; scenarios: string }; example?: Case };

function ctx(world: object): Ctx {
  const w = world as { pbi283?: Ctx };
  w.pbi283 ??= {};
  return w.pbi283;
}

Before({ tags: "@pbi-283" }, function () {
  const c = ctx(this);
  c.dir = mkdtempSync(join(tmpdir(), "pbi283-"));
  c.signIns = join(c.dir, "sign-ins.ndjson");
  writeFileSync(c.signIns, "");
  process.env[SIGN_INS_ENV] = c.signIns;
});

After({ tags: "@pbi-283" }, function () {
  const c = ctx(this);
  delete process.env[SIGN_INS_ENV];
  if (c.dir) rmSync(c.dir, { recursive: true, force: true });
});

// ---- Reading code ----

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The code of a file with its block comments and whole-line comments taken out. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

function source(file: string): Source {
  assert.ok(existsSync(join(repo, file)), `${file} doesn't exist`);
  return { file, code: code(readFileSync(join(repo, file), "utf8").replaceAll("\r\n", "\n")) };
}

function stepSources(pbi: number): Source[] {
  const dir = join(repo, "features", "steps");
  const files = readdirSync(dir).filter((f) => f === `pbi-${pbi}.steps.ts` || (f.startsWith(`pbi-${pbi}-`) && f.endsWith(".steps.ts")));
  assert.ok(files.length, `PBI ${pbi} has no step definitions`);
  return files.map((f) => source(`features/steps/${f}`));
}

function sourcesOf(world: object): Source[] {
  const s = ctx(world).sources;
  assert.ok(s, "no step definitions were read");
  return s;
}

/** Every module a file imports, exports from or imports dynamically, as a path from the repo root. */
function imported(s: Source): string[] {
  const specs = [
    ...s.code.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...s.code.matchAll(/\bimport\s+["']([^"']+)["']/g),
    ...s.code.matchAll(/\bimport\s*\(\s*["'`]([^"'`$]+)["'`]/g),
  ].map((m) => m[1]);
  return specs
    .filter((spec) => spec.startsWith("."))
    .map((spec) => relative(repo, resolve(repo, dirname(s.file), spec)).split(sep).join("/"));
}

const sameModule = (a: string, target: string) => a === target || a === target.replace(/\.ts$/, "") || `${a}.ts` === target;

/** Whether a file imports or loads the module at `target`, a path from the repo root. */
function imports(s: Source, target: string): boolean {
  return imported(s).some((m) => sameModule(m, target));
}

/** Whether a string in the file's code names `target` from the repo root, as a spawn or a dynamic load does. */
function names(s: Source, target: string): boolean {
  if (new RegExp(`(?<![\\w./-])(\\./)?${esc(target)}(?![\\w])`).test(s.code)) return true;
  const parts = target.split("/").map((p) => `["'\`]${esc(p)}["'\`]`).join("\\s*,\\s*");
  return new RegExp(parts).test(s.code);
}

const touches = (s: Source, target: string) => imports(s, target) || names(s, target);

const DEV = /\bdevToken\b|\bdevLoginCookie\b|\/dev-login\b/;
const CONSOLE_LINK = /dev-login\\?\??token|sign-in link|Sign in to the factory dashboard|aspire logs [^\n]*--search/i;

function devUse(s: Source): string[] {
  return s.code.split("\n").filter((l) => DEV.test(l)).map((l) => `${s.file}: ${l.trim()}`);
}

function consoleLinks(s: Source): string[] {
  return s.code.split("\n").filter((l) => CONSOLE_LINK.test(l)).map((l) => `${s.file}: ${l.trim()}`);
}

const SPLIT = ["src/bff/", "src/api/", "src/worker/"];

function drives(s: Source): boolean {
  if (imported(s).some((m) => SPLIT.some((d) => m.startsWith(d)))) return true;
  return SPLIT.some((d) => new RegExp(`(?<![\\w./-])(\\./)?${esc(d)}[\\w./-]+\\.ts`).test(s.code));
}

/** The lines of a file's code that ask Aspire about the resource `name`. */
function asksAspire(s: Source, name: string): string[] {
  const n = esc(name);
  const ask = new RegExp(`aspire (wait|describe|logs|resource) ${n}(?![\\w-])|\\bdescribe\\(\\s*["'\`]${n}["'\`]`);
  return s.code.split("\n").filter((l) => ask.test(l)).map((l) => `${s.file}: ${l.trim()}`);
}

function waitsUp(s: Source, name: string): boolean {
  if (new RegExp(`aspire wait ${esc(name)} --status up`).test(s.code)) return true;
  return /aspire wait \$\{[^}]+\} --status up/.test(s.code) && new RegExp(`["'\`]${esc(name)}["'\`]`).test(s.code);
}

function allFiles(dir: string): string[] {
  return readdirSync(join(repo, dir)).flatMap((f) => {
    const path = `${dir.replace(/\/$/, "")}/${f}`;
    return statSync(join(repo, path)).isDirectory() ? allFiles(path) : /\.[cm]?[jt]s$/.test(f) ? [path] : [];
  });
}

// ---- Who a run signed in ----

function records(world: object): SignInRecord[] {
  const file = ctx(world).signIns;
  assert.ok(file && existsSync(file), "no sign-in record was kept for this run");
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SignInRecord);
}

const signIns = (world: object) => records(world).filter((r): r is SignIn => r.kind === "sign-in");

/** The PBIs whose scenarios the last run ran. */
function ranPbis(s: Suite): number[] {
  const pbis = s.cases.map((k) => /pbi-(\d+)-/.exec(k.uri)?.[1]).filter((p): p is string => !!p).map(Number);
  assert.ok(pbis.length, "the run ran no scenario of any PBI");
  return [...new Set(pbis)];
}

const failed = (k: Case) => k.statuses.some((st) => st !== "PASSED");

// ---- Rule: PBI 19's and PBI 89's scenarios sign people in at the sign-in provider through the BFF ----

Then("everyone it signed in signed in at the test sign-in provider through the BFF", function () {
  const all = signIns(this);
  assert.ok(all.length, "the scenario recorded no sign-in");
  const other = all.filter((r) => r.at !== "test-provider" || r.through !== "bff");
  assert.deepEqual(other, [], "these sign-ins weren't at the test sign-in provider through the BFF");
});

Then("it used no dev sign-in", function () {
  const dev = signIns(this).filter((r) => r.at === "dev-login");
  assert.deepEqual(dev, [], "the scenario signed people in with the dev sign-in");
  const used = ranPbis(suiteOf(this)).flatMap((pbi) => stepSources(pbi).flatMap((s) => [...devUse(s), ...consoleLinks(s)]));
  assert.deepEqual(used, [], "the scenario's steps use the dev sign-in");
});

Then("its example for {string} signed {string} in at the test sign-in provider", function (example: string, person: string) {
  const s = suiteOf(this);
  const k = s.cases.find((c) => c.steps.some((t) => t.includes(`"${example}"`)));
  assert.ok(k, `no example for "${example}" ran, among ${JSON.stringify(s.cases.map((c) => c.steps))}`);
  ctx(this).example = k;
  const mine = signIns(this).filter((r) => r.pickleId === k.pickleId);
  assert.ok(
    mine.some((r) => r.person === person && r.at === "test-provider" && r.through === "bff"),
    `the example for "${example}" didn't sign "${person}" in at the test sign-in provider through the BFF: ${JSON.stringify(mine)}`,
  );
});

Then("that example saw {string}", function (text: string) {
  const k = ctx(this).example;
  assert.ok(k, "no example was picked out");
  assert.ok(!failed(k), `the example ended ${JSON.stringify(k.statuses)}`);
  assert.ok(k.steps.some((t) => t.includes(`"${text}"`)), `no step of the example checks for "${text}": ${JSON.stringify(k.steps)}`);
});

When("I read PBI {int}'s feature file", function (pbi: number) {
  const [file] = featureFiles(pbi);
  const lines = readFileSync(file, "utf8").replaceAll("\r\n", "\n").split("\n");
  // The scenarios start at the first tag, Rule, Background or Scenario line after the feature's description.
  const start = lines.findIndex((l, i) => i > 0 && /^\s*(@|Rule:|Background:|Scenario( Outline)?:|Example:)/.test(l));
  ctx(this).feature = { file, scenarios: start < 0 ? "" : lines.slice(start).join("\n") };
});

function scenarioLines(world: object, pattern: RegExp): string[] {
  const f = ctx(world).feature;
  assert.ok(f, "no feature file was read");
  return f.scenarios.split("\n").filter((l) => pattern.test(l)).map((l) => `${f.file}: ${l.trim()}`);
}

Then("no scenario in it mentions a sign-in link, a sign-in link's token, or a cookie a sign-in link sets", function () {
  const lines = scenarioLines(this, /sign-in link|link with (a|the) wrong token|sign-in cookie|cookie it set|dev-login/i);
  assert.deepEqual(lines, [], "scenarios that mention the dev sign-in");
});

Then("no scenario in it mentions FACTORY_DEV_LOGIN or the dev identity guard", function () {
  const lines = scenarioLines(this, /FACTORY_DEV_LOGIN|dev identity|dev-identity/i);
  assert.deepEqual(lines, [], "scenarios that mention FACTORY_DEV_LOGIN or the dev identity guard");
});

When("I read PBI {int}'s step definitions", function (pbi: number) {
  ctx(this).sources = stepSources(pbi);
});

Then("they read no dev token and open no {string}", function (_path: string) {
  assert.deepEqual(sourcesOf(this).flatMap(devUse), [], "lines that read the dev token or open /dev-login");
});

Then("they look for no sign-in link in any output or console", function () {
  assert.deepEqual(sourcesOf(this).flatMap(consoleLinks), [], "lines that look for a sign-in link");
});

When("the owner runs PBI {int}'s scenarios tagged @local", SUITE, async function (pbi: number) {
  await runSuite(this, featureFiles(pbi), ["--tags", "@local"], false);
});

Then("every one of them passes", function () {
  const s = suiteOf(this);
  assert.ok(s.cases.length > 0, `no scenario ran: ${s.out.slice(-4_000)}`);
  const bad = s.cases.filter(failed).map((k) => `${k.name}: ${JSON.stringify(k.statuses)}`);
  assert.deepEqual(bad, [], `scenarios that didn't pass: ${s.out.slice(-4_000)}`);
  assert.equal(s.code, 0, `cucumber-js exited with code ${s.code}`);
});

Then("one of them signs in at Keycloak's {string} realm as {string} through the BFF, and opens Floor", function (realm: string, person: string) {
  const all = records(this);
  const signed = all.filter((r): r is SignIn => r.kind === "sign-in" && r.at === "keycloak" && r.realm === realm && r.person === person && r.through === "bff");
  assert.ok(signed.length, `no scenario signed "${person}" in at Keycloak's "${realm}" realm through the BFF: ${JSON.stringify(all)}`);
  const opened = all.some((r) => r.kind === "opened" && r.page === "Floor" && r.person === person && signed.some((s) => s.pickleId === r.pickleId));
  assert.ok(opened, `the scenario that signed "${person}" in at Keycloak never opened Floor`);
});

Then("none of them reads a sign-in link from a resource's console", function () {
  const dev = signIns(this).filter((r) => r.at === "dev-login");
  assert.deepEqual(dev, [], "scenarios that signed in with the dev sign-in");
  const lines = ranPbis(suiteOf(this)).flatMap((pbi) => stepSources(pbi).flatMap(consoleLinks));
  assert.deepEqual(lines, [], "lines that read a sign-in link from a console");
});

// ---- Rule: PBI 6's scenarios look up the split services, not the single control resource ----

Then("they wait for, describe or read the logs of no resource named {string}", function (name: string) {
  assert.deepEqual(sourcesOf(this).flatMap((s) => asksAspire(s, name)), [], `lines that ask Aspire about "${name}"`);
});

Then("before a scenario goes on, they wait for the {string}, {string}, {string} and {string} resources to be up", function (a: string, b: string, c: string, d: string) {
  const sources = sourcesOf(this);
  const missing = [a, b, c, d].filter((name) => !sources.some((s) => waitsUp(s, name)));
  assert.deepEqual(missing, [], "resources the steps never wait for to be up");
});

Then("every probe they call, {string}, {string} and {string}, goes to the {string} resource's address", function (p1: string, p2: string, p3: string, resource: string) {
  const sources = sourcesOf(this);
  const address = new RegExp(resource.replace(/-/g, "-?"), "i");
  const calls = sources.flatMap((s) => s.code.split("\n").filter((l) => [p1, p2, p3].some((p) => l.includes(`"${p}"`) || l.includes(`'${p}'`) || l.includes(`${p}\``) || l.includes(`${p}?`))).map((l) => `${s.file}: ${l.trim()}`));
  assert.ok(calls.length, `the steps call none of ${p1}, ${p2} or ${p3}`);
  const elsewhere = calls.filter((l) => !address.test(l.slice(l.indexOf(": ") + 2)));
  assert.deepEqual(elsewhere, [], `probe calls that don't go to the "${resource}" resource's address`);
});

Then("no step asked Aspire about a resource named {string}", function (name: string) {
  const lines = ranPbis(suiteOf(this)).flatMap((pbi) => stepSources(pbi).flatMap((s) => asksAspire(s, name)));
  assert.deepEqual(lines, [], `lines that ask Aspire about "${name}"`);
});

// ---- Rule: No step definition leans on the code #281 deletes ----

When("I read every step definition and support file under {string}", function (dir: string) {
  ctx(this).sources = allFiles(dir).filter((f) => f !== HERE).map(source);
});

Then("none imports or loads {string} or {string}", function (a: string, b: string) {
  const bad = sourcesOf(this).filter((s) => touches(s, a) || touches(s, b)).map((s) => s.file);
  assert.deepEqual(bad, [], `files that import or load ${a} or ${b}`);
});

Then("none imports, loads or starts {string}", function (target: string) {
  const bad = sourcesOf(this).filter((s) => touches(s, target)).map((s) => s.file);
  assert.deepEqual(bad, [], `files that import, load or start ${target}`);
});

Then("none reads the dev token or opens {string}", function (_path: string) {
  assert.deepEqual(sourcesOf(this).flatMap(devUse), [], "lines that read the dev token or open /dev-login");
});

Then("they import, load or start none of {string}, {string} or {string}", function (a: string, b: string, c: string) {
  const bad = sourcesOf(this).flatMap((s) => [a, b, c].filter((t) => touches(s, t)).map((t) => `${s.file}: ${t}`));
  assert.deepEqual(bad, [], "modules #281 deletes that the steps import, load or start");
});

Then("they drive the BFF, the API or the worker", function () {
  const sources = sourcesOf(this);
  assert.ok(sources.some(drives), `${sources.map((s) => s.file).join(", ")} import, load or start nothing under ${SPLIT.join(", ")}`);
});

// ---- Rule: The README tells the owner to sign in at Keycloak ----

const textOf = (world: object) => {
  const t = (world as { lastText?: string | null }).lastText;
  assert.ok(typeof t === "string", "no file was read");
  return t.replaceAll("\r\n", "\n");
};

When("I read the {string} section of {string}", function (heading: string, path: string) {
  const file = join(repo, path);
  const lines = existsSync(file) ? readFileSync(file, "utf8").replaceAll("\r\n", "\n").split("\n") : [];
  const start = lines.findIndex((l) => new RegExp(`^#+\\s+${esc(heading)}\\s*$`).test(l));
  let section: string | null = null;
  if (start >= 0) {
    const level = /^#+/.exec(lines[start])![0].length;
    const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level);
    section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  }
  (this as { lastText?: string | null }).lastText = section;
});

Then("it tells the owner to open the factory dashboard at {string}", function (url: string) {
  const t = textOf(this);
  const sentence = t.split(/(?<=\.)\s+/).find((s) => s.includes(url));
  assert.ok(sentence, `it doesn't name ${url}`);
  assert.match(sentence, /\bopen\b/i, `it names ${url} without telling the owner to open it`);
});

Then("it says the dashboard sends them to Keycloak to sign in", function () {
  const t = textOf(this);
  assert.match(t, /(sends|redirects|takes) (you|them|the owner)\b[^.]*\bKeycloak\b[^.]*\bsign(s)?[ -]in\b|\bKeycloak\b[^.]*\bsign(s)?[ -]in\b/i, "it doesn't say the dashboard sends the owner to Keycloak to sign in");
});

Then("it names the realm's test owner, {string}, and where to find its password", function (user: string) {
  const t = textOf(this);
  assert.ok(t.includes(`\`${user}\``) || t.includes(`"${user}"`), `it doesn't name the user "${user}"`);
  const sentence = t.split(/(?<=\.)\s+/).find((s) => /password/i.test(s));
  assert.ok(sentence, "it says nothing of a password");
  assert.match(sentence, /`[^`]*[/.][^`]*`|\]\([^)]+\)/, `it doesn't say where to find the password: ${sentence}`);
});

Then("it doesn't tell the owner to open the {string} resource's console", function (resource: string) {
  assert.doesNotMatch(textOf(this), new RegExp(`\`?${esc(resource)}\`? resource's console|\`${esc(resource)}\`[^.\\n]*console`, "i"));
});

Then("it mentions no sign-in link for this start", function () {
  assert.doesNotMatch(textOf(this), /sign-in link|dev-login\?token/i);
});

Then("it doesn't say the local dashboard signs the owner in as the {string} user", function (name: string) {
  const lines = textOf(this).split("\n").filter((l) => l.includes(name) && /signs (you|the owner) in as/i.test(l));
  assert.deepEqual(lines, [], `lines that say the dashboard signs the owner in as the ${name} user`);
});
