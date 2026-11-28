// PBI 215, PBI 292, PBI 321: the factory's one reader of the tests a command's output or a CI run's log says failed. It
// lives in core, since the cell's CI finding (through the GitHub repo host), the base-failure check and the bug item
// for a red main all read with it, so the same log names the same tests whoever reads it.

// What GitHub Actions puts in front of each log line, and the colours a reporter may print in CI.
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\x1b\[[\d;]*m/g;
// A TAP result line, as node's test runner printed it before Node 23, or with `--test-reporter tap`.
// Anything after ` # ` is a comment, and a TODO or SKIP one marks a test that doesn't count as failed.
const TAP_LINE = /^(\s*)(not ok|ok) \d+(?: - (.*?))?(?: # (.*))?$/;
// The spec reporter, node's default since Node 23, lists each failing leaf test once more after its summary, under
// `✖ failing tests:`, as `✖ <name> (<duration>)` after a `test at <file>` line.
const SPEC_HEADING = /^✖ failing tests:\s*$/;
const SPEC_LINE = /^✖ (.+?)(?: \([\d.]+m?s\))?\s*$/;
// Cucumber-js 13.3.0's summary lists each scenario that didn't pass under one heading for each way it didn't, as
// `  1) <scenario> # <file>:<line>`, with its steps and errors indented deeper beneath it.
const CUCUMBER_HEADING = /^(?:Failed|Ambiguous|Undefined|Pending) scenarios:\s*$/;
const CUCUMBER_LINE = /^\s+\d+\) (.+?) # \S+:\d+\s*$/;

/**
 * The failing tests a log names, once each, in the order first seen: node's test runner's failures in its spec
 * reporter's `failing tests` list or as TAP `not ok` lines, and the scenarios cucumber lists under its `Failed`,
 * `Ambiguous`, `Undefined` and `Pending scenarios:` blocks, by name. A failing TAP suite is left out when a test inside
 * it failed, so only the leaf is named, and a TODO or SKIP doesn't count. A log with none of these, such as a type
 * error, names none.
 */
export function failingTests(log: string | null): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    const n = name.trim();
    if (n && !names.includes(n)) names.push(n);
  };
  const tap: { indent: number; failed: boolean; name: string }[] = [];
  let section: "spec" | "cucumber" | null = null;
  for (const raw of (log ?? "").split(/\r?\n/)) {
    const line = raw.replace(STAMP, "").replace(ANSI, "").trimEnd();
    // A step's group marker ends whatever list the step before it printed.
    if (line.startsWith("##[")) { section = null; continue; }
    if (SPEC_HEADING.test(line)) { section = "spec"; continue; }
    if (CUCUMBER_HEADING.test(line.trim())) { section = "cucumber"; continue; }
    if (section === "cucumber") {
      // The block ends at the first line that isn't indented, such as the `N scenarios (...)` summary. The step, error
      // and stack lines under a scenario are skipped, a TAP line among them too.
      const m = CUCUMBER_LINE.exec(line);
      if (m) add(m[1]);
      if (m || !line.trim() || /^\s/.test(line)) continue;
      section = null;
    }
    if (section === "spec") {
      const m = SPEC_LINE.exec(line);
      if (m) add(m[1]);
    }
    const m = TAP_LINE.exec(line);
    if (!m) continue;
    tap.push({ indent: m[1].length, failed: m[2] === "not ok" && !/^(TODO|SKIP)\b/i.test(m[4] ?? ""), name: m[3] ?? "" });
  }
  tap.forEach((r, i) => {
    if (!r.failed) return;
    // A suite's own line comes after its tests' lines, which are indented deeper.
    for (let k = i - 1; k >= 0 && tap[k].indent > r.indent; k--) if (tap[k].failed) return;
    add(r.name);
  });
  return names;
}
