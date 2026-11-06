import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "./adapters/fake.ts";
import { createAuth } from "./http/auth.ts";
import { startServer } from "./http/server.ts";
import { controlHandlers } from "./main.ts";
import { dbTest, startTestDb } from "./store/test-db.ts";

/** Starts src/main.ts with only `env` (and PATH, so node runs), and returns how it ended. */
const start = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["src/main.ts"], { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env }, encoding: "utf8", timeout: 60_000 });

describe("main.ts at startup", () => {
  test("the dev identity guard refuses each case before anything starts", () => {
    for (const env of [
      { FACTORY_DEV_LOGIN: "octo" } as Record<string, string>,
      { FACTORY_ENV: "local" },
      { FACTORY_ENV: "local", FACTORY_DEV_LOGIN: "octo", CONTAINER_APP_NAME: "ca-factory-control" },
    ]) {
      const r = start(env);
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.match(r.stderr, /FACTORY_ENV|FACTORY_DEV_LOGIN/, JSON.stringify(env));
      assert.doesNotMatch(r.stdout, /dev-login/);
    }
  });

  test("Azure mode refuses to start, naming what it still lacks", () => {
    const r = start({});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Azure mode/);
  });

  test("locally it logs this start's sign-in link, on the port the dashboard answers on", () => {
    const r = start({ FACTORY_ENV: "local", FACTORY_DEV_LOGIN: "octo", CELL_CONTROL_URL: "http://host.docker.internal:7999" });
    assert.match(r.stdout, /http:\/\/localhost:7999\/dev-login\?token=[0-9a-f]{64}\b/);
    // Nothing else is set here, so it stops after the link and names the first missing variable.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not set/);
  });
});

describe("control plane handlers", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let server: Server;
  let control: ReturnType<typeof controlHandlers>;
  let fake: ReturnType<typeof fakeBacklog>;
  let sourceId: string;
  const secret = "webhook-secret";

  before(async () => {
    db = await startTestDb();
    fake = fakeBacklog();
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'main') returning id")).rows[0].id;
    control = controlHandlers({
      pool: db.pool, local: true, auth: createAuth({ mode: "local", devLogin: "octo" }), origin: "http://localhost:7400",
      sources: [{ id: sourceId, adapter: fake.adapter }], repoHost: fakeRepoHost(), sopVersion: "0.1.0", secret: "cell-secret",
      webhookSecret: secret, claudeToken: "unused", uploadUrl: async (path) => `http://blob.test/${path}`, readBlob: async () => null,
    });
    server = await startServer(control.handlers, { port: 0 });
  });
  after(async () => {
    await control.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.stop();
  });

  test("an /approve comment that arrives as a signed GitHub webhook signs off the scenarios", async () => {
    const ext = await fake.seed({ title: "t", repo: "octo/repo", acceptanceCriteria: ["it works"] });
    const item = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't', 'SignOff') returning id", [sourceId, ext])).rows[0].id;
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, 'sign-off', 'abc')", [item]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [item]);
    await db.pool.query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', 'po', 'Pat', 'operator', true)`);
    const body = Buffer.from(JSON.stringify({
      action: "created", repository: { full_name: "octo/repo" }, issue: { number: Number(ext) },
      comment: { id: 99, body: "/approve looks right", user: { login: "pat", type: "User" } },
    }));
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST", body,
      headers: {
        "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
    assert.equal(r.status, 204);
    // The comment is applied after the 204, so wait for it.
    let decision: string | null = null;
    for (let i = 0; i < 50 && !decision; i++) {
      decision = (await db.pool.query("select decision from question where item_id = $1", [item])).rows[0].decision;
      if (!decision) await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(decision, "approve");
    assert.match((await fake.comments(ext))[0], /signed off/);
  });

  test("a webhook with a wrong signature gets 401, and the cell API answers before the dashboard", async () => {
    const port = (server.address() as AddressInfo).port;
    const hook = await fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00", "x-github-delivery": "d" } });
    assert.equal(hook.status, 401);
    const cell = await fetch(`http://127.0.0.1:${port}/internal/cells/${randomUUID()}/lease`, { method: "POST", body: "{}" });
    assert.equal(cell.status, 409);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/cells/ping`, { method: "POST" })).status, 204);
  });
});
