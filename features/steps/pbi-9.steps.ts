import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type pg from "pg";
import { ctx, load, long, need, testDb } from "./pbi-8.steps.ts";

// Shares PBI 4's database and its "stored item" steps. claimNext and expireLeases look at every item, so each
// scenario starts from empty item tables. A function that doesn't exist yet leaves its result unset, and the Then fails.
type Claim = { itemId: string; runId: string; generation: number } | null;
type Leases = {
  claimNext?: (c: pg.PoolClient, owner: string, now: Date) => Promise<Claim>;
  renewLease?: (c: pg.PoolClient, itemId: string, generation: number, now: Date) => Promise<"ok" | "lost">;
  expireLeases?: (c: pg.PoolClient, now: Date) => Promise<string[]>;
};
type WithTx = { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
type Ctx9 = { claim?: Claim; claimB?: Claim; renewal?: string; expired?: string[]; error?: unknown };

function ctx9(world: object): Ctx9 {
  const w = world as { pbi9?: Ctx9 };
  w.pbi9 ??= {};
  return w.pbi9;
}

async function deps(): Promise<{ store: Leases; tx: WithTx } | null> {
  const store = await load<Leases>("src/store/items.ts");
  const tx = await load<WithTx>("src/store/db.ts");
  return store && tx ? { store, tx } : null;
}

async function newItem(state: string, generation: number, owner: string | null, expires: string | null): Promise<string | undefined> {
  const d = await testDb();
  if (!d) return undefined;
  const source = await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const item = await d.pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, gen_random_uuid()::text, 'test item', $2, $3, $4, $5) returning id`,
    [source.rows[0].id, state, generation, owner, expires],
  );
  return item.rows[0].id;
}

Before({ tags: "@pbi-9", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query("truncate item cascade");
});

Given("a fresh factory database whose one claimable item is in state {string} at lease generation {int}", long, async function (state: string, generation: number) {
  const id = await newItem(state, generation, null, null);
  ctx(this).itemId = id;
  // A SignOff or NeedsInput item is claimable only once its question has an answer.
  const kind = { SignOff: "sign_off", NeedsInput: "needs_input" }[state];
  if (id && kind) {
    await need().pool.query("insert into question (item_id, kind, body, answer, answered_at) values ($1, $2, 'q', 'a', now())", [id, kind]);
  }
});

Given("a fresh factory database with an item in state {string} at lease generation {int}, leased by {string} until {string}", long, async function (state: string, generation: number, owner: string, until: string) {
  ctx(this).itemId = await newItem(state, generation, owner, until);
});

Given("the item's open run resumes from {string}", long, async function (stage: string) {
  const id = ctx(this).itemId;
  if (id) await need().pool.query("insert into run (item_id, next_stage) values ($1, $2)", [id, stage]);
});

When("{string} claims the next item at {string}", long, async function (owner: string, at: string) {
  const c = ctx9(this);
  const d = await deps();
  if (!d?.store.claimNext) return;
  const claimNext = d.store.claimNext;
  try {
    c.claim = await d.tx.withTx(need().pool, (client) => claimNext(client, owner, new Date(at)));
  } catch (e) {
    c.error = e;
  }
});

When("{string} claims the next item at {string}, and before that transaction commits {string} claims the next item", long, async function (ownerA: string, at: string, ownerB: string) {
  const c = ctx9(this);
  const d = await deps();
  if (!d?.store.claimNext) return;
  const claimNext = d.store.claimNext;
  const pool = need().pool;
  try {
    await d.tx.withTx(pool, async (a) => {
      c.claim = await claimNext(a, ownerA, new Date(at));
      // Without SKIP LOCKED the second claim would wait on the first's row lock forever, so it gives up after 5s.
      c.claimB = await d.tx.withTx(pool, async (b) => {
        await b.query("set local lock_timeout = '5s'");
        return claimNext(b, ownerB, new Date(at));
      });
    });
  } catch (e) {
    c.error = e;
  }
});

When("the lease is renewed with generation {int} at {string}", long, async function (generation: number, at: string) {
  const c = ctx9(this);
  const d = await deps();
  const id = ctx(this).itemId;
  if (!d?.store.renewLease || !id) return;
  const renewLease = d.store.renewLease;
  try {
    c.renewal = await d.tx.withTx(need().pool, (client) => renewLease(client, id, generation, new Date(at)));
  } catch (e) {
    c.error = e;
  }
});

When("leases expire at {string}", long, async function (at: string) {
  const c = ctx9(this);
  const d = await deps();
  if (!d?.store.expireLeases) return;
  const expireLeases = d.store.expireLeases;
  try {
    c.expired = await d.tx.withTx(need().pool, (client) => expireLeases(client, new Date(at)));
  } catch (e) {
    c.error = e;
  }
});

function ok(c: Ctx9): void {
  assert.equal(c.error, undefined, `the call failed: ${String(c.error)}`);
}

Then("the claim returns that item at generation {int}", function (generation: number) {
  const c = ctx9(this);
  ok(c);
  assert.ok(c.claim, "the claim returned nothing");
  assert.equal(c.claim.itemId, ctx(this).itemId);
  assert.equal(c.claim.generation, generation);
});

Then("the stored item's lease expires at {string}", long, async function (at: string) {
  const id = ctx(this).itemId;
  assert.ok(id, "no item was created");
  const r = await need().pool.query<{ lease_expires: Date | null }>("select lease_expires from item where id = $1", [id]);
  assert.equal(r.rows[0].lease_expires?.toISOString(), new Date(at).toISOString());
});

Then("the renewal returns {string}", function (result: string) {
  const c = ctx9(this);
  ok(c);
  assert.equal(c.renewal, result);
});

Then("{string} gets the item and {string} gets null", function (_a: string, _b: string) {
  const c = ctx9(this);
  ok(c);
  assert.ok(c.claim, "the first claim returned nothing");
  assert.equal(c.claim.itemId, ctx(this).itemId);
  assert.equal(c.claimB, null);
});

Then("the item has exactly one run", long, async function () {
  const id = ctx(this).itemId;
  assert.ok(id, "no item was created");
  const r = await need().pool.query("select count(*)::int as n from run where item_id = $1", [id]);
  assert.equal(r.rows[0].n, 1);
});

Then("the expiry returns that item", function () {
  const c = ctx9(this);
  ok(c);
  assert.deepEqual(c.expired, [ctx(this).itemId]);
});

Then("the expiry returns no items", function () {
  const c = ctx9(this);
  ok(c);
  assert.deepEqual(c.expired, []);
});

Then("the item's open run still resumes from {string}", long, async function (stage: string) {
  const id = ctx(this).itemId;
  assert.ok(id, "no item was created");
  const r = await need().pool.query("select next_stage from run where item_id = $1 and ended_at is null", [id]);
  assert.deepEqual(r.rows, [{ next_stage: stage }]);
});
