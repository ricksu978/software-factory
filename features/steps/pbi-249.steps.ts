// Step definitions for features/pbi-249-split-child-one-criteria-section.feature. The board, the repo, the judge and
// the coding model run on PBI 144's poll harness, which files children through a scripted SplitBoard into the fake
// backlog and reads each child's criteria back with the GitHub adapter's own parser. The split request scenarios build
// the factory's own split prompt for the parent, against the dor.md the harness's repo holds.
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { splitPrompt } from "../../src/gate/split.ts";
import { loadPolicy } from "../../src/policy/policy.ts";
import { ctx as ctx144 } from "./pbi-144.steps.ts";

/** The heading PBI 144's harness files and reads each child's criteria under. */
const HARNESS_HEADING = "Acceptance criteria";

type Proposed = { title: string; body: string; criteria: number[]; needs: number[] };

type Ctx = {
  heading: string;
  /** The children the coding model proposes, in order. */
  children: Proposed[];
  /** The split request built by "the factory builds the coding model's split request". */
  built?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi249?: Ctx };
  w.pbi249 ??= { heading: HARNESS_HEADING, children: [] };
  return w.pbi249;
}

function propose(world: object, child: Proposed): void {
  const c = ctx(world);
  c.children.push(child);
  ctx144(world).reply = JSON.stringify({ children: c.children });
}

const plainBody = (world: object, title: string) => `${title} for ${ctx144(world).parentTitle}.`;

const isHeading = (line: string) => /^#{1,6}\s/.test(line);
const headingText = (line: string) => line.replace(/^#+\s*/, "").trim().toLowerCase();

/** The line indices of every heading in `body` whose text is `heading`, at any level and in any letter case. */
function headings(body: string, heading: string): number[] {
  const want = heading.trim().toLowerCase();
  return body.split(/\r?\n/).flatMap((l, i) => (isHeading(l) && headingText(l) === want ? [i] : []));
}

/** The text under the first heading `heading`, up to the next heading or rule, trimmed; null when there's none. */
function section(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const [start] = headings(body, heading);
  if (start === undefined) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isHeading(line) || /^\s*---\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

async function childOf(world: object, title: string) {
  const c = ctx144(world);
  assert.ok(c.polls > 0, "the factory never polled");
  const found = c.filed.filter((i) => i.title === title);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  const fi = await c.fake.adapter.getItem(found[0].externalId);
  assert.ok(fi, `no item for child "${title}"`);
  return fi;
}

const bodyOf = async (world: object, title: string) => (await childOf(world, title)).body;

function built(world: object): string {
  const p = ctx(world).built;
  assert.ok(p, "the split request was never built");
  return p;
}

const requestLines = (world: object) => built(world).split(/\r?\n/);

// --- Background ----------------------------------------------------------------------------------------------------

Given("a repo {string} whose board's acceptance criteria heading is {string}", function (repo: string, heading: string) {
  assert.equal(heading, HARNESS_HEADING, "PBI 144's harness files and reads criteria under its own heading");
  ctx144(this).repo = repo;
  ctx(this).heading = heading;
});

Given("a parent issue {string} in {string} on that board, carrying the opt-in label", async function (title: string, repo: string) {
  const c = ctx144(this);
  c.parentTitle = title;
  c.parentId = await c.fake.seed({
    title, body: "Redesign the checkout so a shopper can pay more ways.", acceptanceCriteria: [], labels: [c.label], repo, status: c.backlogStatus,
  });
  c.board.set(c.parentId, c.backlogStatus);
});

// --- The coding model's proposal -----------------------------------------------------------------------------------

Given("the coding model proposes child {string} taking criteria {int} and {int}, with this body:", function (title: string, a: number, b: number, body: string) {
  propose(this, { title, body, criteria: [a, b], needs: [] });
});

Given("the coding model proposes child {string} taking criteria {int} and {int}, with a body that has no acceptance criteria section", function (title: string, a: number, b: number) {
  propose(this, { title, body: plainBody(this, title), criteria: [a, b], needs: [] });
});

Given("the coding model proposes child {string} taking criteria {int} and {int}, needing child {int}, with a body that has no acceptance criteria section", function (title: string, a: number, b: number, need: number) {
  propose(this, { title, body: plainBody(this, title), criteria: [a, b], needs: [need] });
});

Given("the coding model proposes child {string} taking criteria {int} and {int}, with a body that has its own section under {string}", function (title: string, a: number, b: number, heading: string) {
  const body = `${plainBody(this, title)}\n\n## ${heading}\n\n- ${title} works\n- ${title} errors are shown`;
  propose(this, { title, body, criteria: [a, b], needs: [] });
});

// --- The filed children --------------------------------------------------------------------------------------------

Then("{string} holds a new issue titled {string}", function (repo: string, title: string) {
  const c = ctx144(this);
  assert.ok(c.polls > 0, "the factory never polled");
  assert.ok(c.filed.some((i) => i.repo === repo && i.title === title), `issues filed: ${c.filed.map((i) => i.title).join(", ") || "none"}`);
});

Then("the body of child {string} has exactly one section under the heading {string}", async function (title: string, heading: string) {
  const body = await bodyOf(this, title);
  const found = headings(body, heading);
  assert.equal(found.length, 1, `child "${title}"'s body has ${found.length} sections under "${heading}":\n${body}`);
});

Then("the body of child {string} doesn't contain {string}", async function (title: string, text: string) {
  const body = await bodyOf(this, title);
  assert.ok(!body.includes(text), `child "${title}"'s body contains "${text}":\n${body}`);
});

Then("the factory reads child {string} as having these acceptance criteria, in order:", async function (title: string, table: DataTable) {
  const fi = await childOf(this, title);
  assert.deepEqual(fi.acceptanceCriteria, table.hashes().map((r) => r.text), `child "${title}"'s body:\n${fi.body}`);
});

Then("the body of child {string} contains a section {string} reading {string}", async function (title: string, heading: string, text: string) {
  const body = await bodyOf(this, title);
  const got = section(body, heading);
  assert.notEqual(got, null, `child "${title}"'s body has no section "${heading}":\n${body}`);
  assert.equal(got, text, `child "${title}"'s section "${heading}" reads otherwise:\n${body}`);
});

Then("in the body of child {string}, {string} comes before the {string} section", async function (title: string, text: string, heading: string) {
  const body = await bodyOf(this, title);
  const lines = body.split(/\r?\n/);
  const [at] = headings(body, heading);
  assert.notEqual(at, undefined, `child "${title}"'s body has no section "${heading}":\n${body}`);
  const where = body.indexOf(text);
  const sectionAt = lines.slice(0, at).join("\n").length;
  assert.ok(where !== -1 && where < sectionAt, `"${text}" doesn't come before the "${heading}" section:\n${body}`);
});

Then("the body of child {string} ends by saying it was filed by the factory from the parent issue", async function (title: string) {
  const body = await bodyOf(this, title);
  const last = body.trimEnd().split(/\r?\n/).at(-1) ?? "";
  assert.ok(last.startsWith(`Filed by the factory from #${ctx144(this).parentId} `), `child "${title}"'s body ends otherwise:\n${body}`);
});

// --- The split request ---------------------------------------------------------------------------------------------

Given("the parent issue's repo has a {string} with the criterion {string}", function (path: string, criterion: string) {
  assert.equal(path, ".factory/dor.md");
  ctx144(this).dor = `# Definition of Ready\n\n- [ ] ${criterion}\n`;
});

When("the factory builds the coding model's split request for the parent issue", async function () {
  const c = ctx144(this);
  assert.ok(c.parentId, "the parent issue wasn't seeded");
  const parent = await c.fake.adapter.getItem(c.parentId);
  assert.ok(parent);
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? c.dor : null), "dor");
  assert.ok(dor);
  ctx(this).built = splitPrompt(parent, dor);
});

Then("the request tells the model to leave acceptance criteria out of each child's body", function () {
  const tells = requestLines(this).some((l) => /acceptance criteria/i.test(l) && /\bbody\b/i.test(l)
    && /\b(leave|leaves|omit|without|never|not|no)\b/i.test(l));
  assert.ok(tells, `no line of the split request tells the model to leave acceptance criteria out of each child's body:\n${built(this)}`);
});

Then("the request says the factory adds each child's acceptance criteria itself", function () {
  const says = requestLines(this).some((l) => /\bfactory\b/i.test(l) && /\badds?\b/i.test(l) && /acceptance criteria/i.test(l));
  assert.ok(says, `no line of the split request says the factory adds each child's acceptance criteria:\n${built(this)}`);
});

Then("the request still asks for each child's {string} as the indices of the parent's criteria it takes", function (field: string) {
  const asks = requestLines(this).some((l) => l.includes(JSON.stringify(field)) && /\bindices\b/i.test(l));
  assert.ok(asks, `no line of the split request asks for each child's "${field}" as indices:\n${built(this)}`);
});

Then("the request lists the criterion {string} word for word", function (criterion: string) {
  assert.ok(built(this).includes(criterion), `the split request doesn't list "${criterion}":\n${built(this)}`);
});
