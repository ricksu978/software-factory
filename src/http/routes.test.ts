import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { createAuth } from "./auth.ts";
import { dashboardRoutes, tokenBanner } from "./routes.ts";
import { startServer, type Handler } from "./server.ts";

describe("tokenBanner", () => {
  const day = 86_400_000;
  test("shows within 30 days of the token's 365-day life, and not before", () => {
    const now = Date.parse("2027-11-01T00:00:00Z");
    assert.match(tokenBanner({ CLAUDE_TOKEN_CREATED_AT: new Date(now - 340 * day).toISOString() }, now) ?? "", /expires in 25 days/);
    assert.equal(tokenBanner({ CLAUDE_TOKEN_CREATED_AT: new Date(now - 300 * day).toISOString() }, now), null);
    assert.equal(tokenBanner({}, now), null);
  });
});

describe("dashboard routes", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let server: Server;
  let origin: string;
  let fake: ReturnType<typeof fakeBacklog>;
  let host: ReturnType<typeof fakeRepoHost>;
  let sourceId: string;
  let handler: Handler = async () => false;

  before(async () => {
    db = await startTestDb();
    server = await startServer([(req, res) => handler(req, res)], { port: 0 });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate item, backlog_source, "user", override cascade');
    fake = fakeBacklog();
    host = fakeRepoHost();
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    handler = dashboardRoutes({ pool: db.pool, auth: createAuth({ mode: "azure" }), origin, adapter: fake.adapter, sourceId, repoHost: host, env: {} });
  });

  const as = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login });
  const person = (login: string, role: string, productOwner = false) =>
    db.pool.query<{ id: string }>(`insert into "user" (provider, subject, role, product_owner, github_login) values ('microsoft', $1, $2, $3, $1) returning id`, [login, role, productOwner]);
  const get = async (path: string, login: string) => {
    const r = await fetch(`${origin}${path}`, { headers: as(login) });
    return { status: r.status, html: await r.text() };
  };
  const post = (path: string, login: string, body: string) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { ...as(login), origin, "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  async function item(state: string, title = "t", extra: Partial<{ repo: string; criteria: string[] }> = {}) {
    const ext = await fake.seed({ title, repo: extra.repo ?? null, acceptanceCriteria: extra.criteria ?? ["it works"] });
    return { ext, id: (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id", [sourceId, ext, title, state])).rows[0].id };
  }

  test("a request with no identity gets the sign-in page, and routes under /webhooks and /internal aren't the dashboard's", async () => {
    assert.equal((await fetch(`${origin}/`)).status, 401);
    const hook = await fetch(`${origin}/webhooks/github`, { method: "POST", headers: { ...as("octo"), origin } });
    // The server's own 404, not a dashboard page, so the dashboard never handled it.
    assert.equal(hook.status, 404);
    assert.doesNotMatch(await hook.text(), /<html/);
  });

  test("Floor shows each in-flight item's stage, time in stage, cost and badges", async () => {
    await person("octo", "viewer");
    const { id } = await item("InProgress", "busy item");
    await db.pool.query("update item set held = true where id = $1", [id]);
    const run = (await db.pool.query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green') returning id", [id])).rows[0].id;
    await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status, cost_usd, started_at) values ($1, 'red', 1, 'passed', 1.25, now() - interval '2 hours'), ($1, 'green', 1, 'started', 0.5, now() - interval '20 minutes')", [run]);
    await db.pool.query("insert into override (scope, target_id, kind, reason) values ('item', $1, 'hold', 'checking')", [id]);
    const { html } = await get("/", "octo");
    const row = html.slice(html.indexOf("busy item"), html.indexOf("</tr>", html.indexOf("busy item")));
    for (const want of [">held<", ">override<", "InProgress", "green", "20 min", "$1.75"]) assert.ok(row.includes(want), `${want} missing from ${row}`);
  });

  test("Floor counts what waits on people against the review capacity", async () => {
    await person("octo", "viewer");
    const signOff = await item("SignOff");
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [signOff.id]);
    const answered = await item("NeedsInput");
    await db.pool.query("insert into question (item_id, kind, body, answer) values ($1, 'needs_input', 'q', 'a')", [answered.id]);
    await item("InReview");
    assert.match((await get("/", "octo")).html, /2 of 3 waiting/);
  });

  test("Run detail shows the run's pins, policy results, stages and tier", async () => {
    await person("octo", "viewer");
    const { id } = await item("InReview", "detailed");
    const run = (await db.pool.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage, sop_version, config_sha, features_lock_sha, risk_tier, tier_reasons)
       values ($1, 1, 'address', '0.1.0', 'cfg123', 'lock456', 'Medium', '{"touches caching"}') returning id`, [id],
    )).rows[0].id;
    await db.pool.query("insert into policy_result (item_id, run_id, file, source, criterion_index, criterion, status, reason) values ($1, $2, 'dod', 'repo', 1, 'Tests pass', 'passed', 'npm test exited 0')", [id, run]);
    await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status, model, tokens_in, tokens_out, cost_usd, transcript_ref) values ($1, 'green', 2, 'passed', 'claude-opus-5-5', 100, 50, 2.5, 'transcripts/r/green-2.jsonl')", [run]);
    const { status, html } = await get(`/items/${id}`, "octo");
    assert.equal(status, 200);
    for (const want of ["0.1.0", "cfg123", "lock456", "Medium", "touches caching", "dod.md", "repo", "Tests pass", "npm test exited 0", "claude-opus-5-5", "100 in, 50 out", "$2.5", "transcripts/r/green-2.jsonl"]) {
      assert.ok(html.includes(want), `${want} missing`);
    }
  });

  test("the sign-off view lists each criterion with its tagged scenarios, and marks one with none", async () => {
    await person("octo", "viewer");
    const { id } = await item("SignOff", "to sign", { repo: "octo/repo", criteria: ["Exports one month", "Keeps the currency"] });
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha, locked_files) values ($1, 1, 'sign-off', 'sc1', '{features/x.feature}')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    host.files.set("octo/repo@sc1:features/x.feature", "@pbi-1\nFeature: x\n\n  @ac-1\n  Scenario: Other months are left out\n    Given a\n\n  @ac-1 @db\n  Scenario Outline: A month with no invoices\n    Given b\n");
    const { html } = await get(`/items/${id}`, "octo");
    const view = html.slice(html.indexOf("Criteria and their scenarios"));
    assert.ok(view.indexOf("Other months are left out") < view.indexOf("Keeps the currency"));
    assert.ok(view.includes("A month with no invoices"));
    assert.match(view, /Keeps the currency <strong>no scenario<\/strong>/);
    assert.match(html, /<label for="note">/);
  });

  test("a sign-off from a user who isn't a product owner gets 403 and changes nothing", async () => {
    await person("op", "operator");
    const { id } = await item("SignOff");
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, 'sign-off', 'abc')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    assert.equal((await post(`/items/${id}/signoff`, "op", "decision=approve")).status, 403);
    assert.equal((await db.pool.query("select decision from question where item_id = $1", [id])).rows[0].decision, null);
  });

  test("a product owner's sign-off answers the question, comments the decision on the PBI and logs a human event", async () => {
    const userId = (await person("po", "operator", true)).rows[0].id;
    const { ext, id } = await item("SignOff");
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, 'sign-off', 'abc')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    const r = await post(`/items/${id}/signoff`, "po", "decision=approve&note=Looks+right");
    assert.equal(r.status, 303);
    assert.match((await fake.comments(ext))[0], /signed off[\s\S]*Looks right/);
    const ev = (await db.pool.query("select actor, actor_id from event where item_id = $1 and kind = 'decision'", [id])).rows[0];
    assert.deepEqual(ev, { actor: "human", actor_id: userId });
  });

  test("only an owner can add people", async () => {
    await person("op", "operator");
    await person("boss", "owner");
    assert.equal((await post("/users", "op", "provider=google&subject=g1&role=viewer")).status, 403);
    assert.equal((await post("/users", "boss", "provider=google&subject=g1&role=viewer")).status, 303);
    assert.equal((await post("/users", "boss", "provider=github&subject=g2&role=viewer")).status, 400);
    assert.equal((await db.pool.query(`select count(*)::int as n from "user" where provider = 'google'`)).rows[0].n, 1);
  });
});
