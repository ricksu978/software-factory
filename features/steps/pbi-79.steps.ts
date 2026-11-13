import { After, Given } from "@cucumber/cucumber";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx } from "./pbi-28.steps.ts";

// PBI 79 reuses PBI 28's address run: "is being addressed on PR", "asks for its context" and the trusted-comment Thens.
const repoUrl = "https://github.com/ricksu978/software-factory";

type Thread = { threadId: string; path: string; line: number; author: string; body: string };

Given("the allowlisted user's login is stored as {string}", long, async function (login: string) {
  await need().pool.query(`insert into "user" (provider, subject, github_login, role) values ('dev', $1, $1, 'owner')`, [login]);
});

Given("the repo's trusted bot is stored as {string}", long, async function (login: string) {
  await need().pool.query("update repo set trusted_bot = $2 where url = $1", [repoUrl, login]);
});

Given("{string} commented {string} in an open thread on PR {int}", function (author: string, body: string, pr: number) {
  const host = ctx(this).host as unknown as { reviewComments?: Map<string, Thread[]> } | undefined;
  if (!host?.reviewComments) return;
  const key = `ricksu978/software-factory#${pr}`;
  const list = host.reviewComments.get(key) ?? [];
  // The factory's own comment here is a reply, as its address stage posts one, so it goes into a thread a person
  // opened. A thread the bot opens is its own review's, which never reaches an address run (PBI 130).
  if (!list.length && author.endsWith("[bot]")) list.push({ threadId: "t1", path: "src/a.ts", line: 3, author: "a-reviewer", body: "Rename this?" });
  host.reviewComments.set(key, [...list, { threadId: "t1", path: "src/a.ts", line: 3, author, body }]);
});

// Other suites share this repo row and expect the seeded value.
After({ tags: "@pbi-79", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query("update repo set trusted_bot = 'factory[bot]' where url = $1", [repoUrl]);
});
