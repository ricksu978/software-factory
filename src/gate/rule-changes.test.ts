import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRuleChanges, judgedRules, parseRuleChanges, placeName, ruleChangesHash, rulesSection, ruleText, SPEC_PATH, wordDiff,
} from "./rule-changes.ts";

const section = (s: string) => `Lead.\n\n## Acceptance criteria\n\n- One\n\n${s}\n`;

test("an item with no rules section reads no rule change", () => {
  assert.deepEqual(parseRuleChanges("Lead.\n\n## Acceptance criteria\n\n- One\n"), []);
  assert.equal(rulesSection("Lead."), null);
});

test("a section under another heading isn't read", () => {
  assert.deepEqual(parseRuleChanges(section("## Rule changes\n\n### Spec §6\n**Before**\n> A.\n\n**After**\n> B.")), []);
});

test("each entry gives its place, its Before and its After, in the section's order", () => {
  const body = section([
    "## Changes the factory's rules", "",
    "### Spec §6", "**Before**", "> A lease lasts ten minutes", "> and renews every minute.", "", "**After**", "> A lease lasts five minutes.", "",
    "### `policy/dor.md`", "**Before**", "> The item fits one Sprint.", "", "**After**", "> The item fits one Sprint and has a Size of 8 or less.", "",
    "## Notes", "", "### Spec §5", "**Before**", "> Not read.",
  ].join("\n"));
  assert.deepEqual(parseRuleChanges(body), [
    { place: { kind: "spec", section: "§6" }, before: "A lease lasts ten minutes and renews every minute.", after: "A lease lasts five minutes." },
    { place: { kind: "policy", path: "policy/dor.md" }, before: "The item fits one Sprint.", after: "The item fits one Sprint and has a Size of 8 or less." },
  ]);
});

test("an entry missing a part reads it as null", () => {
  const body = section("## Changes the factory's rules\n\n### Spec § 6\n**After**\n> B.\n");
  assert.deepEqual(parseRuleChanges(body), [{ place: { kind: "spec", section: "§6" }, before: null, after: "B." }]);
});

const spec = `<!doctype html><html><body>
<section id="lifecycle">
  <h2><span class="n">05</span>PBI lifecycle</h2>
  <p>A NotReady item moves to Eligible when a readiness input changes.</p>
</section>
<section id="sop">
  <h2><span class="n">06</span>SOP</h2>
  <ul><li><b>Claiming.</b>

  The scheduler renews it every 60 seconds and the item goes back to <code>Queued</code>,

  branch intact.</li><li>Next&nbsp;rule.</li></ul>
</section>
</body></html>`;

test("a spec section's rule text is its HTML read as prose, inline markup dropped and blocks apart", () => {
  const t = ruleText(spec, { kind: "spec", section: "§6" });
  assert.equal(t, "Claiming. The scheduler renews it every 60 seconds and the item goes back to Queued, branch intact. Next rule.");
  assert.equal(ruleText(spec, { kind: "spec", section: "§9" }), null);
});

test("the check holds each Before to main word for word and names the entry that's off", async () => {
  const files: Record<string, string> = { [SPEC_PATH]: spec, "policy/dor.md": "# Definition of Ready\n\n- [ ] The item fits one Sprint.\n" };
  const read = async (path: string) => files[path] ?? null;
  const got = await checkRuleChanges([
    { place: { kind: "spec", section: "§6" }, before: "Claiming. The scheduler renews it every 60 seconds and the item goes back to Queued, branch intact.", after: "X." },
    { place: { kind: "spec", section: "§6" }, before: "Claiming. The scheduler renews it every 90 seconds", after: "X." },
    { place: { kind: "spec", section: "§6" }, before: "renews it every 60 sec", after: "X." },
    { place: { kind: "spec", section: "§6" }, before: "renews it every 60 seconds", after: "X." },
    { place: { kind: "policy", path: "policy/dor.md" }, before: "The item fits one sprint.", after: "X." },
    { place: { kind: "policy", path: "policy/dor.md" }, before: "The item fits one Sprint.", after: null },
    { place: { kind: "spec", section: "§5" }, before: null, after: "X." },
    { place: { kind: "policy", path: "policy/nope.md" }, before: "A.", after: "B." },
  ], read);
  assert.deepEqual(got.map((c) => c.problem ?? null), [
    null,
    "The Before quoted for spec section §6 doesn't match main word for word.",
    "The Before quoted for spec section §6 doesn't match main word for word.",
    null,
    "The Before quoted for policy/dor.md doesn't match main word for word.",
    "The entry for policy/dor.md gives no After.",
    "The entry for spec section §5 gives no Before.",
    "main holds no policy/nope.md, so the Before quoted for it doesn't match main.",
  ]);
});

test("a heading that isn't a spec section or a policy file is never read", async () => {
  const asked: string[] = [];
  const read = async (path: string) => (asked.push(path), "secret");
  const paths = ["aspire-apphost/keycloak/factory-realm.json", "policy/../.env", "policy/sub/dor.md", ".factory/dor.md", "policy/dor.md.bak"];
  const got = await checkRuleChanges(paths.map((path) => ({ place: { kind: "policy" as const, path }, before: "secret", after: "X." })), read);
  assert.deepEqual(asked, []);
  assert.deepEqual(got.map((c) => c.problem), paths.map((p) => `${p} isn't a spec section or a policy file of the factory.`));
});

test("without the factory's repo, an entry's Before can't be checked and fails", async () => {
  const [c] = await checkRuleChanges([{ place: { kind: "spec", section: "§6" }, before: "A.", after: "B." }], undefined);
  assert.match(c.problem ?? "", /couldn't read main/);
});

test("the hash covers each rule's place, Before and After, and nothing else", () => {
  const a = [{ place: { kind: "spec" as const, section: "§6" }, before: "A.", after: "B." }];
  assert.equal(ruleChangesHash(a), ruleChangesHash([{ ...a[0], problem: "x" } as never]));
  assert.notEqual(ruleChangesHash(a), ruleChangesHash([{ ...a[0], after: "C." }]));
});

test("the judge's rules are read as spec sections and policy paths", () => {
  assert.deepEqual(judgedRules(["§6", "spec § 5", "Spec §7.2", " policy/dor.md ", 3, ""]), ["§6", "§5", "§7", "policy/dor.md"]);
  assert.deepEqual(judgedRules(undefined), []);
  assert.equal(placeName({ kind: "spec", section: "§6" }), "spec section §6");
});

test("the word diff marks only the words that change on each side", () => {
  const d = wordDiff("A lease lasts ten minutes and the worker renews it every minute.", "A lease lasts five minutes and the worker renews it every thirty seconds.");
  assert.deepEqual(d.before.filter((w) => w.changed).map((w) => w.text), ["ten", "minute."]);
  assert.deepEqual(d.after.filter((w) => w.changed).map((w) => w.text), ["five", "thirty", "seconds."]);
  assert.equal(d.before.map((w) => w.text).join(" "), "A lease lasts ten minutes and the worker renews it every minute.");
});
