import assert from "node:assert/strict";
import { test } from "node:test";
import { selects } from "./select.ts";

const local = ["@pbi-482", "@local"];
const plain = ["@pbi-482"];

test("a command with no --tags selects every scenario", () => {
  const s = selects("npm run bdd");
  assert.equal(s(plain), true);
  assert.equal(s(local), true);
});

test("this repo's bdd.run leaves out @local scenarios", () => {
  const s = selects('npm run bdd -- --tags "not @local"');
  assert.equal(s(plain), true);
  assert.equal(s(local), false);
});

test("single quotes, --tags= and -t all carry the expression", () => {
  for (const cmd of ["cucumber-js --tags 'not @local'", 'cucumber-js --tags="not @local"', "cucumber-js --tags=not\\ @local", 'cucumber-js -t "not @local"']) {
    const s = selects(cmd);
    assert.equal(s(plain), true, cmd);
    assert.equal(s(local), false, cmd);
  }
});

test("--tags given twice selects only scenarios both expressions select, as cucumber-js does", () => {
  const s = selects('cucumber-js --tags "not @local" --tags "not @slow"');
  assert.equal(s(plain), true);
  assert.equal(s(local), false);
  assert.equal(s(["@pbi-482", "@slow"]), false);
});

test("the filter is the repo's own, not @local by name", () => {
  const s = selects('cucumber-js --tags "not @slow"');
  assert.equal(s(local), true);
  assert.equal(s(["@pbi-482", "@slow"]), false);
});

test("an expression that doesn't parse throws, naming it", () => {
  assert.throws(() => selects('cucumber-js --tags "not ("'), /not \(/);
});
