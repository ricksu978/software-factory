import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// An address run asks the real cell API for its context, over PBI 4's shared database, with the fake repo host
// holding the PR's reviews. Modules load lazily, so a missing one fails the Then instead of crashing the run.
const secret = "cell-secret";
const repoName = "ricksu978/software-factory";

type Review = { state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string; body?: string };
type Host = { prs: { number: number; repo: string; reviews: Review[] }[] };
type Mods = {
  cellApi: { runToken: (secret: string, runId: string, generation: number) => string; cellApi: (deps: object) => unknown };
  server: { startServer: (handlers: unknown[], opts: { port: number }) => Promise<Server> };
  fake: { fakeBacklog: () => { adapter: object; seed(item: { externalId: string; title?: string }): Promise<string> }; fakeRepoHost: () => Host };
  items: { claimNext: (c: pg.PoolClient, owner: string, now: Date) => Promise<{ runId: string; generation: number } | null> };
  db: { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
};
type Comment = { author: string; body: string };
type Ctx = { server?: Server; host?: Host; run?: { runId: string; token: string }; clock: number; comments?: Comment[] | null };

export function ctx(world: object): Ctx {
  const w = world as { pbi28?: Ctx };
  w.pbi28 ??= { clock: Date.parse("2026-11-06T09:00:00Z") };
  return w.pbi28;
}

async function mods(): Promise<Mods | null> {
  const [cellApi, server, fake, items, db] = await Promise.all([
    load<Mods["cellApi"]>("src/control/cell-api.ts"), load<Mods["server"]>("src/http/server.ts"), load<Mods["fake"]>("src/adapters/fake.ts"),
    load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts"),
  ]);
  return cellApi && server && fake && items && db ? { cellApi, server, fake, items, db } : null;
}

// PBI 79's scenarios drive the same address run, so they share these hooks and the steps below.
Before({ tags: "@pbi-28 or @pbi-79", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query(`truncate item, "user" cascade`);
});

After({ tags: "@pbi-28 or @pbi-79" }, async function () {
  const s = ctx(this).server;
  if (s) await new Promise((r) => s.close(r));
});

Given("item {string} is being addressed on PR {int}", long, async function (name: string, pr: number) {
  const c = ctx(this);
  const d = await testDb();
  const m = await mods();
  if (!d || !m) return;
  const source = await d.pool.query<{ id: string }>(
    "insert into backlog_source (adapter, url, field_map) values ('fake', 'test:' || gen_random_uuid(), $1) returning id",
    [JSON.stringify({ statusFor: {} })],
  );
  await d.pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict (url) do nothing", [`https://github.com/${repoName}`]);
  const board = m.fake.fakeBacklog();
  await board.seed({ externalId: name, title: name });
  const host = m.fake.fakeRepoHost();
  host.prs.push({ number: pr, repo: repoName, branch: `factory/pbi-${name}-r1`, base: "main", title: name, body: "", headSha: null, open: true,
    merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [] } as unknown as Host["prs"][number]);
  c.host = host;
  await d.pool.query("insert into item (source_id, external_id, title, state) values ($1, $2, $2, 'Queued')", [source.rows[0].id, name]);
  const claim = await m.db.withTx(d.pool, (client) => m.items.claimNext(client, "cell-a", new Date(c.clock)));
  assert.ok(claim, "the claim returned nothing");
  await d.pool.query(
    "update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234', next_stage = 'address', pr_number = $3 where id = $1",
    [claim.runId, `https://github.com/${repoName}`, pr],
  );
  c.run = { runId: claim.runId, token: m.cellApi.runToken(secret, claim.runId, claim.generation) };
  const api = m.cellApi.cellApi({
    pool: d.pool, secret, repoHost: host, backlogFor: () => board.adapter, stageAfter: () => null,
    uploadUrl: async (path: string) => path, gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "owner-secret" }, webToolsOf: () => [],
  });
  c.server = await m.server.startServer([api], { port: 0 });
});

function review(world: object, pr: number, r: Omit<Review, "submittedAt">) {
  const c = ctx(world);
  const p = c.host?.prs.find((x) => x.number === pr);
  if (!p) return;
  c.clock += 60_000; // each review a minute after the last, so "later" means later
  p.reviews.push({ ...r, submittedAt: new Date(c.clock).toISOString() });
}

async function allowlist(login: string) {
  await need().pool.query(`insert into "user" (provider, subject, github_login, role) values ('dev', $1, $1, 'owner')`, [login]);
}

Given("{string}, an allowlisted user, requested changes on PR {int} with only the summary {string}", long, async function (login: string, pr: number, summary: string) {
  await allowlist(login);
  review(this, pr, { state: "changes_requested", author: login, body: summary });
});

Given("{string} later approved PR {int}", function (login: string, pr: number) {
  review(this, pr, { state: "approved", author: login, body: "" });
});

Given("{string}, who maps to no allowlisted user, requested changes on PR {int} with only the summary {string}", function (login: string, pr: number, summary: string) {
  review(this, pr, { state: "changes_requested", author: login, body: summary });
});

When("the address run asks for its context", long, async function () {
  const c = ctx(this);
  if (!c.server || !c.run) return;
  const r = await fetch(`http://127.0.0.1:${(c.server.address() as AddressInfo).port}/internal/cells/${c.run.runId}/context`, {
    headers: { authorization: `Bearer ${c.run.token}` },
  });
  const body = (await r.json()) as { trustedComments?: Comment[] };
  c.comments = r.status === 200 ? body.trustedComments ?? null : null;
});

function comments(world: object): Comment[] {
  const list = ctx(world).comments;
  assert.ok(list, "the address run got no context: src/control/cell-api.ts or its dependencies are missing");
  return list;
}

Then("its trusted comments hold {string} by {string}", function (body: string, author: string) {
  const list = comments(this);
  assert.ok(list.some((x) => x.body === body && x.author === author), `"${body}" by ${author} is not in ${JSON.stringify(list)}`);
});

Then("no trusted comment holds {string}", function (body: string) {
  assert.ok(!comments(this).some((x) => x.body === body), `"${body}" reached the address run`);
});
