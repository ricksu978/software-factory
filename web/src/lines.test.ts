// The SPA's sentences (redesign step 8b): each reads as today's pages in src/http/views.ts word it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  age, blockedReason, claimLines, drainLine, heartbeatLine, mainRedLead, moveLine, recheckLine, restartLine, schedulerBanner,
  sentence, standing, summary,
} from "./lines.ts";

const key = { own: 3, priority: 3, priorityFrom: null, finalStage: false, finalStageFrom: null, bug: false };

test("age reads minutes, hours, then days", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  assert.equal(age(null, now), "");
  assert.equal(age("2026-11-20T11:48:00Z", now), "12 min");
  assert.equal(age("2026-11-20T09:00:00Z", now), "3 h");
  assert.equal(age("2026-11-18T12:00:00Z", now), "2 days");
});

test("a blocked item names what it waits on", () => {
  assert.equal(blockedReason(["12"]), "Waits on #12, which is still open. It starts once it closes.");
  assert.equal(blockedReason(["12", "13", "14"]), "Waits on #12, #13 and #14, which are still open. It starts once they close.");
});

test("standing names the priority, where it comes from and the final-stage group", () => {
  assert.equal(standing(key), "priority 3");
  assert.equal(standing({ ...key, priority: 2, priorityFrom: { id: "x", externalId: "44" }, finalStage: true, finalStageFrom: { id: "x", externalId: "44" } }),
    "priority 2, from #44, final-stage because of #44");
  assert.equal(standing({ ...key, finalStage: true }), "priority 3, final-stage");
});

test("claim lines never say final-stage or bug label for an item that is neither", () => {
  assert.equal(claimLines(key), "Priority 3.");
  assert.equal(claimLines({ ...key, priority: 1, bug: true }),
    "Priority 1. Carries the bug label, so it's claimed before the priority-1 items outside the final-stage group that don't.");
  assert.equal(claimLines({ ...key, priorityFrom: { id: "x", externalId: "44" }, priority: 2, own: 5 }),
    "Priority 2, from #44, which depends on it. Its own priority on the board is 5.");
});

test("a drain counts its cells, or gives its reason alone without a count", () => {
  assert.equal(drainLine("deploy", undefined), "Draining: deploy");
  assert.equal(drainLine("deploy", 1), "Draining: 1 cell still running. Reason: deploy.");
  assert.equal(drainLine("deploy", 0), "Drain done. No cell is running, so it's safe to restart the factory or stop Docker. Reason: deploy.");
});

test("a restart being prepared counts its cells", () => {
  assert.equal(restartLine({ running: 2, reason: "x" }), "Preparing to restart: 2 cells still running. The factory won't stop them. Reason: x.");
  assert.equal(restartLine({ running: 0 }), "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker.");
});

test("main red names the fix first only when an item is charged", () => {
  const b = { branch: "main", sha: "deadbee1234", repo: "a/b", pr_number: 90, charged: "40", bug_external_id: null, bug_id: null, bug_title: null };
  assert.equal(mainRedLead([b]), "main is red. The factory fixes it before it builds anything else, and an item merged onto it meanwhile waits for it to pass again.");
  assert.equal(mainRedLead([{ ...b, charged: null }]), "main is red. An item merged onto it meanwhile waits for it to pass again.");
});

test("recheck lines", () => {
  assert.equal(recheckLine(null, "UTC", false), "Failed on main, not yet re-checked");
  assert.equal(recheckLine("2026-11-20T10:00:00Z", "UTC", false), "Failed on main, last re-checked at 2026-11-20 10:00");
  assert.match(recheckLine(null, "UTC", true), /^It hasn't been re-checked yet\. /);
});

test("a move between states, and a setting change", () => {
  const e = { at: "", external_id: null, repo: null, title: null, from: "Queued", to: "InProgress", event: "claimed" };
  assert.equal(moveLine({ ...e, kind: "transition" }), "Queued → InProgress (claimed)");
  assert.equal(moveLine({ ...e, kind: "override" }), "Queued → InProgress");
  assert.equal(moveLine({ ...e, kind: "decision" }), "");
  assert.equal(moveLine({ ...e, kind: "setting", from: null, to: "4", actor: "octo", setting: "WIP limit", reason: "more cells free" }),
    "octo changed WIP limit from not set to 4 because more cells free");
});

test("the Phase 0 summary", () => {
  assert.equal(summary([]), "0 merged PRs, $0.00 in all, $0.00 each on average.");
  assert.equal(summary([3]), "1 merged PR, $3.00 in all, $3.00 each on average.");
  assert.equal(summary([3, 5]), "2 merged PRs, $8.00 in all, $4.00 each on average.");
});

test("an API error reads as a sentence", () => {
  assert.equal(sentence("that item isn't waiting for this decision"), "That item isn't waiting for this decision.");
  assert.equal(sentence("Done."), "Done.");
  assert.equal(sentence(""), "The factory refused it.");
});

test("the scheduler banner shows only once the heartbeat is more than a minute old, or there is none", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(schedulerBanner(ago(20_000), now), null);
  assert.equal(schedulerBanner(ago(60_000), now), null);
  assert.equal(schedulerBanner(ago(61_000), now), "Scheduler not ticking. The worker last ticked 1 min ago.");
  assert.equal(schedulerBanner(ago(90_000), now), "Scheduler not ticking. The worker last ticked 2 min ago.");
  assert.equal(schedulerBanner(ago(3 * 3600_000), now), "Scheduler not ticking. The worker last ticked 3 h ago.");
  assert.equal(schedulerBanner(ago(3 * 86_400_000), now), "Scheduler not ticking. The worker last ticked 3 days ago.");
  assert.equal(schedulerBanner(null, now), "Scheduler not ticking. The worker hasn't ticked yet.");
  assert.equal(schedulerBanner(undefined, now), null, "a floor that carries no heartbeat says nothing about it");
});

test("the heartbeat's line says when the worker last ticked", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  assert.equal(heartbeatLine(new Date(now.getTime() - 20_000).toISOString(), now), "The worker last ticked under a minute ago.");
  assert.equal(heartbeatLine(new Date(now.getTime() - 3 * 3600_000).toISOString(), now), "The worker last ticked 3 h ago.");
  assert.equal(heartbeatLine(null, now), "The worker hasn't ticked yet.");
});
