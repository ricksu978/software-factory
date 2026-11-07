import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import type { ItemState } from "../core/states.ts";
import { withTx } from "./db.ts";
import { IllegalTransition, onTransition, transitionItem, upsertItem } from "./items.ts";
import { dbTest, startTestDb } from "./test-db.ts";

const system = { actor: "system" as const, actorId: "test" };

describe("store", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;
  const hookCalls: string[] = [];
  const failingHook = new Set<string>();

  before(async () => {
    db = await startTestDb();
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    // Registered first, so the recording hook below proves later hooks still run after one throws.
    onTransition(async (itemId) => {
      if (failingHook.has(itemId)) throw new Error("hook failure");
    });
    onTransition(async (itemId, from, to, event) => {
      hookCalls.push(`${itemId}:${from}:${to}:${event}`);
    });
  });
  after(async () => {
    await db?.stop();
  });

  async function item(state: ItemState, extra = "lease_generation = 4, lease_owner = 'cell-a', lease_expires = now()"): Promise<string> {
    const id = await upsertItem(db.pool, { sourceId: source, externalId: crypto.randomUUID(), title: "t" });
    await db.pool.query(`update item set state = $2, ${extra} where id = $1`, [id, state]);
    return id;
  }

  const events = async (id: string): Promise<{ kind: string; payload: unknown }[]> =>
    (await db.pool.query("select kind, payload from event where item_id = $1", [id])).rows;
  const row = async (id: string): Promise<{ state: string; lease_generation: number; lease_owner: string | null; lease_expires: Date | null }> =>
    (await db.pool.query("select state, lease_generation, lease_owner, lease_expires from item where id = $1", [id])).rows[0];

  test("Eligible --ready--> Queued writes one transition event", async () => {
    const id = await item("Eligible");
    assert.equal(await withTx(db.pool, (c) => transitionItem(c, id, "ready", system)), "Queued");
    assert.deepEqual(await events(id), [{ kind: "transition", payload: { from: "Eligible", to: "Queued", event: "ready" } }]);
  });

  test("Done --claimed--> throws IllegalTransition and changes nothing", async () => {
    const id = await item("Done");
    await assert.rejects(withTx(db.pool, (c) => transitionItem(c, id, "claimed", system)), IllegalTransition);
    assert.equal((await row(id)).state, "Done");
    assert.deepEqual(await events(id), []);
  });

  test("upsertItem with the same (source_id, external_id) returns the same id", async () => {
    const a = await upsertItem(db.pool, { sourceId: source, externalId: "same", title: "one" });
    const b = await upsertItem(db.pool, { sourceId: source, externalId: "same", title: "two" });
    assert.equal(a, b);
  });

  test("leaving InProgress raises the generation and clears the lease", async () => {
    const id = await item("InProgress");
    await withTx(db.pool, (c) => transitionItem(c, id, "pr_opened", system));
    const r = await row(id);
    assert.equal(r.lease_generation, 5);
    assert.equal(r.lease_owner, null);
    assert.equal(r.lease_expires, null);
  });

  test("a move between two non-InProgress states leaves the lease untouched", async () => {
    const id = await item("Eligible");
    await withTx(db.pool, (c) => transitionItem(c, id, "ready", system));
    const r = await row(id);
    assert.equal(r.lease_generation, 4);
    assert.equal(r.lease_owner, "cell-a");
    assert.notEqual(r.lease_expires, null);
  });

  test("onTransition runs after a commit, and not after a rollback", async () => {
    const committed = await item("Eligible");
    await withTx(db.pool, (c) => transitionItem(c, committed, "ready", system));
    assert.ok(hookCalls.includes(`${committed}:Eligible:Queued:ready`));
    const rolledBack = await item("Eligible");
    await assert.rejects(withTx(db.pool, async (c) => {
      await transitionItem(c, rolledBack, "ready", system);
      throw new Error("abort");
    }));
    assert.ok(!hookCalls.some((h) => h.startsWith(rolledBack)));
  });

  test("a failing hook neither rejects the committed move nor stops later hooks", async () => {
    const id = await item("Eligible");
    failingHook.add(id);
    assert.equal(await withTx(db.pool, (c) => transitionItem(c, id, "ready", system)), "Queued");
    assert.equal((await row(id)).state, "Queued");
    assert.ok(hookCalls.includes(`${id}:Eligible:Queued:ready`));
  });

  test("transitionItem outside withTx refuses before writing", async () => {
    const id = await item("Eligible");
    const c = await db.pool.connect();
    try {
      await assert.rejects(transitionItem(c, id, "ready", system), /inside withTx/);
    } finally {
      c.release();
    }
    assert.equal((await row(id)).state, "Eligible");
    assert.deepEqual(await events(id), []);
  });

  test("factory_app can't UPDATE event", async () => {
    const id = (await db.pool.query<{ id: string }>("insert into event (actor, actor_id, kind) values ('system', 't', 'probe') returning id")).rows[0].id;
    const c: pg.PoolClient = await db.pool.connect();
    try {
      await c.query("set role factory_app");
      await assert.rejects(c.query("update event set kind = 'x' where id = $1", [id]), { code: "42501" });
    } finally {
      await c.query("reset role");
      c.release();
    }
  });

  test("migrate-cli grants factory_app to FACTORY_APP_PRINCIPAL", async () => {
    // A plain Postgres has no pgaadauth_create_principal, so the role exists beforehand and only the grant runs.
    await db.pool.query(`create role "id-factory-control" nologin`);
    const r = spawnSync(process.execPath, ["src/store/migrate-cli.ts"], {
      env: { ...process.env, FACTORY_DB_URI: db.url, FACTORY_SOURCES: "none.yml", FACTORY_APP_PRINCIPAL: "id-factory-control" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const member = await db.pool.query("select pg_has_role('id-factory-control', 'factory_app', 'member') as m");
    assert.equal(member.rows[0].m, true);
  });

  test("seed-owner adds a first owner through migrate-cli, and refuses a word it doesn't know", async () => {
    const seed = (...words: string[]) =>
      spawnSync(process.execPath, ["src/store/migrate-cli.ts", "seed-owner", ...words], { env: { ...process.env, FACTORY_DB_URI: db.url }, encoding: "utf8" });
    const bad = seed("provider=microsoft", "subject=s-2", "role=viewer");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /role=viewer/);
    assert.equal(seed("provider=github", "subject=s-3").status, 1, "an unknown provider");
    assert.equal(seed("provider=microsoft").status, 1, "no subject");
    const ok = seed("provider=microsoft", "subject=s-1", "email=me@example.com", "github-login=Octo", "product-owner");
    assert.equal(ok.status, 0, ok.stderr);
    const rows = (await db.pool.query(`select provider, subject, email, github_login, role, product_owner from "user" where subject like 's-%'`)).rows;
    assert.deepEqual(rows, [{ provider: "microsoft", subject: "s-1", email: "me@example.com", github_login: "Octo", role: "owner", product_owner: true }]);
    // Promoting the same person again with only their sign-in keeps what they already had.
    await db.pool.query(`update "user" set role = 'viewer' where subject = 's-1'`);
    assert.equal(seed("provider=microsoft", "subject=s-1").status, 0);
    const again = (await db.pool.query(`select email, github_login, role, product_owner from "user" where subject = 's-1'`)).rows;
    assert.deepEqual(again, [{ email: "me@example.com", github_login: "Octo", role: "owner", product_owner: true }]);
    await db.pool.query(`delete from "user" where subject like 's-%'`);
  });

  test("migrate-cli seeds sources and the local dev owner, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sources-"));
    try {
      const sources = join(dir, "sources.yml");
      writeFileSync(sources, "- repo: octo/repo\n  installationId: 1\n  owner: { type: user, login: octo }\n  projectNumber: 4\n  fieldMap: {}\n");
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, ["src/store/migrate-cli.ts"], { env: { ...process.env, FACTORY_DB_URI: db.url, FACTORY_SOURCES: sources, ...env }, encoding: "utf8" });
      for (let i = 0; i < 2; i++) assert.equal(run({ FACTORY_ENV: "local", FACTORY_DEV_LOGIN: "octo" }).status, 0);
      const count = async (sql: string) => Number((await db.pool.query(sql)).rows[0].count);
      assert.equal(await count("select count(*) from repo where url = 'https://github.com/octo/repo'"), 1);
      assert.equal(await count("select count(*) from backlog_source where url = 'https://github.com/users/octo/projects/4'"), 1);
      const owner = (await db.pool.query(`select role, product_owner, github_login from "user" where provider = 'dev' and subject = 'octo'`)).rows;
      assert.deepEqual(owner, [{ role: "owner", product_owner: true, github_login: "octo" }]);
      await db.pool.query(`delete from "user" where provider = 'dev'`);
      assert.equal(run({ FACTORY_ENV: "" }).status, 0);
      assert.equal(await count(`select count(*) from "user" where provider = 'dev'`), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
