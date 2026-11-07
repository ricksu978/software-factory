import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activityPage, floorPage } from "./views.ts";

describe("activityPage", () => {
  const at = new Date("2026-11-07T09:05:00Z");

  test("shows a transition's time, item, kind, states and event, one row each", () => {
    const html = activityPage([{ at, external_id: "95", title: "Export a month", kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }], null);
    assert.match(html, /<title>Activity<\/title>/);
    const row = /<tbody>([\s\S]*)<\/tbody>/.exec(html)![1];
    assert.match(row, /<time datetime="2026-11-07T09:05:00.000Z">2026-11-07 09:05<\/time>/);
    for (const v of ["95", "Export a month", "transition", "Queued", "InProgress", "claimed"]) assert.ok(row.includes(v), v);
  });

  test("shows an override's states without an event, and no states for any other kind", () => {
    const html = activityPage([
      { at, external_id: "95", title: "t", kind: "override", from: "InProgress", to: "Failed", event: null },
      { at, external_id: "95", title: "t", kind: "comment", from: "Queued", to: "Failed", event: "x" },
    ], null);
    const [override, comment] = [...html.matchAll(/<tr><td>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    assert.match(override, /InProgress/);
    assert.match(override, /Failed/);
    assert.doesNotMatch(comment, /Queued|Failed|>x</);
  });

  test("escapes titles and says so when nothing has happened", () => {
    const html = activityPage([{ at, external_id: "<i>", title: "<script>alert(1)</script>", kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }], null);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.doesNotMatch(html, /<script>alert|<i>/);
    assert.match(activityPage([], null), /No event yet/);
  });
});

describe("floorPage", () => {
  test("links to the activity log", () => {
    const html = floorPage({ active: [], waiting: [], waitingCount: 0, capacity: 3, next: [], notReady: [], factory: [], canOperate: false }, null);
    assert.match(html, /<a href="\/activity">/);
  });
});
