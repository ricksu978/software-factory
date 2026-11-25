import assert from "node:assert/strict";
import { test } from "node:test";
import { httpCellApi, LeaseLost } from "./api-client.ts";
import { NetworkError } from "./retry.ts";

const cfg = { controlUrl: "http://cell-api.test", runId: "r1", runToken: "t", generation: 1 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A fetch that answers each try from `answers` in turn, the last one ever after, and logs every try. */
function scripted(answers: (number | Error)[]) {
  const tries: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    tries.push({ url, body: init?.body });
    const a = answers[Math.min(tries.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a === 200 ? json(200, { status: "success", ok: true, stop: false }) : json(a, { error: `answered ${a}` });
  }) as typeof globalThis.fetch;
  const slept: number[] = [];
  return { tries, slept, api: httpCellApi(cfg, { fetch, sleep: async (ms) => void slept.push(ms) }) };
}

for (const status of [500, 502, 503, 504]) {
  test(`a ${status} is tried again after a wait`, async () => {
    const s = scripted([status, 200]);
    assert.equal((await s.api.checks("abc")).status, "success");
    assert.equal(s.tries.length, 2);
    assert.equal(s.slept.length, 1);
  });
}

test("a connection that fails or times out is tried again, with the same request", async () => {
  const s = scripted([new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError"), 200]);
  await s.api.stage({ stageId: "green", attempt: 1, status: "started", model: "m", tokensIn: 0, tokensOut: 0, costUsd: 0 });
  assert.equal(s.tries.length, 3);
  assert.equal(new Set(s.tries.map((t) => `${t.url} ${t.body}`)).size, 1);
});

test("a call that fails on every try ends with NetworkError naming the call and the tries", async () => {
  const s = scripted([503]);
  await assert.rejects(s.api.checks("abc"), (e: unknown) =>
    e instanceof NetworkError && /^GET \/checks failed on a network or GitHub error after 5 tries: GET \/checks\?sha=abc: 503/.test(e.message));
  assert.equal(s.tries.length, 5);
  assert.ok(s.slept.reduce((a, b) => a + b, 0) >= 120_000);
});

for (const status of [400, 401, 403, 404]) {
  test(`a ${status} after a 503 isn't tried again`, async () => {
    const s = scripted([503, status]);
    await assert.rejects(s.api.checks("abc"), (e: unknown) => !(e instanceof NetworkError) && new RegExp(`: ${status} `).test(String(e)));
    assert.equal(s.tries.length, 2);
  });
}

test("a 409 after a 503 is LeaseLost at once", async () => {
  const s = scripted([503, 409]);
  await assert.rejects(s.api.checks("abc"), LeaseLost);
  assert.equal(s.tries.length, 2);
});

test("lease({ once: true }) tries once, for the renewal loop's own tolerance", async () => {
  const s = scripted([503, 200]);
  await assert.rejects(s.api.lease({ once: true }), (e: unknown) => !(e instanceof NetworkError));
  assert.equal(s.tries.length, 1);
  assert.deepEqual(await s.api.lease(), { stop: false });
});

test("lease passes on restarting from the cell API's reply, so the cell ends at the stage boundary (PBI 301)", async () => {
  const fetch = (async () => json(200, { ok: true, stop: false, restarting: true })) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await httpCellApi(cfg, { fetch }).lease(), { stop: false, restarting: true });
});
