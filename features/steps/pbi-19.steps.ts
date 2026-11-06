import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import type { fakeBacklog } from "../../src/adapters/fake.ts";
import type { BacklogAdapter } from "../../src/adapters/types.ts";
import type { Handler } from "../../src/http/server.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// The dashboard runs as the real node:http server on a free port, in Azure mode unless a scenario says it runs
// locally. People sign in through the headers Container Apps adds. The modules load lazily, so while they don't
// exist every scenario fails on its first Then.
type Identity = { provider: string; subject: string } | null;
type Auth = {
  devToken: string;
  identify(path: string, headers: Record<string, string | undefined>): Identity;
  devLoginCookie(token: string): string | null;
};
type AuthModule = { createAuth?: (cfg: { mode: "local" | "azure"; devLogin?: string }) => Auth };
type RoutesModule = {
  dashboardRoutes?: (deps: { pool: pg.Pool; auth: Auth; origin: string; adapter: BacklogAdapter; sourceId: string }) => Handler;
};
type DecisionsModule = {
  applyComment?: (
    deps: { pool: pg.Pool; adapter: BacklogAdapter; sourceId: string },
    e: { externalId: string; login: string; body: string; commentId: string },
  ) => Promise<string>;
};
type Fake = ReturnType<typeof fakeBacklog>;
type Ctx = {
  auth?: Auth;
  identity?: Identity;
  identified?: boolean;
  cookie?: string | null;
  cookieAsked?: boolean;
  server?: Server;
  origin?: string;
  fake?: Fake;
  sourceId?: string;
  itemId?: string;
  extId?: string;
  status?: number;
  page?: string;
  applied?: boolean;
};

function ctx(world: object): Ctx {
  const w = world as { pbi19?: Ctx };
  w.pbi19 ??= {};
  return w.pbi19;
}

const azureHeaders = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

/** A fresh source, a fake board and a running dashboard in Azure mode. False while the modules don't exist. */
async function dashboard(c: Ctx): Promise<boolean> {
  if (c.server) return true;
  const authMod = await load<AuthModule>("src/http/auth.ts");
  const routesMod = await load<RoutesModule>("src/http/routes.ts");
  const fakeMod = await load<{ fakeBacklog: () => Fake }>("src/adapters/fake.ts");
  const serverMod = await load<{ startServer: (h: Handler[], o: { port: number }) => Promise<Server> }>("src/http/server.ts");
  const d = await testDb();
  if (!authMod?.createAuth || !routesMod?.dashboardRoutes || !fakeMod || !serverMod || !d) return false;
  c.fake = fakeMod.fakeBacklog();
  c.sourceId ??= (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  let handler: Handler = async () => false;
  c.server = await serverMod.startServer([(req, res) => handler(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = routesMod.dashboardRoutes({ pool: d.pool, auth: authMod.createAuth({ mode: "azure" }), origin: c.origin, adapter: c.fake.adapter, sourceId: c.sourceId });
  return true;
}

async function user(login: string, opts: { productOwner?: boolean; githubLogin?: boolean } = {}): Promise<void> {
  await need().pool.query(
    `insert into "user" (provider, subject, role, product_owner, github_login) values ('microsoft', $1, 'operator', $2, $3)
     on conflict (provider, subject) do update set product_owner = excluded.product_owner, github_login = excluded.github_login`,
    [login, opts.productOwner ?? false, opts.githubLogin === false ? null : login],
  );
}

async function item(c: Ctx, title: string, state: string, extra: { rank?: number } = {}): Promise<string> {
  const ext = c.fake ? await c.fake.seed({ title, labels: ["factory"] }) : title;
  const r = await need().pool.query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $3, $4, $5) returning id",
    [c.sourceId, ext, title, state, extra.rank ?? null],
  );
  return r.rows[0].id;
}

/** An item in SignOff with an open sign-off question and a run whose scenarios were written at `sha`. */
async function awaitingSignOff(c: Ctx, sha: string): Promise<void> {
  if (!(await dashboard(c))) return;
  c.extId = await c.fake!.seed({ title: "the item", labels: ["factory"] });
  const pool = need().pool;
  c.itemId = (await pool.query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, lease_generation) values ($1, $2, 'the item', 'SignOff', 2) returning id",
    [c.sourceId, c.extId],
  )).rows[0].id;
  await pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha, locked_files) values ($1, 1, 'sign-off', $2, '{features/x.feature}')", [c.itemId, sha]);
  await pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios')", [c.itemId]);
}

async function request(c: Ctx, method: string, path: string, headers: Record<string, string>, body?: string): Promise<void> {
  const r = await fetch(`${c.origin}${path}`, { method, headers, body, redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
}

async function approveFromDashboard(c: Ctx, login: string, origin: string | null): Promise<void> {
  if (!c.server || !c.itemId) return;
  const headers: Record<string, string> = { ...azureHeaders(login), "content-type": "application/x-www-form-urlencoded" };
  if (origin) headers.origin = origin;
  await request(c, "POST", `/items/${c.itemId}/signoff`, headers, "decision=approve&note=");
}

async function comment(c: Ctx, login: string, body: string): Promise<void> {
  const mod = await load<DecisionsModule>("src/control/decisions.ts");
  if (!mod?.applyComment || !c.fake || !c.extId || !c.sourceId) return;
  await mod.applyComment({ pool: need().pool, adapter: c.fake.adapter, sourceId: c.sourceId }, { externalId: c.extId, login, body, commentId: "c1" });
  c.applied = true;
}

/** The text of the Floor strip under the heading `title`, up to the next heading. */
function strip(c: Ctx, title: string): string {
  assert.ok(c.page, "Floor didn't load");
  const start = c.page.indexOf(`>${title}<`);
  assert.ok(start >= 0, `Floor has no "${title}" strip`);
  const next = c.page.indexOf("<h2", start);
  return c.page.slice(start, next < 0 ? undefined : next);
}

const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function stored(c: Ctx) {
  const pool = need().pool;
  const item = (await pool.query("select state from item where id = $1", [c.itemId])).rows[0];
  const run = (await pool.query("select next_stage, features_lock_sha from run where item_id = $1 and ended_at is null", [c.itemId])).rows[0];
  const question = (await pool.query("select decision, answer from question where item_id = $1 and kind = 'sign_off'", [c.itemId])).rows[0];
  return { state: item?.state, nextStage: run?.next_stage, lock: run?.features_lock_sha, decision: question?.decision ?? null };
}

Before({ tags: "@pbi-19 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-19" }, async function () {
  const c = ctx(this);
  if (c.server) await new Promise<void>((resolve) => c.server!.close(() => resolve()));
});

// AC-1

Given("the factory's allowlist holds only {string}", long, async function (login: string) {
  const c = ctx(this);
  if (await dashboard(c)) await user(login);
});

When("{string} signs in and opens Floor", long, async function (login: string) {
  const c = ctx(this);
  if (c.server) await request(c, "GET", "/", azureHeaders(login));
});

Then("the response is {int}", function (status: number) {
  const c = ctx(this);
  assert.ok(c.status, "no response came back");
  assert.equal(c.status, status, c.page ?? "");
});

Then("the page says {string}", function (text: string) {
  const c = ctx(this);
  assert.ok(c.page, "no page came back");
  assert.ok(decode(c.page).includes(text), `the page doesn't say "${text}"`);
});

// AC-2, local sign-in

Given("the dashboard runs locally for {string}", async function (login: string) {
  const mod = await load<AuthModule>("src/http/auth.ts");
  if (mod?.createAuth) ctx(this).auth = mod.createAuth({ mode: "local", devLogin: login });
});

When("a request without the sign-in cookie opens Floor, carrying every Azure sign-in header", function () {
  const c = ctx(this);
  if (!c.auth) return;
  c.identity = c.auth.identify("/", azureHeaders("octo"));
  c.identified = true;
});

Then("the request gets no identity", function () {
  const c = ctx(this);
  assert.ok(c.identified, "the dashboard's sign-in doesn't exist");
  assert.equal(c.identity, null);
});

When("someone opens the sign-in link with a wrong token", function () {
  const c = ctx(this);
  if (!c.auth) return;
  c.cookie = c.auth.devLoginCookie(`${c.auth.devToken}x`);
  c.cookieAsked = true;
});

Then("no sign-in cookie is set", function () {
  const c = ctx(this);
  assert.ok(c.cookieAsked, "the sign-in link doesn't exist");
  assert.equal(c.cookie, null);
});

When("someone opens this start's sign-in link", function () {
  const c = ctx(this);
  if (!c.auth) return;
  c.cookie = c.auth.devLoginCookie(c.auth.devToken);
  c.cookieAsked = true;
});

When("opens Floor with the cookie it set", function () {
  const c = ctx(this);
  if (!c.auth || !c.cookie) return;
  // The browser sends back only the cookie's name and value.
  c.identity = c.auth.identify("/", { cookie: c.cookie.split(";")[0] });
  c.identified = true;
});

Then("the request is signed in as {string}", function (login: string) {
  const c = ctx(this);
  assert.ok(c.identified, "the dashboard's sign-in doesn't exist");
  assert.deepEqual(c.identity && { provider: c.identity.provider, subject: c.identity.subject }, { provider: "dev", subject: login });
});

// AC-2, origin check

Given("{string}, a product owner, is signed in, and an item waits for sign-off", long, async function (login: string) {
  const c = ctx(this);
  await awaitingSignOff(c, "abc123");
  if (c.server) await user(login, { productOwner: true });
});

When("{string} posts an approval with the origin {string}", long, async function (login: string, origin: string) {
  await approveFromDashboard(ctx(this), login, origin);
});

When("{string} posts an approval with no origin", long, async function (login: string) {
  await approveFromDashboard(ctx(this), login, null);
});

When("{string} posts an approval from the dashboard's own origin", long, async function (login: string) {
  const c = ctx(this);
  await approveFromDashboard(c, login, c.origin ?? null);
});

Then("the item still waits for sign-off", long, async function () {
  const c = ctx(this);
  assert.ok(c.status !== undefined || c.applied, "nothing was sent to the dashboard or the comment handler");
  const s = await stored(c);
  assert.equal(s.state, "SignOff");
  assert.equal(s.decision, null);
});

// An answered SignOff item is claimable as it stands (Run contract 3), so approval leaves the state alone.
Then("the item is ready to resume at {string}", long, async function (stage: string) {
  const c = ctx(this);
  assert.ok(c.status !== undefined || c.applied, "nothing was sent to the dashboard or the comment handler");
  const s = await stored(c);
  assert.deepEqual([s.state, s.decision !== null, s.nextStage], ["SignOff", true, stage]);
});

// AC-3, Floor

Given("a SignOff item asked 3 hours ago, a NeedsInput item asked 1 hour ago, an InReview item and a Queued item", long, async function () {
  const c = ctx(this);
  if (!(await dashboard(c))) return;
  const pool = need().pool;
  const signOff = await item(c, "the SignOff item", "SignOff");
  const needsInput = await item(c, "the NeedsInput item", "NeedsInput");
  const inReview = await item(c, "the InReview item", "InReview");
  await item(c, "the Queued item", "Queued");
  await pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'q', now() - interval '3 hours')", [signOff]);
  await pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now() - interval '1 hour')", [needsInput]);
  await pool.query("insert into run (item_id, run_number, next_stage, pr_number, pr_url) values ($1, 1, 'address', 7, 'https://github.com/octo/repo/pull/7')", [inReview]);
});

Given("seven Queued items ranked 1 to 7", long, async function () {
  const c = ctx(this);
  if (!(await dashboard(c))) return;
  for (const rank of [4, 7, 1, 6, 2, 5, 3]) await item(c, `item ranked ${rank}`, "Queued", { rank });
});

Given("a NotReady item that failed the dor.md line {string}", long, async function (line: string) {
  const c = ctx(this);
  if (!(await dashboard(c))) return;
  const id = await item(c, "the NotReady item", "NotReady");
  await need().pool.query(
    "insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values ($1, 'dor', 'repo', 1, $2, 'failed', 'Size is 8')",
    [id, line],
  );
});

When("{string} opens Floor", long, async function (login: string) {
  const c = ctx(this);
  if (!c.server) return;
  await user(login);
  await request(c, "GET", "/", azureHeaders(login));
});

Then("{string} lists the SignOff item, then the NeedsInput item, then the InReview item", function (title: string) {
  const text = strip(ctx(this), title);
  const at = ["the SignOff item", "the NeedsInput item", "the InReview item"].map((t) => text.indexOf(t));
  assert.ok(at.every((i) => i >= 0), `"${title}" is missing an item: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `"${title}" lists them out of order`);
});

Then("{string} doesn't list the Queued item", function (title: string) {
  assert.ok(!strip(ctx(this), title).includes("the Queued item"));
});

Then("{string} lists the items ranked 1 to 5, in that order", function (title: string) {
  const text = strip(ctx(this), title);
  const at = [1, 2, 3, 4, 5].map((n) => text.indexOf(`item ranked ${n}<`));
  assert.ok(at.every((i) => i >= 0), `"${title}" is missing an item: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `"${title}" lists them out of order`);
  for (const n of [6, 7]) assert.ok(!text.includes(`item ranked ${n}<`), `"${title}" lists item ranked ${n}`);
});

Then("{string} lists the item with {string}", function (title: string, line: string) {
  const text = decode(strip(ctx(this), title));
  assert.ok(text.includes("the NotReady item"), `"${title}" doesn't list the item`);
  assert.ok(text.includes(line), `"${title}" doesn't show "${line}"`);
});

// AC-4, sign-off from either channel

Given("an item waits for sign-off on scenarios at {string}", long, async function (sha: string) {
  await awaitingSignOff(ctx(this), sha);
});

When("{string}, a product owner, approves through the dashboard button", long, async function (login: string) {
  const c = ctx(this);
  if (!c.server) return;
  await user(login, { productOwner: true });
  await approveFromDashboard(c, login, c.origin ?? null);
});

When("{string}, a product owner, approves through a {string} comment", long, async function (login: string, body: string) {
  const c = ctx(this);
  if (!c.server) return;
  await user(login, { productOwner: true });
  await comment(c, login, body);
});

When("{string}, who is allowlisted but not a product owner comments {string} on the item", long, async function (login: string, body: string) {
  const c = ctx(this);
  if (!c.server) return;
  await user(login, { productOwner: false });
  await comment(c, login, body);
});

When("{string}, who maps to no allowlisted user comments {string} on the item", long, async function (login: string, body: string) {
  await comment(ctx(this), login, body);
});

Then("its scenarios are locked at {string}", long, async function (sha: string) {
  assert.equal((await stored(ctx(this))).lock, sha);
});

Then("its sign-off question is answered {string}", long, async function (decision: string) {
  assert.equal((await stored(ctx(this))).decision, decision);
});

Then("the item gets one reply saying who can sign off", async function () {
  const c = ctx(this);
  assert.ok(c.applied, "the comment handler doesn't exist");
  const replies = await c.fake!.comments(c.extId!);
  assert.equal(replies.length, 1, replies.join("\n---\n"));
  assert.match(replies[0], /product owner/i);
});
