import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { format } from "node:util";
import { fakeRepoHost } from "../adapters/fake.ts";
import { createPool } from "../store/db.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { startWorker, type Worker, type WorkerDeps } from "./main.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    assert.ok(Date.now() < end, `timed out waiting until ${what}`);
    await sleep(20);
  }
}

describe("the worker lock", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const pools: ReturnType<typeof createPool>[] = [];
  const workers: Worker[] = [];
  const start = async (d: WorkerDeps) => {
    const w = await startWorker(d);
    workers.push(w);
    return w;
  };
  before(async () => {
    db = await startTestDb();
  });
  // A test that fails part way leaves no worker holding the lock for the next one.
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop();
  });
  after(async () => {
    for (const p of pools) await p.end();
    await db?.stop();
  });

  /** A worker on a pool of its own, named `app` in pg_stat_activity, with no board and a launcher that starts nothing. */
  function deps(app: string, egress: string[] = []): { d: WorkerDeps; lines: string[] } {
    const pool = createPool(`${db.url}${db.url.includes("?") ? "&" : "?"}application_name=${app}`);
    pools.push(pool);
    const lines: string[] = [];
    const line = (...args: unknown[]) => void lines.push(format(...args));
    return {
      lines,
      d: {
        pool, sources: [], repoHost: fakeRepoHost(), launcher: { start: async () => "cell", stop: async () => {} },
        egress: async () => void egress.push(app), image: "i", controlUrl: "http://c", blob: "b",
        judge: async () => "", killFlag: false, secret: "s", sopVersion: "default@1",
        tickMs: 20, pollMs: 20, lockRetryMs: 50, log: { log: line, warn: line, error: line },
      },
    };
  }
  const ticks = (w: Worker) => w.runs.get("scheduler tick") ?? 0;
  const lockPids = async (app: string) => (await db.pool.query<{ pid: number }>(
    `select l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted and a.application_name = $1`, [app])).rows.map((r) => r.pid);

  test("a second worker stands by, touching nothing, until the first stops, and then takes over", async () => {
    const egress: string[] = [];
    const one = deps("one", egress);
    const two = deps("two", egress);
    const first = await start(one.d);
    await until("the first worker ticks", () => ticks(first) > 0);
    const second = await start(two.d);
    await sleep(300);
    assert.equal(ticks(second), 0);
    assert.deepEqual(egress, ["one"]);
    assert.ok(two.lines.some((l) => /another worker holds the worker lock/i.test(l) && /standing by/i.test(l)), two.lines.join("\n"));
    assert.equal((await lockPids("one")).length, 1);

    await first.stop();
    await first.done;
    await until("the second worker ticks", () => ticks(second) > 0);
    assert.deepEqual(egress, ["one", "two"]);
    assert.ok(two.lines.some((l) => /took the worker lock/.test(l)));
    assert.equal((await lockPids("two")).length, 1);
    await second.stop();
    await second.done;
    assert.equal((await lockPids("two")).length, 0);
  });

  test("a worker whose lock connection Postgres ends stops ticking and its done rejects", async () => {
    const one = deps("lost");
    const w = await start(one.d);
    await until("the worker ticks", () => ticks(w) > 0);
    await db.pool.query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [await lockPids("lost")]);
    await assert.rejects(w.done, /lost the worker lock/);
    const n = ticks(w);
    await sleep(200);
    assert.equal(ticks(w), n);
    await w.stop();
  });

  test("a worker whose egress proxy fails throws and gives the lock back", async () => {
    const one = deps("noegress");
    await assert.rejects(startWorker({ ...one.d, egress: async () => { throw new Error("no docker"); } }), /egress proxy/);
    assert.equal((await lockPids("noegress")).length, 0);
  });
});

describe("the worker heartbeat", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });

  test("each tick records its time, a failed tick too, and a heartbeat that can't be written is logged", async () => {
    await db.pool.query("delete from worker_heartbeat");
    const lines: string[] = [];
    const line = (...args: unknown[]) => void lines.push(format(...args));
    const times: Date[] = [];
    let failHeartbeat = true;
    const pool = createPool(db.url);
    const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
    (pool as unknown as { query: unknown }).query = (...a: unknown[]) =>
      failHeartbeat && typeof a[0] === "string" && a[0].includes("worker_heartbeat") ? Promise.reject(new Error("refused")) : realQuery(...a);
    const w = await startWorker({
      pool, sources: [], repoHost: fakeRepoHost(), launcher: { start: async () => "cell", stop: async () => {} },
      egress: async () => {}, image: "i", controlUrl: "http://c", blob: "b",
      judge: async () => "", killFlag: false, secret: "s", sopVersion: "default@1",
      tickMs: 20, pollMs: 20, lockRetryMs: 50, log: { log: line, warn: line, error: line },
      now: () => {
        const d = new Date();
        times.push(d);
        return d;
      },
    });
    try {
      const ticks = () => w.runs.get("scheduler tick") ?? 0;
      await until("the worker ticks", () => ticks() > 0);
      assert.ok(lines.some((l) => /heartbeat couldn't be written/.test(l)), lines.join("\n"));
      failHeartbeat = false;
      const n = ticks();
      await until("the worker ticks again", () => ticks() > n + 1);
      const h = (await db.pool.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat")).rows;
      assert.equal(h.length, 1);
      assert.ok(times.some((t) => t.getTime() === h[0].ticked_at.getTime()));
    } finally {
      await w.stop();
      await pool.end();
    }
  });
});
