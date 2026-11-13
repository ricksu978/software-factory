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

test("a -t that belongs to another program before cucumber-js isn't read", () => {
  for (const cmd of ["docker run --rm -t app npx cucumber-js", "docker run -t app npm run bdd"]) {
    const s = selects(cmd);
    assert.equal(s(plain), true, cmd);
    assert.equal(s(local), true, cmd);
  }
  const s = selects('docker run --rm -t app npx cucumber-js --tags "not @local"');
  assert.equal(s(plain), true);
  assert.equal(s(local), false);
});

test("a -t in another command of the same line isn't read", () => {
  for (const cmd of ["sort -t , x && cucumber-js", "cucumber-js; sort -t , x", "cucumber-js | tee -t out", "foo -t app & cucumber-js"]) {
    const s = selects(cmd);
    assert.equal(s(plain), true, cmd);
    assert.equal(s(local), true, cmd);
  }
  const s = selects('npm run typecheck && npm test && npm run bdd -- --tags "not @local"');
  assert.equal(s(local), false);
});

test("npm's own flags before -- aren't cucumber-js's; pnpm and yarn pass them on", () => {
  assert.equal(selects('npm run bdd --tags "not @local"')(local), true);
  assert.equal(selects('pnpm run bdd --tags "not @local"')(local), false);
  assert.equal(selects('yarn run bdd -- --tags "not @local"')(local), false);
});

test("a quoted separator doesn't split the command", () => {
  const s = selects('cucumber-js --tags "not @local and not @a;b"');
  assert.equal(s(local), false);
});

test("a command that runs neither cucumber-js nor an npm script has its --tags read wherever they are", () => {
  assert.equal(selects('node fake/bdd.mjs --tags "not @local"')(local), false);
  assert.equal(selects('cp a b && echo --tags "not @local"')(local), false);
});

test("an expression the shell expands isn't read, so every scenario is expected", () => {
  for (const cmd of [
    'npx cucumber-js --tags "$BDD_TAGS"',
    "npx cucumber-js --tags $BDD_TAGS",
    'cucumber-js --tags "${BDD_TAGS}"',
    'npm run bdd -- --tags "$(cat tags.txt)"',
    "cucumber-js --tags `cat tags.txt`",
    'cucumber-js --tags="$BDD_TAGS"',
  ]) {
    const s = selects(cmd);
    assert.equal(s(plain), true, cmd);
    assert.equal(s(local), true, cmd);
  }
});

test("an expanded --tags doesn't hide a literal one beside it", () => {
  const s = selects('cucumber-js --tags "$BDD_TAGS" --tags "not @local"');
  assert.equal(s(plain), true);
  assert.equal(s(local), false);
});

test("a $ in single quotes or escaped isn't expanded, so it's read as written", () => {
  for (const cmd of ["cucumber-js --tags '@$x'", 'cucumber-js --tags "@\\$x"', "cucumber-js --tags @\\$x"]) {
    const s = selects(cmd);
    assert.equal(s(["@$x"]), true, cmd);
    assert.equal(s(plain), false, cmd);
  }
});
