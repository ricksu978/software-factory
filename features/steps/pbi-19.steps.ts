// Step definitions for features/pbi-19-dashboard.feature. People sign in to the dashboard as they do since the
// redesign (2026-11-07 design §04): the browser starts at the BFF's /auth/login, signs in at the sign-in provider, and
// comes back to the BFF with a session cookie. The BFF then forwards the dashboard's calls to the orchestrator API with
// the session's access token, and the API checks that token and looks the person up in "user".
//
// startDashboard runs that whole path in this process, on PBI 4's shared test database:
//   - the test sign-in provider in features/fixtures/pbi-288-provider.ts, whose subject for a person is their name;
//   - the orchestrator API, src/api/main.ts's apiApp, checking each token's signature against the provider's keys and
//     its issuer and audience, behind a front server on a free port that also runs the cell API when it's given one;
//   - the BFF, src/bff/app.ts's createBff, on a free port of its own, forwarding to that front server, with its sessions
//     in Postgres.
// The browser is PBI 288's scripted one, which keeps cookies and follows the provider's redirects. What a person sees
// is the SPA's own: web/src/shell.ts's startShell reads /bff/v1/floor as the browser would, and shows the no-access page
// on a 403, and the pages render from what the API answered (features/support/split-services.ts). Every sign-in is
// recorded for PBI 283 (features/support/sign-ins.ts).
// People the steps add are keyed by the provider's issuer and their name as subject. A person another feature added
// by a provider is put under the provider's issuer the first time their token reaches the API.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import type pg from "pg";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import type { RepoHost } from "../../src/adapters/types.ts";
import { bearerVerifier, discoverJwks } from "../../src/api/auth.ts";
import { apiApp } from "../../src/api/main.ts";
import { createBff } from "../../src/bff/app.ts";
import { pgSessions, SESSION_COOKIE } from "../../src/bff/session.ts";
import { applyComment } from "../../src/control/decisions.ts";
import { startShell, type ShellPage } from "../../web/src/shell.ts";
import { startProvider, type Provider } from "../fixtures/pbi-288-provider.ts";
import { recordOpened, recordSignIn } from "../support/sign-ins.ts";
import { keying, renderNoAccess, renderPage, underIssuer } from "../support/split-services.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { Browser, type Seen } from "./pbi-288.steps.ts";

/** The audience the API checks on every token, the one the test provider issues for. */
const AUDIENCE = "factory-api";
const CLIENT_ID = "dashboard";

/** Answers a request and returns true, or returns false to let the API answer it. */
export type CellHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type Dashboard = {
  provider: Provider;
  /** The BFF's address, as the browser reaches it. */
  origin: string;
  /** The front server's address: the API, and the cell API when one was given. */
  api: string;
  /** The front server. */
  server: Server;
  /** Each person's browser, signed in or not. */
  browsers: Map<string, Browser>;
  stop(): Promise<void>;
};

export type DashboardDeps = {
  pool: pg.Pool;
  webhookSecret?: string;
  repoHost?: RepoHost;
  readBlob?: (path: string) => Promise<string | null>;
  env?: Record<string, string | undefined>;
  /** The cell API's handler, which the front server tries before the API. */
  cell?: CellHandler;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

const close = (server: Server) => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
};

/** Starts the test sign-in provider, the API with the cell API beside it, and the BFF in front, in this process. */
export async function startDashboard(d: DashboardDeps): Promise<Dashboard> {
  const provider = await startProvider("nobody", { subjectOf: (person) => person });
  const jwks = await discoverJwks(provider.issuer);
  const api = apiApp({
    pool: d.pool, issuer: provider.issuer, audience: AUDIENCE, webhookSecret: d.webhookSecret ?? "pbi-19-webhook-secret",
    repoHost: d.repoHost, readBlob: d.readBlob ?? (async () => null), env: d.env ?? {},
    verify: keying(d.pool, bearerVerifier({ issuer: provider.issuer, audience: AUDIENCE, jwks })),
  });
  const toApi = getRequestListener(api.app.fetch);
  const front = createServer((req, res) => {
    void (async () => {
      if (d.cell && (await d.cell(req, res))) return;
      await toApi(req, res);
    })().catch((e) => {
      console.error("the front server failed:", e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const apiOrigin = `http://127.0.0.1:${await listen(front)}`;

  let bffListener: ReturnType<typeof getRequestListener> | undefined;
  const bffServer = createServer((req, res) => void bffListener!(req, res));
  const origin = `http://localhost:${await listen(bffServer)}`;
  const bff = createBff({
    issuer: provider.issuer, clientId: CLIENT_ID, clientSecret: "pbi-19-client-secret", scopes: "openid", origin,
    key: randomBytes(32), sessions: pgSessions(d.pool), apiUrl: apiOrigin,
  });
  bffListener = getRequestListener(bff.fetch);

  return {
    provider, origin, api: apiOrigin, server: front, browsers: new Map(),
    async stop() {
      await close(bffServer);
      await close(front);
      await api.close();
      await provider.stop();
    },
  };
}

const isRedirect = (s: Seen) => s.status >= 300 && s.status < 400 && s.headers.has("location");

/**
 * Signs `person` in at the test provider through the BFF: the browser opens the BFF's /auth/login, follows it to the
 * provider and back to /auth/callback, and ends up holding the session cookie. Returns that browser.
 */
export async function signIn(dash: Dashboard, person: string): Promise<Browser> {
  const b = new Browser();
  dash.provider.signInAs(person);
  let at = await b.request(new URL("/auth/login", dash.origin));
  for (let hop = 0; hop < 10 && isRedirect(at) && !(at.url.origin === dash.origin && at.url.pathname === "/auth/callback"); hop++) at = await b.next(at);
  assert.equal(at.url.pathname, "/auth/callback", `the sign-in never came back to the BFF: it ended at ${at.url.href} with ${at.status}: ${at.body}`);
  assert.ok(isRedirect(at), `the BFF's /auth/callback answered ${at.status}: ${at.body}`);
  assert.ok(b.cookies(new URL(dash.origin).hostname).get(SESSION_COOKIE), `the browser holds no ${SESSION_COOKIE} cookie after signing in`);
  const who = await b.request(new URL("/auth/session", dash.origin));
  assert.equal(who.status, 200, `the BFF doesn't know the session: ${who.body}`);
  assert.deepEqual(JSON.parse(who.body), { issuer: dash.provider.issuer, subject: person }, "the session isn't the person's");
  recordSignIn(person, "test-provider", "bff");
  dash.browsers.set(person, b);
  return b;
}

/** `person`'s signed-in browser, signing them in first when they haven't yet. */
export async function browserOf(dash: Dashboard, person: string): Promise<Browser> {
  return dash.browsers.get(person) ?? signIn(dash, person);
}

/** A call through the BFF from `b`, as the SPA makes it. A state-changing one carries `origin` when it's given. */
export async function viaBff(dash: Dashboard, b: Browser, method: string, path: string, body?: unknown, origin: string | null = dash.origin): Promise<Seen> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && origin) headers.origin = origin;
  return b.request(new URL(path, dash.origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export type Opened = { status: number; page: string; shown: ShellPage | null; json?: unknown };

/**
 * Opens the SPA as `b`'s person would: its shell reads /bff/v1/floor through the BFF, and shows the no-access page on
 * a 403 or the page `read` answers otherwise, rendered from what the API answered.
 */
export async function openSpa(dash: Dashboard, b: Browser, page: "floor" | "item" | "phase0" | "activity", read: string): Promise<Opened> {
  let shown: ShellPage | null = null;
  const shell = await startShell({
    fetch: (async (path: string, init?: RequestInit) => {
      const s = await b.request(new URL(path, dash.origin), { method: init?.method, headers: init?.headers as Record<string, string> | undefined, body: init?.body as string | undefined });
      return new Response(s.status === 204 ? null : s.body, { status: s.status, headers: s.headers });
    }) as typeof fetch,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    root: { classList: { add() {}, remove() {}, toggle: () => false, contains: () => false } },
    navigate: () => {},
    show: (p) => (shown = p),
  });
  const r = await shell.call(read);
  const text = await r.text();
  const now = shown as ShellPage | null;
  if (now?.kind === "no-access") return { status: r.status, page: await renderNoAccess(now.text), shown: now };
  if (r.status !== 200) return { status: r.status, page: text, shown: now };
  const json = JSON.parse(text);
  return { status: r.status, page: await renderPage(page, json), shown: now, json };
}

// ---- this feature's context ----

type Fake = ReturnType<typeof fakeBacklog>;
type Ctx = {
  dash?: Dashboard;
  /** The front server, kept under the name today's other features look for. */
  server?: Server;
  fake?: Fake;
  sourceId?: string;
  itemId?: string;
  extId?: string;
  status?: number;
  page?: string;
  floor?: unknown;
  applied?: boolean;
  /** Who the BFF said was signed in for a request with no session cookie. */
  session?: Seen;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi19?: Ctx };
  w.pbi19 ??= {};
  return w.pbi19;
}

/** Records a response for this file's "the response is {int}" step, so other features' requests can share it. */
export function recordResponse(world: object, status: number, page: string): void {
  const c = ctx(world);
  c.status = status;
  c.page = page;
}

const pool = () => need().pool;

/** A fresh source, a fake board and the dashboard running. */
async function dashboard(c: Ctx): Promise<Dashboard> {
  if (c.dash) return c.dash;
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  c.fake = fakeBacklog();
  c.sourceId ??= (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  c.dash = await startDashboard({ pool: d.pool });
  return c.dash;
}

/** Adds `login` as an operator known by the provider's issuer, with their name as subject and GitHub login. */
async function user(c: Ctx, login: string, opts: { productOwner?: boolean; githubLogin?: boolean } = {}): Promise<void> {
  const issuer = (await dashboard(c)).provider.issuer;
  // Someone another feature added by a provider moves under the issuer first, so their GitHub login stays theirs.
  await underIssuer(pool(), issuer, login);
  await pool().query(
    `insert into "user" (issuer, subject, role, product_owner, github_login) values ($1, $2, 'operator', $3, $4)
     on conflict on constraint user_issuer_subject do update set product_owner = excluded.product_owner, github_login = excluded.github_login`,
    [issuer, login, opts.productOwner ?? false, opts.githubLogin === false ? null : login],
  );
}

async function item(c: Ctx, title: string, state: string, extra: { rank?: number } = {}): Promise<string> {
  const ext = c.fake ? await c.fake.seed({ title, labels: ["factory"] }) : title;
  const r = await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $3, $4, $5) returning id",
    [c.sourceId, ext, title, state, extra.rank ?? null],
  );
  return r.rows[0].id;
}

/** An item in SignOff with an open sign-off question and a run whose scenarios were written at `sha`. */
async function awaitingSignOff(c: Ctx, sha: string): Promise<void> {
  await dashboard(c);
  c.extId = await c.fake!.seed({ title: "the item", labels: ["factory"], repo: "octo/repo" });
  c.itemId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, lease_generation) values ($1, $2, 'the item', 'SignOff', 2) returning id",
    [c.sourceId, c.extId],
  )).rows[0].id;
  await pool().query("insert into run (item_id, run_number, next_stage, scenarios_sha, locked_files) values ($1, 1, 'sign-off', $2, '{features/x.feature}')", [c.itemId, sha]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios')", [c.itemId]);
}

/** `login` approves the item's scenarios from Run detail, through the BFF, with `origin` or none. */
async function approveFromDashboard(c: Ctx, login: string, origin: string | null): Promise<void> {
  const dash = await dashboard(c);
  assert.ok(c.itemId, "no item waits for sign-off");
  const r = await viaBff(dash, await browserOf(dash, login), "POST", `/bff/v1/items/${c.itemId}/decisions`, { kind: "approve", text: "" }, origin);
  c.status = r.status;
  c.page = r.body;
}

async function comment(c: Ctx, login: string, body: string): Promise<void> {
  assert.ok(c.fake && c.extId && c.sourceId, "no item waits for sign-off");
  await applyComment({ pool: pool(), adapter: c.fake.adapter, sourceId: c.sourceId }, { externalId: c.extId, repo: "octo/repo", login, body, commentId: "c1" });
  c.applied = true;
}

/** `login` opens Floor in the SPA, signed in through the BFF. */
async function openFloor(c: Ctx, login: string): Promise<void> {
  const dash = await dashboard(c);
  const opened = await openSpa(dash, await browserOf(dash, login), "floor", "/bff/v1/floor");
  c.status = opened.status;
  c.page = opened.page;
  c.floor = opened.json;
  if (opened.status === 200) recordOpened(login, "Floor");
}

/** The text of the Floor section under the heading `title`, up to the next heading. */
function section(c: Ctx, title: string): string {
  assert.ok(c.page, "Floor didn't load");
  const start = c.page.indexOf(`>${title}<`);
  assert.ok(start >= 0, `Floor has no "${title}" section: ${c.page.slice(0, 500)}`);
  const next = c.page.indexOf("<h2", start);
  return c.page.slice(start, next < 0 ? undefined : next);
}

const decode = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function stored(c: Ctx) {
  const item = (await pool().query("select state from item where id = $1", [c.itemId])).rows[0];
  const run = (await pool().query("select next_stage, features_lock_sha from run where item_id = $1 and ended_at is null", [c.itemId])).rows[0];
  const question = (await pool().query("select decision, answer from question where item_id = $1 and kind = 'sign_off'", [c.itemId])).rows[0];
  return { state: item?.state, nextStage: run?.next_stage, lock: run?.features_lock_sha, decision: question?.decision ?? null };
}

Before({ tags: "@pbi-19 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user", session cascade');
});

After({ tags: "@pbi-19", ...long }, async function () {
  await ctx(this).dash?.stop();
});

// AC-1

Given("the factory's allowlist holds only {string}", long, async function (login: string) {
  await user(ctx(this), login);
});

When("{string} signs in and opens Floor", long, async function (login: string) {
  await openFloor(ctx(this), login);
});

Then("the response is {int}", function (status: number) {
  const c = ctx(this);
  assert.ok(c.status, "no response came back");
  assert.equal(c.status, status, c.page ?? "");
});

Then("the page says {string}", function (text: string) {
  const c = ctx(this);
  assert.ok(c.page, "no page came back");
  assert.ok(decode(c.page).includes(text), `the page doesn't say "${text}": ${c.page.slice(0, 500)}`);
});

// AC-2, a request with no session

Given("the dashboard is running", long, async function () {
  await dashboard(ctx(this));
});

When("a request without a session cookie opens Floor, carrying every Azure sign-in header", long, async function () {
  const c = ctx(this);
  const dash = await dashboard(c);
  await user(c, "octo");
  // Every header Container Apps' built-in sign-in adds, naming an allowlisted person.
  const azure = {
    "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "octo", "x-ms-client-principal-name": "octo",
    "x-ms-client-principal": Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{ typ: "name", val: "octo" }] })).toString("base64"),
    "x-ms-token-aad-access-token": "not-a-token", "x-ms-token-aad-id-token": "not-a-token",
  };
  const b = new Browser();
  const floor = await b.request(new URL("/bff/v1/floor", dash.origin), { headers: azure });
  c.status = floor.status;
  c.page = floor.body;
  c.session = await b.request(new URL("/auth/session", dash.origin), { headers: azure });
});

Then("the BFF's session check says no one is signed in", function () {
  const s = ctx(this).session;
  assert.ok(s, "nothing asked the BFF who is signed in");
  assert.equal(s.status, 401, `the BFF answered /auth/session with ${s.status}: ${s.body}`);
});

// AC-2, origin check

Given("{string}, a product owner, is signed in, and an item waits for sign-off", long, async function (login: string) {
  const c = ctx(this);
  await awaitingSignOff(c, "abc123");
  await user(c, login, { productOwner: true });
  await signIn(c.dash!, login);
});

When("{string} posts an approval with the origin {string}", long, async function (login: string, origin: string) {
  await approveFromDashboard(ctx(this), login, origin);
});

When("{string} posts an approval with no origin", long, async function (login: string) {
  await approveFromDashboard(ctx(this), login, null);
});

When("{string} posts an approval from the dashboard's own origin", long, async function (login: string) {
  const c = ctx(this);
  await approveFromDashboard(c, login, (await dashboard(c)).origin);
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
  if (c.status !== undefined) assert.ok(c.status < 300, `the approval answered ${c.status}: ${c.page}`);
  const s = await stored(c);
  assert.deepEqual([s.state, s.decision !== null, s.nextStage], ["SignOff", true, stage]);
});

// AC-3, Floor

Given("a SignOff item asked 3 hours ago, a NeedsInput item asked 1 hour ago, an InReview item and a Queued item", long, async function () {
  const c = ctx(this);
  await dashboard(c);
  const signOff = await item(c, "the SignOff item", "SignOff");
  const needsInput = await item(c, "the NeedsInput item", "NeedsInput");
  const inReview = await item(c, "the InReview item", "InReview");
  await item(c, "the Queued item", "Queued");
  await pool().query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'q', now() - interval '3 hours')", [signOff]);
  await pool().query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now() - interval '1 hour')", [needsInput]);
  await pool().query("insert into run (item_id, run_number, next_stage, pr_number, pr_url) values ($1, 1, 'address', 7, 'https://github.com/octo/repo/pull/7')", [inReview]);
});

Given("seven Queued items ranked 1 to 7", long, async function () {
  const c = ctx(this);
  await dashboard(c);
  for (const rank of [4, 7, 1, 6, 2, 5, 3]) await item(c, `item ranked ${rank}`, "Queued", { rank });
});

Given("a NotReady item that failed the dor.md line {string}", long, async function (line: string) {
  const c = ctx(this);
  await dashboard(c);
  const id = await item(c, "the NotReady item", "NotReady");
  await pool().query(
    "insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values ($1, 'dor', 'repo', 1, $2, 'failed', 'Size is 8')",
    [id, line],
  );
});

// PBI 175's scenarios open Floor with no PBI 19 Given before it, so the dashboard starts here when it hasn't.
When("{string} opens Floor", long, async function (login: string) {
  const c = ctx(this);
  await user(c, login);
  await openFloor(c, login);
  assert.equal(c.status, 200, `Floor answered ${c.status}: ${c.page?.slice(0, 300)}`);
});

Then("{string} lists the SignOff item, then the NeedsInput item, then the InReview item", function (title: string) {
  const text = section(ctx(this), title);
  const at = ["the SignOff item", "the NeedsInput item", "the InReview item"].map((t) => text.indexOf(t));
  assert.ok(at.every((i) => i >= 0), `"${title}" is missing an item: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `"${title}" lists them out of order`);
});

Then("{string} doesn't list the Queued item", function (title: string) {
  assert.ok(!section(ctx(this), title).includes("the Queued item"));
});

Then("{string} lists the items ranked 1 to 5, in that order", function (title: string) {
  const text = section(ctx(this), title);
  const at = [1, 2, 3, 4, 5].map((n) => text.indexOf(`item ranked ${n}<`));
  assert.ok(at.every((i) => i >= 0), `"${title}" is missing an item: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `"${title}" lists them out of order`);
  for (const n of [6, 7]) assert.ok(!text.includes(`item ranked ${n}<`), `"${title}" lists item ranked ${n}`);
});

Then("{string} lists the item with {string}", function (title: string, line: string) {
  const text = decode(section(ctx(this), title));
  assert.ok(text.includes("the NotReady item"), `"${title}" doesn't list the item`);
  assert.ok(text.includes(line), `"${title}" doesn't show "${line}"`);
});

// AC-4, sign-off from either channel

Given("an item waits for sign-off on scenarios at {string}", long, async function (sha: string) {
  await awaitingSignOff(ctx(this), sha);
});

When("{string}, a product owner, approves through the dashboard button", long, async function (login: string) {
  const c = ctx(this);
  await user(c, login, { productOwner: true });
  await approveFromDashboard(c, login, (await dashboard(c)).origin);
});

When("{string}, a product owner, approves through a {string} comment", long, async function (login: string, body: string) {
  const c = ctx(this);
  await user(c, login, { productOwner: true });
  await comment(c, login, body);
});

When("{string}, who is allowlisted but not a product owner comments {string} on the item", long, async function (login: string, body: string) {
  const c = ctx(this);
  await user(c, login, { productOwner: false });
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
