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

// Red proof: every scenario tagged pbiTag is red, and every expected name ran. Other items' scenarios are ignored.
export function redGate(results: Results, pbiTag: string, expected: string[]): GateResult {
  const mine = tagged(results, pbiTag);
  const findings: string[] = [];
  for (const r of mine) {
    if (r.verdict === "green") findings.push(`scenario passes before any behaviour exists: ${r.name}`);
    if (r.verdict === "crash") findings.push(`scenario crashed instead of failing on a Then: ${r.name}: ${r.reason}`);
  }
  const ran = new Set(mine.map((r) => r.name));
  for (const name of new Set(expected)) if (!ran.has(name)) findings.push(`not run in the cell: ${name}`);
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
