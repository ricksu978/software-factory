// Renders the SPA's pages to a string with react-dom/server (redesign step 8a). Node can't strip JSX, so Vite's SSR
// loader loads web/src/page.tsx with the SPA's own config. A 403 must render the no-access page with today's text, and
// a session with a user must render App.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { FloorData, ItemData } from "./api.ts";
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

describe("a FeatureChangeRequest item on Floor and Run detail (PBI 366)", () => {
  const id = "00000000-0000-4000-8000-000000000366";
  const named = { id, title: "Hold an empty order", external_id: "366", repo: null };
  const floor = (featureChange: boolean): FloorData => ({
    active: [], waiting: [{ ...named, state: "FeatureChangeRequest", since: null, featureChange }], waitingCount: 1, capacity: 3,
    next: [], notReady: [], blocked: [], factory: [], keys: {}, finalStage: [], baseFails: [], mainBreaks: [], split: [], failed: [],
    restart: null, cellImage: null, canOperate: false, claudeToken: null,
  });
  const item = (featureChange: ItemData["featureChange"]): ItemData => ({
    item: { ...named, state: "FeatureChangeRequest" }, run: null, policies: [], stages: [], readiness: [], question: null, criteria: null,
    scope: null, pending: [], features: [], verdicts: [], linkBlobs: false, controls: null, featureChange,
  });
  const render = async (page: "Floor" | "RunDetail", data: FloorData | ItemData) => {
    const m = await vite.ssrLoadModule(`/src/pages/${page}.tsx`);
    const { createElement } = await import("react");
    return renderToString(createElement(m[page], { data, zone: "UTC", now: new Date() }));
  };

  test("Floor's Waiting on you row says it waits on the Product Owner and links to the request on Run detail", async () => {
    const html = await render("Floor", floor(true));
    assert.match(html, /waiting on the Product Owner/);
    assert.ok(html.includes(`href="/runs/${id}#feature-change-request"`), html);
    assert.match(html, />Feature change request</);
    assert.doesNotMatch(await render("Floor", floor(false)), /Feature change request|Product Owner/);
  });

  test("Run detail shows the request in a section the state line links to", async () => {
    const files = [{ path: "features/a.feature", reason: "Held, not refused", before: "  Then refused\n", after: "  Then held\n" }];
    const html = await render("RunDetail", item(files));
    assert.match(html, /waits on the Product Owner: <a [^>]*href="#feature-change-request"/);
    assert.match(html, /<h2 id="feature-change-request"[^>]*>Feature change request<\/h2>/);
    assert.match(html, /Held, not refused/);
    assert.match(html, /<del data-side="before">  Then refused<\/del>/);
    assert.match(html, /<ins data-side="after">  Then held<\/ins>/);
    assert.doesNotMatch(await render("RunDetail", item(null)), /Feature change request/);
  });
});
