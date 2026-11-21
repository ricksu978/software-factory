// checkDefinitionOfDone's CI-check cases (PBI 229) that the scenarios don't already pin. Each runs line 1's command in a
// temporary checkout, where the command leaves a mark file so a test can tell whether it ran.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseCriteria, type Criterion, type Policy, type Verdict } from "../policy/policy.ts";
import { checkDefinitionOfDone, gateCover, gateNote, type CiCheck, type GateRun } from "./engine.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const URL = "https://github.com/acme/widgets/actions/runs/7001";

async function check(lines: string[], ci: CiCheck[] | null | "no-pr", judge?: (j: Criterion[]) => Promise<Verdict[]>) {
  const dir = mkdtempSync(join(tmpdir(), "dod-check-"));
  dirs.push(dir);
  const text = lines.map((l) => `- [ ] ${l}`).join("\n");
  const dod: Policy = { name: "dod", source: "repo", sha: "s", text, criteria: parseCriteria(text) };
  const asked: string[] = [];
  const r = await checkDefinitionOfDone({
    dir, head: "abc1234", dod,
    ciChecks: ci === "no-pr" ? null : async (sha) => { asked.push(sha); return ci; },
    judge: judge ?? (async (j) => { throw new Error(`judged ${j.map((x) => x.index)}`); }),
    store: async () => {},
  });
  return { ...r, asked, ran: existsSync(join(dir, "ran")) };
}

const mark = (code: number) => `node -e "require('fs').writeFileSync('ran', '');process.exit(${code})"`;

describe("checkDefinitionOfDone with a ci: line", () => {
  test("asks CI about the commit being judged, once, however many lines name checks", async () => {
    const r = await check([`A. \`run: ${mark(0)}\` \`ci: ci\``, `B. \`run: ${mark(0)}\` \`ci: lint\``], [
      { name: "ci", conclusion: "success", url: URL }, { name: "lint", conclusion: "success", url: URL },
    ]);
    assert.deepEqual(r.asked, ["abc1234"]);
    assert.equal(r.ran, false);
  });

  test("doesn't ask CI when no line names a check", async () => {
    const r = await check([`A. \`run: ${mark(0)}\``], []);
    assert.deepEqual(r.asked, []);
    assert.equal(r.ran, true);
  });

  test("a check still running stands in for nothing and isn't missing, so the command runs", async () => {
    const r = await check([`A. \`run: ${mark(0)}\` \`ci: ci\``], [{ name: "ci", conclusion: "pending", url: URL }]);
    assert.equal(r.ran, true);
    assert.equal(r.verdicts[0].reason, "exit 0");
    assert.deepEqual(r.findings, []);
  });

  test("a check that ran twice fails the line when either run failed", async () => {
    const r = await check([`A. \`run: ${mark(0)}\` \`ci: ci\``], [
      { name: "ci", conclusion: "success", url: URL }, { name: "ci", conclusion: "failure", url: `${URL}-2` },
    ]);
    assert.equal(r.verdicts[0].status, "failed");
    assert.ok(r.verdicts[0].reason.includes(`${URL}-2`));
  });

  test("a line with a check and no command goes to the judge when the check is missing", async () => {
    const r = await check(["Docs read well. `ci: docs`"], [], async (j) => j.map((c) => ({ index: c.index, criterion: c.text, status: "passed", reason: "judged" })));
    assert.equal(r.verdicts[0].reason, "judged");
    assert.ok(r.findings.some((f) => /"docs".*missing on abc1234/.test(f)), r.findings.join("\n"));
  });

  test("a line with a check and no command passes on the check, and the judge never sees it", async () => {
    const r = await check(["Docs read well. `ci: docs`"], [{ name: "docs", conclusion: "success", url: URL }]);
    assert.equal(r.verdicts[0].status, "passed");
  });

  test("with no PR, the command runs and no check is called missing", async () => {
    const r = await check([`A. \`run: ${mark(1)}\` \`ci: ci\``], "no-pr");
    assert.equal(r.ran, true);
    assert.match(r.verdicts[0].reason, /^exit 1/);
    assert.deepEqual(r.findings, [`Definition of Done line 1 failed: A. \`run: ${mark(1)}\` \`ci: ci\`: ${r.verdicts[0].reason}`]);
  });
});

// PBI 389: a passing Green gate at the commit being checked stands in for the run: lines its commands cover.
describe("checkDefinitionOfDone with Green's gate run", () => {
  const gate = (over: Partial<GateRun> = {}): GateRun => ({ sha: "abc1234ffff", commands: ["npm test", `npm run bdd -- --tags "not @local"`, "npm run lint"], passed: 12, failed: 0, ...over });
  const run = async (lines: string[], g: GateRun | null) => {
    const dir = mkdtempSync(join(tmpdir(), "dod-check-"));
    dirs.push(dir);
    const text = lines.map((l) => `- [ ] ${l}`).join("\n");
    const dod: Policy = { name: "dod", source: "repo", sha: "s", text, criteria: parseCriteria(text) };
    const r = await checkDefinitionOfDone({ dir, head: "abc1234ffff", dod, ciChecks: null, gate: g, judge: async () => [], store: async () => {} });
    return { ...r, ran: existsSync(join(dir, "ran")) };
  };

  test("a line whose command is one of the gate's passes on the gate's run, naming the commit and the counts", async () => {
    const r = await run(["Tests pass. `run: npm  test`"], gate());
    assert.equal(r.verdicts[0].status, "passed");
    assert.match(r.verdicts[0].reason, /Green's gate passed/);
    assert.match(r.verdicts[0].reason, /abc1234/);
    assert.match(r.verdicts[0].reason, /12 scenarios passed and 0 failed/);
  });

  test("a line joined with && runs only the parts the gate didn't run", async () => {
    const r = await run([`Types and tests. \`run: ${mark(0)} && npm test\``], gate());
    assert.equal(r.ran, true);
    assert.equal(r.verdicts[0].status, "passed");
    assert.match(r.verdicts[0].reason, /Green's gate passed `npm test`/);
    assert.ok(r.verdicts[0].reason.includes(`\`${mark(0)}\` exited 0`), r.verdicts[0].reason);
  });

  test("an uncovered part that fails fails the line with its exit code first", async () => {
    const r = await run([`Tests and types. \`run: npm test && ${mark(3)}\``], gate());
    assert.equal(r.verdicts[0].status, "failed");
    assert.match(r.verdicts[0].reason, /^exit 3/);
  });

  test("a gate run at another commit stands in for nothing", async () => {
    const r = await run([`Tests. \`run: ${mark(0)}\``], gate({ sha: "fffffff", commands: [mark(0)] }));
    assert.equal(r.ran, true);
    assert.equal(r.verdicts[0].reason, "exit 0");
  });
});

describe("gateCover", () => {
  const cmds = ["npm test", `npm run bdd -- --tags "not @local"`, "node lint.mjs $(git ls-files '*.md')"];
  test("a command identical to a gate command is covered whole, even with a substitution", () => {
    assert.deepEqual(gateCover("node lint.mjs  $(git ls-files '*.md')", cmds), { covered: ["node lint.mjs $(git ls-files '*.md')"], rest: [] });
  });
  test("&& parts split outside quotes", () => {
    assert.deepEqual(gateCover(`npm run typecheck && npm run bdd -- --tags "not @local"`, cmds), { covered: [`npm run bdd -- --tags "not @local"`], rest: ["npm run typecheck"] });
  });
  test("a line with no covered part, or joined any other way, isn't covered", () => {
    for (const c of ["npm run typecheck", "npm test | tee test.log", "npm run typecheck || npm test", "npm run typecheck; npm test", "(npm run typecheck && npm test)", "npm run typecheck && npm test || true", "npm test && echo $(npm test)", "npm test &"]) {
      assert.equal(gateCover(c, cmds), null, c);
    }
  });
  test("a line with a part that changes the shell's state runs whole", () => {
    for (const c of ["cd web && npm test", "npm run typecheck && cd web && npm test", "export X=1 && npm test", "FOO=1 && npm test", "pushd web && npm test", "source env.sh && npm test", ". ./env.sh && npm test", "set -e && npm test"]) {
      assert.equal(gateCover(c, cmds), null, c);
    }
  });
  test("a gate command repeated in a line is named once", () => {
    assert.deepEqual(gateCover("npm test && npm run typecheck && npm test", cmds), { covered: ["npm test"], rest: ["npm run typecheck"] });
  });
  test("an && inside quotes doesn't split", () => {
    assert.equal(gateCover(`echo "a && npm test"`, cmds), null);
  });
});

describe("gateNote", () => {
  const g: GateRun = { sha: "abc1234ffff", commands: [`npm run bdd -- --tags "not @local"`, "npm test", "npm run lint"], passed: 12, failed: 0 };
  test("says where the full suite passed, with the command and counts, and to run no full suite", () => {
    const n = gateNote(g, "@pbi-7");
    assert.ok(n.includes("The full suite passed in Green's gate at abc1234"), n);
    assert.ok(n.includes(`\`npm run bdd -- --tags "not @local"\` reported 12 scenarios passed and 0 failed`), n);
    assert.match(n, /Don't run the full suite/);
    assert.ok(n.includes(`\`npm run bdd -- --tags "not @local" --tags "@pbi-7 and @ac-1"\``), n);
    assert.match(n, /single test files/);
  });
  test("is empty with no gate run", () => {
    assert.equal(gateNote(null, "@pbi-7"), "");
  });
});
