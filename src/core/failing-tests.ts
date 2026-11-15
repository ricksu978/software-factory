// PBI 215, PBI 292: reading the tests a command's output or a CI run's log says failed. It lives in core, since the
// cell reads a command's output with it and the GitHub repo host reads a failed check run's log.

/**
 * The names of the tests a command's output says failed, in the order first seen: TAP's `not ok` lines (TODO and SKIP
 * left out), node's spec reporter's `✖ name (1.2ms)` lines and the `N) name # path:line` entries of cucumber-js's
 * "Failed scenarios:" block, as the pinned 13.3.0 prints it. Output that
 * names no test, such as a type error, gives none. A GitHub Actions log puts a timestamp before each line, which is
 * dropped first (PBI 292).
 */
export function failingTests(output: string): string[] {
  const out = new Set<string>();
  let cucumber = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "");
    if (line === "Failed scenarios:") { cucumber = true; continue; }
    if (cucumber) {
      // Each scenario is `N) <name> # <path>:<line>`; the step, error and stack lines under it are skipped. The block
      // ends at the summary, `N scenarios (...)`.
      if (/^\d+ scenarios? \(/.test(line)) { cucumber = false; continue; }
      const m = /^\d+\) (.+) # \S+:\d+$/.exec(line);
      if (m) out.add(m[1].trim());
      continue;
    }
    const tap = /^not ok \d+ - (.+?)(?: # (.*))?$/.exec(line);
    if (tap) {
      if (!/^(TODO|SKIP)\b/i.test(tap[2] ?? "")) out.add(tap[1].trim());
      continue;
    }
    const spec = /^✖ (.+?) \([\d.]+m?s\)$/.exec(line);
    if (spec) out.add(spec[1].trim());
  }
  return [...out];
}
