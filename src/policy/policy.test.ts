import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadPolicy, parseCriteria, parseJudgement, PolicyError, readinessSha, type Policy, type ReadinessLogic, type ReadinessTexts } from "./policy.ts";

const repoFiles = (files: Record<string, string>) => async (path: string) => files[path] ?? null;
// The loader's own directory, so a cell that points FACTORY_POLICY_DIR at its image's copy compares like with like.
const defaultDor = readFileSync(join(process.env.FACTORY_POLICY_DIR ?? join(import.meta.dirname, "..", "..", "policy"), "dor.md"), "utf8");

describe("loadPolicy", () => {
  test("a repo with no dor.md gets the factory's default", async () => {
    const p = await loadPolicy(repoFiles({}), "dor");
    assert.equal(p?.source, "default");
    assert.equal(p?.text, defaultDor);
    assert.equal(p?.criteria.length, 3);
  });

  test("a repo's own dor.md replaces the default whole", async () => {
    const p = await loadPolicy(repoFiles({ ".factory/dor.md": "- [ ] Has a Size of 5 or less\n" }), "dor");
    assert.equal(p?.source, "repo");
    assert.ok(!p?.text.includes("one Sprint"));
    assert.deepEqual(p?.criteria.map((c) => c.text), ["Has a Size of 5 or less"]);
  });

  test("a repo with no dod.md gets null, since dod.md has no default", async () => {
    assert.equal(await loadPolicy(repoFiles({}), "dod"), null);
  });

  test("guidance files load whole, with no criteria", async () => {
    for (const name of ["scenarios", "risk"] as const) {
      const p = await loadPolicy(repoFiles({}), name);
      assert.equal(p?.source, "default");
      assert.deepEqual(p?.criteria, []);
    }
  });

  test("a run: line outside dod.md throws PolicyError naming the file", async () => {
    const files = { ".factory/pr-review.md": "Prose first.\n- [ ] Lint is clean `run: npm run lint`\n" };
    await assert.rejects(loadPolicy(repoFiles(files), "pr-review"), (e: unknown) =>
      e instanceof PolicyError && e.message === "pr-review.md: run: lines are allowed only in dod.md");
  });

  test("a read that throws propagates and never falls back to the default", async () => {
    const failing = async () => {
      throw new Error("500 from the git host");
    };
    await assert.rejects(loadPolicy(failing, "dor"), /500/);
  });

  test("the sha is the SHA-256 of the raw text, whether it came from the repo or a default", async () => {
    const a = await loadPolicy(repoFiles({ ".factory/dor.md": "- [ ] A\n" }), "dor");
    const b = await loadPolicy(repoFiles({ ".factory/dor.md": "- [ ] B\n" }), "dor");
    const d = await loadPolicy(repoFiles({}), "dor");
    assert.match(a?.sha ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(a?.sha, b?.sha);
    assert.notEqual(a?.sha, d?.sha);
  });
});

describe("parseCriteria", () => {
  test("only top-level - [ ] lines count, numbered from 1", () => {
    const md = "# Title\n\nSome prose.\n- [ ] First\n  - [ ] Nested, not a criterion\n- a plain bullet\n- [ ] Second\n";
    assert.deepEqual(parseCriteria(md), [
      { index: 1, text: "First", run: null },
      { index: 2, text: "Second", run: null },
    ]);
  });

  test("a byte-order mark before the first line doesn't hide its criterion", () => {
    assert.deepEqual(parseCriteria("\uFEFF- [ ] First\r\n- [ ] Second\r\n").map((c) => c.text), ["First", "Second"]);
  });

  test("a run: in backticks becomes the criterion's command", () => {
    assert.deepEqual(parseCriteria("- [ ] E2E suite passes `run: npm run e2e`\n"), [
      { index: 1, text: "E2E suite passes `run: npm run e2e`", run: "npm run e2e" },
    ]);
  });
});

describe("parseJudgement", () => {
  const policy = (name: Policy["name"], lines: string[]): Policy => ({
    name, source: "repo", sha: "", text: "", criteria: lines.map((text, i) => ({ index: i + 1, text, run: null })),
  });
  const reply = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");

  test("an index the reply leaves out fails as not judged, even when the text was paraphrased", () => {
    const p = policy("dor", ["Has a title", "Has a size"]);
    const v = parseJudgement(`The item has a size, so that's fine.\n${reply({ index: 1, status: "passed", reason: "ok" })}`, p);
    assert.deepEqual(v[1], { index: 2, criterion: "Has a size", status: "failed", reason: "not judged" });
  });

  test("when an index is both passed and failed, the fail wins", () => {
    const v = parseJudgement(reply({ index: 1, status: "passed", reason: "ok" }, { index: 1, status: "failed", reason: "no title" }), policy("dor", ["Has a title"]));
    assert.equal(v[0].status, "failed");
    assert.equal(v[0].reason, "no title");
  });

  test("person counts only in dod.md, and anywhere else it fails", () => {
    const answer = reply({ index: 1, status: "person", reason: "after merge" });
    assert.equal(parseJudgement(answer, policy("dod", ["Deployed to staging"]))[0].status, "person");
    assert.equal(parseJudgement(answer, policy("dor", ["Has a title"]))[0].status, "failed");
  });
});

describe("readinessSha", () => {
  const texts: ReadinessTexts = { dor: "a", scenarios: "b", "pr-review": "c", risk: "d", dod: "e", config: "f" };

  test("it changes when any one text changes, and stays the same when none does", () => {
    const base = readinessSha(texts);
    assert.equal(readinessSha({ ...texts }), base);
    for (const key of Object.keys(texts) as (keyof ReadinessTexts)[]) assert.notEqual(readinessSha({ ...texts, [key]: "changed" }), base, key);
  });

  test("it counts a pr-review.md that loadPolicy rejects, so fixing that file changes the hash", () => {
    assert.notEqual(readinessSha({ ...texts, "pr-review": "- [ ] x `run: y`" }), readinessSha({ ...texts, "pr-review": "- [ ] x" }));
  });

  test("a missing dod.md and an empty one give different hashes", () => {
    assert.notEqual(readinessSha({ ...texts, dod: null }), readinessSha({ ...texts, dod: "" }));
  });

  test("text moved across a file boundary changes the hash, including multi-byte text", () => {
    assert.notEqual(readinessSha({ ...texts, dor: "ab", scenarios: "c" }), readinessSha({ ...texts, dor: "a", scenarios: "bc" }));
    assert.notEqual(readinessSha({ ...texts, dor: "é", scenarios: "" }), readinessSha({ ...texts, dor: "", scenarios: "é" }));
  });

  test("a missing file and one holding the word absent give different hashes", () => {
    for (const key of ["dod", "config"] as const) assert.notEqual(readinessSha({ ...texts, [key]: null }), readinessSha({ ...texts, [key]: "absent" }), key);
  });

  const logic: ReadinessLogic = { judgePrompt: "Judge the item.", version: 1, splitPrompt: "Split the item." };

  test("it covers the factory's readiness logic: the judge's prompt and the readiness version (PBI 149)", () => {
    const base = readinessSha(texts, logic);
    assert.equal(readinessSha({ ...texts }, { ...logic }), base);
    assert.notEqual(base, readinessSha(texts), "the logic adds to the repo files alone");
    assert.notEqual(readinessSha(texts, { ...logic, judgePrompt: "Judge the item briefly." }), base);
    assert.notEqual(readinessSha(texts, { ...logic, version: 2 }), base);
  });

  test("it covers the split prompt too (PBI 159)", () => {
    const base = readinessSha(texts, logic);
    assert.notEqual(readinessSha(texts, { ...logic, splitPrompt: "Split the item briefly." }), base);
    assert.equal(readinessSha(texts, { ...logic, splitPrompt: "Split the item." }), base);
    assert.notEqual(readinessSha(texts, { ...logic, version: 1, splitPrompt: "1" }), readinessSha(texts, { ...logic, version: 11, splitPrompt: "" }));
  });

  test("text moved between the judge's prompt and the version changes the hash", () => {
    assert.notEqual(readinessSha(texts, { judgePrompt: "p1", version: 1, splitPrompt: "s" }), readinessSha(texts, { judgePrompt: "p", version: 11, splitPrompt: "s" }));
  });
});
