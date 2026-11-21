import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cucumberArgs, DEFAULT_WORKERS, workerCount } from "./run.ts";

test("with no worker count set, or an empty one, the suite runs in the default, which is more than one", () => {
  assert.ok(DEFAULT_WORKERS > 1);
  assert.deepEqual(workerCount({}), { workers: DEFAULT_WORKERS });
  assert.deepEqual(workerCount({ BDD_WORKERS: "" }), { workers: DEFAULT_WORKERS });
});

test("BDD_WORKERS sets the worker count", () => {
  assert.deepEqual(workerCount({ BDD_WORKERS: "1" }), { workers: 1 });
  assert.deepEqual(workerCount({ BDD_WORKERS: " 3 " }), { workers: 3 });
});

for (const bad of ["0", "-2", "three", "1.5", "2x", "00"]) {
  test(`a worker count of ${JSON.stringify(bad)} is refused`, () => {
    const r = workerCount({ BDD_WORKERS: bad });
    assert.ok("error" in r);
    assert.match(r.error, /the worker count must be a whole number above zero/);
    assert.match(r.error, /BDD_WORKERS/);
  });
}

test("cucumber-js runs the support code and steps in that many workers, writing the report, with the extra arguments last", () => {
  assert.deepEqual(cucumberArgs(3, ["--tags", "not @local"]), [
    "--import", "features/support/**/*.ts",
    "--import", "features/steps/**/*.ts",
    "--format", "message:reports/bdd.ndjson",
    "--plugin", pathToFileURL(new URL("./serial-last.ts", import.meta.url).pathname).href,
    "--parallel", "3",
    "--tags", "not @local",
  ]);
});

test("an explicit --parallel among the extra arguments wins", () => {
  assert.ok(!cucumberArgs(3, ["--parallel", "5"]).includes("3"));
  assert.ok(!cucumberArgs(3, ["--parallel=5"]).includes("3"));
});
