// Renders the SPA's pages to a string with react-dom/server (redesign step 8a). Node can't strip JSX, so Vite's SSR
// loader loads web/src/page.tsx with the SPA's own config. A 403 must render the no-access page with today's text, and
// a session with a user must render App.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { NO_ACCESS_TEXT, type Shell, type ShellPage } from "./shell.ts";

let vite: ViteDevServer;
let pageFor: (shown: ShellPage, call: Shell["call"], path?: string) => ReactElement;

before(async () => {
  vite = await createServer({
    configFile: join(import.meta.dirname, "..", "vite.config.ts"),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  ({ pageFor } = await vite.ssrLoadModule("/src/page.tsx"));
});

after(async () => {
  await vite?.close();
});

const call: Shell["call"] = async () => new Response("{}", { status: 401 });

test("a no-access page renders NoAccess with today's text", () => {
  const html = renderToString(pageFor({ kind: "no-access", text: NO_ACCESS_TEXT }, call));
  assert.match(html, /No access/);
  assert.match(html, /Ask an owner to add you/);
  assert.doesNotMatch(html, /Software factory/);
});

test("an app page renders App, not the no-access page", () => {
  const html = renderToString(pageFor({ kind: "app" }, call));
  assert.match(html, /Software factory/);
  assert.doesNotMatch(html, /No access/);
});

test("App shows the page its address names, before its one read comes back", () => {
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/")), /Reading the floor/);
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/runs/00000000-0000-4000-8000-000000000046")), /Reading the item/);
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/phase0")), /Reading the Phase 0 report/);
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/activity")), /Reading the activity log/);
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/configuration")), /No such page/);
});

test("Floor ages the worker's heartbeat against the API's time, not the viewer's clock", async () => {
  const { Floor } = await vite.ssrLoadModule("/src/pages/Floor.tsx");
  const { createElement } = await import("react");
  const at = new Date("2026-11-20T12:00:00Z");
  const data = {
    waitingOnYou: [], productionLine: [], productionMore: 0, waitingCount: 0, capacity: 1, factory: [], keys: {},
    baseFails: [], mainBreaks: [], restart: null, cellImage: null, canOperate: false,
    claudeToken: null, workerHeartbeat: new Date(at.getTime() - 5_000).toISOString(), outboxSetAside: 0, at: at.toISOString(),
  };
  const render = (now: Date, d: object = data) => renderToString(createElement(Floor, { data: d, zone: "UTC", now }));
  const fast = render(new Date(at.getTime() + 90_000));
  assert.doesNotMatch(fast, /Scheduler not ticking/, "a viewer whose clock runs 90 s fast sees no banner");
  assert.match(fast, /last ticked under a minute ago/);
  const slow = { ...data, workerHeartbeat: new Date(at.getTime() - 61_000).toISOString() };
  assert.match(render(new Date(at.getTime() - 90_000), slow), /Scheduler not ticking/, "nor does one running 90 s slow hide it");
});

test("Floor links an item in FeatureChangeRequest to its request on Run detail, and no other item (PBI 366)", async () => {
  const { Floor } = await vite.ssrLoadModule("/src/pages/Floor.tsx");
  const { createElement } = await import("react");
  const at = new Date("2026-11-20T12:00:00Z");
  const row = { external_id: "364", repo: "octo/repo", title: "t", since: new Date(at.getTime() - 3 * 3_600_000).toISOString() };
  const data = {
    productionLine: [], productionMore: 0, waitingCount: 2, capacity: 3, factory: [], keys: {},
    baseFails: [], mainBreaks: [], restart: null, cellImage: null, canOperate: false,
    claudeToken: null, workerHeartbeat: at.toISOString(), outboxSetAside: 0, at: at.toISOString(),
    waitingOnYou: [
      { ...row, id: "a", state: "FeatureChangeRequest", why: "feature-change", feature_change: true, partOf: null },
      { ...row, id: "b", state: "SignOff", why: "sign-off", partOf: null },
    ],
  };
  const html = renderToString(createElement(Floor, { data, zone: "UTC", now: at })).replace(/<!-- -->/g, "");
  assert.match(html, /Waiting on the Product Owner&#x27;s decision on the <a [^>]*href="\/runs\/a#feature-change-request">Feature change request<\/a>/);
  assert.equal(html.match(/#feature-change-request/g)?.length, 1);
});

test("Run detail shows a proposed rewrite beside the current body, the changed words marked, and sends the owner to the dashboard (PBI 439)", async () => {
  const { RunDetail } = await vite.ssrLoadModule("/src/pages/RunDetail.tsx");
  const { createElement } = await import("react");
  const at = new Date("2026-11-20T12:00:00Z");
  const data = {
    item: { id: "a", external_id: "512", repo: "acme/widgets", title: "Faster checkout", state: "NotReady", held: false },
    run: null, policies: [], stages: [], readiness: [], question: null, criteria: null, scope: null, pending: [], features: [],
    verdicts: [], linkBlobs: true, controls: null,
    rewrite: {
      current: [[{ text: "Make", changed: false }, { text: "checkout", changed: true }]],
      proposed: [[{ text: "Make", changed: false }, { text: "the", changed: true }, { text: "checkout", changed: true }]],
    },
  };
  const html = renderToString(createElement(RunDetail, { data, zone: "UTC", now: at })).replace(/<!-- -->/g, "");
  assert.match(html, /Proposed rewrite/);
  assert.match(html, /data-side="current">.*Make.*<mark>checkout<\/mark>/);
  assert.match(html, /data-side="proposed">.*<mark>the<\/mark>.*<mark>checkout<\/mark>/);
  assert.match(html, /accepts it on the item&#x27;s page on today&#x27;s dashboard/);
  assert.doesNotMatch(html, /Accept rewrite/);
  assert.doesNotMatch(renderToString(createElement(RunDetail, { data: { ...data, rewrite: null }, zone: "UTC", now: at })), /Proposed rewrite/);
});
