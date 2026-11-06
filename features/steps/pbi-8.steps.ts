import { After, AfterAll, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";

// One Postgres serves the whole feature, and each scenario gets its own item, so seven scenarios cost one
// container start. Rows are set up with plain SQL; only the behaviour under test goes through src/store.
// Modules load lazily, so while they don't exist every scenario fails on its Then instead of crashing the run.
const repo = process.cwd();
const long = { timeout: 300_000 };

type TestDb = { pool: pg.Pool; stop(): Promise<void> };
type Store = {
  transitionItem: (c: pg.PoolClient, itemId: string, event: string, actor: { actor: string; actorId: string }) => Promise<string>;
};
type Ctx = { itemId?: string; error?: unknown; eventId?: string; eventKind?: string; out?: string; status?: number | null; probeDir?: string };

let db: TestDb | null | undefined;

async function load<T>(path: string): Promise<T | null> {
  const file = join(repo, path);
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as T) : null;
}

async function testDb(): Promise<TestDb | null> {
  if (db !== undefined) return db;
  const mod = await load<{ startTestDb: () => Promise<TestDb> }>("src/store/test-db.ts");
  db = mod ? await mod.startTestDb() : null;
  return db;
}

function ctx(world: object): Ctx {
  const w = world as { pbi8?: Ctx };
  w.pbi8 ??= {};
  return w.pbi8;
}

function need(): TestDb {
  assert.ok(db, "src/store/test-db.ts doesn't exist");
  return db;
}

async function newItem(state: string, generation = 0, owner: string | null = null): Promise<string | undefined> {
  const d = await testDb();
  if (!d) return undefined;
  const source = await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test') returning id");
  const item = await d.pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, gen_random_uuid()::text, 'test item', $2, $3, $4, case when $4::text is null then null else now() + interval '5 minutes' end)
     returning id`,
    [source.rows[0].id, state, generation, owner],
  );
  return item.rows[0].id;
}

async function stored(itemId: string): Promise<{ state: string; lease_generation: number; lease_owner: string | null; lease_expires: Date | null }> {
  const r = await need().pool.query("select state, lease_generation, lease_owner, lease_expires from item where id = $1", [itemId]);
  return r.rows[0];
}

async function eventsFor(itemId: string): Promise<{ kind: string; payload: unknown }[]> {
  return (await need().pool.query("select kind, payload from event where item_id = $1 order by at", [itemId])).rows;
}

After({ tags: "@pbi-8" }, function () {
  const dir = ctx(this).probeDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

AfterAll(long, async function () {
  if (db) await db.stop();
});

Given("a fresh factory database with an item in state {string}", long, async function (state: string) {
  ctx(this).itemId = await newItem(state);
});

Given("a fresh factory database with an item in state {string} at lease generation {int}, leased by {string}", long, async function (state: string, generation: number, owner: string) {
  ctx(this).itemId = await newItem(state, generation, owner);
});

Given("the event table refuses new rows", long, async function () {
  const c = ctx(this);
  if (!db || !c.itemId) return;
  // Refuses inserts for this scenario's item only, so other scenarios sharing the database are unaffected.
  await db.pool.query(`
    create or replace function refuse_event() returns trigger language plpgsql as $$
    begin
      if new.item_id = '${c.itemId}' then raise exception 'event table refuses new rows'; end if;
      return new;
    end $$`);
  await db.pool.query("drop trigger if exists refuse_event on event; create trigger refuse_event before insert on event for each row execute function refuse_event()");
});

When("the item takes the event {string}", long, async function (event: string) {
  const c = ctx(this);
  const store = await load<Store>("src/store/items.ts");
  if (!db || !store || !c.itemId) return;
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await store.transitionItem(client, c.itemId, event, { actor: "system", actorId: "test" });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    c.error = e;
  } finally {
    client.release();
  }
});

Then("the stored item's state is {string}", long, async function (state: string) {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  assert.equal((await stored(c.itemId)).state, state);
});

Then("the event table holds exactly one new row, a {string} from {string} to {string} on {string}", long, async function (kind: string, from: string, to: string, event: string) {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  assert.equal(c.error, undefined, `the move failed: ${String(c.error)}`);
  const rows = await eventsFor(c.itemId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, kind);
  assert.deepEqual(rows[0].payload, { from, to, event });
});

Then("the move fails", function () {
  assert.ok(ctx(this).error, "the move succeeded");
});

Then("the move fails with IllegalTransition", function () {
  const e = ctx(this).error as { name?: string } | undefined;
  assert.ok(e, "the move succeeded");
  assert.equal(e.name, "IllegalTransition");
});

Then("the event table holds no new row", long, async function () {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  assert.equal((await eventsFor(c.itemId)).length, 0);
});

Then("the stored item's lease generation is {int}", long, async function (generation: number) {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  assert.equal(c.error, undefined, `the move failed: ${String(c.error)}`);
  assert.equal((await stored(c.itemId)).lease_generation, generation);
});

Then("the stored item has no lease owner and no lease expiry", long, async function () {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  const s = await stored(c.itemId);
  assert.equal(s.lease_owner, null);
  assert.equal(s.lease_expires, null);
});

Then("the stored item's lease owner is {string}", long, async function (owner: string) {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was created");
  assert.equal((await stored(c.itemId)).lease_owner, owner);
});

Given("a fresh factory database with one event row", long, async function () {
  const c = ctx(this);
  const d = await testDb();
  if (!d) return;
  const r = await d.pool.query<{ id: string; kind: string }>(
    "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'test', null, 'probe', '{}') returning id, kind",
  );
  c.eventId = r.rows[0].id;
  c.eventKind = r.rows[0].kind;
});

When("I connect as {string} and update that event row", long, async function (role: string) {
  const c = ctx(this);
  if (!db || !c.eventId) return;
  const client = await db.pool.connect();
  try {
    await client.query(`set role ${role}`);
    await client.query("update event set kind = 'rewritten' where id = $1", [c.eventId]);
  } catch (e) {
    c.error = e;
  } finally {
    await client.query("reset role");
    client.release();
  }
});

Then("the update fails with a permission error", function () {
  const e = ctx(this).error as { code?: string } | undefined;
  assert.ok(db, "src/store/test-db.ts doesn't exist");
  assert.ok(e, "the update succeeded");
  assert.equal(e.code, "42501", `expected insufficient_privilege, got ${String(e)}`);
});

Then("the event row is unchanged", long, async function () {
  const c = ctx(this);
  assert.ok(c.eventId, "no event row was created");
  const r = await need().pool.query("select kind from event where id = $1", [c.eventId]);
  assert.equal(r.rows[0].kind, c.eventKind);
});

function runProbe(c: Ctx, skip: boolean): void {
  const dir = join(repo, "src", "probe-db");
  if (!c.probeDir) {
    c.probeDir = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "probe.test.ts"),
      `import { describe, test } from "node:test";\nimport { dbTest, startTestDb } from "../store/test-db.ts";\n` +
        `describe("db probe", dbTest, () => {\n  test("reaches the database", async () => {\n    const d = await startTestDb();\n` +
        `    await d.pool.query("select 1");\n    await d.stop();\n  });\n});\n`,
    );
  }
  const env = { ...process.env };
  if (skip) env.FACTORY_DB_TESTS = "skip";
  else delete env.FACTORY_DB_TESTS;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "probe.test.ts")], { cwd: repo, env, encoding: "utf8" });
  c.status = r.status;
  c.out = `${r.stdout}${r.stderr}`;
}

When("I run a test file that uses dbTest with {string}", long, function (_setting: string) {
  runProbe(ctx(this), true);
});

When("I run the same test file without that variable", long, function () {
  runProbe(ctx(this), false);
});

Then("its test is reported as skipped", function () {
  const c = ctx(this);
  assert.match(c.out ?? "", /^# skip 1$/m, `not skipped:\n${c.out}`);
  assert.match(c.out ?? "", /^# pass 0$/m);
});

Then("its test runs and passes", function () {
  const c = ctx(this);
  assert.equal(c.status, 0, c.out ?? "");
  assert.match(c.out ?? "", /^# pass 1$/m, `didn't pass:\n${c.out}`);
  assert.match(c.out ?? "", /^# skip 0$/m);
});
