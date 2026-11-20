import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { serveSpa } from "./spa.ts";

const PAGE = '<!doctype html><div id="root"></div><script type="module" src="/assets/index-abc.js"></script>';
let root: string;
let dist: string;
let app: Hono;

before(() => {
  root = mkdtempSync(join(tmpdir(), "spa-test-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), PAGE);
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "index-abc.css"), ":root{--background:#fff}");
  writeFileSync(join(root, "secret.txt"), "outside the build");
  app = new Hono();
  app.get("/auth/session", (c) => c.json({ error: "not signed in" }, 401));
  app.get("*", serveSpa(dist));
});
after(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string, method = "GET") => app.request(path, { method });

test("the SPA's page answers / and any path without a file extension, as HTML that isn't cached", async () => {
  for (const path of ["/", "/runs/482", "/items/7/"]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(await r.text(), PAGE);
    assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  }
});

test("a built file is served with its type, and a hashed asset is cached for good", async () => {
  const js = await get("/assets/index-abc.js");
  assert.equal(js.status, 200);
  assert.equal(await js.text(), "console.log(1)");
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.match(js.headers.get("cache-control") ?? "", /immutable/);
  const css = await get("/assets/index-abc.css");
  assert.match(css.headers.get("content-type") ?? "", /^text\/css/);
  assert.equal(await css.text(), ":root{--background:#fff}");
});

test("a HEAD gets the headers with no body", async () => {
  const r = await get("/assets/index-abc.js", "HEAD");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "");
});

test("a missing file with an extension gets 404, not the SPA's page", async () => {
  for (const path of ["/assets/missing.js", "/package.json", "/src/shell.ts", "/favicon.ico"]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(await r.text(), /id="root"/);
  }
});

test("nothing outside the built files is served, however the path is written", async () => {
  for (const path of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/..%5csecret.txt"]) {
    const r = await get(path);
    assert.ok(r.status === 404 || r.status === 400, `${path} answered ${r.status}`);
    assert.doesNotMatch(await r.text(), /outside the build/, path);
  }
});

test("the BFF's own addresses keep their answers, and an unknown one under /auth or /bff gets 404, not the page", async () => {
  assert.equal((await get("/auth/session")).status, 401);
  for (const path of ["/auth/nothing", "/bff/v2/floor", "/bff"]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(await r.text(), /id="root"/);
  }
});

test("before the SPA is built, the page answers 503 saying so", async () => {
  const empty = new Hono();
  empty.get("*", serveSpa(join(root, "not-built")));
  const r = await empty.request("/");
  assert.equal(r.status, 503);
  assert.match(await r.text(), /npm run build/);
});
