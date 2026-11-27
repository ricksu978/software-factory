// The SPA's reads and submit handlers (redesign step 8b), against a stand-in for the shell's call that records what
// it's sent and answers as the API does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFloor, readItem, type Call, type ItemData } from "./api.ts";
import { buttonsFor, submitAnswer, submitFeatureChange, submitFloorControls, submitItemControls, submitRuleApproval, submitSetting, submitSignOff } from "./forms.ts";

type Sent = { path: string; method: string; body: unknown };

function stub(answers: { post?: [number, unknown]; read?: unknown } = {}): { call: Call; sent: Sent[] } {
  const sent: Sent[] = [];
  const call: Call = async (path, init) => {
    const method = init?.method ?? "GET";
    sent.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const [status, body] = method === "POST" ? answers.post ?? [201, { ok: true }] : [200, answers.read ?? { read: path }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { call, sent };
}

const item = { item: { id: "i-1", external_id: "46", repo: null, title: "Add search", state: "Queued" } } as ItemData;

test("a read that fails names its status", async () => {
  const call: Call = async () => new Response("{}", { status: 500 });
  await assert.rejects(readFloor(call), /500/);
  const { call: ok, sent } = stub();
  await readItem(ok, "i-1");
  assert.equal(sent[0].path, "/bff/v1/items/i-1");
});

test("a factory-wide override sends its kind and reason, then reads the floor again", async () => {
  const { call, sent } = stub({ read: { floor: true } });
  const r = await submitFloorControls(call, "Kill switch", "  runaway spend ");
  assert.deepEqual(r, { outcome: "accepted", data: { floor: true } });
  assert.deepEqual(sent.map((s) => [s.method, s.path]), [["POST", "/bff/v1/overrides"], ["GET", "/bff/v1/floor"]]);
  assert.deepEqual(sent[0].body, { kind: "kill", reason: "runaway spend" });
});

test("an override with an empty reason, or one of spaces, sends nothing", async () => {
  const { call, sent } = stub();
  assert.deepEqual(await submitFloorControls(call, "Pause", ""), { outcome: "refused", field: "Reason" });
  assert.deepEqual(await submitItemControls(call, item, "Re-queue", "   "), { outcome: "refused", field: "Reason" });
  assert.deepEqual(sent, []);
});

test("an item override names the item, and a refusal reads as the API's sentence", async () => {
  const { call, sent } = stub({ post: [409, { error: "only a Failed or Abandoned item can be re-queued" }] });
  const r = await submitItemControls(call, item, "Re-queue", "fixed");
  assert.deepEqual(r, { outcome: "failed", message: "Only a Failed or Abandoned item can be re-queued." });
  assert.deepEqual(sent[0].body, { kind: "requeue", reason: "fixed", itemId: "i-1" });
  assert.equal(sent.length, 1, "nothing is read again after a refusal");
});

test("a button the form doesn't have is an error, not a send", async () => {
  const { call, sent } = stub();
  await assert.rejects(submitFloorControls(call, "Hold", "x"), /no "Hold" button/);
  assert.deepEqual(sent, []);
});

test("sign-off sends the decision with the note, which may be empty", async () => {
  const { call, sent } = stub({ post: [200, { outcome: "applied" }] });
  const r = await submitSignOff(call, item, "Approve the scenarios", "");
  assert.equal(r.outcome, "accepted");
  assert.deepEqual(sent.map((s) => [s.method, s.path]), [["POST", "/bff/v1/items/i-1/decisions"], ["GET", "/bff/v1/items/i-1"]]);
  assert.deepEqual(sent[0].body, { kind: "approve", text: "" });
  await submitSignOff(call, item, "Ask for changes", "More");
  assert.deepEqual(sent[2].body, { kind: "changes", text: "More" });
});

test("a 403 on a decision shows the API's refusal", async () => {
  const { call } = stub({ post: [403, { error: "you can't make that decision" }] });
  assert.deepEqual(await submitSignOff(call, item, "Approve the scenarios", ""), { outcome: "failed", message: "You can't make that decision." });
});

test("an answer needs text", async () => {
  const { call, sent } = stub({ post: [200, { outcome: "applied" }] });
  assert.deepEqual(await submitAnswer(call, item, "Send the answer", " "), { outcome: "refused", field: "Your answer" });
  assert.equal((await submitAnswer(call, item, "Send the answer", "Blue")).outcome, "accepted");
  assert.deepEqual(sent[0].body, { kind: "answer", text: "Blue" });
});

test("an item's buttons fit its controls", () => {
  const c = { held: false, stoppable: false, requeueable: false };
  assert.deepEqual(buttonsFor({ ...c, stoppable: true }), ["Hold", "Stop the run"]);
  assert.deepEqual(buttonsFor({ ...c, held: true, requeueable: true }), ["Release the hold", "Re-queue"]);
  assert.deepEqual(buttonsFor({ ...c, startable: true, movable: true }), ["Hold", "Start now", "Move up", "Move down"]);
});

test("an override the factory accepts whose re-read fails says it was accepted, not that it wasn't sent", async () => {
  const sent: string[] = [];
  const call: Call = async (path, init) => {
    sent.push(`${init?.method ?? "GET"} ${path}`);
    return init?.method === "POST" ? new Response('{"ok":true}', { status: 201 }) : new Response('{"error":"bad gateway"}', { status: 502 });
  };
  const r = await submitItemControls(call, item, "Move up", "urgent");
  assert.equal(r.outcome, "failed");
  assert.match((r as { message: string }).message, /^The factory accepted it, but the page couldn't be read again .*502.*Reload the page before sending it again\.$/);
  assert.deepEqual(sent, ["POST /bff/v1/overrides", "GET /bff/v1/items/i-1"]);
});

test("a feature change decision sends the button's decision with the note, then reads the item again (PBI 365)", async () => {
  const { call, sent } = stub({ post: [200, { outcome: "applied" }] });
  assert.equal((await submitFeatureChange(call, item, "Approve the change", "")).outcome, "accepted");
  assert.deepEqual(sent.map((s) => [s.method, s.path]), [["POST", "/bff/v1/items/i-1/feature-change"], ["GET", "/bff/v1/items/i-1"]]);
  assert.deepEqual(sent[0].body, { decision: "approve", note: "" });
  await submitFeatureChange(call, item, "Ask for changes", "Keep it\nas it was ");
  assert.deepEqual(sent[2].body, { decision: "changes", note: "Keep it\nas it was" });
  await assert.rejects(submitFeatureChange(call, item, "Approve the scenarios", ""), /no "Approve the scenarios" button/);
});

test("a rule change approval sends the hash of the rule changes the page shows (PBI 395)", async () => {
  const { call, sent } = stub({ post: [403, { error: "only an owner can approve a change to the factory's rules" }] });
  const shown = { ...item, ruleChanges: { changes: [], waiting: true, canApprove: true, approval: null, hash: "h-1" } } as ItemData;
  const r = await submitRuleApproval(call, shown, "Approve rule change", "");
  assert.deepEqual(r, { outcome: "failed", message: "Only an owner can approve a change to the factory's rules." });
  assert.deepEqual(sent, [{ path: "/bff/v1/items/i-1/rule-approval", method: "POST", body: { ruleChangesHash: "h-1" } }]);
  await assert.rejects(submitRuleApproval(call, item, "Approve rule change", ""), /no rule changes/);
});

test("a setting change sends its key, value and reason, then reads the settings again with the factory's notice (PBI 175)", async () => {
  const { call, sent } = stub({ post: [200, { ok: true, changed: "review_capacity", notice: "Setting saved: review capacity changed." }], read: { runtime: [] } });
  const r = await submitSetting(call, "review_capacity", " 5 ", " more reviewers ");
  assert.deepEqual(r, { outcome: "accepted", data: { data: { runtime: [] }, notice: "Setting saved: review capacity changed." } });
  assert.deepEqual(sent.map((s) => [s.method, s.path]), [["POST", "/bff/v1/configuration"], ["GET", "/bff/v1/configuration"]]);
  assert.deepEqual(sent[0].body, { setting: "review_capacity", value: "5", reason: "more reviewers" });
});

test("a setting change with no reason sends nothing, and one the factory turns down says why", async () => {
  const { call, sent } = stub({ post: [400, { error: "Review capacity must be a whole number of at least 1." }] });
  assert.deepEqual(await submitSetting(call, "review_capacity", "5", "  "), { outcome: "refused", field: "Reason" });
  assert.equal(sent.length, 0);
  assert.deepEqual(await submitSetting(call, "review_capacity", "0", "r"), { outcome: "failed", message: "Review capacity must be a whole number of at least 1." });
  assert.equal(sent.length, 1, "a refused change reads nothing again");
});
