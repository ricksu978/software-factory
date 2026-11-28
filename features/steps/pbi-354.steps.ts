// Step definitions for features/pbi-354-red-main-bug-item-names-spec-section.feature.
//
// The scenarios reuse PBI 255's steps and harness: its item held after a merge, a commit's first parent, CI's checks and
// their logs, "the poller runs once" (PBI 12's poll, then the scheduler's CI check on merged items, pollMergedCi), and its
// reading of the one bug item the factory filed, title and body together.
//
// The bug item says it implements the design spec's §10 "Red main" rule when one line of its body says "implements" (in
// any case, "Implements: ..." included), names "§10" (or "§ 10"), and names "Red main". The section that line names is the
// number after its "§". A section of the design spec is one of its <h2> headings, numbered as `<span class="n">NN</span>`,
// and runs to the next <h2>. A section holds the "Red main" rule when its text has the rule's bold lead, "Red main.".
//
// A failed check's line is one that holds a failed check's URL; a failing test's line is one of the list items PBI 255
// reads as the failing tests.
import { Before, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pollMergedCi } from "../../src/scheduler/scheduler.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx } from "./pbi-12.steps.ts";
import { bugItem, listedTests } from "./pbi-255.steps.ts";

const REPO = "acme/widgets";
const SPEC = "docs/superpowers/specs/2026-11-05-software-factory-design.html";

Before({ tags: "@pbi-354", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
  const c = pollCtx(this);
  c.afterPoll = async () => {
    await pollMergedCi({ pool: need().pool, repoHost: c.host!, backlogFor: () => c.fake!.adapter, now: new Date() });
  };
});

const SECTION = /§\s*(\d+)/;

/** The lines of the bug item that say it implements a spec section. */
function implementsLines(text: string): string[] {
  return text.split("\n").filter((l) => /\bimplements\b/i.test(l) && SECTION.test(l));
}

/** The line of the bug item that says it implements spec §10 "Red main", if one does. */
function redMainLine(text: string): string | undefined {
  return implementsLines(text).find((l) => /§\s*10\b/.test(l) && /\bRed main\b/i.test(l));
}

/** The design spec's sections, by number: each one's HTML from its <h2> to the next. */
function specSections(): Map<number, string> {
  const html = readFileSync(SPEC, "utf8");
  const sections = new Map<number, string>();
  const parts = html.split(/(?=<h2\b)/);
  for (const part of parts) {
    const m = /^<h2\b[^>]*>\s*<span class="n">(\d+)<\/span>/.exec(part);
    if (m) sections.set(Number(m[1]), part);
  }
  return sections;
}

type World = { pbi354?: { section?: number } };

Then("the bug item's body says it implements the design spec's §10 \"Red main\" rule", long, async function () {
  const bug = await bugItem(this);
  assert.ok(redMainLine(bug.text), `no line of the bug item says it implements the design spec's §10 "Red main" rule:\n${bug.text}`);
});

Then("the spec section the bug item's body says it implements is a section of the design spec", long, async function () {
  const bug = await bugItem(this);
  const lines = implementsLines(bug.text);
  assert.ok(lines.length > 0, `no line of the bug item says which spec section it implements:\n${bug.text}`);
  const n = Number(SECTION.exec(lines[0])![1]);
  assert.ok(specSections().has(n), `the design spec has no section §${n}`);
  (this as World).pbi354 = { section: n };
});

Then("that section of the design spec holds the {string} rule", function (rule: string) {
  const n = (this as World).pbi354?.section;
  assert.ok(n !== undefined, "no spec section was read from the bug item");
  const html = specSections().get(n)!;
  assert.match(html, new RegExp(`<b>${rule}\\.</b>`), `the design spec's §${n} doesn't hold the "${rule}" rule`);
});

Then("the bug item's body names spec §10 \"Red main\" exactly once", long, async function () {
  const bug = await bugItem(this);
  const count = bug.text.split("\n").filter((l) => /§\s*10\b/.test(l)).length;
  assert.equal(count, 1, `the bug item names spec §10 on ${count} lines:\n${bug.text}`);
  assert.equal((bug.text.match(/§\s*10\b/g) ?? []).length, 1, `the bug item names spec §10 more than once on a line:\n${bug.text}`);
});

Then("no failed check's line and no failing test's line in the bug item names spec §10", long, async function () {
  const bug = await bugItem(this);
  const urls = (pollCtx(this).host!.runs.get(`${REPO}@m3rg001`) ?? []).filter((r) => r.status === "failure").map((r) => r.url).filter(Boolean) as string[];
  const checkLines = bug.text.split("\n").filter((l) => urls.some((u) => l.includes(u)));
  assert.ok(checkLines.length > 0, `the bug item has no line for a failed check:\n${bug.text}`);
  for (const l of [...checkLines, ...listedTests(bug.text)]) {
    assert.doesNotMatch(l, /§\s*10\b/, `a failed check's or failing test's line names spec §10: ${l}`);
  }
});
