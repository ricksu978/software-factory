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
