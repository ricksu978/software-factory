// Red and Green from a Cucumber Messages report (spec §6 "Reading runner results", plan Task 10).
// Statuses come from TestStepResult.status and step kinds from the pickle step's type, per
// cucumber/messages jsonschema/messages.schema.json.

export type ScenarioResult = { name: string; tags: string[]; verdict: "red" | "green" | "crash"; reason: string };
export type Results = Map<string, ScenarioResult>;
export type GateResult = { ok: boolean; findings: string[] };

type PickleStep = { id: string; type?: string; text: string };
type Pickle = { id: string; name: string; tags: { name: string }[]; steps: PickleStep[] };
type TestCase = { id: string; pickleId: string; testSteps: { id: string; pickleStepId?: string }[] };
type StepResult = { status: string; message?: string };

// Keyed by pickle id. A report that's empty or cut short yields fewer results, never a false red or green:
// a scenario counts only from the results it has, and a step with no result is a crash.
export function classify(ndjson: string): Results {
  const pickles = new Map<string, Pickle>();
  const cases = new Map<string, TestCase>();
  const startedCase = new Map<string, string>(); // testCaseStarted id -> testCase id
  const latestStart = new Map<string, string>(); // testCase id -> its last attempt's testCaseStarted id
  const stepResults = new Map<string, StepResult>(); // `${testCaseStarted id}/${testStep id}` -> result

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // a truncated last line; its scenario lacks that result and becomes a crash
    }
    if (m.pickle) pickles.set(m.pickle.id, m.pickle);
    else if (m.testCase) cases.set(m.testCase.id, m.testCase);
    else if (m.testCaseStarted) {
      startedCase.set(m.testCaseStarted.id, m.testCaseStarted.testCaseId);
      latestStart.set(m.testCaseStarted.testCaseId, m.testCaseStarted.id); // a retry replaces the earlier attempt
    } else if (m.testStepFinished) {
      const f = m.testStepFinished;
      stepResults.set(`${f.testCaseStartedId}/${f.testStepId}`, f.testStepResult);
    }
  }

  const results: Results = new Map();
  for (const tc of cases.values()) {
    const pickle = pickles.get(tc.pickleId);
    if (!pickle) continue;
    const started = latestStart.get(tc.id);
    const steps = new Map(pickle.steps.map((s) => [s.id, s]));
    let verdict: ScenarioResult["verdict"] = "green";
    let reason = "";
    for (const ts of tc.testSteps) {
      const step = ts.pickleStepId ? steps.get(ts.pickleStepId) : undefined;
      const label = step ? `"${step.text}"` : "a hook";
      const result = started ? stepResults.get(`${started}/${ts.id}`) : undefined;
      if (!result) {
        verdict = "crash";
        reason = `no result for ${label}`;
        break;
      }
      if (result.status === "PASSED") continue;
      const message = result.message ? `: ${result.message.split("\n")[0]}` : "";
      if (result.status === "FAILED" && step?.type === "Outcome") {
        verdict = "red";
        reason = `${label} failed${message}`;
      } else {
        verdict = "crash";
        reason = `${result.status} at ${label}${message}`;
      }
      break;
    }
    results.set(pickle.id, { name: pickle.name, tags: pickle.tags.map((t) => t.name), verdict, reason });
  }
  return results;
}

function tagged(results: Results, tag: string): ScenarioResult[] {
  return [...results.values()].filter((r) => r.tags.includes(tag));
}

// Red proof: every scenario tagged pbiTag is red, except @regression ones, which are green, and every expected
// name ran. Other items' scenarios are ignored. A @regression scenario restates behaviour that already holds,
// such as "every existing test still passes". A new-behaviour scenario tagged @regression is red at Red, so it
// still fails, as long as its Then asserts. One whose Then asserts nothing passes both gates, so self-review's
// "every step asserts" check and the person signing off, who sees the tag, are what catch it.
export const REGRESSION_TAG = "@regression";

// `expected` names the item's scenarios bdd.run selects, and `listed` counts the ones bdd.parse lists, filter or no
// filter (PBI 185). A scenario bdd.run leaves out isn't expected to run, but an item none of whose scenarios it selects
// fails, since nothing then proves the item red.
export function redGate(results: Results, pbiTag: string, expected: string[], listed = expected.length): GateResult {
  const mine = tagged(results, pbiTag);
  const findings: string[] = [];
  for (const r of mine) {
    if (r.tags.includes(REGRESSION_TAG)) {
      if (r.verdict !== "green") findings.push(`regression scenario doesn't pass before the build: ${r.name}: ${r.verdict}${r.reason ? `: ${r.reason}` : ""}`);
      continue;
    }
    if (r.verdict === "green") findings.push(`scenario passes before any behaviour exists: ${r.name}`);
    if (r.verdict === "crash") findings.push(`scenario crashed instead of failing on a Then: ${r.name}: ${r.reason}`);
  }
  // Counted, not just named: a Scenario Outline's rows share one name, and a tag on one Examples block
  // can keep some rows out of the cell while the others run.
  const ran = new Map<string, number>();
  for (const r of mine) ran.set(r.name, (ran.get(r.name) ?? 0) + 1);
  const want = new Map<string, number>();
  for (const name of expected) want.set(name, (want.get(name) ?? 0) + 1);
  const notRun = [...want].filter(([name, n]) => (ran.get(name) ?? 0) < n).map(([name]) => name);
  // Only when every expected scenario ran: if some didn't, the ones that did don't show the item is all @regression.
  if (notRun.length === 0 && mine.length > 0 && mine.every((r) => r.tags.includes(REGRESSION_TAG))) findings.push(`every scenario carrying ${pbiTag} is ${REGRESSION_TAG}, so Red proves nothing`);
  for (const name of notRun) findings.push(`not run in the cell: ${name}`);
  if (mine.length === 0 && expected.length === 0) {
    findings.push(listed === 0 ? `no scenario carries ${pbiTag}` : `no scenario carrying ${pbiTag} runs in the cell: bdd.run's tag filter leaves out all ${listed}`);
  }
  return { ok: findings.length === 0, findings };
}

// Green: every scenario in the suite is green, so earlier items' scenarios keep guarding against regressions.
export function greenGate(results: Results): GateResult {
  const findings = [...results.values()].filter((r) => r.verdict !== "green").map((r) => `scenario is ${r.verdict}: ${r.name}: ${r.reason}`);
  if (results.size === 0) findings.push("the report holds no scenarios");
  return { ok: findings.length === 0, findings };
}

// Every @ac-N, for N from 1 to criteriaCount, that no scenario tagged pbiTag carries.
export function traceability(results: Results, criteriaCount: number, pbiTag: string): string[] {
  const mine = tagged(results, pbiTag);
  const missing: string[] = [];
  for (let n = 1; n <= criteriaCount; n++) if (!mine.some((r) => r.tags.includes(`@ac-${n}`))) missing.push(`@ac-${n}`);
  return missing;
}

// A dry run executes no step, so cucumber-js reports each one SKIPPED, or UNDEFINED or AMBIGUOUS when it has no single
// step definition (PBI 185).
const NOT_EXECUTED = new Set(["SKIPPED", "UNDEFINED", "AMBIGUOUS"]);

// Why a report that should come from `--dry-run` doesn't, or null when it does: a step that finished PASSED, FAILED or
// PENDING ran, and a test case that never started was cut short. The flag misses cucumber-js when the command hands it
// to something else, as `npm run <script>` without `--` does, or a trailing `|| true` or pipe, and the command then
// runs the suite for real.
export function notDryRun(ndjson: string): string | null {
  const cases = new Set<string>();
  const started = new Set<string>();
  const ran = new Map<string, number>();
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.testCase) cases.add(m.testCase.id);
    else if (m.testCaseStarted) started.add(m.testCaseStarted.testCaseId);
    else if (m.testStepFinished) {
      const status = String(m.testStepFinished.testStepResult?.status);
      if (!NOT_EXECUTED.has(status)) ran.set(status, (ran.get(status) ?? 0) + 1);
    }
  }
  if (ran.size) return `steps ran: ${[...ran].map(([s, n]) => `${n} ${s}`).join(", ")}`;
  const unstarted = [...cases].filter((c) => !started.has(c)).length;
  if (unstarted) return `${unstarted} test case${unstarted === 1 ? "" : "s"} never started`;
  return null;
}
