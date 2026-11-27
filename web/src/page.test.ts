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
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/configuration")), /Reading the configuration/);
  assert.match(renderToString(pageFor({ kind: "app" }, call, "/settings")), /No such page/);
});

test("Floor ages the worker's heartbeat against the API's time, not the viewer's clock", async () => {
  const { Floor } = await vite.ssrLoadModule("/src/pages/Floor.tsx");
  const { createElement } = await import("react");
  const at = new Date("2026-11-20T12:00:00Z");
  const data = {
    active: [], waiting: [], waitingCount: 0, capacity: 1, next: [], notReady: [], blocked: [], factory: [], keys: {},
    finalStage: [], baseFails: [], mainBreaks: [], split: [], failed: [], restart: null, cellImage: null, canOperate: false,
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
    active: [], waitingCount: 2, capacity: 3, next: [], notReady: [], blocked: [], factory: [], keys: {},
    finalStage: [], baseFails: [], mainBreaks: [], split: [], failed: [], restart: null, cellImage: null, canOperate: false,
    claudeToken: null, workerHeartbeat: at.toISOString(), outboxSetAside: 0, at: at.toISOString(),
    waiting: [{ ...row, id: "a", state: "FeatureChangeRequest", feature_change: true }, { ...row, id: "b", state: "SignOff" }],
  };
  const html = renderToString(createElement(Floor, { data, zone: "UTC", now: at })).replace(/<!-- -->/g, "");
  assert.match(html, /Waiting on the Product Owner&#x27;s decision on the <a [^>]*href="\/runs\/a#feature-change-request">Feature change request<\/a>/);
  assert.equal(html.match(/#feature-change-request/g)?.length, 1);
});

test("Run detail offers a product owner the feature change decision, and the owner the rule change approval (PBI 365, PBI 395)", async () => {
  const { RunDetail } = await vite.ssrLoadModule("/src/pages/RunDetail.tsx");
  const { createElement } = await import("react");
  const at = new Date("2026-11-20T12:00:00Z");
  const base = {
    item: { id: "i", external_id: "1", repo: null, title: "t", state: "FeatureChangeRequest" }, run: null, policies: [], stages: [], readiness: [],
    question: null, criteria: null, scope: null, pending: [], features: [], verdicts: [], linkBlobs: true, controls: null,
  };
  const rule = {
    place: { kind: "spec", section: "§6" }, key: "§6", name: "spec section §6", before: "A lease lasts one minute", after: "A lease lasts five minutes",
    words: { before: [{ text: "A", changed: false }, { text: "one", changed: true }], after: [{ text: "A", changed: false }, { text: "five", changed: true }] },
  };
  const render = (d: object) => renderToString(createElement(RunDetail, { data: { ...base, ...d }, zone: "UTC", now: at })).replace(/<!-- -->/g, "");
  const files = [{ path: "features/a.feature", reason: "why", before: "Then a\n", after: "Then b\n" }];
  const deciding = render({ featureChange: files, canDecideFeatureChange: true, ruleChanges: { changes: [rule], waiting: true, canApprove: true, approval: null, hash: "h" } });
  assert.match(deciding, /<form aria-label="Feature change"[^>]*>[\s\S]*<textarea[^>]*name="note"[\s\S]*>Approve the change<\/button>[\s\S]*>Ask for changes<\/button>/);
  assert.match(deciding, /<h2[^>]*>Rule changes<\/h2><p>This item waits for the owner to approve its rule changes: spec section §6.<\/p>/);
  assert.match(deciding, /data-rule="§6"[\s\S]*<blockquote data-side="before"[^>]*><span>A<\/span><span> <mark>one<\/mark><\/span>/);
  assert.match(deciding, /<form aria-label="Rule approval"[\s\S]*>Approve rule change<\/button>/);
  const viewing = render({ featureChange: files, canDecideFeatureChange: false, ruleChanges: { changes: [rule], waiting: false, canApprove: false, approval: { by: "olive", at: at.toISOString() }, hash: "h" } });
  assert.doesNotMatch(viewing, /Approve the change|Approve rule change/);
  assert.match(viewing, /olive approved the rule change at <time[^>]*>2026-11-20 12:00<\/time>/);
  const decided = render({ item: { ...base.item, state: "Queued" }, featureChangeDecision: { kind: "changes", by: "pia", at: at.toISOString() } });
  assert.match(decided, /pia turned down the feature change request at <time[^>]*>2026-11-20 12:00<\/time>/);
});

test("the Configuration page offers an operator a form for each setting they can change, and a viewer none (PBI 175)", async () => {
  const { Configuration } = await vite.ssrLoadModule("/src/pages/Configuration.tsx");
  const { createElement } = await import("react");
  const data = (canOperate: boolean, pause: string | null) => ({
    runtime: [
      { key: "mode", label: "WIP mode", value: "fixed", editable: false, clearable: false, note: null },
      { key: "review_capacity", label: "review capacity", value: "3", editable: true, clearable: false, note: null },
      { key: "usage_pause", label: "usage pause", value: pause, editable: false, clearable: true, note: null },
    ],
    env: [{ key: "FACTORY_POLICY_DIR", label: "FACTORY_POLICY_DIR", value: "./policy\"><b>x</b>" }, { key: "FACTORY_KILL", label: "FACTORY_KILL", value: null }],
    canOperate, at: "2026-11-20T12:00:00Z",
  });
  const render = (d: object, o: object = {}) => renderToString(createElement(Configuration, { data: d, ...o })).replace(/<!-- -->/g, "");
  const viewer = render(data(false, "2026-11-21T00:00:00Z"));
  assert.match(viewer, /<h1[^>]*>Configuration<\/h1>/);
  assert.match(viewer, /<h2[^>]*>Runtime settings<\/h2>[\s\S]*<h2[^>]*>Env-backed settings<\/h2>/);
  assert.doesNotMatch(viewer, /<(form|input|button)\b/, "a viewer gets no form");
  assert.match(viewer, /<code>FACTORY_KILL<\/code><\/th><td[^>]*><span[^>]*>not set<\/span><\/td><td[^>]*>Needs a restart<\/td>/);
  assert.doesNotMatch(viewer, /<b>x<\/b>/, "a value shows as text");
  const operator = render(data(true, "2026-11-21T00:00:00Z"), { notice: "Setting saved: review capacity changed." });
  assert.match(operator, /data-slot="alert-description"[^>]*>Setting saved: review capacity changed.</);
  assert.match(operator, /name="setting" value="review_capacity"[\s\S]*<input[^>]*name="value"[^>]*value="3"[\s\S]*<input[^>]*id="reason-review_capacity"[^>]*required[^>]*name="reason"[\s\S]*>Change<\/button>/);
  assert.match(operator, /name="setting" value="usage_pause"[\s\S]*>Clear<\/button>/, "an active pause can be cleared");
  assert.doesNotMatch(operator, /value="mode"/, "the WIP mode has no form");
  assert.doesNotMatch(render(data(true, "2026-11-19T00:00:00Z")), /value="usage_pause"/, "a pause that has passed has no button");
  assert.match(render(data(false, null), { message: "Review capacity must be a whole number of at least 1." }), /role="alert"[\s\S]*Review capacity must be a whole number of at least 1./);
});

test("Floor links to the Configuration page (PBI 175)", async () => {
  const { Floor } = await vite.ssrLoadModule("/src/pages/Floor.tsx");
  const { createElement } = await import("react");
  const data = {
    active: [], waiting: [], waitingCount: 0, capacity: 1, next: [], notReady: [], blocked: [], factory: [], keys: {},
    finalStage: [], baseFails: [], mainBreaks: [], split: [], failed: [], restart: null, cellImage: null, canOperate: false, claudeToken: null,
  };
  assert.match(renderToString(createElement(Floor, { data, zone: "UTC", now: new Date() })), /<a [^>]*href="\/configuration"[^>]*>Configuration<\/a>/);
});
