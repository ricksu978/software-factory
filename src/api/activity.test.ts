import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActivityRow } from "../http/views.ts";
import { activityLog } from "./activity.ts";

const at = new Date("2026-11-19T09:00:00Z");
const base: ActivityRow = { at, external_id: "95", repo: "acme/shop", title: "Export a month", kind: "transition", from: "Queued", to: "InProgress", event: "claimed", actor: "system-x", setting: null, reason: null };

describe("the activity log's rows", () => {
  test("a transition keeps its states and event, with the time as ISO", () => {
    assert.deepEqual(activityLog([base]), [{
      at: "2026-11-19T09:00:00.000Z", external_id: "95", repo: "acme/shop", title: "Export a month", kind: "transition",
      from: "Queued", to: "InProgress", event: "claimed",
    }]);
  });

  test("an override keeps its states but not an event, as the page shows it", () => {
    const [row] = activityLog([{ ...base, kind: "override", event: "stop" }]);
    assert.deepEqual([row.from, row.to, row.event], ["Queued", "InProgress", null]);
  });

  test("another kind carries no states, even if its payload has some", () => {
    const [row] = activityLog([{ ...base, kind: "comment" }]);
    assert.deepEqual([row.from, row.to, row.event], [null, null, null]);
    assert.ok(!("actor" in row) && !("reason" in row));
  });

  test("a setting change says who changed which setting, from what, to what, and why", () => {
    const [row] = activityLog([{ ...base, external_id: null, repo: null, title: null, kind: "setting", from: "3", to: "5", event: null, actor: "octo", setting: "review capacity", reason: "the queue is long" }]);
    assert.deepEqual(row, { at: "2026-11-19T09:00:00.000Z", external_id: null, repo: null, title: null, kind: "setting", from: "3", to: "5", event: null, actor: "octo", setting: "review capacity", reason: "the queue is long" });
  });
});
