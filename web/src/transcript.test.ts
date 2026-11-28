// PBI 326: reading a stage attempt's JSON Lines transcript as a conversation, and clipping long text to its first lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefLine } from "../../src/agent/brief.ts";
import { readTranscript, runningAttempt, type Call, type ItemData, type Stage } from "./api.ts";
import { clip, readConversation, shortInput, type Entry } from "./transcript.ts";

const jsonl = (...ms: (object | string)[]) => ms.map((m) => (typeof m === "string" ? m : JSON.stringify(m)) + "\n").join("");
const asst = (id: string, block: object, parent: string | null = null) =>
  ({ type: "assistant", message: { id, role: "assistant", content: [block] }, parent_tool_use_id: parent });
const results = (...rs: object[]) => ({ type: "user", message: { role: "user", content: rs } });
const kinds = (es: Entry[]) => es.map((e) => e.kind);

test("a call reads as its brief, then its turns, with each turn's blocks merged by message id, in order", () => {
  const es = readConversation(jsonl(
    briefLine("Make it pass"),
    { type: "system", subtype: "init" },
    asst("m1", { type: "thinking", thinking: "Hmm" }), asst("m1", { type: "text", text: "Reading" }),
    asst("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }),
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "system", subtype: "task_progress" },
    results({ type: "tool_result", tool_use_id: "t1", content: "contents" }),
    asst("m2", { type: "text", text: "Done" }),
  ), { running: false });
  assert.deepEqual(kinds(es), ["brief", "turn", "turn"]);
  assert.deepEqual(es[0], { kind: "brief", text: "Make it pass" });
  const t = es[1];
  assert.ok(t.kind === "turn");
  assert.deepEqual(t.parts.map((p) => p.kind), ["thinking", "text", "tool"]);
  const call = t.parts[2];
  assert.ok(call.kind === "tool");
  assert.equal(call.short, "a.ts");
  assert.deepEqual(call.result, { text: "contents", error: false });
});

test("each result goes to its own call, an error is marked as one, and a call with none has a null result", () => {
  const es = readConversation(jsonl(
    asst("m1", { type: "tool_use", id: "a", name: "Read", input: { file_path: "a.ts" } }),
    asst("m1", { type: "tool_use", id: "b", name: "Read", input: { file_path: "b.ts" } }),
    asst("m1", { type: "tool_use", id: "c", name: "Bash", input: { command: "npm test" } }),
    results(
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "contents of b" }] },
      { type: "tool_result", tool_use_id: "a", content: "<tool_use_error>File does not exist</tool_use_error>", is_error: true },
    ),
  ), { running: false });
  const t = es[0];
  assert.ok(t.kind === "turn");
  const [a, b, c] = t.parts;
  assert.ok(a.kind === "tool" && b.kind === "tool" && c.kind === "tool");
  assert.deepEqual(a.result, { text: "File does not exist", error: true });
  assert.deepEqual(b.result, { text: "contents of b", error: false });
  assert.equal(c.result, null);
});

test("redacted thinking reads as thinking with no words", () => {
  const es = readConversation(jsonl(asst("m1", { type: "redacted_thinking", data: "abc" })), { running: false });
  assert.ok(es[0].kind === "turn");
  assert.deepEqual(es[0].parts, [{ kind: "thinking", text: null }]);
});

test("subagent tasks read as a start and a finish, the finish named by its task's start", () => {
  const es = readConversation(jsonl(
    { type: "system", subtype: "task_started", task_id: "k", subagent_type: "Explore", description: "Find it" },
    { type: "system", subtype: "task_notification", task_id: "k", status: "failed", summary: "Gave up" },
  ), { running: false });
  assert.deepEqual(es, [
    { kind: "subagent-start", name: "Explore", description: "Find it" },
    { kind: "subagent-finish", name: "Explore", status: "failed", summary: "Gave up" },
  ]);
});

test("a background shell's task isn't a subagent's, so neither its start nor its finish shows", () => {
  const es = readConversation(jsonl(
    { type: "system", subtype: "task_started", task_id: "b1", task_type: "local_bash", description: "Run the full test suite", is_backgrounded: true },
    { type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "Background command completed", output_file: "/tmp/x" },
    { type: "system", subtype: "task_started", task_id: "a1", task_type: "local_agent", description: "Look around" },
    { type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "Looked" },
  ), { running: false });
  assert.deepEqual(es, [
    { kind: "subagent-start", name: "subagent", description: "Look around" },
    { kind: "subagent-finish", name: "subagent", status: "completed", summary: "Looked" },
  ]);
});

test("a final result reads as how the call ended, with its cost and tokens summed over its models", () => {
  const usage = (costUSD: number, i: number, o: number) => ({ inputTokens: i, outputTokens: o, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, costUSD });
  const end = (subtype: string, isError: boolean, more: object) => readConversation(jsonl({ type: "result", subtype, is_error: isError, modelUsage: { x: usage(0.25, 1000, 10), y: usage(0.5, 0, 5) }, ...more }), { running: false })[0];
  assert.deepEqual(end("success", false, { result: "All done" }), { kind: "result", ended: "succeeded", ok: true, costUsd: 0.75, tokensIn: 1200, tokensOut: 15, message: "All done" });
  for (const [subtype, isError, ended] of [
    ["success", true, "failed with an error"], ["error_max_turns", true, "ran out of turns"],
    ["error_during_execution", true, "failed with an error"], ["error_max_budget_usd", true, "ran out of budget"],
  ] as const) {
    const r = end(subtype, isError, subtype === "success" ? { result: "API Error" } : { errors: ["one", "two"] });
    assert.ok(r.kind === "result" && r.ended === ended && !r.ok, `${subtype}: ${JSON.stringify(r)}`);
    assert.equal(r.message, subtype === "success" ? "API Error" : "one\ntwo");
  }
});

test("a line that isn't a JSON object reads as itself, unreadable, and blank lines read as nothing", () => {
  assert.deepEqual(readConversation("{oops\n\n42\n", { running: false }), [{ kind: "unreadable", line: "{oops" }, { kind: "unreadable", line: "42" }]);
});

test("a running attempt's last line, cut short by an upload in flight, is left out", () => {
  const body = jsonl(asst("m1", { type: "text", text: "One" })) + '{"type":"assis';
  assert.deepEqual(kinds(readConversation(body, { running: true })), ["turn"]);
  assert.deepEqual(kinds(readConversation(body, { running: false })), ["turn", "unreadable"]);
});

test("a tool call's short form is its main field, and the rest of its input are its other fields", () => {
  assert.deepEqual(shortInput("Bash", { command: "npm test", description: "Run the tests" }), { short: "npm test", fields: [{ key: "description", value: "Run the tests" }] });
  assert.deepEqual(shortInput("Edit", { file_path: "x.ts", old_string: "a", new_string: "b" }).short, "x.ts");
  assert.deepEqual(shortInput("Grep", { pattern: "ref", path: "src" }).short, "ref");
  assert.deepEqual(shortInput("mcp__acme__lookup", { n: 3, ticket: "ACME-12" }), { short: "ACME-12", fields: [{ key: "n", value: "3" }] });
  const long = shortInput("Bash", { command: "cat <<EOF\nline\nEOF" });
  assert.equal(long.short, "cat <<EOF …");
  assert.deepEqual(long.fields, [{ key: "command", value: "cat <<EOF\nline\nEOF" }]);
  assert.deepEqual(shortInput("Read", null), { short: "", fields: [] });
});

test("clip keeps short text whole, and cuts long text to its first lines or characters, saying how much is left", () => {
  assert.deepEqual(clip("a\nb\nc"), { head: "a\nb\nc", rest: "", more: "" });
  const many = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
  const m = clip(many);
  assert.equal(m.head.split("\n").length, 10);
  assert.equal(m.head + "\n" + m.rest, many);
  assert.equal(m.more, "390 more lines");
  const one = clip("x".repeat(5000));
  assert.equal(one.head.length, 1000);
  assert.equal(one.rest.length, 4000);
  assert.equal(one.more, "4,000 more characters");
  assert.deepEqual(clip("a\n".repeat(10)), { head: "a\n".repeat(10), rest: "", more: "" });
});

// ---- readTranscript ----

const ITEM = "i-326";
const stageRow = (more: Partial<Stage> = {}): Stage => ({
  stage_id: "build", attempt: 1, model: "m", tokens_in: 1, tokens_out: 1, cost_usd: "0.1", status: "passed",
  transcript_ref: "transcripts/r/build-1.jsonl", started_at: "2026-11-28T10:00:00.000Z", ended_at: "2026-11-28T10:05:00.000Z", ...more,
});
const itemData = (stages: Stage[], more: Partial<ItemData> = {}) => ({
  item: { id: ITEM, external_id: "326", repo: "acme/shop", title: "Add search", state: "InProgress" },
  run: { open: true }, stages, linkBlobs: true, ...more,
}) as unknown as ItemData;

function caller(item: ItemData, blobs: Record<string, string>, seen: string[] = []): Call {
  return async (path: string) => {
    seen.push(path);
    if (path === `/bff/v1/items/${ITEM}`) return Response.json(item);
    const ref = /^\/bff\/v1\/blobs\/(.+)$/.exec(path)?.[1];
    if (ref !== undefined && ref in blobs) return new Response(blobs[ref], { headers: { "content-type": "text/plain" } });
    return Response.json({ error: "no such file" }, { status: 404 });
  };
}

test("readTranscript reads the item and the attempt's stored transcript, as text, with its raw file's address", async () => {
  const seen: string[] = [];
  const d = await readTranscript(caller(itemData([stageRow()]), { "transcripts/r/build-1.jsonl": "{}\n" }, seen), ITEM, "build", 1);
  assert.deepEqual(seen, [`/bff/v1/items/${ITEM}`, "/bff/v1/blobs/transcripts/r/build-1.jsonl"]);
  assert.equal(d.jsonl, "{}\n");
  assert.equal(d.rawHref, "/bff/v1/blobs/transcripts/r/build-1.jsonl");
  assert.equal(d.running, false);
  assert.equal(d.item.title, "Add search");
});

test("readTranscript gives no transcript for one no longer stored, nor for an attempt with none or where none can be served", async () => {
  assert.equal((await readTranscript(caller(itemData([stageRow()]), {}), ITEM, "build", 1)).jsonl, null);
  const none = await readTranscript(caller(itemData([stageRow({ transcript_ref: null })]), {}), ITEM, "build", 1);
  assert.deepEqual([none.jsonl, none.rawHref], [null, null]);
  const unserved = await readTranscript(caller(itemData([stageRow()], { linkBlobs: false }), { "transcripts/r/build-1.jsonl": "{}\n" }), ITEM, "build", 1);
  assert.deepEqual([unserved.jsonl, unserved.rawHref], [null, null]);
});

test("readTranscript fails for an attempt the item doesn't have", async () => {
  await assert.rejects(readTranscript(caller(itemData([stageRow()]), {}), ITEM, "build", 2), /no "build" attempt 2/);
});

test("an attempt is running only while it's the newest, unended, on an In progress item's open run", () => {
  const old = stageRow({ stage_id: "red", status: "started", ended_at: null, started_at: "2026-11-28T09:00:00.000Z" });
  const now = stageRow({ status: "started", ended_at: null });
  assert.equal(runningAttempt(itemData([old, now])), now);
  assert.equal(runningAttempt(itemData([old, stageRow()])), null);
  assert.equal(runningAttempt(itemData([now], { run: { open: false } } as Partial<ItemData>)), null);
  assert.equal(runningAttempt({ ...itemData([now]), item: { ...itemData([]).item, state: "Queued" } }), null);
});
