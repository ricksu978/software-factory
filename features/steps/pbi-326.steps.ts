// Step definitions for features/pbi-326-transcript-as-conversation.feature.
//
// What these steps drive:
//   web/src/api.ts               readTranscript(call, id, stage, attempt), the transcript page's one read of the factory
//                                through the shell's call, giving a TranscriptData.
//   web/src/pages/Transcript.tsx Transcript({ data }), the page itself.
//   web/src/routes.ts            routeOf, which reads Run detail's transcript link as { page: "transcript", id, stage,
//                                attempt } for the item's id.
//   web/src/pages/RunDetail.tsx  Run detail, whose Stages table links each stored transcript.
//   src/agent/run.ts             runAgent, which writes each call's transcript.
// PBI 279's Vite SSR loader loads the pages, react-dom/server renders them to a string, and PBI 279's parser reads that
// string as a tree of elements. PBI 279's "transcripts can be served" sets the item's linkBlobs.
//
// The item is a fixture, as Run detail's GET /bff/v1/items/{id} answers it (web/src/api.ts's ItemData), with the one
// stage attempt the feature names. The call the page reads through answers GET /bff/v1/items/{id} with it, and GET
// /bff/v1/blobs/{transcript_ref} with the attempt's stored transcript as text/plain, or 404 when nothing is stored.
// An attempt is running as Run detail has it (PBI 209, PBI 239): the item is InProgress on an open run and the attempt
// is "started" with no end. A cell that died leaves its attempt "stopped", with LEASE_RAN_OUT, once the lease expires.
//
// Every transcript is written by the real runAgent, one call per agent call the attempt made, given the call's brief as
// its prompt and a scripted `send` that yields the call's SDK messages, so the transcript holds whatever runAgent
// writes for a call: today one line per message, and no line for the brief. The page can only show the brief the
// agent got once runAgent writes it into the call's transcript, through onMessage too, so the transcript a running
// attempt has uploaded so far holds it. An attempt's calls follow each other in its transcript, as the cell's meter
// joins them. Each call starts with the SDK's system init message. An assistant turn is written as the SDK streams
// it: one `assistant` message per content block, all with the turn's message id. A tool's result comes in a `user`
// message of tool_result blocks. A subagent task is the SDK's task_started and task_notification system messages,
// the subagent's name being its subagent_type. A running attempt's stored transcript is the lines runAgent's
// onMessage had heard when the cell last uploaded.
//
// What the page's structure means here:
//   an entry        an element with a data-entry attribute, one per step of the conversation, in document order:
//                   "brief" for the brief a call was given, "turn" for an assistant turn (every message with the same
//                   message id), "subagent-start" and "subagent-finish" for a subagent task's start and finish,
//                   "result" for a call's final result, and "unreadable" for a line the page can't read, holding the
//                   line as text. No other message gets an entry: not the system init, a rate limit event, a task
//                   progress update nor a user message of tool results.
//   a part          an element with a data-part attribute inside a turn: "thinking", "text", "tool-call" and
//                   "tool-result". A tool call holds an element with data-slot="tool-name" whose text is the tool's
//                   name, and the short form of its input. A call's result is the first tool-result part after the
//                   call starts, in document order, before any other tool call or entry outside the call. An error
//                   result has a data-error attribute, or says "error". A call with no result says "no result yet".
//   labelled        a thinking part says "thinking" besides its own words, and a brief says "brief" besides the brief.
//   shown           an element's text as a reader sees it before anything is opened: the content of a <details> that
//                   isn't open shows only its <summary>, and an element with the hidden attribute shows nothing.
//                   Opening the rest of a long input or result opens its <details>, so the rest is in the page,
//                   inside that <details>.
//   still running   the page's text says "still running", and an attempt that stopped says "stopped before it finished".
//   not found       the page's text says the transcript "can't be found".
//   the raw link    an <a> whose href is /bff/v1/blobs/{transcript_ref}, which the call answers with the stored file.
//   the heading     an h1, h2 or h3 naming the stage and "attempt N", on a page that names the item's number and title.
// Opening a page records a read that fails, or a page that doesn't render, rather than failing the step, and every Then
// first checks that the page opened, so a page that isn't built fails on its Then.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { runAgent, type Send } from "../../src/agent/run.ts";
import { LEASE_RAN_OUT } from "../../src/store/items.ts";
import type { Call, ItemData, RunDetailProps, Stage, TranscriptData, TranscriptProps } from "../../web/src/api.ts";
import { routeOf } from "../../web/src/routes.ts";
import { all, load, parse, section, table, cell, text, type El } from "./pbi-279.steps.ts";
import { long } from "./pbi-8.steps.ts";

const MODEL = "claude-opus-5-5";
const SID = "session-pbi-326";
const ITEM_ID = "00000000-0000-4000-8000-000000000326";
const RUN_ID = "00000000-0000-4000-8000-0000000a0326";
const DEFAULT_BRIEF = "Make the scenarios for item 326 pass";
const MARKUP = "<b>bold</b><script>window.pwned = 1</script><img src=x onerror=alert(1)>";
const NOW = new Date();
const MIN = 60_000;

type Msg = Record<string, unknown>;
type Planned = Msg | { raw: string } | { snapshot: true };
type Plan = { brief: string; msgs: Planned[] };
type Tool = { name: string; short: string; id: string };
type Store = "complete" | "uploaded" | "deleted" | "explicit";

type Ctx = {
  label: string; number: string; title: string;
  stage: string; attempt: number;
  state: string; runOpen: boolean;
  row: Partial<Stage>;
  ref: string;
  calls: Plan[];
  store: Store;
  explicit?: string;
  /** Cut the stored transcript part-way through its last line. */
  halfLast: boolean;
  ids: number;
  /** What a "that turn" step means: a text the turn shows. */
  mark?: string;
  /** The last tool call a Given wrote. */
  tool?: Tool;
  /** The tools by what the steps call them, as `Read on "a.ts"`. */
  tools: Map<string, Tool>;
  /** What the steps say "it" shows: the last result or call a Then looked at. */
  subject?: El;
  lastStart?: string;
  lastFinish?: string;
  notUploaded: string[];
  uploadedTurns: string[];
  /** A short result's lines. */
  short?: string[];
  /** The subagent starts and finishes a step wrote, in order, as "start NAME" or "finish NAME". */
  order?: string[];
  /** Results long enough to open, by their first and last lines. */
  longs: { first: string; last: string }[];
  /** Every <details> counts as open, for a markup check of a result's rest. */
  openAll: boolean;
  /** Where the markup scenario puts it. */
  markupIn?: string;
  blobs: Map<string, string>;
  jsonl?: string;
  // what opening the page did
  data?: TranscriptData;
  error?: string;
  html: string;
  tree?: El;
  /** Why a "When I open the rest" found nothing to open. */
  openError?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi326?: Ctx };
  w.pbi326 ??= {
    label: "#326 Add search", number: "326", title: "Add search", stage: "build", attempt: 1,
    state: "InReview", runOpen: true, row: {}, ref: `transcripts/${RUN_ID}/build-1.jsonl`,
    calls: [{ brief: DEFAULT_BRIEF, msgs: [] }], store: "complete", halfLast: false, ids: 0, tools: new Map(),
    notUploaded: [], uploadedTurns: [], longs: [], openAll: false, blobs: new Map(), html: "",
  };
  return w.pbi326;
}

const message = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
const cur = (c: Ctx) => c.calls.at(-1)!;
const uuid = (c: Ctx) => `00000000-0000-4000-9000-${String(++c.ids).padStart(12, "0")}`;

// ---- the SDK messages a transcript holds ----

type Block = Record<string, unknown>;
const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: "c2lnbmF0dXJl" });
const REDACTED = "RW5jcnlwdGVkVGhpbmtpbmdCbG9iUGJpMzI2";
const redacted = (): Block => ({ type: "redacted_thinking", data: REDACTED });
const say = (t: string): Block => ({ type: "text", text: t });

function use(c: Ctx, name: string, input: Record<string, unknown>, short: string, key?: string): Block {
  const id = `toolu_${String(++c.ids).padStart(6, "0")}`;
  const tool = { name, short, id };
  c.tool = tool;
  c.tools.set(key ?? `${name} ${short}`, tool);
  return { type: "tool_use", id, name, input };
}

/** An assistant turn, as the SDK streams it: one message per content block, each with the turn's message id. */
function turn(c: Ctx, blocks: Block[]): Msg[] {
  const id = `msg_${String(++c.ids).padStart(6, "0")}`;
  return blocks.map((b) => ({
    type: "assistant",
    message: {
      id, type: "message", role: "assistant", model: MODEL, content: [b], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    parent_tool_use_id: null, uuid: uuid(c), session_id: SID,
  }));
}

function results(c: Ctx, rs: { id: string; content: string; error?: boolean }[]): Msg {
  return {
    type: "user",
    message: { role: "user", content: rs.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.error ? { is_error: true } : {}) })) },
    parent_tool_use_id: null, uuid: uuid(c), session_id: SID,
  };
}

function init(c: Ctx): Msg {
  return {
    type: "system", subtype: "init", apiKeySource: "none", cwd: "/work/repo", tools: ["Read", "Edit", "Write", "Bash", "Grep", "Agent"],
    mcp_servers: [], model: MODEL, permissionMode: "bypassPermissions", slash_commands: [], output_style: "default", skills: [], plugins: [],
    uuid: uuid(c), session_id: SID,
  };
}

function final(c: Ctx, o: { subtype: string; isError?: boolean; cost?: number; tin?: number; tout?: number; text?: string }): Msg {
  const cost = o.cost ?? 0.25;
  const tin = o.tin ?? 4000;
  const tout = o.tout ?? 300;
  const base = {
    type: "result", subtype: o.subtype, duration_ms: 61_000, duration_api_ms: 52_000, is_error: o.isError ?? o.subtype !== "success",
    num_turns: 4, stop_reason: "end_turn", total_cost_usd: cost,
    usage: { input_tokens: tin, output_tokens: tout, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: tin, outputTokens: tout, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost, contextWindow: 200_000, maxOutputTokens: 32_000 } },
    permission_denials: [], uuid: uuid(c), session_id: SID,
  };
  return o.subtype === "success" ? { ...base, result: o.text ?? "Done." } : { ...base, errors: [o.text ?? "The call stopped early."] };
}

function taskStarted(c: Ctx, task: string, name: string, description: string): Msg {
  return { type: "system", subtype: "task_started", task_id: task, tool_use_id: `toolu_${task}`, description, subagent_type: name, task_type: "local_agent", uuid: uuid(c), session_id: SID };
}

function taskFinished(c: Ctx, task: string, status: string, summary: string): Msg {
  return {
    type: "system", subtype: "task_notification", task_id: task, tool_use_id: `toolu_${task}`, status, output_file: `/tmp/${task}.output`, summary,
    usage: { total_tokens: 2400, tool_uses: 3, duration_ms: 30_000 }, uuid: uuid(c), session_id: SID,
  };
}

const push = (c: Ctx, ...ms: Planned[]) => cur(c).msgs.push(...ms);

// ---- writing the transcript, through runAgent ----

async function write(c: Ctx): Promise<{ full: string; snapshots: string[] }> {
  let full = "";
  const snapshots: string[] = [];
  for (const plan of c.calls) {
    const heard: string[] = [];
    const raws = new Map<string, string>();
    const fix = (l: string) => raws.get(l) ?? l;
    const earlier = full;
    const msgs: Planned[] = [init(c), ...plan.msgs];
    const send: Send = () => (async function* () {
      for (const m of msgs) {
        if ("snapshot" in m) {
          snapshots.push(earlier + heard.map((l) => fix(l) + "\n").join(""));
          continue;
        }
        if ("raw" in m && typeof m.raw === "string") {
          const placeholder = { type: "pbi-326-raw-line", n: raws.size };
          raws.set(JSON.stringify(placeholder), m.raw);
          yield placeholder as unknown as SDKMessage;
          continue;
        }
        yield m as unknown as SDKMessage;
      }
    })();
    const r = await runAgent({
      prompt: plan.brief, model: MODEL, effort: "medium", cwd: tmpdir(), mode: "cell", signal: new AbortController().signal,
      onMessage: (l) => void heard.push(l),
    }, send);
    full += r.transcript.split("\n").map(fix).join("\n");
  }
  return { full, snapshots };
}

async function store(c: Ctx): Promise<void> {
  c.blobs.clear();
  if (c.store === "deleted") return;
  let body: string;
  if (c.store === "explicit") body = c.explicit ?? "";
  else {
    const { full, snapshots } = await write(c);
    body = c.store === "uploaded" ? snapshots.at(-1) ?? "" : full;
  }
  if (c.halfLast) {
    const lines = body.replace(/\n$/, "").split("\n");
    const last = lines.pop() ?? "";
    body = [...lines, ""].join("\n") + last.slice(0, Math.floor(last.length / 2));
  }
  c.jsonl = body;
  c.blobs.set(c.ref, body);
}

// ---- the item, and the call the page reads through ----

function stageRow(c: Ctx): Stage {
  return {
    stage_id: c.stage, attempt: c.attempt, model: MODEL, effort: "medium", tokens_in: 12_750, tokens_out: 640, cost_usd: "0.4213",
    status: "passed", transcript_ref: c.ref, started_at: new Date(NOW.getTime() - 20 * MIN).toISOString(),
    ended_at: new Date(NOW.getTime() - 5 * MIN).toISOString(), restates: [], message: null, ...c.row,
  };
}

function itemData(world: object): ItemData {
  const c = ctx(world);
  const linkBlobs = (world as { pbi279linkBlobs?: boolean }).pbi279linkBlobs ?? false;
  return {
    item: { id: ITEM_ID, external_id: c.number, repo: "acme/shop", title: c.title, state: c.state, held: false },
    run: { sop_version: "v1", config_sha: "c0nf1g0", scenarios_sha: null, features_lock_sha: null, risk_tier: null, tier_reasons: null, next_stage: c.stage, pr_number: null, pr_url: null, open: c.runOpen },
    policies: [], stages: [stageRow(c)], readiness: [], question: null, criteria: null, scope: null, pending: [], features: [],
    verdicts: [], linkBlobs, fixingCi: null, controls: null, startNow: null, moveEnded: null, claim: null, splitInto: [], recheck: null,
  };
}

function caller(world: object): Call {
  const c = ctx(world);
  return async (path: string, init?: RequestInit) => {
    const p = new URL(path, "http://spa.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") return json(405, { error: "only reads here" });
    if (p === `/bff/v1/items/${ITEM_ID}`) return json(200, itemData(world));
    const blob = /^\/bff\/v1\/blobs\/(.+)$/.exec(p);
    if (blob) {
      const body = c.blobs.get(decodeURIComponent(blob[1]));
      return body === undefined ? json(404, { error: "no such file" })
        : new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    }
    return json(404, { error: "not found" });
  };
}

// ---- opening the page ----

type Api = { readTranscript(call: Call, id: string, stage: string, attempt: number): Promise<TranscriptData> };

/** Hands the page, or why it didn't open, to PBI 131's page steps, through PBI 19's context. */
function handOver(world: object): void {
  const c = ctx(world);
  (world as { pbi19?: { status?: number; page?: string } }).pbi19 = c.tree ? { status: 200, page: c.html } : { status: 500, page: c.error ?? "nothing rendered" };
}

async function openPage(world: object, id: string, stage: string, attempt: number): Promise<void> {
  try {
    await openOnly(world, id, stage, attempt);
  } finally {
    handOver(world);
  }
}

async function openOnly(world: object, id: string, stage: string, attempt: number): Promise<void> {
  const c = ctx(world);
  c.data = undefined;
  c.html = "";
  c.tree = undefined;
  c.error = undefined;
  try {
    const a = await load<Api>("/src/api.ts");
    c.data = await a.readTranscript(caller(world), id, stage, attempt);
  } catch (e) {
    c.error = `the transcript page's read failed: ${message(e)}`;
    return;
  }
  try {
    const page = await load<{ Transcript: ComponentType<TranscriptProps> }>("/src/pages/Transcript.tsx");
    c.html = renderToString(createElement(page.Transcript, { data: c.data }));
    c.tree = parse(c.html);
  } catch (e) {
    c.error = `the transcript page didn't render: ${message(e)}`;
  }
}

function sameAttempt(c: Ctx, stage: string, attempt: number): void {
  assert.equal(stage, c.stage, `the feature set up the "${c.stage}" stage, not "${stage}"`);
  assert.equal(attempt, c.attempt, `the feature set up attempt ${c.attempt}, not ${attempt}`);
}

/** The page that opened, or why it didn't. */
function page(c: Ctx): El {
  assert.ok(c.tree, `the transcript page didn't open: ${c.error ?? "nothing rendered"}`);
  assert.ok(c.html.trim() !== "", "the transcript page rendered nothing");
  return c.tree;
}

// ---- reading the page ----

const INLINE = new Set(["a", "abbr", "b", "code", "em", "i", "kbd", "label", "mark", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);

function shownRaw(c: Ctx, n: El | string): string {
  if (typeof n === "string") return n;
  if (n.tag === "script" || n.tag === "style" || "hidden" in n.attrs) return "";
  const closed = n.tag === "details" && !("open" in n.attrs) && !c.openAll;
  const kids = closed ? n.children.filter((k) => typeof k !== "string" && k.tag === "summary") : n.children;
  const inner = kids.map((k) => shownRaw(c, k)).join("");
  return INLINE.has(n.tag) || n.tag.startsWith("#") ? inner : ` ${inner} `;
}
/** What a reader sees of an element, before anything in it is opened. */
const shown = (c: Ctx, n: El | string) => shownRaw(c, n).replace(/\s+/g, " ").trim();
const clip = (s: string, n = 1200) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);

function within(x: El, e: El): boolean {
  for (let p = x.parent; p; p = p.parent) if (p === e) return true;
  return false;
}

const entries = (root: El) => all(root).filter((e) => e.attrs["data-entry"] !== undefined);
const kind = (e: El) => e.attrs["data-entry"];
const partsOf = (scope: El, k: string) => all(scope).filter((e) => e.attrs["data-part"] === k);
const turns = (root: El) => entries(root).filter((e) => kind(e) === "turn");
const toolName = (call: El) => {
  const slot = all(call).find((e) => e.attrs["data-slot"] === "tool-name");
  return slot ? text(slot) : undefined;
};
const kinds = (root: El) => entries(root).map((e) => `${kind(e)}: ${text(e).slice(0, 80)}`);

function turnShowing(c: Ctx, root: El, what: string): El {
  const ts = turns(root).filter((t) => shown(c, t).includes(what));
  assert.ok(ts.length > 0, `no assistant turn shows "${what}": the page's entries are ${JSON.stringify(kinds(root))}`);
  return ts[0];
}

function thatTurn(c: Ctx, root: El): El {
  assert.ok(c.mark, "no step set up a turn");
  return turnShowing(c, root, c.mark);
}

function findCall(c: Ctx, root: El, name: string, short?: string): El {
  const calls = partsOf(root, "tool-call");
  const named = calls.filter((e) => toolName(e) === name);
  assert.ok(named.length > 0, `no tool call shows the tool's name "${name}": the calls show ${JSON.stringify(calls.map((e) => shown(c, e).slice(0, 120)))}`);
  if (short === undefined) return named[0];
  const hit = named.find((e) => shown(c, e).includes(short));
  assert.ok(hit, `no "${name}" call shows "${short}": they show ${JSON.stringify(named.map((e) => shown(c, e).slice(0, 200)))}`);
  return hit;
}

/** The call's result: the first tool-result part after it, before any other call or entry outside it. */
function resultOf(root: El, call: El): El | null {
  const order = all(root);
  for (const e of order.slice(order.indexOf(call) + 1)) {
    if (e.attrs["data-part"] === "tool-result") return e;
    if ((e.attrs["data-part"] === "tool-call" || e.attrs["data-entry"] !== undefined) && !within(e, call)) return null;
  }
  return null;
}

function result(c: Ctx, root: El, call: El, what: string): El {
  const r = resultOf(root, call);
  assert.ok(r, `${what} has no result after it: it shows ${clip(shown(c, call), 300)}`);
  return r;
}

function knownCall(c: Ctx, root: El, key?: string): El {
  const tool = key ? c.tools.get(key) : c.tool;
  assert.ok(tool, `no step wrote the call ${key ?? ""}`);
  return findCall(c, root, tool.name, tool.short);
}

/** Checks that what's named shows in this order in the page, each after the one before. */
function inOrder(c: Ctx, root: El, targets: (string | El)[], names: string[]): void {
  const order = all(root);
  let at = -1;
  targets.forEach((t, i) => {
    const after = i === 0 ? "the start of the page" : names[i - 1];
    let idx: number;
    if (typeof t === "string") {
      const hits = order.map((e, j) => [e, j] as const).filter(([e, j]) => j > at && shown(c, e).includes(t));
      const inner = hits.filter(([e]) => !hits.some(([x]) => x !== e && within(x, e)));
      assert.ok(inner.length > 0, `the page doesn't show ${names[i]} after ${after}: its entries are ${JSON.stringify(kinds(root))}`);
      idx = inner[0][1];
    } else {
      idx = order.indexOf(t);
      assert.ok(idx > at, `the page shows ${names[i]} before ${after}, not after it: its entries are ${JSON.stringify(kinds(root))}`);
    }
    at = idx;
  });
}

function closedDetails(c: Ctx, scope: El): El[] {
  return [scope, ...all(scope)].filter((e) => e.tag === "details" && !("open" in e.attrs) && !c.openAll);
}

function offersRest(c: Ctx, scope: El, what: string): void {
  const d = closedDetails(c, scope);
  assert.ok(d.length > 0, `${what} offers nothing to open: it shows ${clip(shown(c, scope), 600)}`);
  assert.ok(d.some((x) => x.children.some((k) => typeof k !== "string" && k.tag === "summary" && text(k) !== "")), `${what}'s <details> has no <summary> that offers the rest`);
}

function openRest(c: Ctx, scope: El | undefined, what: string): void {
  c.openError = undefined;
  if (!scope) {
    c.openError = `there was no ${what} to open`;
    return;
  }
  const d = closedDetails(c, scope);
  if (!d.length) c.openError = `${what} had nothing to open`;
  for (const x of d) x.attrs.open = "";
}

function showsAllLines(c: Ctx, scope: El, lines: string[], what: string): void {
  if (c.openError) assert.fail(c.openError);
  const got = shown(c, scope);
  const missing = lines.filter((l) => !got.includes(l));
  assert.deepEqual(missing.slice(0, 5), [], `${what} doesn't show ${missing.length} of its ${lines.length} lines, once opened`);
  const last = lines.at(-1)!;
  const before = lines.at(-2);
  if (before !== undefined) assert.ok(got.lastIndexOf(last) > got.lastIndexOf(before), `${what} doesn't end with "${last}"`);
}

const lines = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1));
const stillRunning = /still running/i;

// ---- Background ----

// Two of this feature's steps are other features' own, which hand them to this file through hooks on the world: PBI
// 279's "it shows {string}" and PBI 205's "the start shows {string}". PBI 131's "the page has no link to {string}"
// reads the page this file renders, which it hands it through PBI 19's context, as PBI 279 does.
Before({ tags: "@pbi-326" }, function () {
  const w = this as { itShows?: (what: string) => void; startShows?: (what: string) => void };
  w.itShows = (what) => itShows(this, what);
  w.startShows = (what) => startShows(this, what);
});

Given("item {string} has a {string} stage attempt {int} with a stored transcript", function (label: string, stage: string, attempt: number) {
  const c = ctx(this);
  const m = /^#(\d+)\s+(.+)$/.exec(label);
  assert.ok(m, `"${label}" isn't "#N title"`);
  Object.assign(c, { label, number: m[1], title: m[2], stage, attempt, ref: `transcripts/${RUN_ID}/${stage}-${attempt}.jsonl`, store: "complete" });
});

// ---- opening the page ----

When("I follow the transcript link for {string} attempt {int} on Run detail", long, async function (stage: string, attempt: number) {
  const c = ctx(this);
  sameAttempt(c, stage, attempt);
  c.tree = undefined;
  c.html = "";
  try {
    await store(c);
    const runDetail = await load<{ RunDetail: ComponentType<RunDetailProps> }>("/src/pages/RunDetail.tsx");
    const root = parse(renderToString(createElement(runDetail.RunDetail, { data: itemData(this), zone: "UTC", now: NOW, message: null })));
    const t = table(section(root, "Stages"), "Run detail's Stages");
    const row = t.rows.find((r) => text(cell(t, r, "Stage")) === stage && text(cell(t, r, "Attempt")) === String(attempt));
    if (!row) return void (c.error = `Run detail's Stages table has no row for "${stage}" attempt ${attempt}`);
    const link = all(cell(t, row, "Transcript")).find((e) => e.tag === "a");
    if (!link) return void (c.error = `Run detail's "${stage}" attempt ${attempt} has no transcript link: ${text(cell(t, row, "Transcript"))}`);
    const href = link.attrs.href ?? "";
    const route = routeOf(new URL(href, "http://spa.test").pathname);
    if (route.page !== "transcript") return void (c.error = `Run detail's transcript link goes to ${href}, which isn't the transcript page`);
    if (route.id !== ITEM_ID || route.stage !== stage || route.attempt !== attempt) {
      return void (c.error = `Run detail's transcript link goes to ${href}, the transcript of ${route.id}'s "${route.stage}" attempt ${route.attempt}`);
    }
    await openPage(this, route.id, route.stage, route.attempt);
  } catch (e) {
    c.error = `Run detail's transcript link couldn't be followed: ${message(e)}`;
  } finally {
    handOver(this);
  }
});

When("I open the transcript page for {string} attempt {int}", long, async function (stage: string, attempt: number) {
  const c = ctx(this);
  sameAttempt(c, stage, attempt);
  try {
    await store(c);
  } catch (e) {
    c.error = `the transcript couldn't be written: ${message(e)}`;
    return void handOver(this);
  }
  await openPage(this, ITEM_ID, stage, attempt);
});

Then("I see the transcript page for {string} attempt {int} of {string}", function (stage: string, attempt: number, label: string) {
  const c = ctx(this);
  const root = page(c);
  const heads = all(root).filter((e) => /^h[1-3]$/.test(e.tag)).map((e) => shown(c, e));
  assert.ok(heads.some((h) => h.includes(stage) && new RegExp(`attempt ${attempt}\\b`, "i").test(h)), `no heading names "${stage}" attempt ${attempt}: the headings are ${JSON.stringify(heads)}`);
  const m = /^#(\d+)\s+(.+)$/.exec(label)!;
  const got = shown(c, root);
  assert.ok(got.includes(m[1]) && got.includes(m[2]), `the page doesn't name the item ${label}: ${clip(got, 600)}`);
});

// ---- AC-1 ----

Given("the attempt's agent was given the brief {string}", function (brief: string) {
  ctx(this).calls[0].brief = brief;
});

Given("its transcript holds, in order, an assistant turn saying {string}, a call to {string} and its result, and an assistant turn saying {string}", function (first: string, tool: string, last: string) {
  const c = ctx(this);
  const call = use(c, tool, { file_path: "docs/spec.html" }, "docs/spec.html");
  push(c, ...turn(c, [say(first), call]), results(c, [{ id: c.tool!.id, content: "The spec's contents" }]), ...turn(c, [say(last)]));
});

Then("the page shows the brief {string} first", function (brief: string) {
  const c = ctx(this);
  const root = page(c);
  const es = entries(root);
  assert.ok(es.length > 0, `the page shows no entries: ${clip(shown(c, root))}`);
  assert.equal(kind(es[0]), "brief", `the page's first entry isn't the brief: its entries are ${JSON.stringify(kinds(root))}`);
  assert.ok(shown(c, es[0]).includes(brief), `the brief doesn't show "${brief}": ${clip(shown(c, es[0]))}`);
});

Then("after the brief it shows, in order, {string}, the {string} call, its result, and {string}", function (first: string, tool: string, last: string) {
  const c = ctx(this);
  const root = page(c);
  const brief = entries(root).find((e) => kind(e) === "brief");
  assert.ok(brief, `the page shows no brief: its entries are ${JSON.stringify(kinds(root))}`);
  const call = findCall(c, root, tool);
  const r = result(c, root, call, `the "${tool}" call`);
  inOrder(c, root, [brief, first, call, r, last], ["the brief", `"${first}"`, `the "${tool}" call`, "its result", `"${last}"`]);
});

Then("the brief is labelled as the brief the agent got", function () {
  const c = ctx(this);
  const root = page(c);
  const brief = c.calls[0].brief;
  const b = entries(root).find((e) => kind(e) === "brief" && shown(c, e).includes(brief));
  assert.ok(b, `no brief entry shows "${brief}": the page's entries are ${JSON.stringify(kinds(root))}`);
  assert.match(shown(c, b).replace(brief, ""), /\bbrief\b/i, `the brief isn't labelled as the brief: ${clip(shown(c, b))}`);
});

Then("it isn't shown as one of the assistant's turns", function () {
  const c = ctx(this);
  const root = page(c);
  const brief = c.calls[0].brief;
  const inTurn = turns(root).filter((t) => shown(c, t).includes(brief));
  assert.equal(inTurn.length, 0, `the brief shows in an assistant turn: ${clip(inTurn.map((t) => shown(c, t)).join(" | "))}`);
  assert.ok(entries(root).some((e) => kind(e) === "brief" && shown(c, e).includes(brief)), "the page shows no brief entry");
});

Given("the attempt made two agent calls", function () {
  const c = ctx(this);
  c.calls = [{ brief: DEFAULT_BRIEF, msgs: [] }, { brief: "Fix what's left", msgs: [] }];
});

Given("the first call was given the brief {string} and its assistant said {string}", function (brief: string, said: string) {
  const c = ctx(this);
  c.calls[0].brief = brief;
  c.calls[0].msgs.push(...turn(c, [say(said)]));
});

Given("the second call was given the brief {string} and its assistant said {string}", function (brief: string, said: string) {
  const c = ctx(this);
  c.calls[1].brief = brief;
  c.calls[1].msgs.push(...turn(c, [say(said)]));
});

Then("the page shows, in order, {string}, {string}, {string} and {string}", function (a: string, b: string, d: string, e: string) {
  const c = ctx(this);
  const root = page(c);
  inOrder(c, root, [a, b, d, e], [a, b, d, e].map((x) => `"${x}"`));
  const briefs = entries(root).filter((x) => kind(x) === "brief");
  assert.equal(briefs.length, 2, `the page doesn't show each call's brief: its entries are ${JSON.stringify(kinds(root))}`);
});

Given("the attempt's transcript holds a rate limit event and a task progress update between two assistant turns", function () {
  const c = ctx(this);
  c.mark = "First of two turns";
  push(c, ...turn(c, [say("First of two turns")]),
    { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.81, resetsAt: Math.floor(NOW.getTime() / 1000) + 3600, rateLimitType: "five_hour" }, uuid: uuid(c), session_id: SID },
    { type: "system", subtype: "task_progress", task_id: "task-progress-1", description: "Progress on the side task", usage: { total_tokens: 900, tool_uses: 2, duration_ms: 9000 }, last_tool_name: "Grep", uuid: uuid(c), session_id: SID },
    ...turn(c, [say("Second of two turns")]));
});

Then("the page shows the two assistant turns one after the other", function () {
  const c = ctx(this);
  const root = page(c);
  const es = entries(root).filter((e) => kind(e) !== "brief");
  assert.deepEqual(es.map(kind), ["turn", "turn"], `the page's entries after the brief aren't the two turns: ${JSON.stringify(kinds(root))}`);
  assert.ok(shown(c, es[0]).includes("First of two turns") && shown(c, es[1]).includes("Second of two turns"), `the turns aren't the two, in order: ${JSON.stringify(kinds(root))}`);
});

Then("it shows no turn for the rate limit event or the task progress update", function () {
  const c = ctx(this);
  const root = page(c);
  const got = shown(c, root);
  for (const s of ["rate_limit_event", "allowed_warning", "Progress on the side task", "task_progress"]) assert.ok(!got.includes(s), `the page shows "${s}"`);
  assert.equal(turns(root).length, 2, `the page shows ${turns(root).length} turns, not the two: ${JSON.stringify(kinds(root))}`);
});

Given("the attempt's transcript holds an assistant turn saying {string}, then a line that isn't valid JSON reading {string}, then an assistant turn saying {string}", function (a: string, raw: string, b: string) {
  const c = ctx(this);
  push(c, ...turn(c, [say(a)]), { raw }, ...turn(c, [say(b)]));
});

Then("the page shows, in order, {string}, {string} as plain text, and {string}", function (a: string, raw: string, b: string) {
  const c = ctx(this);
  const root = page(c);
  const line = entries(root).find((e) => kind(e) === "unreadable" && shown(c, e).includes(raw));
  assert.ok(line, `no entry shows the line the page can't read, "${raw}": the page's entries are ${JSON.stringify(kinds(root))}`);
  inOrder(c, root, [a, line, b], [`"${a}"`, `"${raw}"`, `"${b}"`]);
});

Given("the stored transcript for {string} attempt {int} has been deleted", function (stage: string, attempt: number) {
  const c = ctx(this);
  sameAttempt(c, stage, attempt);
  c.store = "deleted";
});

Then("the page says the transcript can't be found", function () {
  const c = ctx(this);
  assert.match(shown(c, page(c)), /can['’]t be found/i, "the page doesn't say the transcript can't be found");
});

Then("it shows no turns", function () {
  const c = ctx(this);
  const root = page(c);
  assert.deepEqual(entries(root).map(kind), [], `the page shows entries: ${JSON.stringify(kinds(root))}`);
});

// ---- AC-2 ----

Given("an assistant turn in the attempt's transcript holds the thinking {string}, the text {string} and a call to {string} with the file path {string}", function (thought: string, said: string, tool: string, path: string) {
  const c = ctx(this);
  c.mark = said;
  push(c, ...turn(c, [thinking(thought), say(said), use(c, tool, { file_path: path }, path)]));
});

Then("that turn shows, in order, the thinking, the text and the {string} call", function (tool: string) {
  const c = ctx(this);
  const root = page(c);
  const t = thatTurn(c, root);
  const th = partsOf(t, "thinking")[0];
  const tx = partsOf(t, "text")[0];
  const call = partsOf(t, "tool-call").find((e) => toolName(e) === tool);
  assert.ok(th, `the turn shows no thinking part: ${clip(shown(c, t))}`);
  assert.ok(tx, `the turn shows no text part: ${clip(shown(c, t))}`);
  assert.ok(call, `the turn shows no "${tool}" call: ${clip(shown(c, t))}`);
  inOrder(c, t, [th, tx, call], ["the thinking", "the text", `the "${tool}" call`]);
});

Then("the thinking {string} is labelled as thinking", function (thought: string) {
  const c = ctx(this);
  const root = page(c);
  const th = partsOf(root, "thinking").find((e) => shown(c, e).includes(thought));
  assert.ok(th, `no thinking part shows "${thought}": ${clip(shown(c, root))}`);
  assert.match(shown(c, th).replace(thought, ""), /thinking/i, `the thinking isn't labelled as thinking: ${clip(shown(c, th))}`);
});

Then("the text {string} isn't labelled as thinking", function (said: string) {
  const c = ctx(this);
  const root = page(c);
  const tx = partsOf(root, "text").find((e) => shown(c, e).includes(said));
  assert.ok(tx, `no text part shows "${said}": ${clip(shown(c, root))}`);
  assert.ok(!partsOf(root, "thinking").some((th) => within(tx, th)), "the text is inside a thinking part");
  assert.doesNotMatch(shown(c, tx), /thinking/i, `the text is labelled as thinking: ${clip(shown(c, tx))}`);
});

Then("the {string} call shows the tool's name {string} and {string}", function (tool: string, name: string, short: string) {
  const c = ctx(this);
  assert.equal(tool, name);
  c.subject = findCall(c, page(c), name, short);
});

Given(/^an assistant turn in the attempt's transcript calls "([^"]+)" with the input (\{.*\})$/, function (tool: string, input: string) {
  const c = ctx(this);
  const parsed = JSON.parse(input) as Record<string, unknown>;
  push(c, ...turn(c, [use(c, tool, parsed, "")]));
  c.mark = undefined;
});

Then("the call shows the tool's name {string} and {string}", function (name: string, short: string) {
  const c = ctx(this);
  c.subject = findCall(c, page(c), name, short);
});

Then("it doesn't show the input as raw JSON", function () {
  const c = ctx(this);
  assert.ok(c.subject, "no step looked at a call");
  const got = shown(c, c.subject);
  assert.ok(!/[{]\s*"|"\s*:\s*"/.test(got), `the call shows its input as raw JSON: ${clip(got, 400)}`);
});

Given("an assistant turn in the attempt's transcript calls {string} on {string}, then {string} on {string}, then {string} with {string}", function (t1: string, a1: string, t2: string, a2: string, t3: string, a3: string) {
  const c = ctx(this);
  const input = (t: string, a: string) => (t === "Bash" ? { command: a, description: "Run it" } : { file_path: a });
  push(c, ...turn(c, [use(c, t1, input(t1, a1), a1), use(c, t2, input(t2, a2), a2), use(c, t3, input(t3, a3), a3)]));
});

Then("that turn shows the calls in order: {string} with {string}, {string} with {string}, {string} with {string}", function (t1: string, a1: string, t2: string, a2: string, t3: string, a3: string) {
  const c = ctx(this);
  const root = page(c);
  const calls = partsOf(root, "tool-call");
  const got = calls.map((e) => ({ name: toolName(e), shows: shown(c, e) }));
  const want = [[t1, a1], [t2, a2], [t3, a3]];
  assert.equal(calls.length, 3, `the page shows ${calls.length} tool calls, not 3: ${clip(JSON.stringify(got))}`);
  want.forEach(([t, a], i) => assert.ok(got[i].name === t && got[i].shows.includes(a), `call ${i + 1} isn't "${t}" with "${a}": ${clip(JSON.stringify(got))}`));
  const turn0 = turns(root).find((t) => within(calls[0], t));
  assert.ok(turn0 && calls.every((e) => within(e, turn0)), "the three calls aren't all in the one turn");
});

Given("an assistant turn in the attempt's transcript holds only the text {string}", function (said: string) {
  const c = ctx(this);
  c.mark = said;
  push(c, ...turn(c, [say(said)]));
});

Then("that turn shows {string}", function (what: string) {
  const c = ctx(this);
  const t = thatTurn(c, page(c));
  assert.ok(shown(c, t).includes(what));
});

Then("that turn shows nothing labelled as thinking", function () {
  const c = ctx(this);
  const t = thatTurn(c, page(c));
  assert.equal(partsOf(t, "thinking").length, 0, `the turn shows a thinking part: ${clip(shown(c, t))}`);
  assert.doesNotMatch(shown(c, t), /thinking/i, `the turn says "thinking": ${clip(shown(c, t))}`);
});

Then("that turn shows no tool call", function () {
  const c = ctx(this);
  const t = thatTurn(c, page(c));
  assert.equal(partsOf(t, "tool-call").length, 0, `the turn shows a tool call: ${clip(shown(c, t))}`);
});

Given("an assistant turn in the attempt's transcript holds redacted thinking, then the text {string}", function (said: string) {
  const c = ctx(this);
  c.mark = said;
  push(c, ...turn(c, [redacted(), say(said)]));
});

Then("that turn shows a part labelled as thinking that says its content was withheld", function () {
  const c = ctx(this);
  const t = thatTurn(c, page(c));
  const th = partsOf(t, "thinking")[0];
  assert.ok(th, `the turn shows no thinking part: ${clip(shown(c, t))}`);
  const got = shown(c, th);
  assert.match(got, /thinking/i, `the part isn't labelled as thinking: ${clip(got)}`);
  assert.match(got, /withheld/i, `the thinking doesn't say its content was withheld: ${clip(got)}`);
  assert.ok(!shown(c, t).includes(REDACTED), "the turn shows the redacted thinking's data as if it were text");
  c.subject = th;
});

Then("then it shows {string}", function (said: string) {
  const c = ctx(this);
  const root = page(c);
  const t = thatTurn(c, root);
  const th = partsOf(t, "thinking")[0];
  assert.ok(th, "the turn shows no thinking part");
  const tx = partsOf(t, "text").find((e) => shown(c, e).includes(said));
  assert.ok(tx, `the turn shows no text "${said}"`);
  inOrder(c, t, [th, tx], ["the thinking", `"${said}"`]);
});

// ---- AC-3 ----

const bashInput = (command: string) => ({ command, description: "Run it" });

Given("an assistant turn in the attempt's transcript calls {string} with {string}", function (tool: string, arg: string) {
  const c = ctx(this);
  push(c, ...turn(c, [use(c, tool, tool === "Bash" ? bashInput(arg) : { file_path: arg }, arg)]));
});

Given("the result of that call is {string}", function (content: string) {
  const c = ctx(this);
  push(c, results(c, [{ id: c.tool!.id, content }]));
});

Then("{string} shows straight after the {string} call with {string}, as its result", function (content: string, tool: string, arg: string) {
  const c = ctx(this);
  const root = page(c);
  const call = findCall(c, root, tool, arg);
  const r = result(c, root, call, `the "${tool}" call`);
  assert.ok(shown(c, r).includes(content), `the "${tool}" call's result doesn't show "${content}": ${clip(shown(c, r))}`);
});

Given("an assistant turn in the attempt's transcript calls {string} on {string} and {string} on {string}", function (t1: string, a1: string, t2: string, a2: string) {
  const c = ctx(this);
  push(c, ...turn(c, [use(c, t1, { file_path: a1 }, a1), use(c, t2, { file_path: a2 }, a2)]));
});

Given("the next message in the transcript holds both results, the one for {string} first: {string} and {string}", function (firstFor: string, first: string, second: string) {
  const c = ctx(this);
  const byFile = [...c.tools.values()];
  const a = byFile.find((t) => t.short === firstFor)!;
  const b = byFile.find((t) => t.short !== firstFor && t.name === a.name)!;
  push(c, results(c, [{ id: a.id, content: first }, { id: b.id, content: second }]));
});

Then("{string} shows as the result of the {string} call on {string}", function (content: string, tool: string, arg: string) {
  const c = ctx(this);
  const root = page(c);
  const r = result(c, root, findCall(c, root, tool, arg), `the "${tool}" call on "${arg}"`);
  const got = shown(c, r);
  assert.ok(got.includes(content), `the "${tool}" call on "${arg}" has the result ${clip(got)}, not "${content}"`);
  const other = /contents of ([ab])/.exec(content);
  if (other) assert.ok(!got.includes(`contents of ${other[1] === "a" ? "b" : "a"}`), `the result of the call on "${arg}" shows the other call's result too: ${clip(got)}`);
});

Given("an assistant turn in the attempt's transcript calls {string} on {string}", function (tool: string, arg: string) {
  const c = ctx(this);
  push(c, ...turn(c, [use(c, tool, { file_path: arg }, arg)]));
});

Given("the result of that call is the error {string}", function (content: string) {
  const c = ctx(this);
  push(c, results(c, [{ id: c.tool!.id, content: `<tool_use_error>${content}</tool_use_error>`, error: true }]));
});

Then("the result of the {string} call shows {string} marked as an error", function (tool: string, content: string) {
  const c = ctx(this);
  const root = page(c);
  const r = result(c, root, knownCall(c, root), `the "${tool}" call`);
  const got = shown(c, r);
  assert.ok(got.includes(content), `the result doesn't show "${content}": ${clip(got)}`);
  assert.ok("data-error" in r.attrs || /\berror\b/i.test(got.replace(content, "")), `the result isn't marked as an error: ${clip(got)}`);
});

Given("the attempt's transcript ends with an assistant turn calling {string} with {string} and no result for it", function (tool: string, arg: string) {
  const c = ctx(this);
  push(c, ...turn(c, [say("Running the tests"), use(c, tool, bashInput(arg), arg)]));
});

Then("the {string} call with {string} says it has no result yet", function (tool: string, arg: string) {
  const c = ctx(this);
  const root = page(c);
  const call = findCall(c, root, tool, arg);
  const r = resultOf(root, call);
  assert.equal(r, null, `the call shows a result: ${r ? clip(shown(c, r)) : ""}`);
  assert.match(shown(c, call), /no result yet/i, `the call doesn't say it has no result yet: ${clip(shown(c, call))}`);
});

Given("the result of that call is {int} lines long, the first reading {string} and the last {string}", function (n: number, first: string, last: string) {
  const c = ctx(this);
  const body = lines(n, (k) => `line ${k} of ${n}`);
  assert.equal(body[0], first);
  assert.equal(body.at(-1), last);
  push(c, results(c, [{ id: c.tool!.id, content: body.join("\n") }]));
});

Then("the result shows {string}", function (what: string) {
  const c = ctx(this);
  const root = page(c);
  const r = result(c, root, knownCall(c, root), "the call");
  c.subject = r;
  assert.ok(shown(c, r).includes(what), `the result doesn't show "${what}": ${clip(shown(c, r), 400)}`);
});

Then("it doesn't show {string}", function (what: string) {
  const c = ctx(this);
  page(c);
  assert.ok(c.subject, "no step looked at a result or a call");
  const got = shown(c, c.subject);
  assert.ok(!got.includes(what), `it shows "${what}" before anything is opened: it shows ${got.length} characters`);
});

Then("it offers to show the rest", function () {
  const c = ctx(this);
  page(c);
  assert.ok(c.subject, "no step looked at a result or a call");
  offersRest(c, c.subject, "the result");
});

When("I open the rest of that result", function () {
  const c = ctx(this);
  if (!c.tree) return;
  const call = (() => {
    try {
      return knownCall(c, c.tree!);
    } catch {
      return undefined;
    }
  })();
  const r = call ? resultOf(c.tree, call) ?? undefined : undefined;
  c.subject = r;
  openRest(c, r, "result");
});

Then("it shows all {int} lines, ending with {string}", function (n: number, last: string) {
  const c = ctx(this);
  page(c);
  assert.ok(c.subject, "no step looked at a result or a call");
  const want = c.tool?.name === "Write" ? [...lines(n - 1, (k) => `big.ts line ${k}`), last] : lines(n, (k) => `line ${k} of ${n}`);
  assert.equal(want.at(-1), last);
  showsAllLines(c, c.subject, want, c.tool?.name === "Write" ? "the call's input" : "the result");
});

Given("an assistant turn in the attempt's transcript calls {string} on {string} with content {int} lines long, the last reading {string}", function (tool: string, path: string, n: number, last: string) {
  const c = ctx(this);
  const content = [...lines(n - 1, (k) => `big.ts line ${k}`), last].join("\n");
  push(c, ...turn(c, [use(c, tool, { file_path: path, content }, path)]), results(c, [{ id: c.tool!.id, content: `File created successfully at: ${path}` }]));
});

Then("the {string} call shows {string}", function (tool: string, what: string) {
  const c = ctx(this);
  c.subject = findCall(c, page(c), tool, what);
});

When("I open the rest of that call's input", function () {
  const c = ctx(this);
  if (!c.tree) return;
  let call: El | undefined;
  try {
    call = knownCall(c, c.tree);
  } catch {
    call = undefined;
  }
  c.subject = call;
  openRest(c, call, "call's input");
});

Given("the result of that call is {int} lines long", function (n: number) {
  const c = ctx(this);
  const body = ["On branch main", "Your branch is up to date with 'origin/main'.", "nothing to commit, working tree clean"].slice(0, n);
  assert.equal(body.length, n);
  c.short = body;
  push(c, results(c, [{ id: c.tool!.id, content: body.join("\n") }]));
});

Then("the result shows all {int} lines", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  const r = result(c, root, knownCall(c, root), "the call");
  c.subject = r;
  const body = c.short ?? [];
  assert.equal(body.length, n);
  const got = shown(c, r);
  for (const l of body) assert.ok(got.includes(l), `the result doesn't show "${l}": ${clip(got)}`);
});

Then("it offers nothing more to open", function () {
  const c = ctx(this);
  page(c);
  assert.ok(c.subject, "no step looked at a result");
  assert.equal([c.subject, ...all(c.subject)].filter((e) => e.tag === "details").length, 0, `the result offers something to open: ${clip(shown(c, c.subject))}`);
});

Given(/^the result of that call is one line of ([\d,]+) characters, ending in "([^"]+)"$/, function (n: string, end: string) {
  const c = ctx(this);
  const size = Number(n.replace(/,/g, ""));
  push(c, results(c, [{ id: c.tool!.id, content: "x".repeat(size - end.length) + end }]));
});

Then("the result doesn't show {string}", function (what: string) {
  const c = ctx(this);
  const root = page(c);
  const r = result(c, root, knownCall(c, root), "the call");
  c.subject = r;
  const got = shown(c, r);
  assert.ok(!got.includes(what), `the result shows "${what}" before it's opened: it shows ${got.length} characters`);
});

function itShows(world: object, what: string): void {
  const c = ctx(world);
  page(c);
  if (c.openError) assert.fail(c.openError);
  assert.ok(c.subject, "no step looked at a result");
  assert.ok(shown(c, c.subject).includes(what), `once opened, it doesn't show "${what}"`);
}

Given("the attempt's transcript is 1 MB, made of {int} turns whose tool results are each thousands of lines long", function (n: number) {
  const c = ctx(this);
  c.longs = [];
  for (let t = 1; t <= n; t++) {
    const tag = `t${String(t).padStart(2, "0")}`;
    const body = lines(2000, (k) => `${tag} line ${String(k).padStart(4, "0")}`);
    c.longs.push({ first: body[0], last: body.at(-1)! });
    push(c, ...turn(c, [say(`Turn ${t}: reading the log`), use(c, "Bash", bashInput(`cat log-${t}.txt`), `cat log-${t}.txt`)]), results(c, [{ id: c.tool!.id, content: body.join("\n") }]));
  }
});

Then("the page shows all {int} turns", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  assert.ok((c.jsonl ?? "").length >= 1_000_000, `the transcript is ${(c.jsonl ?? "").length} characters, not 1 MB`);
  assert.equal(turns(root).length, n, `the page shows ${turns(root).length} turns, not ${n}`);
});

Then("each of their tool results shows only its first lines until opened", function () {
  const c = ctx(this);
  const root = page(c);
  const rs = partsOf(root, "tool-result");
  assert.equal(rs.length, c.longs.length, `the page shows ${rs.length} tool results, not ${c.longs.length}`);
  rs.forEach((r, i) => {
    const got = shown(c, r);
    assert.ok(got.includes(c.longs[i].first), `result ${i + 1} doesn't show its first line "${c.longs[i].first}"`);
    assert.ok(!got.includes(c.longs[i].last), `result ${i + 1} shows its last line "${c.longs[i].last}" before it's opened`);
    offersRest(c, r, `result ${i + 1}`);
  });
});

Then("the text the page shows before anything is opened is a small part of the transcript's 1 MB", function () {
  const c = ctx(this);
  const got = shown(c, page(c)).length;
  const size = (c.jsonl ?? "").length;
  assert.ok(got < size / 10, `the page shows ${got} characters of a ${size}-character transcript before anything is opened`);
});

// ---- AC-4 ----

/** A subagent task's id, one per subagent name. */
const taskOf = (name: string) => `task-${[...name].map((ch) => ch.charCodeAt(0).toString(16)).join("").slice(0, 24)}`;

Given("the attempt's transcript holds a subagent task {string} described as {string} starting after the assistant's turn {string}", function (name: string, description: string, said: string) {
  const c = ctx(this);
  push(c, ...turn(c, [say(said)]), taskStarted(c, taskOf(name), name, description));
  c.lastStart = name;
});

Given("it holds that task finishing as completed with the summary {string}, before the assistant's turn {string}", function (summary: string, said: string) {
  const c = ctx(this);
  const name = c.lastStart!;
  push(c, taskFinished(c, taskOf(name), "completed", summary), ...turn(c, [say(said)]));
});

function subagent(c: Ctx, root: El, which: "start" | "finish", name: string): El | undefined {
  return entries(root).find((e) => kind(e) === `subagent-${which}` && shown(c, e).includes(name));
}

function mustSubagent(c: Ctx, root: El, which: "start" | "finish", name: string): El {
  const e = subagent(c, root, which, name);
  assert.ok(e, `the page shows no ${which} of subagent "${name}": its entries are ${JSON.stringify(kinds(root))}`);
  return e;
}

Then("the page shows, in order, {string}, the start of subagent {string}, the finish of subagent {string}, and {string}", function (a: string, s: string, f: string, b: string) {
  const c = ctx(this);
  const root = page(c);
  const start = mustSubagent(c, root, "start", s);
  const finish = mustSubagent(c, root, "finish", f);
  c.lastStart = s;
  c.lastFinish = f;
  inOrder(c, root, [a, start, finish, b], [`"${a}"`, `the start of "${s}"`, `the finish of "${f}"`, `"${b}"`]);
});

function startShows(world: object, what: string): void {
  const c = ctx(world);
  const e = mustSubagent(c, page(c), "start", c.lastStart!);
  assert.ok(shown(c, e).includes(what), `the start doesn't show "${what}": ${clip(shown(c, e))}`);
}

Then("the finish shows {string}", function (what: string) {
  const c = ctx(this);
  const e = mustSubagent(c, page(c), "finish", c.lastFinish!);
  assert.ok(shown(c, e).includes(what), `the finish doesn't show "${what}": ${clip(shown(c, e))}`);
});

Given("the attempt's transcript holds a subagent task {string} that started and then finished as {word}", function (name: string, status: string) {
  const c = ctx(this);
  const t = taskOf(name);
  push(c, ...turn(c, [say("Asking for a review")]), taskStarted(c, t, name, "Review the branch"), taskFinished(c, t, status, "The review's last words"), ...turn(c, [say("Carrying on")]));
});

Then("the finish of subagent {string} says it {word}", function (name: string, how: string) {
  const c = ctx(this);
  const e = mustSubagent(c, page(c), "finish", name);
  assert.ok(new RegExp(`\\b${how}\\b`, "i").test(shown(c, e)), `the finish doesn't say it ${how}: ${clip(shown(c, e))}`);
});

Given("the attempt's transcript holds subagent {string} starting, then subagent {string} starting, then {string} finishing, then {string} finishing", function (a: string, b: string, b2: string, a2: string) {
  const c = ctx(this);
  assert.equal(b, b2);
  assert.equal(a, a2);
  push(c, ...turn(c, [say("Starting two subagents")]),
    taskStarted(c, taskOf(a), a, "Review the branch"), taskStarted(c, taskOf(b), b, "Find the transcript code"),
    taskFinished(c, taskOf(b), "completed", "Found it in web/src"), taskFinished(c, taskOf(a), "completed", "APPROVED"),
    ...turn(c, [say("Both subagents finished")]));
  c.order = [`start ${a}`, `start ${b}`, `finish ${b}`, `finish ${a}`];
});

Then("the page shows each start and finish in that order, each with its subagent's name", function () {
  const c = ctx(this);
  const root = page(c);
  const order = c.order!;
  const got = entries(root).filter((e) => /^subagent-(start|finish)$/.test(kind(e)));
  assert.equal(got.length, order.length, `the page shows ${got.length} subagent starts and finishes, not ${order.length}: ${JSON.stringify(kinds(root))}`);
  order.forEach((want, i) => {
    const [which, name] = want.split(" ");
    assert.ok(kind(got[i]) === `subagent-${which}` && shown(c, got[i]).includes(name), `the page's ${i + 1}st subagent entry isn't the ${which} of "${name}": ${JSON.stringify(kinds(root))}`);
  });
});

Given("the attempt's transcript holds subagent {string} starting and never finishing", function (name: string) {
  const c = ctx(this);
  push(c, ...turn(c, [say("Asking for a review")]), taskStarted(c, taskOf(name), name, "Review the branch"));
});

Then("the page shows the start of subagent {string}", function (name: string) {
  const c = ctx(this);
  mustSubagent(c, page(c), "start", name);
  c.lastStart = name;
});

Then("it shows no finish for it", function () {
  const c = ctx(this);
  const root = page(c);
  assert.equal(subagent(c, root, "finish", c.lastStart!), undefined, `the page shows a finish for "${c.lastStart}"`);
});

Given(/^the attempt's transcript ends with a result of success, costing \$(\d+(?:\.\d+)?), with (\d+) tokens in and (\d+) tokens out$/, function (cost: string, tin: string, tout: string) {
  const c = ctx(this);
  push(c, ...turn(c, [say("All done")]), final(c, { subtype: "success", cost: Number(cost), tin: Number(tin), tout: Number(tout), text: "All done" }));
});

Given(/^the attempt's transcript ends with a result of (error_max_turns|error_during_execution|error_max_budget_usd|success marked as an error)$/, function (subtype: string) {
  const c = ctx(this);
  const r = subtype === "success marked as an error" ? final(c, { subtype: "success", isError: true, text: "API Error: 500 Internal server error" }) : final(c, { subtype });
  push(c, ...turn(c, [say("Working on it")]), r);
});

function finals(root: El): El[] {
  return entries(root).filter((e) => kind(e) === "result");
}

function lastFinal(c: Ctx, root: El): El {
  const rs = finals(root);
  assert.ok(rs.length > 0, `the page shows no final result: its entries are ${JSON.stringify(kinds(root))}`);
  return rs.at(-1)!;
}

Then("the page ends with the final result", function () {
  const c = ctx(this);
  const root = page(c);
  const es = entries(root);
  assert.ok(es.length > 0 && kind(es.at(-1)!) === "result", `the page doesn't end with the final result: its entries are ${JSON.stringify(kinds(root))}`);
});

Then("the final result shows a cost of {string}", function (cost: string) {
  const c = ctx(this);
  const r = lastFinal(c, page(c));
  assert.ok(shown(c, r).includes(cost), `the final result doesn't show "${cost}": ${clip(shown(c, r))}`);
});

Then("the final result shows {string}", function (what: string) {
  const c = ctx(this);
  const r = lastFinal(c, page(c));
  assert.ok(shown(c, r).includes(what), `the final result doesn't show "${what}": ${clip(shown(c, r))}`);
});

Then(/^the final result says the attempt (.+)$/, function (ended: string) {
  const c = ctx(this);
  const r = lastFinal(c, page(c));
  assert.ok(shown(c, r).toLowerCase().includes(ended.toLowerCase()), `the final result doesn't say the attempt ${ended}: ${clip(shown(c, r))}`);
});

Given(/^the first call ended in success costing \$(\d+\.\d+), and the second in success costing \$(\d+\.\d+)$/, function (a: string, b: string) {
  const c = ctx(this);
  // modelUsage is each call's running total, so each call's result is that call's own cost.
  c.calls[0].msgs.push(...turn(c, [say("First pass done")]), final(c, { subtype: "success", cost: Number(a) }));
  c.calls[1].msgs.push(...turn(c, [say("Second pass done")]), final(c, { subtype: "success", cost: Number(b) }));
});

Then("the first call's final result shows {string} before the second call's brief", function (cost: string) {
  const c = ctx(this);
  const root = page(c);
  const rs = finals(root);
  const briefs = entries(root).filter((e) => kind(e) === "brief");
  assert.equal(rs.length, 2, `the page shows ${rs.length} final results, not 2: ${JSON.stringify(kinds(root))}`);
  assert.equal(briefs.length, 2, `the page shows ${briefs.length} briefs, not 2: ${JSON.stringify(kinds(root))}`);
  assert.ok(shown(c, rs[0]).includes(cost), `the first call's final result doesn't show "${cost}": ${clip(shown(c, rs[0]))}`);
  inOrder(c, root, [rs[0], briefs[1]], ["the first call's final result", "the second call's brief"]);
});

Then("the second call's final result shows {string} at the end of the page", function (cost: string) {
  const c = ctx(this);
  const root = page(c);
  const es = entries(root);
  assert.ok(es.length > 0 && kind(es.at(-1)!) === "result", `the page doesn't end with a final result: ${JSON.stringify(kinds(root))}`);
  assert.ok(shown(c, es.at(-1)!).includes(cost), `the last final result doesn't show "${cost}": ${clip(shown(c, es.at(-1)!))}`);
});

// ---- AC-5 ----

Given(/^the attempt's (brief|assistant's thinking|assistant's text|tool call's input|tool result|tool result's rest, once opened|subagent's name and description|final result's message|line the page can't read) holds "(.*)"$/, function (where: string, markup: string) {
  const c = ctx(this);
  c.markupIn = where;
  if (where === "brief") c.calls[0].brief = markup;
  else if (where === "assistant's thinking") push(c, ...turn(c, [thinking(markup), say("Thought it through")]));
  else if (where === "assistant's text") push(c, ...turn(c, [say(markup)]));
  else if (where === "tool call's input") push(c, ...turn(c, [use(c, "Bash", bashInput(markup), markup)]));
  else if (where === "tool result") push(c, ...turn(c, [use(c, "Bash", bashInput("cat page.html"), "cat page.html")]), results(c, [{ id: c.tool!.id, content: markup }]));
  else if (where === "tool result's rest, once opened") {
    c.openAll = true;
    push(c, ...turn(c, [use(c, "Bash", bashInput("cat page.html"), "cat page.html")]), results(c, [{ id: c.tool!.id, content: [...lines(300, (k) => `page line ${k}`), markup].join("\n") }]));
  } else if (where === "subagent's name and description") push(c, ...turn(c, [say("Asking a subagent")]), taskStarted(c, "task-markup", markup, markup), taskFinished(c, "task-markup", "completed", "Done"));
  else if (where === "final result's message") push(c, ...turn(c, [say("Finishing")]), final(c, { subtype: "success", text: markup }));
  else push(c, { raw: markup });
});

Then("the page shows {string} as text", function (what: string) {
  const c = ctx(this);
  const root = page(c);
  const got = shown(c, root);
  assert.ok(got.includes(what), `the page doesn't show ${JSON.stringify(what)} as text${c.openAll ? ", once opened" : ""}: ${clip(got)}`);
});

Then("the page has no script, image or bold element that came from the transcript", function () {
  const c = ctx(this);
  const els = all(page(c));
  assert.deepEqual(els.filter((e) => e.tag === "script").map((e) => text(e)), [], "the page has a script element");
  assert.deepEqual(els.filter((e) => e.tag === "img" && (e.attrs.src === "x" || "onerror" in e.attrs)).length, 0, "the page has the transcript's image");
  assert.deepEqual(els.filter((e) => e.tag === "b" && text(e) === "bold").length, 0, "the page has the transcript's bold element");
  assert.equal(els.filter((e) => Object.keys(e.attrs).some((a) => a.startsWith("on"))).length, 0, "the page has an element with an event handler attribute");
});

Then("no script from the transcript has run", function () {
  const c = ctx(this);
  page(c);
  assert.equal((globalThis as { pwned?: unknown }).pwned, undefined, "the transcript's script ran");
  assert.ok(!/<script\b/i.test(c.html), "the page holds a script element, which a browser would run");
});

Given("an assistant turn in the attempt's transcript calls a tool named {string}", function (name: string) {
  const c = ctx(this);
  push(c, ...turn(c, [use(c, name, { command: "ls" }, "ls")]));
});

Then("the call shows the tool's name {string} as text", function (name: string) {
  const c = ctx(this);
  c.subject = findCall(c, page(c), name);
});

Then("the page has no italic element that came from the transcript", function () {
  const c = ctx(this);
  assert.equal(all(page(c)).filter((e) => e.tag === "i" && text(e) === "Bash").length, 0, "the page has the transcript's italic element");
});

Given("an assistant turn in the attempt's transcript says {string}", function (said: string) {
  const c = ctx(this);
  c.mark = said;
  push(c, ...turn(c, [say(said)]));
});

// ---- AC-6 ----

function running(c: Ctx): void {
  c.state = "InProgress";
  c.runOpen = true;
  c.row = { status: "started", ended_at: null, cost_usd: null, tokens_in: null, tokens_out: null };
  c.store = "uploaded";
}

const snapshot = { snapshot: true } as const;
function textTurns(c: Ctx, prefix: string, from: number, to: number): string[] {
  const said = lines(to - from + 1, (k) => `${prefix} ${from + k - 1}`);
  for (const s of said) push(c, ...turn(c, [say(s)]));
  return said;
}

Given("item {string} is In progress and its {string} stage attempt {int} is still running", function (label: string, stage: string, attempt: number) {
  const c = ctx(this);
  assert.equal(label, c.label);
  sameAttempt(c, stage, attempt);
  running(c);
});

Given("the cell has uploaded the transcript so far, holding the brief and {int} assistant turns", function (n: number) {
  const c = ctx(this);
  c.uploadedTurns = textTurns(c, "Uploaded turn", 1, n);
  push(c, snapshot);
});

Given("the agent has written {int} more turns since, which haven't been uploaded yet", function (n: number) {
  const c = ctx(this);
  c.notUploaded = textTurns(c, "Written since, turn", 1, n);
});

Then("the page shows the brief and the {int} uploaded turns", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  const brief = c.calls[0].brief;
  assert.ok(entries(root).some((e) => kind(e) === "brief" && shown(c, e).includes(brief)), `the page doesn't show the brief: its entries are ${JSON.stringify(kinds(root))}`);
  assert.equal(turns(root).length, n, `the page shows ${turns(root).length} turns, not ${n}: ${JSON.stringify(kinds(root))}`);
  inOrder(c, root, c.uploadedTurns, c.uploadedTurns.map((s) => `"${s}"`));
});

Then("it doesn't show the {int} turns written since", function (n: number) {
  const c = ctx(this);
  const got = shown(c, page(c));
  assert.equal(c.notUploaded.length, n);
  for (const s of c.notUploaded) assert.ok(!got.includes(s), `the page shows "${s}", which wasn't uploaded`);
});

Then("the page says the attempt is still running", function () {
  const c = ctx(this);
  assert.match(shown(c, page(c)), stillRunning, "the page doesn't say the attempt is still running");
});

Then("the page shows no final result", function () {
  const c = ctx(this);
  const root = page(c);
  assert.equal(finals(root).length, 0, `the page shows a final result: ${JSON.stringify(kinds(root))}`);
});

Given("the cell uploaded the transcript so far with {int} assistant turns, and again with {int}", function (a: number, b: number) {
  const c = ctx(this);
  c.uploadedTurns = textTurns(c, "Uploaded turn", 1, a);
  push(c, snapshot);
  c.uploadedTurns.push(...textTurns(c, "Uploaded turn", a + 1, b));
  push(c, snapshot);
});

Then("the page shows all {int} turns in order", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  assert.equal(turns(root).length, n, `the page shows ${turns(root).length} turns, not ${n}: ${JSON.stringify(kinds(root))}`);
  inOrder(c, root, c.uploadedTurns, c.uploadedTurns.map((s) => `"${s}"`));
});

Given("the {string} stage attempt {int} has passed and its complete transcript is stored", function (stage: string, attempt: number) {
  const c = ctx(this);
  sameAttempt(c, stage, attempt);
  c.state = "InReview";
  c.runOpen = true;
  c.row = { status: "passed" };
  c.store = "complete";
  push(c, ...turn(c, [say("All scenarios pass")]), final(c, { subtype: "success", cost: 0.4213, tin: 12_750, tout: 640 }));
});

Then("the page doesn't say the attempt is still running", function () {
  const c = ctx(this);
  assert.doesNotMatch(shown(c, page(c)), stillRunning, "the page says the attempt is still running");
});

Then("the page shows the final result", function () {
  const c = ctx(this);
  lastFinal(c, page(c));
});

Given("the {string} stage attempt {int} started, the cell uploaded the transcript so far with {int} turns, and then the cell died without ending the stage", function (stage: string, attempt: number, n: number) {
  const c = ctx(this);
  sameAttempt(c, stage, attempt);
  running(c);
  c.uploadedTurns = textTurns(c, "Uploaded turn", 1, n);
  push(c, snapshot);
  c.notUploaded = textTurns(c, "Lost with the cell, turn", 1, 1);
});

Given("the run's lease has expired", function () {
  const c = ctx(this);
  // What closeStartedAttempts writes when the lease runs out (PBI 239): the item goes back to Queued, its run stays open.
  c.state = "Queued";
  c.row = { ...c.row, status: "stopped", ended_at: NOW.toISOString(), message: LEASE_RAN_OUT };
});

Then("the page shows the {int} uploaded turns", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  assert.equal(turns(root).length, n, `the page shows ${turns(root).length} turns, not ${n}: ${JSON.stringify(kinds(root))}`);
  inOrder(c, root, c.uploadedTurns, c.uploadedTurns.map((s) => `"${s}"`));
});

Then("the page says the attempt stopped before it finished", function () {
  const c = ctx(this);
  assert.match(shown(c, page(c)), /stopped before it finished/i, "the page doesn't say the attempt stopped before it finished");
});

Given("the transcript uploaded so far holds {int} assistant turns and then half of a fourth line", function (n: number) {
  const c = ctx(this);
  c.uploadedTurns = textTurns(c, "Uploaded turn", 1, n);
  textTurns(c, "Cut short, turn", n + 1, n + 1);
  push(c, snapshot);
  c.halfLast = true;
});

Then("the page shows the {int} turns", function (n: number) {
  const c = ctx(this);
  const root = page(c);
  assert.equal(turns(root).length, n, `the page shows ${turns(root).length} turns, not ${n}: ${JSON.stringify(kinds(root))}`);
  inOrder(c, root, c.uploadedTurns, c.uploadedTurns.map((s) => `"${s}"`));
});

// ---- AC-7 ----

Given("the attempt's transcript is stored as {string}", function (path: string) {
  const c = ctx(this);
  c.ref = path;
  push(c, ...turn(c, [say("Stored as it is")]), final(c, { subtype: "success" }));
});

Then("the page has a link to the raw JSON Lines file", function () {
  const c = ctx(this);
  const root = page(c);
  const want = `/bff/v1/blobs/${c.ref}`;
  const links = all(root).filter((e) => e.tag === "a");
  assert.ok(links.some((e) => e.attrs.href === want), `the page has no link to ${want}: its links are ${JSON.stringify(links.map((e) => e.attrs.href))}`);
});

async function follow(world: object): Promise<string> {
  const c = ctx(world);
  const r = await caller(world)(`/bff/v1/blobs/${c.ref}`);
  assert.equal(r.status, 200, `the raw link answered ${r.status}`);
  return r.text();
}

Then("following that link gives the stored {string} exactly as stored", async function (path: string) {
  const c = ctx(this);
  page(c);
  assert.equal(path, c.ref);
  assert.equal(await follow(this), c.blobs.get(path));
});

Given("the cell has uploaded the transcript so far as {string}", function (path: string) {
  const c = ctx(this);
  c.ref = path;
  c.uploadedTurns = textTurns(c, "Uploaded turn", 1, 2);
  push(c, snapshot);
});

Then("following that link gives the transcript uploaded so far, exactly as stored", async function () {
  const c = ctx(this);
  page(c);
  assert.equal(await follow(this), c.blobs.get(c.ref));
});

Given("the attempt's stored transcript holds no line the page can read", function () {
  const c = ctx(this);
  c.store = "explicit";
  c.explicit = "this isn't JSON\n{\"type\": \"assistant\", \"message\": \n<html>\n";
});
