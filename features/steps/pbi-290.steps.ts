// Step definitions for features/pbi-290-bff-webhooks-and-events.feature.
//
// The scenarios run the BFF as `node src/bff/main.ts` in a child process against the test provider and the stand-in
// API, through the Background steps of PBI 288 and PBI 289 (features/steps/pbi-288.steps.ts and pbi-289.steps.ts),
// and share their context. The stand-in API (features/fixtures/pbi-289-api.ts) records each call's bytes as they
// arrived, and can hold a GET open as a stream of server-sent events that follows a scenario's plan.
// GitHub is played by a plain fetch that posts a delivery's exact bytes and headers to the BFF, with no cookie and no
// Origin, as GitHub does. The browser's event stream is a fetch with alice's session cookie whose body is read as it
// arrives, so each event's arrival time is recorded.
// Every step asserts something. A Given asserts only what it arranges, so a scenario can't pass on a precondition that
// never held.
import { After, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { ApiCall, ApiStream, StreamPlan } from "../fixtures/pbi-289-api.ts";
import { answers, bffHost, bffUrl, browser, ctx as shared, providerOf, stopBff, type Seen } from "./pbi-288.steps.ts";
import { ctx as forwarding } from "./pbi-289.steps.ts";
import { long } from "./pbi-8.steps.ts";

/** The secret the API checks deliveries against. The stand-in doesn't check it: the API's real routes aren't built yet. */
const WEBHOOK_SECRET = "pbi-290-webhook-secret";
const WRONG_SECRET = "not-the-webhook-secret";
/** How far an event's arrival may drift from the time it was meant for, and still count as about then. */
const ABOUT_MS = 5_000;
/** How near the browser must get an event to the moment the API sent it. */
const PROMPT_MS = 2_000;

type Delivery = { body: Buffer; headers: Record<string, string> };

type EventStream = {
  controller: AbortController;
  /** Epoch milliseconds when the browser asked for the stream, and when the BFF answered. */
  askedAt: number;
  openedAt: number;
  status: number;
  received: { event: string; at: number }[];
  ended?: { at: number; error?: string };
  /** When the browser closed the stream itself. */
  closedAt?: number;
};

type Ctx = { delivery?: Delivery; stream?: EventStream };

function ctx(world: object): Ctx {
  const w = world as { pbi290?: Ctx };
  w.pbi290 ??= {};
  return w.pbi290;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

After({ tags: "@pbi-290", ...long }, async function () {
  ctx(this).stream?.controller.abort();
  const s = shared(this);
  await stopBff(s);
  await s.provider?.stop();
  await forwarding(this).api?.stop();
});

// ---- GitHub's deliveries ----

/**
 * A delivery's JSON as GitHub writes it: its own key order, which isn't sorted, its own spacing, and a \u escape, so
 * anything that parses and writes it again changes its bytes.
 */
function githubJson(event: string, id: string, extra = ""): string {
  return (
    `{"action":"created","delivery_hint":"${id}",  "event": "${event}",` +
    `"repository":{"name":"software-factory","id":71234567,"full_name":"factory/software-factory"},` +
    `"comment":{"body":"Caf\\u00e9 r\\u00e9sum\\u00e9 \\ud83d\\ude80","user":{"login":"alice","id":4242}},` +
    `"sender":{"login":"alice" , "id":4242}${extra}}\n`
  );
}

function headersFor(event: string, id: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "user-agent": "GitHub-Hookshot/7a3c2e1",
    "x-github-event": event,
    "x-github-delivery": id,
    "x-github-hook-id": "482910",
    "x-github-hook-installation-target-type": "repository",
    "x-github-hook-installation-target-id": "71234567",
  };
}

function sign(d: Delivery, secret: string): void {
  d.headers["x-hub-signature"] = `sha1=${createHmac("sha1", secret).update(d.body).digest("hex")}`;
  d.headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(d.body).digest("hex")}`;
}

function arrange(world: object, d: Delivery, event: string, id: string): void {
  ctx(world).delivery = d;
  assert.equal(d.headers["x-github-event"], event, "the delivery doesn't name its event");
  assert.equal(d.headers["x-github-delivery"], id, "the delivery doesn't carry its id");
  assert.ok(d.body.length > 0, "the delivery has no body");
}

function delivery(world: object): Delivery {
  const d = ctx(world).delivery;
  assert.ok(d, "no GitHub delivery was arranged");
  return d;
}

function json(event: string, id: string): Delivery {
  return { body: Buffer.from(githubJson(event, id), "utf8"), headers: headersFor(event, id, "application/json") };
}

Given("a GitHub {string} delivery {string}", function (event: string, id: string) {
  arrange(this, json(event, id), event, id);
});

Given("a GitHub {string} delivery {string} whose body has GitHub's own spacing and key order", function (event: string, id: string) {
  const d = json(event, id);
  arrange(this, d, event, id);
  const text = d.body.toString("utf8");
  assert.notEqual(JSON.stringify(JSON.parse(text)), text, "the body reads the same written again, so it can't show a rewrite");
});

Given("the delivery is signed with the webhook secret", function () {
  const d = delivery(this);
  sign(d, WEBHOOK_SECRET);
  const want = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(d.body).digest("hex")}`;
  assert.equal(d.headers["x-hub-signature-256"], want, "the delivery isn't signed with the webhook secret");
  assert.ok(d.headers["x-hub-signature"]?.startsWith("sha1="), "the delivery carries no X-Hub-Signature");
});

Given("a GitHub {string} delivery {string} signed with the wrong secret", function (event: string, id: string) {
  const d = json(event, id);
  sign(d, WRONG_SECRET);
  arrange(this, d, event, id);
  const right = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(d.body).digest("hex")}`;
  assert.ok(d.headers["x-hub-signature-256"], "the delivery isn't signed");
  assert.notEqual(d.headers["x-hub-signature-256"], right, "the delivery is signed with the webhook secret");
});

Given("a GitHub {string} delivery {string} sent form-encoded, with its JSON in the payload field", function (event: string, id: string) {
  const payload = githubJson(event, id);
  const d: Delivery = {
    body: Buffer.from(new URLSearchParams({ payload }).toString(), "utf8"),
    headers: headersFor(event, id, "application/x-www-form-urlencoded"),
  };
  arrange(this, d, event, id);
  assert.equal(new URLSearchParams(d.body.toString("utf8")).get("payload"), payload, "the payload field doesn't hold the JSON");
});

Given("a GitHub {string} delivery {string} whose body holds bytes that aren't valid UTF-8", function (event: string, id: string) {
  const text = githubJson(event, id, `,"blob":"`);
  // The bytes go inside the "blob" string, so the rest is still GitHub's JSON: 0xff and 0xfe never appear in UTF-8,
  // and 0xc3 0x28 is a lead byte with no continuation.
  const d: Delivery = {
    body: Buffer.concat([Buffer.from(text.slice(0, -2), "utf8"), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80]), Buffer.from(`"}\n`, "utf8")]),
    headers: headersFor(event, id, "application/json"),
  };
  arrange(this, d, event, id);
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(d.body), "the body is valid UTF-8");
});

Given("a GitHub {string} delivery {string} with a body of {int} MB", function (event: string, id: string, mb: number) {
  const size = mb * 1024 * 1024;
  const head = githubJson(event, id).slice(0, -2) + `,"padding":"`;
  const tail = `"}\n`;
  const fill = size - Buffer.byteLength(head) - Buffer.byteLength(tail);
  assert.ok(fill > 0, `${mb} MB is too small for a delivery`);
  // A repeating, varied filler, so a body cut short or with a chunk repeated doesn't match.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let pad = "";
  for (let i = 0; pad.length < fill; i++) pad += alphabet[(i * 7 + (i >> 5)) % alphabet.length];
  const d: Delivery = {
    body: Buffer.concat([Buffer.from(head), Buffer.from(pad.slice(0, fill)), Buffer.from(tail)]),
    headers: headersFor(event, id, "application/json"),
  };
  arrange(this, d, event, id);
  assert.equal(d.body.length, size, `the body is ${d.body.length} bytes, not ${size}`);
});

Given("a GitHub {string} delivery {string} with the extra header {string} set to {string}", function (event: string, id: string, header: string, value: string) {
  const d = json(event, id);
  d.headers[header.toLowerCase()] = value;
  arrange(this, d, event, id);
  assert.equal(d.headers[header.toLowerCase()], value, `the delivery doesn't carry ${header}`);
});

// ---- The API ----

Given("the API is down", long, async function () {
  const api = forwarding(this).api;
  assert.ok(api, "no stand-in API is running");
  await api.stop();
  const port = Number(new URL(api.url).port);
  assert.ok(!api.up && !(await answers(port)), `the stand-in API still answers on port ${port}`);
});

const seconds = (text: string): number => {
  const m = /^(\d+)\s+seconds?$/.exec(text.trim());
  assert.ok(m, `"${text}" isn't a number of seconds`);
  return Number(m[1]) * 1000;
};

function plan(world: object, url: string, p: StreamPlan): void {
  const api = forwarding(world).api;
  assert.ok(api, "no stand-in API is running");
  api.stream(url, p);
  assert.deepEqual(api.streaming(url), p, `the stand-in API won't stream ${url} as told`);
}

Given("the API will hold {string} open and send the event {string} after {int} seconds", function (url: string, event: string, s: number) {
  plan(this, url, { events: [{ afterMs: s * 1000, event }] });
});

Given("the API will hold {string} open and send these events:", function (url: string, table: DataTable) {
  const events = table.hashes().map((r) => ({ afterMs: seconds(r.after), event: r.event }));
  assert.ok(events.length > 0, "the table lists no events");
  plan(this, url, { events });
});

Given("the API will hold {string} open, send the event {string} after {int} seconds, and end the stream after {int} seconds", function (url: string, event: string, s: number, end: number) {
  plan(this, url, { events: [{ afterMs: s * 1000, event }], endAfterMs: end * 1000 });
});

Given("the API will hold {string} open until its caller leaves", function (url: string) {
  plan(this, url, { events: [] });
});

// ---- GitHub posting ----

async function post(world: object, path: string): Promise<void> {
  const d = delivery(world);
  const url = bffUrl(shared(world), path);
  let seen: Seen;
  try {
    const r = await fetch(url, { method: "POST", headers: d.headers, body: new Uint8Array(d.body), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    seen = { url, method: "POST", status: r.status, headers: r.headers, setCookies: [], body: await r.text() };
  } catch (e) {
    seen = { url, method: "POST", status: 0, headers: new Headers(), setCookies: [], body: String(e) };
  }
  assert.notEqual(seen.status, 0, `the BFF didn't answer POST ${path}: ${seen.body}`);
  forwarding(world).last = seen;
}

When("GitHub posts the delivery to the BFF at {string}", long, async function (path: string) {
  await post(this, path);
});

When("GitHub posts the delivery to the BFF at {string} with no cookie and no Origin", long, async function (path: string) {
  const d = delivery(this);
  assert.ok(!("cookie" in d.headers) && !("origin" in d.headers), "the delivery carries a cookie or an Origin");
  await post(this, path);
});

// ---- What the API received ----

function onlyCall(world: object): ApiCall {
  const api = forwarding(world).api;
  assert.ok(api, "no stand-in API is running");
  const cs = api.calls;
  assert.equal(cs.length, 1, `the API received ${cs.length} calls: ${JSON.stringify(cs.map((x) => `${x.method} ${x.url}`))}`);
  return cs[0];
}

function sentHeader(world: object, header: string): string {
  const v = delivery(world).headers[header.toLowerCase()];
  assert.ok(v !== undefined, `GitHub sent no ${header}`);
  return v;
}

Then("that call's body is byte for byte the body GitHub sent", function () {
  const k = onlyCall(this);
  const sent = delivery(this).body;
  if (k.raw.equals(sent)) return;
  let i = 0;
  while (i < k.raw.length && i < sent.length && k.raw[i] === sent[i]) i++;
  assert.fail(`${k.method} ${k.url} carried ${k.raw.length} bytes, not the ${sent.length} GitHub sent; they differ from byte ${i}`);
});

Then("that call carried these headers with the values GitHub sent:", function (table: DataTable) {
  const k = onlyCall(this);
  const rows = table.hashes().map((r) => r.header);
  assert.ok(rows.length > 0, "the table lists no headers");
  for (const h of rows) {
    assert.equal(k.headers[h.toLowerCase()], sentHeader(this, h), `${k.method} ${k.url} didn't carry ${h} as GitHub sent it`);
  }
});

Then("that call carried the Content-Type {string}", function (type: string) {
  const k = onlyCall(this);
  assert.equal(sentHeader(this, "Content-Type"), type, `GitHub didn't send the Content-Type ${type}`);
  assert.equal(k.headers["content-type"], type, `${k.method} ${k.url} carried the Content-Type ${k.headers["content-type"]}`);
});

Then("that call carried the header {string} with the value {string}", function (header: string, value: string) {
  const k = onlyCall(this);
  assert.equal(k.headers[header.toLowerCase()], value, `${k.method} ${k.url} carried ${header}: ${k.headers[header.toLowerCase()]}`);
});

Then("that call carried no Authorization header", function () {
  const k = onlyCall(this);
  assert.equal(k.headers.authorization, undefined, `${k.method} ${k.url} carried Authorization: ${k.headers.authorization}`);
});

Then("that call didn't carry alice's access token", function () {
  const k = onlyCall(this);
  const tokens = providerOf(shared(this)).issued.filter((i) => i.user === "alice").map((i) => i.accessToken);
  assert.ok(tokens.length > 0, "the provider issued alice no access token");
  const sent = `${k.url}\n${Object.entries(k.headers).map(([h, v]) => `${h}: ${v}`).join("\n")}\n${k.body}`;
  for (const t of tokens) assert.ok(!sent.includes(t), `${k.method} ${k.url} carried alice's access token`);
});

Then("that call carried the X-Hub-Signature-256 GitHub sent", function () {
  const k = onlyCall(this);
  assert.equal(k.headers["x-hub-signature-256"], sentHeader(this, "X-Hub-Signature-256"), `${k.method} ${k.url} didn't carry GitHub's signature`);
});

// ---- The browser's event stream ----

/** Reads a stream of server-sent events as it arrives, recording each event's name and arrival time, and its end. */
async function read(s: EventStream, body: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const name = block.split("\n").find((l) => l.startsWith("event:"))?.slice("event:".length).trim();
        if (name) s.received.push({ event: name, at: Date.now() });
      }
    }
    s.ended = { at: Date.now() };
  } catch (e) {
    s.ended = { at: Date.now(), error: s.controller.signal.aborted ? "closed by the browser" : String((e as Error).cause ?? e) };
  }
}

When("alice's browser opens the event stream at {string}", long, async function (path: string) {
  const s = shared(this);
  const jar = browser(s, 1).cookies(bffHost);
  assert.ok(jar.size > 0, "alice's browser holds no cookies");
  const controller = new AbortController();
  const askedAt = Date.now();
  const opening = fetch(bffUrl(s, path), {
    headers: { accept: "text/event-stream", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    redirect: "manual",
    signal: controller.signal,
  });
  const r = await Promise.race([opening, sleep(20_000).then(() => null)]);
  if (!r) controller.abort();
  assert.ok(r, `the BFF didn't answer GET ${path} within 20 seconds`);
  const stream: EventStream = { controller, askedAt, openedAt: Date.now(), status: r.status, received: [] };
  ctx(this).stream = stream;
  if (r.body) void read(stream, r.body);
  else stream.ended = { at: Date.now() };
});

When("alice's browser keeps listening for {int} seconds and then closes the stream", long, async function (s: number) {
  const st = eventStream(this);
  await sleep(Math.max(0, st.askedAt + s * 1000 - Date.now()));
  st.controller.abort();
  st.closedAt = Date.now();
  assert.ok(st.controller.signal.aborted, "the browser didn't close its stream");
});

function eventStream(world: object): EventStream {
  const s = ctx(world).stream;
  assert.ok(s, "alice's browser didn't open the event stream");
  return s;
}

/** Waits until `done` holds, the stream ends, or `until` (epoch milliseconds) passes. */
async function waitFor(s: EventStream, done: () => boolean, until: number): Promise<void> {
  while (!done() && !s.ended && Date.now() < until) await sleep(100);
}

const describe = (s: EventStream) =>
  `the stream answered ${s.status}, received ${JSON.stringify(s.received.map((e) => `${e.event} at ${((e.at - s.askedAt) / 1000).toFixed(1)}s`))}` +
  (s.ended ? `, and ended at ${((s.ended.at - s.askedAt) / 1000).toFixed(1)}s${s.ended.error ? ` with ${s.ended.error}` : ""}` : "");

function apiPlan(world: object): StreamPlan {
  const api = forwarding(world).api;
  assert.ok(api, "no stand-in API is running");
  const p = api.streaming("/v1/events");
  assert.ok(p, "the API wasn't told to stream /v1/events");
  return p;
}

function apiStream(world: object): ApiStream {
  const api = forwarding(world).api;
  assert.ok(api, "no stand-in API is running");
  assert.equal(api.streams.length, 1, `the API held ${api.streams.length} streams`);
  return api.streams[0];
}

Then("alice's browser receives the event {string} after about {int} seconds", long, async function (event: string, secs: number) {
  const s = eventStream(this);
  const seen = () => s.received.find((e) => e.event === event);
  await waitFor(s, () => !!seen(), s.askedAt + secs * 1000 + ABOUT_MS * 2);
  const e = seen();
  assert.ok(e, `alice's browser didn't receive "${event}": ${describe(s)}`);
  const after = e.at - s.askedAt;
  assert.ok(Math.abs(after - secs * 1000) <= ABOUT_MS, `"${event}" arrived after ${(after / 1000).toFixed(1)} seconds, not about ${secs}`);
});

Then("alice's event stream is still open after it receives {string}", long, async function (event: string) {
  const s = eventStream(this);
  const e = s.received.find((x) => x.event === event);
  assert.ok(e, `alice's browser didn't receive "${event}": ${describe(s)}`);
  await sleep(Math.max(0, e.at + 3_000 - Date.now()));
  assert.ok(!s.ended, `alice's event stream closed after "${event}": ${describe(s)}`);
});

Then("alice's browser receives each event at about the time the API sent it", long, async function () {
  const s = eventStream(this);
  const p = apiPlan(this);
  const last = Math.max(...p.events.map((e) => e.afterMs));
  await waitFor(s, () => s.received.length >= p.events.length, s.askedAt + last + ABOUT_MS * 2);
  const sent = apiStream(this).sent;
  for (const planned of p.events) {
    const out = sent.find((x) => x.event === planned.event);
    assert.ok(out, `the API never sent "${planned.event}", as the BFF's stream had closed: ${describe(s)}`);
    const got = s.received.find((x) => x.event === planned.event);
    assert.ok(got, `alice's browser didn't receive "${planned.event}": ${describe(s)}`);
    assert.ok(Math.abs(got.at - out.at) <= PROMPT_MS, `"${planned.event}" reached the browser ${got.at - out.at} ms after the API sent it`);
  }
});

Then("alice's browser receives {string}, {string} and {string} in that order", long, async function (a: string, b: string, c: string) {
  const s = eventStream(this);
  const p = apiPlan(this);
  const last = Math.max(...p.events.map((e) => e.afterMs));
  await waitFor(s, () => s.received.length >= 3, s.askedAt + last + ABOUT_MS * 2);
  assert.deepEqual(s.received.map((e) => e.event), [a, b, c], describe(s));
});

Then("alice's browser receives the event {string}", long, async function (event: string) {
  const s = eventStream(this);
  const p = apiPlan(this);
  const planned = p.events.find((e) => e.event === event);
  assert.ok(planned, `the API wasn't told to send "${event}"`);
  await waitFor(s, () => s.received.some((e) => e.event === event), s.askedAt + planned.afterMs + ABOUT_MS * 2);
  assert.ok(s.received.some((e) => e.event === event), `alice's browser didn't receive "${event}": ${describe(s)}`);
});

Then("alice's event stream ends after about {int} seconds without an error", long, async function (secs: number) {
  const s = eventStream(this);
  await waitFor(s, () => false, s.askedAt + secs * 1000 + ABOUT_MS * 2);
  assert.ok(s.ended, `alice's event stream hadn't ended after ${secs} seconds: ${describe(s)}`);
  assert.equal(s.ended.error, undefined, `alice's event stream ended with an error: ${describe(s)}`);
  const after = s.ended.at - s.askedAt;
  assert.ok(Math.abs(after - secs * 1000) <= ABOUT_MS, `alice's event stream ended after ${(after / 1000).toFixed(1)} seconds, not about ${secs}`);
});

Then("the API's stream to the BFF was still open after {int} seconds", function (secs: number) {
  const a = apiStream(this);
  const open = (a.closedAt ?? Date.now()) - a.openedAt;
  assert.ok(open >= secs * 1000, `the API's stream to the BFF closed after ${(open / 1000).toFixed(1)} seconds, by the ${a.closedBy}`);
});

Then("the API's stream to the BFF closes within {int} seconds of the browser closing its own", long, async function (secs: number) {
  const s = eventStream(this);
  assert.ok(s.closedAt, "alice's browser didn't close its stream");
  const a = apiStream(this);
  while (a.closedAt === undefined && Date.now() < s.closedAt + secs * 1000 + 500) await sleep(100);
  assert.ok(a.closedAt !== undefined, `the API's stream to the BFF was still open ${secs} seconds after the browser closed its own`);
  const gap = a.closedAt - s.closedAt;
  assert.ok(gap >= 0, `the API's stream to the BFF closed ${(-gap / 1000).toFixed(1)} seconds before the browser closed its own, by the ${a.closedBy}`);
  assert.ok(gap <= secs * 1000, `the API's stream to the BFF closed ${(gap / 1000).toFixed(1)} seconds after the browser closed its own`);
});
