import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_BACK_TO_GREEN, onlyCiFailures } from "./questions.ts";

test("an \"Address failed\" question naming one CI failure is one the factory answers (PBI 317)", () => {
  assert.equal(onlyCiFailures("Address failed:\n- CI failed on m3rge01"), true);
});

test("one naming several CI failures, with what each commit was, is too (PBI 317)", () => {
  assert.equal(onlyCiFailures("Address failed:\n- CI failed on m3rge01\n- CI failed on m3rge01\n- CI failed on m3rge02, the PR addresser's fix for the PR review's findings"), true);
  assert.equal(onlyCiFailures("Address failed:\r\n- CI failed on abc1234, the PR addresser's fix: the check \"ci\" failed, https://x/1. Failing tests: \"a\".\r\n"), true);
});

test("one naming anything besides CI failures isn't (PBI 317)", () => {
  assert.equal(onlyCiFailures("Address failed:\n- CI failed on m3rge01\n- the locked scenario file \"features/pbi-12-poller.feature\" changed"), false);
  assert.equal(onlyCiFailures("Address failed:\n- Definition of Done failed: `npm test` exited 1"), false);
  assert.equal(onlyCiFailures("Address failed:"), false);
  assert.equal(onlyCiFailures("Address failed: CI failed on the PR"), false);
  assert.equal(onlyCiFailures("no CI ran on the PR"), false);
  assert.equal(onlyCiFailures("Green failed:\n- CI failed on m3rge01"), false);
});

test("the factory's answer says it sends the item back to Green to fix the CI failure (PBI 317)", () => {
  assert.match(CI_BACK_TO_GREEN, /\bGreen\b/);
  assert.match(CI_BACK_TO_GREEN, /CI failure/);
  assert.match(CI_BACK_TO_GREEN, /\bfix\b/);
});
