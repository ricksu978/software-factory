import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, parseRepoConfig } from "./repo-config.ts";

const valid = `bdd:\n  parse: npm run bdd -- --dry-run\n  run: npm run bdd\n  report: reports/bdd.ndjson\ncommands:\n  test: npm test\n  lint: npm run lint\n`;

describe("parseRepoConfig", () => {
  test("a repo with no config fails on bdd, since it can't run BDD", () => {
    assert.throws(() => parseRepoConfig(null), (e: unknown) => e instanceof ConfigError && e.key === "bdd");
  });

  test("a config without commands fails naming commands", () => {
    assert.throws(() => parseRepoConfig(valid.split("commands:")[0]), (e: unknown) => e instanceof ConfigError && e.key === "commands");
  });

  test("a blank command fails naming it", () => {
    assert.throws(() => parseRepoConfig(valid.replace("lint: npm run lint", "lint: ''")), (e: unknown) => e instanceof ConfigError && e.key === "commands.lint");
  });

  test("broken YAML is a ConfigError, not a crash", () => {
    assert.throws(() => parseRepoConfig("bdd: [unclosed"), ConfigError);
  });

  test("sensitive_paths and reviewers default to empty, and read through when set", () => {
    const c = parseRepoConfig(valid);
    assert.deepEqual([c.sensitivePaths, c.reviewers], [[], []]);
    const set = parseRepoConfig(`${valid}sensitive_paths: ["infra/**"]\nreviewers: [octo/team]\n`);
    assert.deepEqual([set.sensitivePaths, set.reviewers], [["infra/**"], ["octo/team"]]);
    assert.deepEqual(set.commands, { test: "npm test", lint: "npm run lint" });
  });

  test("web_tools defaults to none, takes the two known tools, and refuses anything else", () => {
    assert.deepEqual(parseRepoConfig(valid).webTools, []);
    assert.deepEqual(parseRepoConfig(`${valid}web_tools: [WebSearch]\n`).webTools, ["WebSearch"]);
    assert.throws(() => parseRepoConfig(`${valid}web_tools: [Bash]\n`), (e: unknown) => e instanceof ConfigError && e.key === "web_tools");
  });

  test("this repo's own .factory/config.yml parses", () => {
    const c = parseRepoConfig(readFileSync(join(import.meta.dirname, "..", "..", ".factory", "config.yml"), "utf8"));
    assert.equal(c.bdd.report, "reports/bdd.ndjson");
  });
});
