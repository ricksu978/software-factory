// Step definitions for features/pbi-202-split-children-meet-dor.feature. The Background and the gate run on PBI 143's
// harness: PBI 13's in-memory repo files, the fake backlog, a scripted judge and a scripted coding model that records
// every request, so a scenario reads the split prompt it was asked with. This file's judge also records the dor.md it
// was given, so a scenario can compare the split request with what the judge saw. The @ac-3 scenarios move the same
// parent onto PBI 144's poll harness, which files children, with an in-memory splits store as the poller keeps one.
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs } from "../../src/agent/run.ts";
import { splitPrompt } from "../../src/gate/split.ts";
import { loadPolicy, parseCriteria, type Policy } from "../../src/policy/policy.ts";
import { ctx as ctx143, files, runGate } from "./pbi-143.steps.ts";
import { ctx as ctx144, poll, polled } from "./pbi-144.steps.ts";

const DOR_PATH = ".factory/dor.md";
const HEADING = "Acceptance criteria";

type Ctx = {
  /** The dor.md the readiness judge was last given. */
  given?: Policy;
  /** Every dor.md text this scenario's repo held, so a Then can name criteria the judge wasn't given. */
  dors: string[];
  /** Guidance written above the criteria of a dor.md still being written by the steps. */
  guidance?: string;
  /** The prompt built by "the factory builds the coding model's split request". */
  built?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi202?: Ctx };
  w.pbi202 ??= { dors: [] };
  return w.pbi202;
}

const CHILDREN = [
  { title: "Card payments", criteria: [1, 3], needs: [] as number[] },
  { title: "Bank transfers", criteria: [2], needs: [1] },
  { title: "Payment receipts", criteria: [4], needs: [1, 2] },
];

function reply(children: typeof CHILDREN, title: string, section: string | undefined): string {
  const body = section ? `Part of "${title}", spec section ${section}.` : `Part of "${title}".`;
  return JSON.stringify({ children: children.map((ch) => ({ ...ch, body })) });
}

function writeDor(world: object, text: string): void {
  files(world).set(DOR_PATH, text);
  ctx(world).dors.push(text);
}

const checklist = (criteria: string[]) => criteria.map((t) => `- [ ] ${t}`).join("\n");

const defaultDor = async (): Promise<Policy> => {
  const p = await loadPolicy(async () => null, "dor");
  assert.ok(p, "the factory has no default dor.md");
  return p;
};

// --- Background ----------------------------------------------------------------------------------------------------

Given("a parent item {string} whose body cites spec section {string}", function (title: string, section: string) {
  const c = ctx143(this);
  c.title = title;
  c.section = section;
  c.body = `Redesign the checkout so a shopper can pay more ways. See spec section ${section}.`;
});

Given("the readiness judge finds the parent item oversized", function () {
  const k = ctx(this);
  ctx143(this).judge = async (_item: FactoryItem, dor: Policy) => {
    k.given = dor;
    return [
      ...dor.criteria.map((cr) => JSON.stringify({ index: cr.index, status: "passed", reason: "ok" })),
      JSON.stringify({ flags: [], oversized: true }),
    ].join("\n");
  };
});

Given("the coding model proposes a valid split of the parent item", function () {
  const c = ctx143(this);
  c.reply = reply(CHILDREN, c.title!, c.section);
});

Given("the coding model proposes a split which leaves criterion {int} to no child", function (index: number) {
  const c = ctx143(this);
  const children = CHILDREN.map((ch) => ({ ...ch, criteria: ch.criteria.filter((i) => i !== index) })).filter((ch) => ch.criteria.length > 0);
  c.reply = reply(children, c.title!, c.section);
});

Given("the parent item's body cites no spec section or plan task", async function () {
  const c = ctx143(this);
  c.section = undefined;
  c.body = "Redesign the checkout so a shopper can pay more ways.";
  assert.ok(c.itemId, "the parent item wasn't seeded");
  c.itemId = await c.fake.seed({ externalId: c.itemId, title: c.title, body: c.body, acceptanceCriteria: c.criteria, repo: "acme/shop" });
});

// --- The repo's dor.md ---------------------------------------------------------------------------------------------

Given("the parent item's repo has a {string} with these criteria:", function (path: string, table: DataTable) {
  assert.equal(path, DOR_PATH);
  writeDor(this, `# Definition of Ready\n\n${checklist(table.hashes().map((r) => r.text))}\n`);
});

Given("the parent item's repo has a {string} with the criterion {string}", function (path: string, criterion: string) {
  assert.equal(path, DOR_PATH);
  writeDor(this, `# Definition of Ready\n\n${checklist([criterion])}\n`);
});

Given("the parent item's repo has a {string} whose text above its criteria reads {string}", function (path: string, text: string) {
  assert.equal(path, DOR_PATH);
  ctx(this).guidance = text;
  writeDor(this, `# Definition of Ready\n\n${text}\n`);
});

Given("that dor.md has the criterion {string}", function (criterion: string) {
  const guidance = ctx(this).guidance;
  assert.ok(guidance !== undefined, "no dor.md is being written");
  writeDor(this, `# Definition of Ready\n\n${guidance}\n\n${checklist([criterion])}\n`);
});

Given("the parent item's repo has a {string} that reads {string} and has no criteria", function (path: string, text: string) {
  assert.equal(path, DOR_PATH);
  writeDor(this, `${text}\n`);
  assert.deepEqual(parseCriteria(files(this).get(DOR_PATH)!), []);
});

Given("the parent item's repo has no {string}", function (path: string) {
  assert.equal(path, DOR_PATH);
  files(this).delete(DOR_PATH);
});

Given("the repo's dor.md has since changed to the single criterion {string}", function (criterion: string) {
  writeDor(this, `# Definition of Ready\n\n${checklist([criterion])}\n`);
});

// --- Gating --------------------------------------------------------------------------------------------------------

When("the readiness gate checks the parent item for the first time", async function () {
  assert.equal(ctx143(this).requests.length, 0, "the parent item was checked before");
  await runGate(this);
});

When("the factory builds the coding model's split request for the parent item", async function () {
  const c = ctx143(this);
  assert.ok(c.itemId, "the parent item wasn't seeded");
  const item = await c.fake.adapter.getItem(c.itemId);
  assert.ok(item);
  const dor = await loadPolicy(async (p) => files(this).get(p) ?? null, "dor");
  assert.ok(dor);
  ctx(this).built = splitPrompt(item, dor);
});

// --- The split request sent through the gate -----------------------------------------------------------------------

function sent(world: object): string {
  const c = ctx143(world);
  assert.equal(c.error, undefined, `the gate failed: ${String(c.error)}`);
  assert.ok(c.outcome, "the readiness gate didn't run");
  assert.equal(c.requests.length, 1, `the coding model was asked ${c.requests.length} times`);
  return c.requests[0].prompt;
}

function given(world: object): Policy {
  const p = ctx(world).given;
  assert.ok(p, "the readiness judge was never asked");
  return p;
}

const lists = (prompt: string, text: string) => prompt.includes(text);

Then("the split request lists the criterion {string} word for word", function (criterion: string) {
  const prompt = sent(this);
  assert.ok(lists(prompt, criterion), `the split request doesn't list "${criterion}":\n${prompt}`);
});

Then("the split request includes {string} word for word", function (text: string) {
  const prompt = sent(this);
  assert.ok(prompt.includes(text), `the split request doesn't include "${text}":\n${prompt}`);
});

Then("the split request doesn't list {string}", function (criterion: string) {
  const prompt = sent(this);
  assert.ok(!lists(prompt, criterion), `the split request lists "${criterion}":\n${prompt}`);
});

Then("every criterion the readiness judge was given for the parent item is in the split request", function () {
  const prompt = sent(this);
  const dor = given(this);
  assert.ok(dor.criteria.length > 0, "the judge was given no criterion");
  const missing = dor.criteria.filter((cr) => !lists(prompt, cr.text)).map((cr) => cr.text);
  assert.deepEqual(missing, [], `the split request lacks criteria the judge was given:\n${prompt}`);
});

Then("the split request lists no dor.md criterion the readiness judge wasn't given", async function () {
  const prompt = sent(this);
  const judged = new Set(given(this).criteria.map((cr) => cr.text));
  const candidates = [...(await defaultDor()).criteria.map((cr) => cr.text), ...ctx(this).dors.flatMap((t) => parseCriteria(t).map((cr) => cr.text))];
  const extra = [...new Set(candidates)].filter((t) => !judged.has(t) && lists(prompt, t));
  assert.deepEqual(extra, [], `the split request lists criteria the judge wasn't given:\n${prompt}`);
});

Then("the split request lists none of the factory default dor.md's criteria", async function () {
  const prompt = sent(this);
  const listed = (await defaultDor()).criteria.map((cr) => cr.text).filter((t) => lists(prompt, t));
  assert.deepEqual(listed, [], `the split request lists the factory default's criteria:\n${prompt}`);
});

Then("the split request lists every criterion of the factory default dor.md word for word", async function () {
  const prompt = sent(this);
  const dor = await defaultDor();
  const missing = dor.criteria.map((cr) => cr.text).filter((t) => !lists(prompt, t));
  assert.deepEqual(missing, [], `the split request lacks the factory default's criteria:\n${prompt}`);
});

Then("the split request asks for each child's body to meet every dor.md criterion it lists", function () {
  const prompt = sent(this);
  const asks = prompt.split("\n").some((l) => /\bbod(y|ies)\b/i.test(l) && /\b(meets?|satisf(y|ies))\b/i.test(l) && /\b(every|each|all)\b/i.test(l) && /dor\.md|Definition of Ready/i.test(l));
  assert.ok(asks, `no line of the split request asks for each child's body to meet every dor.md criterion:\n${prompt}`);
});

// --- The split request built directly ------------------------------------------------------------------------------

function built(world: object): string {
  const p = ctx(world).built;
  assert.ok(p !== undefined, "no split request was built");
  return p;
}

const citesOwn = (l: string) =>
  /\bcites?\b/i.test(l) && /\bevery\b/i.test(l) && /spec section/i.test(l) && /plan task/i.test(l) && /\bimplements or changes\b/i.test(l);

Then("the request asks each child's body to cite every spec section or plan task that child itself implements or changes", function () {
  const prompt = built(this);
  assert.ok(prompt.split("\n").some((l) => /\bbody\b/i.test(l) && citesOwn(l)),
    `no line asks each child's body to cite every spec section or plan task it implements or changes:\n${prompt}`);
});

Then("the request still asks each child's body to name the parent item {string}", function (title: string) {
  const prompt = built(this);
  assert.ok(prompt.split("\n").some((l) => /\bbody\b/i.test(l) && /\bnames?\b/i.test(l) && l.includes(JSON.stringify(title))),
    `no line asks each child's body to name the parent item "${title}":\n${prompt}`);
});

Then("the request says a child cites the sections and tasks it implements or changes even when the parent's body doesn't cite them", function () {
  const prompt = built(this);
  const says = prompt.split("\n").some((l) => /\bimplements or changes\b/i.test(l) && /\bparent/i.test(l) && /\b(even (when|if)|whether or not|not only)\b/i.test(l));
  assert.ok(says, `no line says a child cites its own sections and tasks even when the parent's body doesn't:\n${prompt}`);
});

Then("the request doesn't ask a child to cite only the spec section or plan task the parent's body cites", function () {
  const prompt = built(this);
  const parentOnly = prompt.split("\n").filter((l) => /spec section or plan task the parent's body cites/i.test(l) && !/\bimplements or changes\b/i.test(l));
  assert.deepEqual(parentOnly, [], "the request asks a child to cite only the parent's spec section or plan task");
});

// --- @ac-3: filing on PBI 144's poll harness -----------------------------------------------------------------------

Given("the parent item is an issue in {string} carrying the opt-in label {string}", async function (repo: string, label: string) {
  const a = ctx143(this);
  const c = ctx144(this);
  c.repo = repo;
  c.label = label;
  c.criteria = [...a.criteria];
  c.oversized = true;
  c.kept = new Map();
  assert.ok(a.title && a.reply, "the Background set up no parent item or split");
  c.reply = a.reply;
  c.parentTitle = a.title;
  const body = `${a.body}\n\n## ${HEADING}\n\n${c.criteria.map((t) => `- ${t}`).join("\n")}\n`;
  c.parentId = await c.fake.seed({ title: a.title, body, acceptanceCriteria: c.criteria, labels: [label], repo, status: c.backlogStatus });
  c.board.set(c.parentId, c.backlogStatus);
});

Given("the factory has polled the backlog once and filed the parent's {int} children", async function (n: number) {
  const c = ctx144(this);
  await poll(c);
  assert.deepEqual(c.errors, [], `the poll failed: ${c.errors.map(String).join("; ")}`);
  assert.equal((c.subIssues.get(c.parentId!) ?? []).length, n, "setup didn't file the parent's children");
});

Given("the repo refuses the next filing of the parent's second child once", function () {
  const c = ctx144(this);
  const children = (JSON.parse(c.reply) as { children: { title: string }[] }).children;
  assert.ok(children.length >= 2, "the split has no second child");
  c.refusals.push({ kind: "file", title: children[1].title });
});

Then("the coding model was asked for a split of the parent item only once", function () {
  const c = ctx144(this);
  polled(c);
  const asked = c.requests.filter((r: AgentArgs) => r.prompt.includes(JSON.stringify(c.parentTitle)));
  assert.equal(asked.length, 1, `the coding model was asked ${asked.length} times`);
});

Then("no child of the parent was filed twice", function () {
  const c = ctx144(this);
  polled(c);
  const titles = c.filed.map((i) => i.title);
  assert.deepEqual(titles.filter((t, i) => titles.indexOf(t) !== i), [], `filed: ${titles.join(", ")}`);
});
