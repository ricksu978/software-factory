// Step definitions for features/pbi-312-local-run-asks-only-local-parameters.feature. They run the start's parameter
// check in src/apphost/local-parameters.ts against a fake checkout in a temp directory, both ways the real start meets
// it: checkLocalParameters() with a scripted owner, and the `--ask` and `--verdict` command line that
// scripts/set-local-secrets.ps1 takes its parameters to ask for, its "Still missing" line and its exit code from.
// - The checkout holds aspire-apphost/apphost.mts, either a copy of the factory's real one or that copy with the
//   declarations a scenario adds. Each added declaration goes beside the BFF's parameters, using the AppHost's own
//   runMode and secret() helper the way it declares oidc-issuer and oidc-client-secret.
// - The secrets store is a fresh secrets.json in its own temp directory, as `aspire secret path` would give it. The steps
//   save parameters by writing it, and read it back afterwards.
// - The owner's answers are scripted: each prompt is recorded, and answered with a value or left empty.
// - Nothing starts: the check's result says whether the start would go on to `aspire run`, as scripts/factory.ps1 does.
// The steps know which parameters each AppHost declares under `aspire run` from the feature's own list and the
// declarations they add, never from the code under test.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLocalParameters, runCli } from "../../src/apphost/local-parameters.ts";

const REAL_APPHOST = join(import.meta.dirname, "..", "..", "aspire-apphost", "apphost.mts");
/** What the factory's AppHost declares under `aspire run`, and only for a published run, as the feature lists them. */
const RUN_PARAMS = [
  "claude-oauth-token", "github-app-key", "github-project-token", "cell-secret", "github-webhook-secret", "dev-login",
  "github-app-id", "claude-token-created-at", "bff-session-key",
];
const PUBLISH_ONLY_PARAMS = ["oidc-issuer", "oidc-client-secret"];
const OIDC = PUBLISH_ONLY_PARAMS;
/** The line the added declarations go after. */
const ANCHOR = "const bffClientSecret = runMode ? '' : await secret('oidc-client-secret');";

type Ctx = {
  root: string;
  checkout: string;
  secretsFile: string;
  /** What this checkout's AppHost declares under `aspire run`, and only outside it. */
  runParams: string[];
  publishOnly: string[];
  added: string[];
  /** Whether the owner answers every prompt; `empty` holds the parameters the owner leaves empty regardless. */
  answerAll: boolean;
  empty: Set<string>;
  asked: string[];
  said: string[];
  wentOn: boolean | null;
};

function ctx(world: object): Ctx {
  const c = (world as { pbi312?: Ctx }).pbi312;
  assert.ok(c, "the scenario has no fake checkout");
  return c;
}

function newCheckout(world: object, additions: { line: string; run: string[]; publishOnly: string[] }[] = []): Ctx {
  const root = mkdtempSync(join(tmpdir(), "pbi-312-"));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "aspire-apphost"), { recursive: true });
  let src = readFileSync(REAL_APPHOST, "utf8");
  assert.ok(src.includes(ANCHOR), "the factory's AppHost no longer declares oidc-client-secret where the steps expect");
  if (additions.length) src = src.replace(ANCHOR, [ANCHOR, ...additions.map((a) => a.line)].join("\n"));
  writeFileSync(join(checkout, "aspire-apphost", "apphost.mts"), src);
  const c: Ctx = {
    root,
    checkout,
    secretsFile: join(root, "user-secrets", "secrets.json"),
    runParams: [...RUN_PARAMS, ...additions.flatMap((a) => a.run)],
    publishOnly: [...PUBLISH_ONLY_PARAMS, ...additions.flatMap((a) => a.publishOnly)],
    added: [],
    answerAll: false,
    empty: new Set(),
    asked: [],
    said: [],
    wentOn: null,
  };
  (world as { pbi312?: Ctx }).pbi312 = c;
  return c;
}

function readStore(c: Ctx): Record<string, unknown> {
  return existsSync(c.secretsFile) ? (JSON.parse(readFileSync(c.secretsFile, "utf8")) as Record<string, unknown>) : {};
}

function save(c: Ctx, names: string[]) {
  const store = readStore(c);
  for (const n of names) store[`Parameters:${n}`] = `saved-${n}`;
  mkdirSync(join(c.root, "user-secrets"), { recursive: true });
  writeFileSync(c.secretsFile, JSON.stringify(store, null, 2));
}

function unsave(c: Ctx, names: string[]) {
  if (!existsSync(c.secretsFile)) return;
  const store = readStore(c);
  for (const n of names) delete store[`Parameters:${n}`];
  writeFileSync(c.secretsFile, JSON.stringify(store, null, 2));
}

const savedNames = (c: Ctx) =>
  Object.keys(readStore(c)).filter((k) => k.startsWith("Parameters:")).map((k) => k.slice("Parameters:".length));

/** The names in the start's "Still missing:" line, or [] if it said none. */
function namedMissing(c: Ctx): string[] {
  const line = c.said.find((l) => l.startsWith("Still missing:"));
  return line ? line.slice("Still missing:".length).split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const sorted = (xs: string[]) => [...xs].sort();

After(function () {
  const c = (this as { pbi312?: Ctx }).pbi312;
  if (c) rmSync(c.root, { recursive: true, force: true });
});

// ---- Given ----

Given("a checkout of the factory's AppHost with no parameter saved", function () {
  newCheckout(this);
});

Given("a checkout of the factory's AppHost", function () {
  newCheckout(this);
});

/** The AppHost's declaration of a `kind` named `name`, only under `aspire run`, only outside it, or for every run. */
function declaration(kind: string, name: string, when: "run" | "publish" | "both"): string {
  const decl = kind === "secret" ? `await secret('${name}')` : `await builder.addParameter('${name}')`;
  const v = `pbi312_${name.replace(/-/g, "_")}`;
  if (when === "both") return `const ${v} = ${decl};\nvoid ${v};`;
  return `const ${v} = runMode ? ${when === "run" ? `${decl} : ''` : `'' : ${decl}`};\nvoid ${v};`;
}

Given(/^a checkout whose AppHost also declares a (secret|plain parameter) "([^"]+)" only under "aspire run"$/, function (kind: string, name: string) {
  newCheckout(this, [{ line: declaration(kind, name, "run"), run: [name], publishOnly: [] }]);
});

Given(/^a checkout whose AppHost also declares a (secret|plain parameter) "([^"]+)" only outside "aspire run"$/, function (kind: string, name: string) {
  newCheckout(this, [{ line: declaration(kind, name, "publish"), run: [], publishOnly: [name] }]);
});

Given(
  "a checkout whose AppHost declares a secret {string} for every run, and a secret {string} only outside {string}",
  function (shared: string, publishOnly: string, _run: string) {
    newCheckout(this, [
      { line: declaration("secret", shared, "both"), run: [shared], publishOnly: [] },
      { line: declaration("secret", publishOnly, "publish"), run: [], publishOnly: [publishOnly] },
    ]);
  },
);

Given("no parameter is saved", function () {
  const c = ctx(this);
  rmSync(c.secretsFile, { force: true });
});

Given("every parameter the AppHost declares under {string} is saved", function (_run: string) {
  const c = ctx(this);
  save(c, c.runParams);
});

Given("every parameter that AppHost declares under {string} is saved", function (_run: string) {
  const c = ctx(this);
  save(c, c.runParams);
});

Given("every parameter the AppHost declares under {string} is saved except {string}", function (_run: string, except: string) {
  const c = ctx(this);
  save(c, c.runParams.filter((n) => n !== except));
});

Given("every parameter the AppHost declares, for either kind of run, is saved except {string}", function (except: string) {
  const c = ctx(this);
  save(c, [...c.runParams, ...c.publishOnly].filter((n) => n !== except));
});

Given("every other parameter that AppHost declares is saved", function () {
  const c = ctx(this);
  // The parameter the scenario added under `aspire run` is the one left out.
  const added = c.runParams.filter((n) => !RUN_PARAMS.includes(n));
  save(c, [...c.runParams, ...c.publishOnly].filter((n) => !added.includes(n)));
});

Given("{string} is not saved", function (name: string) {
  unsave(ctx(this), [name]);
});

Given("neither OIDC setting is saved", function () {
  unsave(ctx(this), OIDC);
});

Given("the owner will give a value for every parameter the start asks for", function () {
  ctx(this).answerAll = true;
});

Given("the owner will leave {string} empty when asked", function (name: string) {
  ctx(this).empty.add(name);
});

// ---- When ----

When("the owner runs {string}", async function (command: string) {
  assert.equal(command, "npm run factory");
  const c = ctx(this);
  const cli = (mode: string) => {
    const out: string[] = [];
    return { code: runCli([c.checkout, mode, c.secretsFile], (l) => out.push(l)), out };
  };
  // What set-local-secrets.ps1 -MissingOnly would ask for, read before the owner answers.
  const scriptAsks = cli("--ask").out.map((l) => l.slice(l.indexOf(" ") + 1));
  c.wentOn = await checkLocalParameters({
    checkout: c.checkout,
    secretsFile: c.secretsFile,
    ask: async (name) => {
      c.asked.push(name);
      return c.answerAll && !c.empty.has(name) ? `answer-${name}` : "";
    },
    say: (line) => c.said.push(line),
  });
  // The script asks for the same parameters, and stops or goes on the same way, with the same line.
  assert.deepEqual(scriptAsks, c.asked, "set-local-secrets.ps1 would ask for different parameters");
  const scriptVerdict = cli("--verdict");
  assert.equal(scriptVerdict.code, c.wentOn ? 0 : 1, "set-local-secrets.ps1 would exit differently");
  assert.equal(scriptVerdict.out.join("\n"), c.said.at(-1), "set-local-secrets.ps1 would say something different");
});

// ---- Then ----

Then("the start asks for exactly these parameters:", function (table: { raw(): string[][] }) {
  const c = ctx(this);
  assert.deepEqual(sorted(c.asked), sorted(table.raw().map((r) => r[0]!)), `the start asked for ${c.asked.join(", ")}`);
});

Then("the start asks for exactly the parameters the factory's own AppHost declares under {string}", function (_run: string) {
  const c = ctx(this);
  assert.deepEqual(sorted(c.asked), sorted(RUN_PARAMS), `the start asked for ${c.asked.join(", ")}`);
});

Then("the start asks for {string}", function (name: string) {
  const c = ctx(this);
  assert.ok(c.asked.includes(name), `the start asked for ${c.asked.join(", ") || "nothing"}, not ${name}`);
});

Then("the start doesn't ask for {string}", function (name: string) {
  const c = ctx(this);
  assert.ok(!c.asked.includes(name), `the start asked for ${name}`);
});

Then("the start asks for no parameter", function () {
  const c = ctx(this);
  assert.deepEqual(c.asked, [], `the start asked for ${c.asked.join(", ")}`);
});

Then("the start says every parameter is set", function () {
  const c = ctx(this);
  assert.ok(c.said.some((l) => /^All \d+ parameters are set\.$/.test(l)), `the start said:\n${c.said.join("\n")}`);
});

Then("the start says all {int} parameters are set", function (n: number) {
  const c = ctx(this);
  assert.ok(c.said.includes(`All ${n} parameters are set.`), `the start said:\n${c.said.join("\n")}`);
});

Then("the start says {string} is still missing", function (name: string) {
  const c = ctx(this);
  assert.ok(namedMissing(c).includes(name), `the start said:\n${c.said.join("\n")}`);
});

Then("the start doesn't name {string} or {string} as missing", function (a: string, b: string) {
  const c = ctx(this);
  const named = namedMissing(c).filter((n) => n === a || n === b);
  assert.deepEqual(named, [], `the start named ${named.join(" and ")} as missing`);
});

Then("the start goes on to {string}", function (_run: string) {
  const c = ctx(this);
  assert.equal(c.wentOn, true, `the start stopped before aspire run. It said:\n${c.said.join("\n")}`);
});

Then("the start stops before {string}", function (_run: string) {
  const c = ctx(this);
  assert.equal(c.wentOn, false, "the start went on to aspire run");
});

Then("{string} is still not saved", function (name: string) {
  const c = ctx(this);
  assert.ok(!savedNames(c).includes(name), `${name} was saved`);
});
