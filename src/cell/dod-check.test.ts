// checkDefinitionOfDone's CI-check cases (PBI 229) that the scenarios don't already pin. Each runs line 1's command in a
// temporary checkout, where the command leaves a mark file so a test can tell whether it ran.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseCriteria, type Criterion, type Policy, type Verdict } from "../policy/policy.ts";
import { checkDefinitionOfDone, type CiCheck } from "./engine.ts";

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
