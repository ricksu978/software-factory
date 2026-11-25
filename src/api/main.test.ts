import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { cleanPath, main, MAX_JSON, MAX_WEBHOOK, startApi, type Api } from "./main.ts";

describe("the API at startup", () => {
  test("names every setting it lacks, before it connects or listens", async () => {
    await assert.rejects(main({}), /FACTORY_DB_URI, FACTORY_BLOB, OIDC_ISSUER, API_AUDIENCE, GITHUB_WEBHOOK_SECRET are not set/);
  });

  test("refuses a PORT that isn't a port", async () => {
    const env = { FACTORY_DB_URI: "postgres://x@127.0.0.1:1/x", FACTORY_BLOB: "b", OIDC_ISSUER: "http://i", API_AUDIENCE: "a", GITHUB_WEBHOOK_SECRET: "s", PORT: "web" };
    await assert.rejects(main(env), /PORT web isn't a port/);
  });
});

describe("the API's raw-path guard", () => {
  test("refuses the dashboard routing test's dot-segment paths, encoded separators in either case, and spelled-out routes", () => {
    for (const path of [
      "/webhooks/github/%2e%2e/%2e%2e/v1/items/x/decisions", "/v1/items/%2e/x/decisions", "/x/../v1/items/x/decisions", "/v1/./items",
      "/v1/items%2fx", "/v1/items%2Fx", "/v1/items%5cx", "/v1/items%5Cx", "/v1/%2E%2E/floor", "/v1//../floor",
      "/%761/floor", "/v1/items/x/decisi%6fns", "/v1/overrid%65s", "/webhooks/githu%62", "/v1/%", "/v1/%E2",
    ]) assert.equal(cleanPath(path), false, path);
  });

  test("takes a path that is already its normalised form", () => {
    for (const path of ["/", "/v1/floor", "/v1/items/00000000-0000-4000-8000-000000000001/decisions", "/webhooks/github"]) {
      assert.equal(cleanPath(path), true, path);
    }
  });
});

describe("the API", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let issuerServer: Server;
  let issuer: string;
  let key: CryptoKey;
  let api: Api;
  let base: string;
  let port: number;
  const itemId = "00000000-0000-4000-8000-000000000001";

  before(async () => {
    db = await startTestDb();
    const pair = await generateKeyPair("RS256", { extractable: true });
    key = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" };
    issuerServer = createServer((req, res) => {
      const send = (b: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (req.url?.endsWith("/.well-known/openid-configuration")) send({ issuer, jwks_uri: `${issuer}/certs` });
      else send({ keys: [jwk] });
    });
    await new Promise<void>((r) => issuerServer.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}/realm`;
    const source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'api-test') returning id")).rows[0].id;
    await db.pool.query("insert into item (id, source_id, external_id, title, state) values ($1, $2, '1', 'one', 'InProgress')", [itemId, source]);
    for (const [name, role] of [["vera", "viewer"], ["otto", "operator"], ["olga", "owner"]]) {
      await db.pool.query(`insert into "user" (issuer, subject, role, github_login) values ($1, $2, $3, $2)`, [issuer, name, role]);
    }
    api = await startApi({ pool: db.pool, issuer, audience: "factory-api", webhookSecret: "s", readBlob: async () => null, env: {} }, 0);
    port = (api.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await api?.stop();
    await new Promise<void>((r) => issuerServer.close(() => r()));
    await db?.stop();
  });

  const token = (sub: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(issuer).setAudience("factory-api").setSubject(sub)
      .setIssuedAt(now).setExpirationTime(now + 300).sign(key);
  };
  const as = async (sub: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${await token(sub)}`, "content-type": "application/json", ...init.headers } });

  /** Sends `path` exactly as written, which fetch would normalise. */
  const raw = (path: string) => new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject).end();
  });

  test("a path whose dot segments or encoding normalise to another is refused", async () => {
    assert.equal(await raw("/v1/x/../floor"), 400);
    assert.equal(await raw("/v1/items%2fx"), 400);
    assert.equal(await raw("/v1/%2e%2e/floor"), 400);
    assert.equal(await raw("/v1/floor"), 401, "a clean path reaches the bearer check");
  });

  test("a path that spells part of a route in percent-encoding is refused, as is one with a broken escape", async () => {
    for (const path of ["/%761/floor", "/v1/flo%6fr", "/v1/item%73/x", "/%77ebhooks/github", "/v1/items/%E2%82%AC", "/v1/items/%zz", "/v1/items/%E2"]) {
      assert.equal(await raw(path), 400, path);
    }
    assert.equal(await raw("/v1/floor?x=%2e%2e%2f"), 401, "the query string doesn't count");
  });

  test("a 401 tells the caller to bring a bearer token", async () => {
    const r = await fetch(`${base}/v1/floor`);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
  });

  test("the floor has no token banner or heartbeat when neither is known", async () => {
    const b = await (await as("vera", "/v1/floor")).json();
    assert.equal(b.claudeToken, null);
    assert.equal(b.workerHeartbeat, null);
    assert.equal(b.canOperate, false);
  });

  test("an unknown item or one that isn't an id is 404", async () => {
    assert.equal((await as("vera", "/v1/items/00000000-0000-4000-8000-000000000999")).status, 404);
    assert.equal((await as("vera", "/v1/items/nope")).status, 404);
  });

  test("the floor carries each claim key by item id, as JSON can", async () => {
    const b = await (await as("vera", "/v1/floor")).json();
    assert.equal(typeof b.keys, "object");
    assert.ok(!Array.isArray(b.keys));
  });

  test("Run detail carries what the SPA's page shows, with override buttons only for an operator", async () => {
    const run = (await db.pool.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage, scenarios_sha, features_lock_sha, acceptance_criteria, started_at)
       values ($1, 1, 'green', 'aaa', 'aaa', '{"Search finds a title"}', now()) returning id`, [itemId],
    )).rows[0].id;
    await db.pool.query(
      "insert into run_file (run_id, path, sha, text) values ($1, 'features/pbi-1.feature', 'aaa', $2)", [run, "Feature: Search\n  @ac-1\n  Scenario: By title\n"],
    );
    await db.pool.query(
      `insert into stage_run (run_id, stage_id, attempt, model, status, tokens_in, tokens_out, restates)
       values ($1, 'green', 1, 'opus', 'started', 1200, 80, '[{"round":1,"reason":"cut off"}]')`, [run],
    );
    try {
      const viewer = await (await as("vera", `/v1/items/${itemId}`)).json();
      assert.equal(viewer.controls, null);
      assert.equal(viewer.run.open, true);
      assert.equal(viewer.run.acceptance_criteria[0], "Search finds a title");
      assert.deepEqual(viewer.stages.map((s: Record<string, unknown>) => [s.model, s.tokens_in, s.tokens_out]), [["opus", 1200, 80]]);
      assert.deepEqual(viewer.stages[0].restates, [{ round: 1, reason: "cut off" }]);
      assert.deepEqual(viewer.features.map((f: { path: string }) => f.path), ["features/pbi-1.feature"], "the signed-off files are the lock sha's");
      assert.deepEqual(viewer.pending, [], "no file is up for sign-off while the item isn't waiting for it");
      assert.equal(viewer.criteria, null);
      assert.deepEqual(viewer.verdicts, []);
      assert.equal(viewer.linkBlobs, true);
      assert.deepEqual(viewer.splitInto, []);
      for (const k of ["startNow", "moveEnded", "claim", "recheck", "fixingCi", "scope"]) assert.ok(k in viewer, `no ${k}`);
      const operator = await (await as("otto", `/v1/items/${itemId}`)).json();
      assert.deepEqual(operator.controls, { held: false, stoppable: true, requeueable: false, startable: false, movable: false });
      await db.pool.query("update item set state = 'SignOff' where id = $1", [itemId]);
      const signing = await (await as("vera", `/v1/items/${itemId}`)).json();
      assert.deepEqual(signing.pending.map((f: { text: string }) => f.text), ["Feature: Search\n  @ac-1\n  Scenario: By title\n"]);
      assert.deepEqual(signing.criteria, [{ criterion: "Search finds a title", scenarios: [{ name: "By title", regression: false }] }]);
    } finally {
      await db.pool.query("update item set state = 'InProgress' where id = $1", [itemId]);
      await db.pool.query("delete from stage_run where run_id = $1", [run]);
      await db.pool.query("delete from run_file where run_id = $1", [run]);
      await db.pool.query("delete from run where id = $1", [run]);
    }
  });

  test("a blob path outside the stored patterns is 404", async () => {
    assert.equal((await as("vera", "/v1/blobs/secrets/key.txt")).status, 404);
  });

  test("the activity log lists events newest first, without what the page hides", async () => {
    await db.pool.query(
      `insert into event (at, actor, actor_id, item_id, kind, payload) values
         ('2026-11-19T09:00:00Z', 'system', 'test', $1, 'transition', '{"from":"Queued","to":"InProgress","event":"claimed","detail":"hidden-detail"}'),
         ('2026-11-19T09:10:00Z', 'human', 'test', $1, 'decision', '{"text":"hidden-text","from":"A","to":"B"}')`, [itemId]);
    const r = await as("vera", "/v1/activity");
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes("hidden-detail") && !text.includes("hidden-text"), text);
    const { events } = JSON.parse(text) as { events: { kind: string; from: string | null; event: string | null }[] };
    const mine = events.filter((e) => e.kind === "transition" || e.kind === "decision");
    assert.deepEqual(mine.map((e) => [e.kind, e.from, e.event]), [["decision", null, null], ["transition", "Queued", "claimed"]]);
  });

  test("/v1/events streams server-sent events", async () => {
    const ctl = new AbortController();
    const r = await as("vera", "/v1/events", { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = r.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /: open/);
    await db.pool.query("select pg_notify('factory_events', '{\"kind\":\"test\"}')");
    let seen = "";
    while (!seen.includes("data:")) seen += new TextDecoder().decode((await reader.read()).value);
    assert.match(seen, /data: \{"kind":"test"\}/);
    ctl.abort();
  });

  test("a body over its cap is 413, for the webhook and for a /v1 route", async () => {
    // Sends `n` bytes chunked, with no content-length, and resolves with the status however early the API answers.
    // Each goes on its own connection, since one the API answers before reading its body can't be reused.
    const streamed = (path: string, n: number, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      }).on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < n) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    assert.equal(await streamed("/webhooks/github", MAX_WEBHOOK + 1), 413);
    const hook = await streamed("/webhooks/github", 0).catch(() => 0);
    assert.notEqual(hook, 413, "an empty delivery is checked by its signature, not refused for its size");
    const authorization = `Bearer ${await token("otto")}`;
    assert.equal(await streamed("/v1/overrides", MAX_JSON + 1, { authorization, "content-type": "application/json" }), 413);
    const json = await fetch(`${base}/v1/overrides`, {
      method: "POST", headers: { authorization, "content-type": "application/json", connection: "close" },
      body: `{"kind":"pause","reason":"${"x".repeat(MAX_JSON)}"}`,
    });
    assert.equal(json.status, 413);
    assert.match((await json.json()).error, /over 1 MiB/);
    const anon = await streamed("/v1/overrides", MAX_JSON + 1);
    assert.equal(anon, 401, "an unauthenticated caller is refused before the size matters");
  });

  test("an override needs a known kind, a reason, and for a WIP pin a whole limit", async () => {
    const post = (b: unknown) => as("otto", "/v1/overrides", { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ kind: "explode", reason: "r" })).status, 400);
    assert.equal((await post({ kind: "pause", reason: " " })).status, 400);
    assert.equal((await post({ kind: "wip", value: 0, reason: "r" })).status, 400);
    assert.equal((await post({ kind: "wip", value: 2.5, reason: "r" })).status, 400);
    assert.equal((await as("otto", "/v1/overrides", { method: "POST", body: "{" })).status, 400);
    assert.equal((await post({ kind: "requeue", itemId, reason: "r" })).status, 409, "an InProgress item isn't re-queued");
  });

  test("an item override refuses Start now on an InProgress item and moves a Queued one through the queue", async () => {
    const post = (b: unknown) => as("otto", "/v1/overrides", { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ kind: "start_now", itemId, reason: "r" })).status, 409, "an InProgress item can't be started now");
    assert.equal((await post({ kind: "move_up", itemId, reason: "r" })).status, 409, "an InProgress item isn't in the queue");
    const source = (await db.pool.query<{ source_id: string }>("select source_id from item where id = $1", [itemId])).rows[0].source_id;
    const [a, b] = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
    await db.pool.query("insert into item (id, source_id, external_id, title, state) values ($1, $3, 'q1', 'q1', 'Queued'), ($2, $3, 'q2', 'q2', 'Queued')", [a, b, source]);
    try {
      assert.equal((await post({ kind: "move_up", itemId: b, reason: "first" })).status, 201);
      const moves = (await db.pool.query("select kind, value from override where target_id = $1 and cleared_at is null", [b])).rows;
      assert.equal(moves.length, 1);
      assert.equal(moves[0].kind, "move_up");
      assert.ok(moves[0].value, "a move keeps its new queue key");
    } finally {
      await db.pool.query("delete from override where target_id = any($1)", [[a, b]]);
      await db.pool.query("delete from item where id = any($1)", [[a, b]]);
    }
  });

  test("a second WIP pin replaces the first", async () => {
    for (const value of [2, 4]) {
      assert.equal((await as("otto", "/v1/overrides", { method: "POST", body: JSON.stringify({ kind: "wip", value, reason: "pin" }) })).status, 201);
    }
    const pins = (await db.pool.query("select value from override where kind = 'wip' and cleared_at is null")).rows;
    assert.deepEqual(pins.map((p) => p.value), [4]);
  });

  test("a decision on an item that isn't waiting for it is 409, and an unknown kind is 400", async () => {
    const post = (b: unknown) => as("otto", `/v1/items/${itemId}/decisions`, { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ kind: "answer", text: "x" })).status, 409);
    assert.equal((await post({ kind: "maybe" })).status, 400);
  });

  test("an owner can't add a user without an http issuer, or with a login someone has", async () => {
    const post = (b: unknown) => as("olga", "/v1/users", { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ issuer: "ftp://x", subject: "n", role: "viewer" })).status, 400);
    assert.equal((await post({ issuer, subject: "n", role: "king" })).status, 400);
    assert.equal((await post({ issuer, subject: "nora", role: "viewer", github_login: "VERA" })).status, 409);
  });

  test("an owner changing a user's role keeps one row", async () => {
    const post = (role: string) => as("olga", "/v1/users", { method: "POST", body: JSON.stringify({ issuer, subject: "nick", role }) });
    assert.equal((await post("viewer")).status, 201);
    assert.equal((await post("operator")).status, 201);
    assert.deepEqual((await db.pool.query(`select role from "user" where subject = 'nick'`)).rows, [{ role: "operator" }]);
  });
});
