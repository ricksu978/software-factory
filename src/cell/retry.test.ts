import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkError, RETRY_WAITS_MS, Transient, withRetries } from "./retry.ts";

const transient = (e: unknown) => e instanceof Transient;

test("the waits give at least 3 retries over at least 2 minutes", () => {
  assert.ok(RETRY_WAITS_MS.length >= 3);
  assert.ok(RETRY_WAITS_MS.reduce((a, b) => a + b, 0) >= 120_000);
});

test("a transient failure is tried again after a wait, and the later success is returned", async () => {
  const slept: number[] = [];
  let n = 0;
  const r = await withRetries("GET /x", async () => { if (n++ < 2) throw new Transient("503"); return "ok"; },
    { transient, sleep: async (ms) => void slept.push(ms) });
  assert.equal(r, "ok");
  assert.deepEqual(slept, RETRY_WAITS_MS.slice(0, 2));
});

test("a failure that isn't transient is thrown at once", async () => {
  let n = 0;
  const boom = new Error("400 nope");
  await assert.rejects(withRetries("GET /x", async () => { n++; throw boom; }, { transient, sleep: async () => {} }), (e) => e === boom);
  assert.equal(n, 1);
});

test("a transient failure on every try throws NetworkError naming the call and the tries", async () => {
  let n = 0;
  await assert.rejects(
    withRetries("GET /x", async () => { n++; throw new Transient("GET /x: 503"); }, { transient, sleep: async () => {}, waits: [1, 2, 3] }),
    (e: unknown) => e instanceof NetworkError && e.tries === 4 && /^GET \/x failed on a network or GitHub error after 4 tries: GET \/x: 503$/.test(e.message),
  );
  assert.equal(n, 4);
});
