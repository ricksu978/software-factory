// Step definitions for features/pbi-280-live-floor-events-heartbeat-outbox.feature.
//
// Floor in the SPA runs on PBI 279's harness (features/steps/pbi-279.steps.ts): the real shell against a stubbed fetch
// that answers from the scenario's fixture data and records every request, and Floor rendered with react-dom/server
// and read as a tree of elements. This file adds to it:
//   - The SPA's clock: src/clock.ts's fakeClock, which Floor's `now` reads on every render and web/src/live.ts's
//     startLiveFloor sets its timers on. "Time passes", here and in PBI 134's `N seconds pass`, moves it on.
//   - The event stream: the stub answers GET /bff/v1/events with a text/event-stream body the scenario writes to. An
//     event is a `data:` line as the API's /v1/events sends it. "The factory ends the stream" closes the body, "the
//     stream drops" errors it, and the SPA closes it by cancelling the body or aborting its call. Each attempt to open
//     a stream is recorded with the clock's time and the status it got.
//   - Live Floor: once Floor opens, the steps start web/src/live.ts's startLiveFloor with the shell's call, the fake
//     clock and an onFloor that draws Floor again from the read it hands back. Opening another page stops it. Each
//     render's banners are kept, so a Then can say what Floor showed at any point.
//   - The Reason field: the SPA renders on the server here, with no DOM to type into, so typing and focus are what
//     Floor's Controls tell the live Floor through reasonField({ value, focused }). The field "still holds" what was
//     typed when Floor hasn't been drawn afresh from a new read since, which would have lost it.
//   - The worker's heartbeat: the floor's workerHeartbeat, set relative to the SPA's clock. A worker that "ticks every
//     5 seconds" makes each read of the floor report its latest tick on that clock.
//   - "Next to the worker's heartbeat": the element holding the text, or one of its two nearest ancestors, also reads
//     "worker" (the heartbeat's line, or the "Scheduler not ticking" banner).
// A When never asserts what the SPA did: an event sent with no stream open, or a stream ended that isn't open, is
// recorded and goes nowhere, so a Floor that doesn't follow the events fails on a Then.
//
// The BFF's scenario runs src/bff/app.ts's createBff in this process, with a session store in memory holding one
// session, a stub API on its fetch whose /v1/events body stays open until the scenario ends it, and the BFF's per-call
// timeout set on a fake clock, so "45 seconds after" moves that clock on rather than waiting.
//
// The @db scenarios run the API on PBI 284's harness, as PBI 286's do, and read the floor's `outboxSetAside`.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import type { FloorData } from "../../web/src/api.ts";
import { EVENTS_PATH, startLiveFloor, type LiveFloor, type ReasonField } from "../../web/src/live.ts";
import { createBff } from "../../src/bff/app.ts";
import { hashSessionId, newSessionId, SESSION_COOKIE, type NewSession, type Session, type SessionStore } from "../../src/bff/session.ts";
import { fakeClock, type FakeClock } from "../../src/clock.ts";
import { CONSUMER } from "../../src/store/outbox.ts";
import { body, ctx as pbi284, startIssuer, stopAll } from "./pbi-284.steps.ts";
import {
  addActive, all, banners, ctx as pbi279, floorRoot, includes, named, open, override, render, role, rowFor, section, showsCells, table, text,
  type El, type PageName,
} from "./pbi-279.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const UNIT: Record<string, number> = { second: SECOND, minute: MINUTE, hour: 60 * MINUTE, day: 24 * 60 * MINUTE };
const ms = (n: number, unit: string) => n * UNIT[unit.replace(/s$/, "")];

// ---- the scenario's context ----

type Stream = {
  at: number;
  status: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  /** "ended" by the factory, "dropped" as a connection does, or "closed" by the SPA. */
  closed?: "ended" | "dropped" | "closed";
  closedAt?: number;
};

type Render = { at: number; banners: string[] };

type Bff = {
  clock: FakeClock;
  app: ReturnType<typeof createBff>;
  cookie: string;
  api?: Stream;
  browser?: { text: string; ended?: "end" | "error"; error?: string; status: number };
  event?: string;
};

type Ctx = {
  clock: FakeClock;
  live?: LiveFloor;
  liveError?: string;
  /** Renders of Floor since it opened, from the clock's onFloor and the open itself. */
  renders: Render[];
  /** The banners Floor showed when it opened. */
  openedBanners?: string[];
  /** When the SPA read the floor, on the clock. */
  reads: number[];
  /** Every attempt to open the event stream. */
  streams: Stream[];
  /** The floor reads by the time Floor opened, or by the time I left it. */
  baseline: number;
  /** When Floor opened, on the clock. */
  openedAt?: number;
  /** The navigations by the time Floor opened. */
  navigationsAtOpen: number;
  /** The next attempts to open the stream that the BFF refuses, and with what. */
  refuse: { status: number; left: number } | null;
  /** The BFF answers 401 to everything from now on. */
  signedOut: boolean;
  /** The events the factory sent, on the clock. */
  sent: number[];
  /** When the factory ended or dropped the stream the SPA had open. */
  endedAt?: number;
  ticking?: { every: number; from: number };
  field?: ReasonField;
  /** The renders by the time the reason was typed. */
  rendersAtTyping?: number;
  /** Floor's renders waiting to finish. */
  drawing: Promise<void>;
  bff?: Bff;
};

function ctx(world: object): Ctx {
  const w = world as { pbi280?: Ctx };
  assert.ok(w.pbi280, "PBI 280's context isn't set up: the scenario isn't tagged @pbi-280");
  return w.pbi280;
}

/** For PBI 134's `N seconds pass`, which moves this feature's clock when the scenario is one of these. */
export function isPbi280(world: object): boolean {
  return (world as { pbi280?: Ctx }).pbi280 !== undefined;
}

const enc = new TextEncoder();
const eventLine = (n: number) => `data: ${JSON.stringify({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, itemId: null, kind: "transition" })}\n\n`;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Lets the stream reads, the shell's calls and Floor's renders that are under way finish. */
async function settle(c: Ctx): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await tick();
    await c.drawing;
  }
}

/** Moves the SPA's clock on by `n` ms, firing the timers that fall due, and lets what they start finish. */
export async function pass(world: object, n: number): Promise<void> {
  const c = ctx(world);
  await settle(c);
  await c.clock.advance(n);
  await settle(c);
}

const now = (c: Ctx) => c.clock.now().getTime();
const isOpen = (s: Stream) => s.status === 200 && !s.closed;
const openStream = (c: Ctx) => c.streams.filter(isOpen).at(-1);

function stream(c: Ctx, init?: RequestInit): Response {
  const s: Stream = { at: now(c), status: 200 };
  c.streams.push(s);
  const close = (how: NonNullable<Stream["closed"]>) => {
    if (s.closed) return;
    s.closed = how;
    s.closedAt = now(c);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      s.controller = controller;
      controller.enqueue(enc.encode(": open\n\n"));
    },
    cancel() {
      close("closed");
    },
  });
  init?.signal?.addEventListener("abort", () => {
    if (s.closed) return;
    close("closed");
    try {
      s.controller?.error(new DOMException("The operation was aborted.", "AbortError"));
    } catch {}
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Answers what PBI 279's stub leaves to this feature: the event stream, the refusals, and a session that ended. */
function hook(c: Ctx) {
  return (method: string, path: string, init?: RequestInit): Response | undefined => {
    if (c.signedOut) {
      if (method === "GET" && path === EVENTS_PATH) c.streams.push({ at: now(c), status: 401 });
      return json(401, { error: "not signed in" });
    }
    if (method === "GET" && path === "/bff/v1/floor") {
      c.reads.push(now(c));
      return undefined;
    }
    if (method === "GET" && path === EVENTS_PATH) {
      if (c.refuse && c.refuse.left > 0) {
        c.refuse.left--;
        c.streams.push({ at: now(c), status: c.refuse.status });
        return json(c.refuse.status, { error: "the API didn't answer" });
      }
      return stream(c, init);
    }
    return undefined;
  };
}

Before({ tags: "@pbi-280" }, function () {
  const w = this as { pbi280?: Ctx; pbi278?: { fake?: unknown } };
  const c: Ctx = {
    clock: fakeClock(new Date()),
    renders: [],
    reads: [],
    streams: [],
    baseline: 0,
    navigationsAtOpen: 0,
    refuse: null,
    signedOut: false,
    sent: [],
    drawing: Promise.resolve(),
  };
  w.pbi280 = c;
  const p = pbi279(this);
  p.clock = () => c.clock.now();
  p.now = c.clock.now();
  p.fetchHook = hook(c);
  p.serveFloor = (f: FloorData) => {
    if (c.ticking) {
      const { every, from } = c.ticking;
      f.workerHeartbeat = new Date(from + Math.floor((now(c) - from) / every) * every).toISOString();
    }
    return f;
  };
  p.rendered = () => {
    if (p.page === "floor" && p.tree) c.renders.push({ at: now(c), banners: banners(p.tree).map(text) });
  };
  const world = this;
  p.opened = async (page: PageName) => {
    if (page === "floor") await follow(world);
    else leave(world);
  };
  // PBI 278's `the SPA sends the browser to` reads where the shell sent the browser from its own stand-ins.
  w.pbi278 = { ...(w.pbi278 ?? {}), fake: { navigations: p.navigations, calls: [], shown: p.shown } };
});

After({ tags: "@pbi-280", ...long }, async function () {
  const w = this as { pbi280?: Ctx };
  try {
    w.pbi280?.live?.stop();
  } catch {}
  for (const s of w.pbi280?.streams ?? []) {
    try {
      if (!s.closed) s.controller?.close();
    } catch {}
  }
});

/** Starts the live Floor once Floor has opened and drawn from its first read. */
async function follow(world: object): Promise<void> {
  const c = ctx(world);
  const p = pbi279(world);
  c.baseline = c.reads.length;
  c.openedAt = now(c);
  c.navigationsAtOpen = p.navigations.length;
  c.openedBanners = c.renders.at(-1)?.banners;
  c.live?.stop();
  c.live = undefined;
  if (!p.call || p.data === undefined) return;
  try {
    c.live = startLiveFloor({
      call: p.call,
      clock: c.clock,
      onFloor: (data) => {
        c.drawing = c.drawing.then(async () => {
          p.data = data;
          await render(world);
        });
      },
    });
    c.liveError = undefined;
  } catch (e) {
    c.liveError = e instanceof Error ? e.stack ?? e.message : String(e);
  }
  await settle(c);
}

function leave(world: object): void {
  const c = ctx(world);
  try {
    c.live?.stop();
  } catch (e) {
    c.liveError = e instanceof Error ? e.stack ?? e.message : String(e);
  }
  c.live = undefined;
}

async function openFloor(world: object, operator: boolean): Promise<void> {
  role(world, { operator });
  await open(world, "floor");
}

/** The factory sends an event on the stream the SPA has open, if it has one. */
function send(c: Ctx): void {
  c.sent.push(now(c));
  const s = openStream(c);
  if (!s) return;
  try {
    s.controller?.enqueue(enc.encode(eventLine(c.sent.length)));
  } catch {}
}

function end(c: Ctx, how: "ended" | "dropped"): void {
  c.endedAt = now(c);
  const s = openStream(c);
  if (!s) return;
  s.closed = how;
  s.closedAt = now(c);
  try {
    if (how === "ended") s.controller?.close();
    else s.controller?.error(new TypeError("network error"));
  } catch {}
}

async function reason(world: object, field: ReasonField): Promise<void> {
  const c = ctx(world);
  c.field = field;
  c.live?.reasonField(field);
  await settle(c);
}

/** The Reason field under Controls, as the page renders it: the control its "Reason" label is for. */
function reasonFieldOf(root: El): El {
  const s = section(root, "Controls");
  const label = all(s).find((e) => e.tag === "label" && text(e) === "Reason");
  assert.ok(label, `Floor's Controls have no "Reason" label: ${JSON.stringify(text(s).slice(0, 400))}`);
  const target = all(root).find((e) => e.attrs.id === label.attrs.for && (e.tag === "input" || e.tag === "textarea"));
  assert.ok(target, `the "Reason" label is for no field`);
  return target;
}

const liveNote = (c: Ctx) => (c.liveError ? `, and starting the live Floor failed: ${c.liveError}` : "");
const attempts = (c: Ctx, from = c.openedAt ?? 0) => c.streams.filter((s) => s.at >= from);
const describe = (ss: Stream[]) => JSON.stringify(ss.map((s) => ({ at: s.at - (ss[0]?.at ?? 0), status: s.status, closed: s.closed ?? null })));

// ---- Given: the viewer and Floor ----

Given("I am a viewer", function () {
  role(this, { operator: false });
});

Given("I am a viewer with Floor open in the SPA", long, async function () {
  await openFloor(this, false);
});

Given("I am a viewer with Floor open in the SPA, showing {string} under {string}", long, async function (label: string, where: string) {
  const p = pbi279(this);
  assert.equal(where, "Next up", `this step puts items under "Next up", not "${where}"`);
  p.floor.next.push(named(p, label));
  await openFloor(this, false);
  includes(section(floorRoot(this), where), label, `Floor's "${where}"`);
});

Given("I am a viewer with Floor open in the SPA, showing {string}", long, async function (shown: string) {
  const m = /^Outbox rows set aside: (\d+)$/.exec(shown);
  assert.ok(m, `this step opens Floor showing the count of outbox rows set aside, not "${shown}"`);
  // The factory's floor holds that count. Showing it is this feature's to build, so the Thens check it.
  pbi279(this).floor.outboxSetAside = Number(m[1]);
  await openFloor(this, false);
});

Given("I am a viewer with Floor open in the SPA, and the worker last ticked {int} seconds ago", long, async function (n: number) {
  const c = ctx(this);
  pbi279(this).floor.workerHeartbeat = new Date(now(c) - n * SECOND).toISOString();
  await openFloor(this, false);
});

// ---- Given: what the factory reports when asked again ----

Given("the factory, asked for the floor again, reports {string} In progress at stage {string}", function (label: string, stage: string) {
  const p = pbi279(this);
  const n = named(p, label);
  p.floor.next = p.floor.next.filter((x) => x.id !== n.id);
  addActive(p, n, { state: "InProgress", stage });
});

Given("the factory, asked for the floor again, reports {string} under {string}", function (label: string, where: string) {
  assert.equal(where, "Next up", `this step puts items under "Next up", not "${where}"`);
  const p = pbi279(this);
  p.floor.next.push(named(p, label));
});

Given("the factory, asked for the floor again, reports a {string} override with the reason {string}", function (kind: string, why: string) {
  const p = pbi279(this);
  override(p, p.floor, kind, why);
});

Given(/^the factory, asked for the floor again, counts (\d+) outbox rows? set aside$/, function (n: string) {
  pbi279(this).floor.outboxSetAside = Number(n);
});

// ---- Given: the BFF ----

Given("the BFF answers {int} to the next {int} attempts to open the event stream", function (status: number, n: number) {
  ctx(this).refuse = { status, left: n };
});

Given("the BFF now answers 401 to the SPA's calls, the event stream included", function () {
  ctx(this).signedOut = true;
});

// ---- Given: the Reason field ----

Given("I have typed {string} in the {string} field under {string}, and the field still has focus", long, async function (typed: string, field: string, under: string) {
  assert.equal(`${field} under ${under}`, "Reason under Controls");
  reasonFieldOf(floorRoot(this));
  const c = ctx(this);
  c.rendersAtTyping = c.renders.length;
  await reason(this, { value: "", focused: true });
  await reason(this, { value: typed, focused: true });
});

Given("I have typed {string} in the {string} field under {string}, then moved focus off the field", long, async function (typed: string, field: string, under: string) {
  assert.equal(`${field} under ${under}`, "Reason under Controls");
  reasonFieldOf(floorRoot(this));
  const c = ctx(this);
  c.rendersAtTyping = c.renders.length;
  await reason(this, { value: "", focused: true });
  await reason(this, { value: typed, focused: true });
  await reason(this, { value: typed, focused: false });
});

Given("the {string} field under {string} has focus and holds nothing", long, async function (field: string, under: string) {
  assert.equal(`${field} under ${under}`, "Reason under Controls");
  reasonFieldOf(floorRoot(this));
  const c = ctx(this);
  c.rendersAtTyping = c.renders.length;
  await reason(this, { value: "", focused: true });
});

Given("the factory sent an event on the stream while I was typing", long, async function () {
  const c = ctx(this);
  send(c);
  await pass(this, SECOND);
});

// ---- Given: the worker's heartbeat and the outbox ----

Given(/^the worker last ticked (\d+) (seconds?|minutes?|hours?|days?) before the SPA's clock$/, function (n: string, unit: string) {
  const c = ctx(this);
  pbi279(this).floor.workerHeartbeat = new Date(now(c) - ms(Number(n), unit)).toISOString();
});

Given("the factory holds no heartbeat for the worker", function () {
  pbi279(this).floor.workerHeartbeat = null;
});

Given(/^the factory's floor counts (\d+) outbox rows? set aside$/, function (n: string) {
  pbi279(this).floor.outboxSetAside = Number(n);
});

Given("from now on the worker doesn't tick, and the factory sends no event", function () {
  ctx(this).ticking = undefined;
});

Given("from now on the worker ticks every {int} seconds, and the factory sends no event", function (n: number) {
  const c = ctx(this);
  c.ticking = { every: n * SECOND, from: now(c) };
});

// ---- When ----

When("the factory sends an event on the stream", long, async function () {
  send(ctx(this));
  await settle(ctx(this));
});

When("the factory sends an event on whichever stream the SPA has open", long, async function () {
  send(ctx(this));
  await settle(ctx(this));
});

When("the factory sends {int} events on the stream within half a second", long, async function (n: number) {
  const c = ctx(this);
  for (let i = 0; i < n; i++) {
    if (i > 0) await pass(this, Math.floor(450 / (n - 1)));
    send(c);
  }
  await settle(c);
});

When(/^a (second|minute) passes(?: after the last of them)?$/, long, async function (unit: string) {
  await pass(this, ms(1, unit));
});

When("I go from Floor to Activity", long, async function () {
  await open(this, "activity");
  const c = ctx(this);
  c.baseline = c.reads.length;
  await settle(c);
});

When("the factory ends the event stream, as it does after five minutes", long, async function () {
  const c = ctx(this);
  end(c, "ended");
  await settle(c);
});

When(/^the event stream drops(?: without the factory ending it, as when the BFF restarts)?$/, long, async function () {
  const c = ctx(this);
  end(c, "dropped");
  await settle(c);
});

When("I clear the {string} field and move focus off it", long, async function (field: string) {
  assert.equal(field, "Reason");
  await reason(this, { value: "", focused: true });
  await reason(this, { value: "", focused: false });
});

// ---- Then: the stream ----

Then("the SPA opens the event stream at {string}", function (path: string) {
  const c = ctx(this);
  const tried = attempts(c);
  assert.ok(tried.length > 0 && pbi279(this).requests.some((r) => r.method === "GET" && r.path === path), `the SPA didn't call GET ${path} once Floor opened${liveNote(c)}`);
  assert.ok(tried.some(isOpen), `the SPA has no stream open at ${path}: ${describe(tried)}`);
});

Then("the SPA opens the event stream at {string} again within {int} seconds", long, async function (path: string, n: number) {
  const c = ctx(this);
  assert.equal(path, EVENTS_PATH);
  assert.ok(c.endedAt !== undefined, "no stream ended");
  const ended = c.endedAt;
  for (let waited = 0; waited < n * SECOND && !c.streams.some((s) => s.at >= ended && isOpen(s)); waited += 500) await pass(this, 500);
  const again = c.streams.find((s) => s.at >= ended && isOpen(s));
  assert.ok(again, `the SPA didn't open a new stream within ${n} seconds of the last one ending: ${describe(attempts(c))}${liveNote(c)}`);
  assert.ok(again.at - ended <= n * SECOND, `the SPA opened a new stream ${again.at - ended} ms after the last one ended`);
});

Then("once the new stream is open, the SPA reads the floor from the factory again", long, async function () {
  const c = ctx(this);
  const s = c.streams.filter((x) => c.endedAt !== undefined && x.at >= c.endedAt && x.status === 200).at(0);
  assert.ok(s, `no new stream opened: ${describe(attempts(c))}`);
  await pass(this, SECOND);
  assert.ok(c.reads.some((r) => r >= s.at), `the SPA didn't read the floor once the new stream opened: it read at ${JSON.stringify(c.reads.map((r) => r - s.at))} ms from then`);
});

Then("the SPA closes Floor's event stream", function () {
  const c = ctx(this);
  const opened = c.streams.filter((s) => s.status === 200);
  assert.ok(opened.length > 0, `Floor opened no event stream${liveNote(c)}`);
  const left = opened.filter((s) => s.closed !== "closed");
  assert.equal(left.length, 0, `the SPA left Floor's event stream open: ${describe(opened)}`);
});

Then("an event the factory sends afterwards doesn't make the SPA read the floor", long, async function () {
  const c = ctx(this);
  const before = c.reads.length;
  for (const s of c.streams.filter((x) => x.status === 200)) {
    try {
      s.controller?.enqueue(enc.encode(eventLine(99)));
    } catch {}
  }
  await pass(this, 5 * SECOND);
  assert.equal(c.reads.length, before, "the SPA read the floor after an event, though Floor isn't open");
});

Then("the SPA has tried to open the event stream at least {int} times", function (n: number) {
  const c = ctx(this);
  const tried = attempts(c, c.endedAt);
  assert.ok(tried.length >= n, `the SPA tried to open the stream ${tried.length} times after it dropped: ${describe(tried)}${liveNote(c)}`);
});

Then("it waited at least a second between one attempt and the next", function () {
  const c = ctx(this);
  const tried = attempts(c, c.endedAt);
  assert.ok(tried.length > 1, `the SPA made ${tried.length} attempts after the stream dropped`);
  for (let i = 1; i < tried.length; i++) {
    assert.ok(tried[i].at - tried[i - 1].at >= SECOND, `the SPA tried again ${tried[i].at - tried[i - 1].at} ms after its last attempt: ${describe(tried)}`);
  }
});

Then("once a stream opens, the SPA reads the floor from the factory again", long, async function () {
  const c = ctx(this);
  const s = attempts(c, c.endedAt).find((x) => x.status === 200);
  assert.ok(s, `no stream opened after the drop: ${describe(attempts(c, c.endedAt))}`);
  await pass(this, SECOND);
  assert.ok(c.reads.some((r) => r >= s.at), "the SPA didn't read the floor once a stream opened");
});

Then("the SPA still has the event stream at {string} open", function (path: string) {
  const c = ctx(this);
  assert.equal(path, EVENTS_PATH);
  assert.ok(openStream(c), `the SPA has no event stream open: ${describe(attempts(c))}${liveNote(c)}`);
});

// ---- Then: reading the floor ----

Then("the SPA reads the floor from the factory again", function () {
  const c = ctx(this);
  assert.ok(c.reads.length > c.baseline, `the SPA hasn't read the floor since Floor opened${liveNote(c)}`);
});

Then("the SPA has read the floor from the factory once more, not {int} times", function (_n: number) {
  const c = ctx(this);
  assert.equal(c.reads.length - c.baseline, 1, `the SPA read the floor ${c.reads.length - c.baseline} times since Floor opened${liveNote(c)}`);
});

Then("the SPA hasn't read the floor from the factory again", function () {
  const c = ctx(this);
  assert.equal(c.reads.length - c.baseline, 0, `the SPA read the floor ${c.reads.length - c.baseline} times since Floor opened`);
});

Then("the SPA has read the floor from the factory again during those {int} minutes, though no event arrived", function (_n: number) {
  const c = ctx(this);
  assert.equal(c.sent.length, 0, "the factory sent an event");
  assert.ok(c.reads.length > c.baseline, `the SPA hasn't read the floor since Floor opened${liveNote(c)}`);
});

// ---- Then: what Floor shows ----

Then("the {string} table has a row for {string} showing {string} and {string}", function (name: string, what: string, a: string, b: string) {
  const t = table(section(floorRoot(this), name), `Floor's "${name}"`);
  showsCells(rowFor(t, what), [a, b]);
});

Then("Floor shows nothing under {string} but {string}", function (where: string, want: string) {
  assert.equal(text(section(floorRoot(this), where)), want);
});

Then("Floor shows {string} under {string}", function (what: string, where: string) {
  includes(section(floorRoot(this), where), what, `Floor's "${where}"`);
});

Then("the browser didn't reload the page", function () {
  const c = ctx(this);
  const p = pbi279(this);
  floorRoot(this);
  assert.deepEqual(p.navigations.slice(c.navigationsAtOpen), [], "the SPA sent the browser to another page");
  assert.equal(c.liveError, undefined, `starting the live Floor failed: ${c.liveError}`);
});

Then("the {string} field still holds {string}", function (field: string, want: string) {
  const c = ctx(this);
  assert.equal(field, "Reason");
  reasonFieldOf(floorRoot(this));
  assert.equal(c.field?.value, want, `the Reason field holds ${JSON.stringify(c.field?.value)}`);
  assert.equal(c.renders.length, c.rendersAtTyping, "Floor was drawn afresh from a new read while the reason was typed, which loses it");
});

Then("Floor shows {string} next to the worker's heartbeat", function (want: string) {
  const root = floorRoot(this);
  const holding = all(root).filter((e) => text(e).includes(want));
  const inner = holding.filter((e) => !all(e).some((x) => holding.includes(x)));
  assert.ok(inner.length > 0, `Floor doesn't show "${want}": ${JSON.stringify(text(root).slice(0, 800))}`);
  const near = inner.some((e) => [e, e.parent, e.parent?.parent].some((x) => x && /worker/i.test(text(x))));
  assert.ok(near, `"${want}" isn't next to the worker's heartbeat: ${JSON.stringify(inner.map((e) => text(e.parent?.parent ?? e)))}`);
});

Then("Floor has at no point shown a banner beginning {string}", function (lead: string) {
  const c = ctx(this);
  floorRoot(this);
  const shown = c.renders.filter((r) => r.banners.some((b) => b.startsWith(lead)));
  assert.equal(shown.length, 0, `Floor showed a banner beginning "${lead}" at ${JSON.stringify(shown.map((r) => r.at - (c.openedAt ?? 0)))} ms`);
});

Then("Floor showed a banner beginning {string} when I opened it", function (lead: string) {
  const c = ctx(this);
  assert.ok(c.openedBanners?.some((b) => b.startsWith(lead)), `Floor opened with no banner beginning "${lead}": ${JSON.stringify(c.openedBanners)}`);
});

Then("Floor now shows no banner beginning {string}", function (lead: string) {
  const got = banners(floorRoot(this)).map(text);
  assert.ok(!got.some((b) => b.startsWith(lead)), `Floor still has a banner beginning "${lead}": ${JSON.stringify(got)}`);
});

// ---- The BFF passes the event stream through ----

function memorySessions(s: Session & { cookieHash: string }): SessionStore {
  const rows = new Map<string, Session>([[s.cookieHash, s]]);
  return {
    async create(n: NewSession) {
      rows.set(n.cookieHash, n);
    },
    async find(hash) {
      return rows.get(hash) ?? null;
    },
    async updateTokens(hash, t) {
      const r = rows.get(hash);
      if (r) rows.set(hash, { ...r, ...t });
    },
    async remove(hash) {
      rows.delete(hash);
    },
  };
}

Given("the BFF forwards to a stub API whose event stream stays open until the stub ends it", function () {
  const c = ctx(this);
  const clock = fakeClock(new Date());
  const id = newSessionId();
  const sessions = memorySessions({
    cookieHash: hashSessionId(id), issuer: "https://login.test", subject: "alice",
    accessToken: "access-alice", accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshTokenEncrypted: null,
  });
  const bff: Partial<Bff> = { clock, cookie: `${SESSION_COOKIE}=${id}` };
  const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname !== "/v1/events") return json(404, { error: "not found" });
    const s: Stream = { at: clock.now().getTime(), status: 200 };
    bff.api = s;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        s.controller = controller;
        controller.enqueue(enc.encode(": open\n\n"));
      },
      cancel() {
        s.closed ??= "closed";
      },
    });
    // fetch ends the response's body when its signal aborts, so the stub does too.
    init?.signal?.addEventListener("abort", () => {
      if (s.closed) return;
      s.closed = "closed";
      try {
        s.controller?.error(init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      } catch {}
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  bff.app = createBff({
    issuer: "https://login.test", clientId: "dashboard", scopes: "openid", origin: "http://bff.test", key: randomBytes(32), sessions,
    apiUrl: "http://api.test", fetch: apiFetch,
    timeout: (n) => {
      const a = new AbortController();
      clock.setTimeout(() => a.abort(new DOMException("The operation timed out.", "TimeoutError")), n);
      return a.signal;
    },
  });
  c.bff = bff as Bff;
});

Given("a browser with a session has opened {string} on the BFF", long, async function (path: string) {
  const c = ctx(this);
  const b = c.bff;
  assert.ok(b, "no BFF is running");
  const r = await b.app.fetch(new Request(`http://bff.test${path}`, { headers: { cookie: b.cookie, accept: "text/event-stream" } }));
  if (r.status !== 200) assert.fail(`the BFF answered ${r.status}: ${await r.text()}`);
  assert.ok(r.body, "the BFF's answer has no body");
  const seen: NonNullable<Bff["browser"]> = { text: "", status: r.status };
  b.browser = seen;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          seen.ended = "end";
          return;
        }
        seen.text += dec.decode(value, { stream: true });
      }
    } catch (e) {
      seen.ended = "error";
      seen.error = e instanceof Error ? e.message : String(e);
    }
  })();
  for (let i = 0; i < 20; i++) await tick();
  assert.ok(b.api, "the BFF didn't call the API's /v1/events");
});

When("the stub API sends an event {int} seconds after the stream opened, past the BFF's 30 seconds for a call", long, async function (n: number) {
  const b = ctx(this).bff!;
  await b.clock.advance(n * SECOND - (b.clock.now().getTime() - b.api!.at));
  b.event = eventLine(280);
  try {
    b.api!.controller?.enqueue(enc.encode(b.event));
  } catch {}
  for (let i = 0; i < 20; i++) await tick();
});

Then("the browser receives that event on the stream as soon as the API sends it", function () {
  const b = ctx(this).bff!;
  assert.ok(b.browser?.text.includes(b.event!), `the browser didn't receive the event: it got ${JSON.stringify(b.browser?.text)}, and its stream ${b.browser?.ended ? `ended (${b.browser.ended}${b.browser.error ? `: ${b.browser.error}` : ""})` : "is open"}`);
});

Then("the browser's stream is still open", function () {
  const b = ctx(this).bff!;
  assert.equal(b.browser?.ended, undefined, `the browser's stream ended (${b.browser?.ended}${b.browser?.error ? `: ${b.browser.error}` : ""})`);
});

Then("when the stub API ends the stream, the browser's stream ends too", long, async function () {
  const b = ctx(this).bff!;
  try {
    b.api!.controller?.close();
  } catch {}
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(b.browser?.ended, "end", `the browser's stream ${b.browser?.ended ? `ended (${b.browser.ended})` : "is still open"}`);
});

// ---- The API's floor counts the outbox rows set aside ----

const pool = () => need().pool;

// The API runs against PBI 284's fake issuer, as PBI 286's scenarios do in their Background, and gets the database.
Before({ tags: "@pbi-280 and @db", ...long }, async function () {
  const c = pbi284(this);
  c.db = true;
  await startIssuer(c);
  c.audience = "factory-api";
});

After({ tags: "@pbi-280 and @db", ...long }, async function () {
  await stopAll(this);
});

/** Writes `n` outbox rows, each with an event of its own, that have failed `attempts` times. */
async function outboxRows(n: number, attempts: number, setAside: boolean): Promise<void> {
  for (let i = 0; i < n; i++) {
    const e = await pool().query<{ id: string }>("insert into event (actor, actor_id, kind) values ('system', 'pbi-280', 'test') returning id");
    await pool().query(
      `insert into outbox (consumer, event_id, attempts, next_attempt_at, failed_at)
       values ($1, $2, $3, now() + case when $3::int > 0 then interval '10 minutes' else interval '0' end, case when $4 then now() end)`,
      [CONSUMER.boardMirror, e.rows[0].id, attempts, setAside],
    );
  }
}

Given(/^the outbox holds (\d+) rows? the worker set aside after their tenth failed attempt$/, long, async function (n: string) {
  await outboxRows(Number(n), 10, true);
});

Given(/^(?:the outbox|it) holds (\d+) rows? that has failed (\d+) times and waits to be tried again$/, long, async function (n: string, times: string) {
  await outboxRows(Number(n), Number(times), false);
});

Given(/^it holds (\d+) rows? that hasn't been tried yet$/, long, async function (n: string) {
  await outboxRows(Number(n), 0, false);
});

Then(/^the floor counts (\d+) outbox rows? set aside$/, function (n: string) {
  const c = pbi284(this);
  const b = body(c) as { outboxSetAside?: unknown };
  assert.equal(b.outboxSetAside, Number(n), `the floor's outboxSetAside is ${JSON.stringify(b.outboxSetAside)}`);
});
