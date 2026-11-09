import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { fakeLauncher } from "../scheduler/launcher.ts";
import { tick } from "../scheduler/scheduler.ts";
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
  let routes: ReturnType<typeof dashboardRoutes> | null = null;
  let blobs: Map<string, string>;
  const handler: Handler = (req, res) => (routes ? routes(req, res) : Promise.resolve(false));

  before(async () => {
    db = await startTestDb();
    server = await startServer([handler], { port: 0 });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await routes?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.stop();
  });
  beforeEach(async () => {
    await routes?.close();
    await db.pool.query('truncate item, backlog_source, "user", override cascade');
    fake = fakeBacklog();
    host = fakeRepoHost();
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    blobs = new Map();
    routes = dashboardRoutes({
      pool: db.pool, auth: createAuth({ mode: "azure" }), origin, adapter: fake.adapter, sourceId, repoHost: host, env: {},
      readBlob: async (path) => blobs.get(path) ?? null,
    });
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

  test("Next up follows the scheduler's brake: at capacity, a fresh Queued item isn't next", async () => {
    await person("octo", "viewer");
    for (let n = 0; n < 3; n++) await item("InReview", `review ${n}`);
    const fresh = await item("Queued", "fresh item");
    await db.pool.query("update item set backlog_rank = 1 where id = $1", [fresh.id]);
    const back = await item("Queued", "item back to address");
    await db.pool.query("update item set backlog_rank = 2 where id = $1", [back.id]);
    const run = (await db.pool.query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, 'address') returning id", [back.id])).rows[0].id;
    await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'green', 1, 'passed')", [run]);
    const { html } = await get("/", "octo");
    const next = html.slice(html.indexOf(">Next up<"), html.indexOf("<h2", html.indexOf(">Next up<")));
    assert.ok(next.includes("item back to address<"));
    assert.ok(!next.includes("fresh item<"), "a fresh item shows as next while the brake is on");
  });

  test("Not ready shows an engine rule's reason and a dor.md line's criterion", async () => {
    await person("octo", "viewer");
    const { id } = await item("NotReady", "held back");
    await db.pool.query(
      `insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values
       ($1, 'dor', 'repo', 0, 'engine rule', 'failed', 'The item depends on #7, which is still open'),
       ($1, 'dor', 'repo', 1, 'Has a Size of 5 or less', 'failed', 'Size is 8')`, [id],
    );
    const { html } = await get("/", "octo");
    const view = html.slice(html.indexOf(">Not ready<"), html.indexOf("<h2", html.indexOf(">Not ready<")));
    assert.ok(view.includes("The item depends on #7, which is still open"), view);
    assert.ok(view.includes("Has a Size of 5 or less"), view);
    assert.ok(!view.includes("engine rule"), view);
  });

  test("an item with two open questions counts and lists once", async () => {
    await person("octo", "viewer");
    const { id } = await item("NeedsInput", "two questions");
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'needs_input', 'q1'), ($1, 'needs_input', 'q2')", [id]);
    const { html } = await get("/", "octo");
    assert.match(html, /1 of 3 waiting/);
    assert.equal(html.split("two questions<").length - 1, 2, "listed in Waiting on you and In flight only");
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
    host.files.set("octo/repo@sc1:features/x.feature", "@pbi-1\nFeature: x\n\n  @ac-1\n  Scenario: Other months are left out\n    Given a\n\n  @ac-1 @db @regression\n  Scenario Outline: A month with no invoices\n    Given b\n");
    const { html } = await get(`/items/${id}`, "octo");
    const view = html.slice(html.indexOf("Criteria and their scenarios"));
    assert.ok(view.indexOf("Other months are left out") < view.indexOf("Keeps the currency"));
    assert.match(view, /A month with no invoices <strong>expected to pass at Red<\/strong>/);
    assert.match(view, /Other months are left out<\/li>/);
    assert.match(view, /Keeps the currency <strong>no scenario<\/strong>/);
    assert.match(html, /<label for="note">/);
  });

  test("the sign-off view marks every scenario of a feature tagged @regression", async () => {
    await person("octo", "viewer");
    const { id } = await item("SignOff", "to sign", { repo: "octo/repo", criteria: ["Exports one month"] });
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha, locked_files) values ($1, 1, 'sign-off', 'sc1', '{features/x.feature}')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    host.files.set("octo/repo@sc1:features/x.feature", "@pbi-1 @regression\nFeature: x\n\n  @ac-1\n  Scenario: Other months are left out\n    Given a\n");
    assert.match((await get(`/items/${id}`, "octo")).html, /Other months are left out <strong>expected to pass at Red<\/strong>/);
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

  test("a path with dot segments never signs in or reaches a dashboard route", async () => {
    await person("po", "owner", true);
    const { id } = await item("SignOff");
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, 'sign-off', 'abc')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    // fetch normalises dot segments before sending, so this goes through node:http with the raw path.
    const port = (server.address() as AddressInfo).port;
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...as("po"), origin, "content-type": "application/x-www-form-urlencoded" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end("decision=approve");
      });
    for (const path of [`/webhooks/github/%2e%2e/%2e%2e/items/${id}/signoff`, `/items/%2e/${id}/signoff`, `/x/../items/${id}/signoff`]) {
      const status = await raw(path);
      assert.ok(status === 400 || status === 404, `${path} got ${status}`);
    }
    assert.equal((await db.pool.query("select decision from question where item_id = $1", [id])).rows[0].decision, null);
  });

  test("open event streams share one connection, so the rest of the dashboard keeps working, and events reach them", async () => {
    await person("octo", "viewer");
    const aborts = Array.from({ length: 12 }, () => new AbortController());
    const streams = await Promise.all(aborts.map((a) => fetch(`${origin}/events`, { headers: as("octo"), signal: a.signal })));
    try {
      assert.ok(streams.every((s) => s.status === 200));
      assert.equal((await get("/", "octo")).status, 200);
      const reader = streams[0].body!.getReader();
      await db.pool.query("select pg_notify('factory_events', '{\"id\":\"e1\"}')");
      let text = "";
      while (!text.includes("data:")) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /data: \{"id":"e1"\}/);
    } finally {
      for (const a of aborts) a.abort();
    }
  });

  test("a dropped listener connection ends the streams without crashing, and a new stream listens again", async () => {
    await person("octo", "viewer");
    const first = await fetch(`${origin}/events`, { headers: as("octo") });
    const reader = first.body!.getReader();
    await reader.read();
    // Kill the listener's backend, as a Postgres restart or an idle-connection kill would.
    await db.pool.query("select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen factory_events'");
    while (!(await reader.read()).done);
    const again = new AbortController();
    const second = await fetch(`${origin}/events`, { headers: as("octo"), signal: again.signal });
    try {
      const r = second.body!.getReader();
      await db.pool.query("select pg_notify('factory_events', '{\"id\":\"e2\"}')");
      let text = "";
      while (!text.includes("data:")) text += new TextDecoder().decode((await r.read()).value);
      assert.match(text, /"id":"e2"/);
    } finally {
      again.abort();
    }
  });

  test("Floor reloads itself from the event stream", async () => {
    await person("octo", "viewer");
    assert.match((await get("/", "octo")).html, /new EventSource\("\/events"\)/);
  });

  test("Run detail shows the signed-off feature files at the lock sha", async () => {
    await person("octo", "viewer");
    const { id } = await item("InProgress", "locked", { repo: "octo/repo" });
    await db.pool.query("insert into run (item_id, run_number, next_stage, features_lock_sha, locked_files) values ($1, 1, 'green', 'lock1', '{features/a.feature}')", [id]);
    host.files.set("octo/repo@lock1:features/a.feature", "Feature: Export <invoices>\n  Scenario: one month\n");
    const { html } = await get(`/items/${id}`, "octo");
    assert.match(html, /Signed-off scenarios/);
    assert.match(html, /<h3>features\/a\.feature<\/h3><pre>Feature: Export &lt;invoices&gt;/);
  });

  test("an item withdrawn while waiting for sign-off shows no sign-off form", async () => {
    await person("octo", "viewer");
    const { id } = await item("Abandoned");
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    await db.pool.query(`insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'poller', $1, 'transition', '{"from":"SignOff","to":"Abandoned","event":"withdrawn"}')`, [id]);
    assert.doesNotMatch((await get(`/items/${id}`, "octo")).html, /\/signoff/);
  });

  test("a GitHub login another user holds in any case is refused with 400", async () => {
    await person("boss", "owner");
    await person("Octo", "viewer");
    assert.equal((await post("/users", "boss", "provider=google&subject=g1&role=viewer&github_login=octo")).status, 400);
  });

  test("a form body over 1 MiB gets 413", async () => {
    await person("boss", "owner");
    assert.equal((await post("/users", "boss", `provider=google&subject=${"x".repeat(1024 * 1024 + 1)}&role=viewer`)).status, 413);
  });

  test("only an owner can add people", async () => {
    await person("op", "operator");
    await person("boss", "owner");
    assert.equal((await post("/users", "op", "provider=google&subject=g1&role=viewer")).status, 403);
    assert.equal((await post("/users", "boss", "provider=google&subject=g1&role=viewer")).status, 303);
    assert.equal((await post("/users", "boss", "provider=github&subject=g2&role=viewer")).status, 400);
    assert.equal((await db.pool.query(`select count(*)::int as n from "user" where provider = 'google'`)).rows[0].n, 1);
  });

  // ---- PBI 15b (#89) ----

  /** A Cucumber Messages report with one scenario per name, each tagged with `tag`. */
  const report = (tag: string, results: Record<string, "PASSED" | "FAILED">) => Object.entries(results).flatMap(([name, status], i) => [
    { pickle: { id: `${tag}p${i}`, name, tags: [{ name: tag }], steps: [{ id: `${tag}s${i}`, type: "Outcome", text: "it works" }] } },
    { testCase: { id: `${tag}c${i}`, pickleId: `${tag}p${i}`, testSteps: [{ id: `${tag}t${i}`, pickleStepId: `${tag}s${i}` }] } },
    { testCaseStarted: { id: `${tag}r${i}`, testCaseId: `${tag}c${i}` } },
    { testStepFinished: { testCaseStartedId: `${tag}r${i}`, testStepId: `${tag}t${i}`, testStepResult: { status } } },
  ].map((m) => JSON.stringify(m))).join("\n") + "\n";
  const overrides = async () => (await db.pool.query("select scope, target_id, kind, reason from override where cleared_at is null order by created_at")).rows;

  test("a viewer can't post an override, and an operator's needs a known kind and a reason", async () => {
    await person("viewer", "viewer");
    await person("op", "operator");
    assert.equal((await post("/overrides", "viewer", "kind=pause&reason=lunch")).status, 403);
    assert.equal((await post("/overrides", "op", "kind=pause&reason=+")).status, 400);
    assert.equal((await post("/overrides", "op", "kind=launch&reason=x")).status, 400);
    assert.deepEqual(await overrides(), []);
  });

  test("an operator's factory and item overrides are recorded with their reason", async () => {
    const op = (await person("op", "operator")).rows[0].id;
    const { id } = await item("InProgress", "busy");
    assert.equal((await post("/overrides", "op", "kind=drain&reason=release+day")).status, 303);
    const r = await post("/overrides", "op", `kind=hold&reason=checking&itemId=${id}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), `/items/${id}`);
    assert.equal((await post("/overrides", "op", "kind=hold&reason=checking")).status, 400, "an item override names its item");
    assert.equal((await post("/overrides", "op", `kind=pause&reason=x&itemId=${id}`)).status, 400, "a factory override names none");
    assert.deepEqual(await overrides(), [
      { scope: "factory", target_id: null, kind: "drain", reason: "release day" },
      { scope: "item", target_id: id, kind: "hold", reason: "checking" },
    ]);
    assert.equal((await db.pool.query("select count(*)::int as n from override where created_by = $1", [op])).rows[0].n, 2);
  });

  test("Re-queue needs a reason, only a Failed or Abandoned item takes it, and the next tick moves it back to Queued", async () => {
    await person("op", "operator");
    const failed = await item("Failed", "broke");
    const busy = await item("InProgress", "busy");
    assert.match((await get(`/items/${failed.id}`, "op")).html, /<input[^>]*name="reason"[^>]*required[\s\S]*Re-queue/);
    assert.doesNotMatch((await get(`/items/${busy.id}`, "op")).html, /Re-queue/);
    assert.equal((await post("/overrides", "op", `kind=requeue&reason=&itemId=${failed.id}`)).status, 400);
    assert.equal((await post("/overrides", "op", `kind=requeue&reason=retry&itemId=${busy.id}`)).status, 409);
    assert.equal((await post("/overrides", "op", `kind=requeue&reason=retry&itemId=${failed.id}`)).status, 303);
    // No WIP, so the tick applies the re-queue and starts nothing.
    await db.pool.query("update wip_policy set current_wip = 0");
    try {
      await tick({ pool: db.pool, launcher: fakeLauncher(), now: new Date(), killFlag: false, repoHost: host, backlogFor: () => fake.adapter,
        secret: "s", controlUrl: "http://control", sopVersion: "0.1.0" });
    } finally {
      await db.pool.query("update wip_policy set current_wip = 1");
    }
    assert.equal((await db.pool.query("select state from item where id = $1", [failed.id])).rows[0].state, "Queued");
  });

  test("Floor badges an item's active override, not an expired one, and shows the factory's pause", async () => {
    await person("op", "operator");
    const held = await item("InProgress", "held item");
    const stale = await item("InProgress", "stale item");
    await db.pool.query("insert into override (scope, target_id, kind, reason) values ('item', $1, 'hold', 'x')", [held.id]);
    await db.pool.query("insert into override (scope, target_id, kind, reason, expires_at) values ('item', $1, 'hold', 'x', now() - interval '1 minute')", [stale.id]);
    await db.pool.query("insert into override (scope, kind, reason) values ('factory', 'pause', 'lunch')");
    const { html } = await get("/", "op");
    const row = (title: string) => html.slice(html.indexOf(title), html.indexOf("</tr>", html.indexOf(title)));
    assert.match(row("held item"), />override</);
    assert.doesNotMatch(row("stale item"), />override</);
    assert.match(html, /Paused: lunch/);
    assert.match(html, /<form method="post" action="\/overrides">/);
  });

  // PBI 140: Prepare restart is a factory override, logged like any, and Floor counts down its wrap-up until no cell runs.
  test("an operator prepares a restart with a reason, and Floor counts its wrap-up down until no cell runs", async (t) => {
    await person("op", "operator");
    const logged = t.mock.method(console, "log", () => {});
    assert.equal((await post("/overrides", "op", "kind=restart&reason=")).status, 400);
    assert.equal((await post("/overrides", "op", "kind=restart&reason=upgrading+Docker")).status, 303);
    assert.deepEqual(await overrides(), [{ scope: "factory", target_id: null, kind: "restart", reason: "upgrading Docker" }]);
    assert.ok(logged.mock.calls.some((c) => /override: op set the factory restart: "upgrading Docker"/.test(String(c.arguments[0]))));
    await db.pool.query("update override set created_at = now() - interval '6 minutes' where kind = 'restart'");
    const busy = await item("InProgress", "busy");
    await db.pool.query("update item set lease_expires = now() + interval '4 minutes' where id = $1", [busy.id]);
    assert.match((await get("/", "op")).html, /Preparing to restart: 1 cell is wrapping up, with 9 minutes left/);
    await db.pool.query("update item set state = 'Queued', lease_expires = null where id = $1", [busy.id]);
    const ready = (await get("/", "op")).html;
    assert.match(ready, /Ready to restart\. No cell is running/);
    assert.doesNotMatch(ready, /Preparing to restart/);
  });

  test("Floor shows an in-flight item's newest agent message", async () => {
    await person("octo", "viewer");
    const { id } = await item("InProgress", "talking item");
    const run = (await db.pool.query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green') returning id", [id])).rows[0].id;
    await db.pool.query(
      `insert into stage_run (run_id, stage_id, attempt, status, message, started_at, ended_at) values
       ($1, 'red', 1, 'passed', 'Wrote the <stubs>', now() - interval '2 hours', now() - interval '1 hour'),
       ($1, 'green', 1, 'failed', '', now() - interval '50 minutes', now() - interval '30 minutes'),
       ($1, 'green', 2, 'started', null, now() - interval '20 minutes', null)`, [run],
    );
    const { html } = await get("/", "octo");
    const row = html.slice(html.indexOf("talking item"), html.indexOf("</tr>", html.indexOf("talking item")));
    assert.ok(row.includes("Wrote the &lt;stubs&gt;"), row);
  });

  test("Run detail shows each of the item's scenarios with its red and green verdict, and links each transcript", async () => {
    await person("octo", "viewer");
    const { id, ext } = await item("InReview", "evidence");
    const run = (await db.pool.query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, 'address') returning id", [id])).rows[0].id;
    await db.pool.query(
      `insert into stage_run (run_id, stage_id, attempt, status, report_ref, transcript_ref, started_at) values
       ($1, 'red', 1, 'passed', $2, $3, now() - interval '2 hours'), ($1, 'green', 1, 'passed', $4, null, now() - interval '1 hour')`,
      [run, `reports/${run}/red-1.ndjson`, `transcripts/${run}/red-1.jsonl`, `reports/${run}/green-1.ndjson`],
    );
    blobs.set(`reports/${run}/red-1.ndjson`, report(`@pbi-${ext}`, { "Exports one month": "FAILED" }) + report("@pbi-other", { "Someone else's": "PASSED" }));
    blobs.set(`reports/${run}/green-1.ndjson`, report(`@pbi-${ext}`, { "Exports one month": "PASSED" }));
    blobs.set(`transcripts/${run}/red-1.jsonl`, '{"type":"assistant"}\n');
    const { html } = await get(`/items/${id}`, "octo");
    assert.match(html, /<td>Exports one month<\/td><td>red<\/td><td>green<\/td>/);
    assert.doesNotMatch(html, /Someone else/);
    assert.ok(html.includes(`<a href="/blobs/transcripts/${run}/red-1.jsonl">`), "transcript link");
    const t = await fetch(`${origin}/blobs/transcripts/${run}/red-1.jsonl`, { headers: as("octo") });
    assert.equal(t.status, 200);
    assert.equal(await t.text(), '{"type":"assistant"}\n');
    assert.equal((await fetch(`${origin}/blobs/transcripts/${run}/missing-1.jsonl`, { headers: as("octo") })).status, 404);
    assert.equal((await fetch(`${origin}/blobs/secrets/${run}/red-1.jsonl`, { headers: as("octo") })).status, 404);
    assert.equal((await fetch(`${origin}/blobs/transcripts/${run}/red-1.jsonl`)).status, 401);
  });

  test("/phase0 lists each merged run with its own cost and tier, under the count, total and mean", async () => {
    await person("octo", "viewer");
    const { id } = await item("Done", "merged twice");
    for (const [n, cost, tier, startedHoursAgo] of [[1, "1.50", "Low", 9], [2, "2.50", "High", 3], [3, "4.00", null, 2]] as const) {
      const r = (await db.pool.query<{ id: string }>(
        `insert into run (item_id, run_number, pr_url, merge_sha, risk_tier, tier_reasons, started_at)
         values ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7)) returning id`,
        [id, n, `https://github.com/o/r/pull/${n}`, n === 3 ? null : `sha${n}`, tier, tier ? [`reason ${n}`] : null, startedHoursAgo],
      )).rows[0].id;
      await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status, cost_usd) values ($1, 'green', 1, 'passed', $2)", [r, cost]);
    }
    // Run 1 merged 6 hours ago, run 2 an hour ago. The first merge after a run started is that run's.
    await db.pool.query(
      `insert into event (actor, actor_id, item_id, kind, payload, at) values
       ('system', 'github', $1, 'transition', '{"from":"InReview","to":"Accepted","event":"merged"}', now() - interval '6 hours'),
       ('system', 'github', $1, 'transition', '{"from":"InReview","to":"Accepted","event":"merged"}', now() - interval '1 hour')`, [id],
    );
    const { status, html } = await get("/phase0", "octo");
    assert.equal(status, 200);
    assert.match(html, /2 merged PRs, \$4\.00 in all, \$2\.00 each on average/);
    const one = html.indexOf("https://github.com/o/r/pull/1");
    const two = html.indexOf("https://github.com/o/r/pull/2");
    assert.ok(one > 0 && two > one, "oldest merge first");
    assert.ok(!html.includes("https://github.com/o/r/pull/3"), "an unmerged run isn't listed");
    for (const want of ["$1.50", "Low", "reason 1", "$2.50", "High", "reason 2"]) assert.ok(html.includes(want), `${want} missing`);
  });

  test("/activity lists the 100 newest events, newest first, with only their states and event from the payload", async () => {
    await person("octo", "viewer");
    const { id } = await item("Queued", "Export a month");
    await db.pool.query(
      `insert into event (actor, actor_id, item_id, kind, payload, at)
       select 'system', 'unit', $1, 'transition', jsonb_build_object('from', 'Eligible', 'to', 'NotReady', 'event', 'readiness_failed', 'detail', 'secret-' || n),
         timestamptz '2026-11-07 08:00Z' + make_interval(mins => n)
       from generate_series(1, 105) n`, [id],
    );
    const { status, html } = await get("/activity", "octo");
    assert.equal(status, 200);
    const times = [...html.matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(times.length, 100);
    assert.equal(times[0], "2026-11-07T09:45:00.000Z");
    assert.equal(times[99], "2026-11-07T08:06:00.000Z");
    assert.ok(!html.includes("secret-"), "a payload field other than from, to and event reached the page");
    assert.equal((await fetch(`${origin}/activity`)).status, 401);
  });
});
