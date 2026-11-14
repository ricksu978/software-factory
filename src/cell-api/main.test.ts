import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { runToken } from "../control/cell-api.ts";
import { withTx } from "../store/db.ts";
import { claimNext } from "../store/items.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { main, serveCellApi } from "./main.ts";

const secret = "cell-secret";

describe("the cell API service at startup", () => {
  test("refuses to start without CELL_SECRET, naming it, before it connects or listens", async () => {
    const env = {
      FACTORY_DB_URI: "postgres://nobody@127.0.0.1:1/none", FACTORY_BLOB: "UseDevelopmentStorage=true",
      GITHUB_APP_ID: "1", GITHUB_APP_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", PORT: "0",
    };
    await assert.rejects(main(env), /CELL_SECRET is not set/);
  });

  test("names every setting it lacks", async () => {
    await assert.rejects(main({}), /FACTORY_DB_URI, FACTORY_BLOB, CELL_SECRET, GITHUB_APP_ID, GITHUB_APP_KEY, CLAUDE_CODE_OAUTH_TOKEN are not set/);
  });
});

describe("the cell API service", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let upstream: Server;
  let seen: string[];
  let served: Awaited<ReturnType<typeof serveCellApi>>;
  let base: string;
  let run: { runId: string; generation: number };

  before(async () => {
    db = await startTestDb();
    seen = [];
    upstream = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const board = fakeBacklog();
    const sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'cell-api-main') returning id")).rows[0].id;
    await board.seed({ externalId: "A" });
    await db.pool.query("insert into item (source_id, external_id, title, state) values ($1, 'A', 'a', 'Queued')", [sourceId]);
    const claim = await withTx(db.pool, (c) => claimNext(c, "cell-a", new Date()));
    assert.ok(claim);
    run = claim;
    // The gateway reads the run's repo config for its web tools, so the run has a repo and a config sha.
    await db.pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', 'https://github.com/octo/repo', 'factory[bot]')");
    await db.pool.query("update run set repo_id = (select id from repo where url = 'https://github.com/octo/repo'), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1", [run.runId]);
    const repoHost = fakeRepoHost();
    repoHost.files.set("octo/repo@cfg1234:.factory/config.yml", "bdd:\n  parse: p\n  run: r\n  report: out.ndjson\ncommands:\n  test: t\n  lint: l\n");
    served = await serveCellApi({
      pool: db.pool, sources: [{ id: sourceId, adapter: board.adapter }], repoHost, secret,
      claudeToken: "owner-secret", modelUpstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      uploadUrl: async (path) => `http://blob.test/${path}`,
    }, 0);
    base = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await served.stop();
    await new Promise<void>((r) => upstream.close(() => r()));
    await db.stop();
  });

  test("serves a cell route with the run's token, and fences a token from another generation with 409", async () => {
    const ok = await fetch(`${base}/internal/cells/${run.runId}/lease`, {
      method: "POST", body: JSON.stringify({ generation: run.generation }),
      headers: { authorization: `Bearer ${runToken(secret, run.runId, run.generation)}`, "content-type": "application/json" },
    });
    assert.equal(ok.status, 200);
    const stale = await fetch(`${base}/internal/cells/${run.runId}/lease`, {
      method: "POST", body: JSON.stringify({ generation: run.generation + 1 }),
      headers: { authorization: `Bearer ${runToken(secret, run.runId, run.generation + 1)}`, "content-type": "application/json" },
    });
    assert.equal(stale.status, 409);
  });

  test("passes a model request on with the owner's token", async () => {
    const r = await fetch(`${base}/internal/model/v1/messages`, {
      method: "POST", body: "{}",
      headers: { authorization: `Bearer sk-ant-oat01-${run.runId}.${run.generation}.${runToken(secret, run.runId, run.generation)}`, "content-type": "application/json" },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(seen, ["Bearer owner-secret"]);
  });

  test("answers 404 for the dashboard's paths", async () => {
    for (const path of ["/", "/webhooks/github", "/internal/cells/ping"]) {
      const r = await fetch(`${base}${path}`, { method: path === "/" ? "GET" : "POST", redirect: "manual" });
      await r.text();
      assert.equal(r.status, 404, path);
    }
  });
});
