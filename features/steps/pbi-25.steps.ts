import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readinessSha, type ReadinessTexts } from "../../src/policy/policy.ts";

// Each scenario builds two sets of the six readiness texts and compares readinessSha over them. The files
// are named as the factory reads them, and every text a scenario doesn't name holds its own fixed value.
type Ctx = { sets: ReadinessTexts[] };
const keys: Record<string, keyof ReadinessTexts> = {
  "dor.md": "dor", "scenarios.md": "scenarios", "pr-review.md": "pr-review", "risk.md": "risk", "dod.md": "dod", "config.yml": "config",
};
const base: ReadinessTexts = { dor: "dor", scenarios: "scenarios", "pr-review": "pr-review", risk: "risk", dod: "dod", config: "bdd: {}" };

function ctx(world: object): Ctx {
  const w = world as { pbi25?: Ctx };
  w.pbi25 ??= { sets: [] };
  return w.pbi25;
}

function key(file: string): keyof ReadinessTexts {
  const k = keys[file];
  assert.ok(k, `no readiness file ${file}`);
  return k;
}

function add(world: object, change: Partial<ReadinessTexts>): void {
  ctx(world).sets.push({ ...base, ...change });
}

const pair = (first: string, a: string, second: string, b: string) => ({ [key(first)]: a, [key(second)]: b });

Given("one set of readiness files where {word} holds {string} and {word} holds {string}", function (first: string, a: string, second: string, b: string) {
  add(this, pair(first, a, second, b));
});

Given("another set where {word} holds {string} and {word} holds {string}", function (first: string, a: string, second: string, b: string) {
  add(this, pair(first, a, second, b));
});

Given("one set of readiness files with no {word}", function (file: string) {
  add(this, { [key(file)]: null });
});

Given("another set where {word} holds {string}", function (file: string, text: string) {
  add(this, { [key(file)]: text });
});

Given("one set of readiness files", function () {
  add(this, {});
});

Given("another set with the same files", function () {
  add(this, {});
});

Given("another set where only {word} differs", function (file: string) {
  add(this, { [key(file)]: `${base[key(file)]} edited` });
});

function fingerprints(world: object): [string, string] {
  const sets = ctx(world).sets;
  assert.equal(sets.length, 2, "a scenario compares exactly two sets");
  return [readinessSha(sets[0]), readinessSha(sets[1])];
}

Then("the two sets have different fingerprints", function () {
  const [a, b] = fingerprints(this);
  assert.notEqual(a, b, `both sets hash to ${a}`);
});

Then("the two sets have the same fingerprint", function () {
  const [a, b] = fingerprints(this);
  assert.equal(a, b);
});
