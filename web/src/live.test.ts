// Floor's live updates (PBI 280): the event stream, the reconnects, the polls and the Reason field holding Floor back,
// on a fake clock against a stand-in for the shell's call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fakeClock } from "../../src/clock.ts";
import type { FloorData } from "./api.ts";
import { emptiedOnAccept, EVENTS_PATH, POLL_MS, RETRY_MS, startLiveFloor } from "./live.ts";

const enc = new TextEncoder();
const floor = { next: [] } as unknown as FloorData;

type Stream = { at: number; status: number; controller?: ReadableStreamDefaultController<Uint8Array>; aborted?: boolean };

/** The shell's call, answering the floor and the event stream, and refusing the next `refuse` attempts to open one. */
function stand(opts: { refuse?: number; status?: number; signedOut?: boolean } = {}) {
  const clock = fakeClock(new Date("2026-11-20T12:00:00Z"));
  const reads: number[] = [];
  const streams: Stream[] = [];
  let refuse = opts.refuse ?? 0;
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const at = clock.now().getTime();
      if (path === "/auth/session") return new Response("{}", { status: opts.signedOut ? 401 : 200 });
    if (path === "/bff/v1/floor") {
      reads.push(at);
      return new Response(JSON.stringify(floor), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(path, EVENTS_PATH);
    if (refuse > 0) {
      refuse--;
      streams.push({ at, status: opts.status ?? 502 });
      return new Response("{}", { status: opts.status ?? 502 });
    }
    const s: Stream = { at, status: 200 };
    streams.push(s);
    init?.signal?.addEventListener("abort", () => {
      s.aborted = true;
      try {
        s.controller?.error(new DOMException("aborted", "AbortError"));
      } catch {}
    });
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (s.controller = c) });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const drawn: FloorData[] = [];
  const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };
  const live = startLiveFloor({ call, clock, onFloor: (d) => drawn.push(d) });
  const open = () => streams.filter((s) => s.status === 200 && !s.aborted).at(-1);
  const send = () => open()?.controller?.enqueue(enc.encode(`data: {"kind":"transition"}\n\n`));
  const pass = async (ms: number) => {
    await settle();
    await clock.advance(ms);
    await settle();
  };
  return { clock, reads, streams, drawn, live, settle, send, pass, open };
}

test("an event reads the floor once the burst has settled, and draws it", async () => {
  const s = stand();
  await s.settle();
  assert.equal(s.streams.length, 1);
  assert.equal(s.reads.length, 0, "opening the first stream doesn't read the floor, which Floor has just read");
  for (let i = 0; i < 5; i++) {
    s.send();
    await s.pass(100);
  }
  await s.pass(1000);
  assert.equal(s.reads.length, 1);
  assert.equal(s.drawn.length, 1);
  s.live.stop();
});

test("while a stream can't be opened, Floor waits longer after each attempt, and catches up once one opens", async () => {
  const t = stand({ refuse: 3 });
  await t.settle();
  assert.equal(t.streams.length, 1, "the first attempt was refused");
  await t.pass(60_000);
  const at = t.streams.map((x) => x.at - t.streams[0].at);
  assert.deepEqual(at, [0, RETRY_MS, 3 * RETRY_MS, 7 * RETRY_MS]);
  assert.ok(t.reads.some((r) => r >= t.streams[3].at), "it read the floor once a stream opened");
  t.live.stop();
});

test("a stream the factory ends is reopened, and the floor read again", async () => {
  const s = stand();
  await s.settle();
  s.open()!.controller!.close();
  await s.pass(RETRY_MS);
  assert.equal(s.streams.length, 2);
  assert.equal(s.reads.length, 1);
  s.live.stop();
});

test("a 401 stops following, since the shell sends the browser to sign in", async () => {
  const s = stand({ refuse: 1, status: 401 });
  await s.pass(10 * 60_000);
  assert.equal(s.streams.length, 1);
  assert.equal(s.reads.length, 0);
});

test("a stream that ends with the session gone stops following at once, with no further attempt", async () => {
  const s = stand({ signedOut: true });
  await s.settle();
  s.open()!.controller!.error(new TypeError("network error"));
  await s.pass(10 * 60_000);
  assert.equal(s.streams.length, 1);
  assert.equal(s.clock.pending(), 0);
});

test("Floor reads the floor every POLL_MS with no event", async () => {
  const s = stand();
  await s.pass(POLL_MS * 3);
  assert.equal(s.reads.length, 3);
  s.live.stop();
});

test("a Reason field with focus or text holds Floor back, and it catches up once the field is empty and left", async () => {
  const s = stand();
  await s.settle();
  s.live.reasonField({ value: "", focused: true });
  s.send();
  await s.pass(POLL_MS * 2);
  s.live.reasonField({ value: "deploy", focused: false });
  s.send();
  await s.pass(POLL_MS * 2);
  assert.equal(s.reads.length, 0);
  s.live.reasonField({ value: "", focused: false });
  await s.pass(1000);
  assert.equal(s.reads.length, 1);
  assert.equal(s.drawn.length, 1);
  s.live.stop();
});

test("once the factory accepts the Controls form, the reason it sent no longer holds Floor back", async () => {
  const s = stand();
  await s.settle();
  // The operator types a reason and clicks a button, which leaves the field with the reason still in it.
  s.live.reasonField({ value: "lunch", focused: true });
  s.live.reasonField({ value: "lunch", focused: false });
  const empty = () => s.live.reasonField({ value: "", focused: false });
  await emptiedOnAccept(Promise.resolve({ outcome: "accepted", data: floor }), empty);
  s.send();
  await s.pass(1000);
  assert.equal(s.reads.length, 1, "an event after the accepted form reads the floor");
  assert.equal(s.drawn.length, 1);
  await s.pass(POLL_MS);
  assert.equal(s.reads.length, 2, "and so does the poll");
  s.live.stop();
});

test("a Controls form the factory refuses or fails keeps its reason, which still holds Floor back", async () => {
  const s = stand();
  await s.settle();
  s.live.reasonField({ value: "lunch", focused: false });
  const empty = () => s.live.reasonField({ value: "", focused: false });
  await emptiedOnAccept(Promise.resolve({ outcome: "failed" as const, message: "No." }), empty);
  await emptiedOnAccept(Promise.resolve({ outcome: "refused" as const, field: "Reason" }), empty);
  s.send();
  await s.pass(POLL_MS);
  assert.equal(s.reads.length, 0);
  s.live.stop();
});

test("stop closes the stream and clears every timer", async () => {
  const s = stand();
  await s.settle();
  s.live.stop();
  await s.settle();
  assert.equal(s.open(), undefined);
  assert.equal(s.clock.pending(), 0);
});
