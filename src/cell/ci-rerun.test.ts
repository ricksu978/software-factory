import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failedNames, refusedNotes, rerunNotes } from "./ci-rerun.ts";

const SHA = "c0ffee1234567890";

describe("failedNames", () => {
  test("names each failed check once, and none that passed or still runs", () => {
    assert.deepEqual(failedNames([
      { name: "lint", conclusion: "success", url: "u" },
      { name: "ci", conclusion: "failure", url: "u" },
      { name: "e2e", conclusion: "failure", url: "u" },
      { name: "ci", conclusion: "failure", url: "v" },
      { name: "deploy", conclusion: "pending", url: "u" },
    ]), ["ci", "e2e"]);
    assert.deepEqual(failedNames(null), []);
  });
});

describe("rerunNotes", () => {
  test("says each check was re-run on the short commit and passed on the re-run", () => {
    assert.deepEqual(rerunNotes(SHA, ["ci"], "success", [{ name: "ci", conclusion: "success", url: "u" }]), [
      `The check "ci" failed on c0ffee1, so the factory re-ran it once, and it passed on the re-run.`,
    ]);
  });

  test("says which check failed again and which passed", () => {
    assert.deepEqual(rerunNotes(SHA, ["ci", "e2e"], "failure", [
      { name: "ci", conclusion: "success", url: "u" },
      { name: "e2e", conclusion: "failure", url: "w" },
    ]), [
      `The check "ci" failed on c0ffee1, so the factory re-ran it once, and it passed on the re-run.`,
      `The check "e2e" failed on c0ffee1, so the factory re-ran it once, and it failed again on the re-run.`,
    ]);
  });

  test("falls back on CI's overall answer when the checks couldn't be read", () => {
    assert.deepEqual(rerunNotes(SHA, ["ci"], "failure", null), [
      `The check "ci" failed on c0ffee1, so the factory re-ran it once, and CI was still red after the re-run.`,
    ]);
    assert.deepEqual(rerunNotes(SHA, ["ci"], "success", null), [
      `The check "ci" failed on c0ffee1, so the factory re-ran it once, and it passed on the re-run.`,
    ]);
  });
});

describe("refusedNotes", () => {
  test("says each check couldn't be re-run on the short commit, and why", () => {
    assert.deepEqual(refusedNotes(SHA, ["ci"], new Error("403 Forbidden")), [
      `The check "ci" failed on c0ffee1, and the factory couldn't re-run it (403 Forbidden), so the failure stands.`,
    ]);
  });
});
