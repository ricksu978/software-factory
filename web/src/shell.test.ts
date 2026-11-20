// Unit tests for the SPA's shell (web/src/shell.ts), against stand-ins for the browser it runs in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_ACCESS_TEXT, startShell, type ShellEnv, type ShellPage } from "./shell.ts";

type Listener = (e: { matches: boolean }) => void;

function browser(opts: { dark?: boolean; status?: number } = {}) {
  const b = {
    dark: opts.dark ?? false,
    status: opts.status ?? 200,
    calls: [] as { url: string; init?: RequestInit }[],
    queries: [] as string[],
    listeners: [] as Listener[],
    classes: new Set<string>(),
    navigations: [] as string[],
    shown: [] as ShellPage[],
  };
  const env: ShellEnv = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      b.calls.push({ url: String(input), init });
      return new Response("{}", { status: b.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    matchMedia(query: string) {
      b.queries.push(query);
      return {
        get matches() {
          return b.dark;
        },
        addEventListener: (_type: "change", l: Listener) => void b.listeners.push(l),
      };
    },
    root: {
      classList: {
        add: (t) => void b.classes.add(t),
        remove: (t) => void b.classes.delete(t),
        toggle: (t, force) => {
          const on = force ?? !b.classes.has(t);
          if (on) b.classes.add(t);
          else b.classes.delete(t);
          return on;
        },
        contains: (t) => b.classes.has(t),
      },
    },
    navigate: (url) => void b.navigations.push(url),
    show: (page) => void b.shown.push(page),
  };
  return { b, env };
}

test("the shell marks the page dark when the operating system is dark, and not when it's light", async () => {
  for (const dark of [true, false]) {
    const { b, env } = browser({ dark });
    await startShell(env);
    assert.deepEqual(b.queries, ["(prefers-color-scheme: dark)"]);
    assert.equal(b.classes.has("dark"), dark);
  }
});

test("the shell follows the operating system's colour scheme while it's open", async () => {
  const { b, env } = browser({ dark: false });
  await startShell(env);
  b.listeners.forEach((l) => l({ matches: true }));
  assert.ok(b.classes.has("dark"));
  b.listeners.forEach((l) => l({ matches: false }));
  assert.ok(!b.classes.has("dark"));
});

test("with a session the shell checks it on the BFF and shows the SPA's page", async () => {
  const { b, env } = browser();
  await startShell(env);
  assert.deepEqual(b.calls.map((c) => c.url), ["/bff/v1/floor"]);
  assert.equal(b.calls[0].init?.credentials, "same-origin");
  assert.deepEqual(b.shown, [{ kind: "app" }]);
  assert.deepEqual(b.navigations, []);
});

test("without a session the shell sends the browser to /auth/login and shows nothing", async () => {
  const { b, env } = browser({ status: 401 });
  await startShell(env);
  assert.deepEqual(b.navigations, ["/auth/login"]);
  assert.deepEqual(b.shown, []);
});

test("a 403 at start shows the no-access page", async () => {
  const { b, env } = browser({ status: 403 });
  await startShell(env);
  assert.deepEqual(b.shown, [{ kind: "no-access", text: NO_ACCESS_TEXT }]);
  assert.equal(NO_ACCESS_TEXT, "You don't have access to this factory. Ask an owner to add you.");
  assert.deepEqual(b.navigations, []);
});

test("a call that gets 401 after start sends the browser to /auth/login and still answers", async () => {
  const { b, env } = browser();
  const shell = await startShell(env);
  b.status = 401;
  const r = await shell.call("/bff/v1/floor");
  assert.equal(r.status, 401);
  assert.deepEqual(b.navigations, ["/auth/login"]);
});

test("a read that gets 403 after start shows the no-access page", async () => {
  const { b, env } = browser();
  const shell = await startShell(env);
  b.status = 403;
  await shell.call("/bff/v1/items/1");
  assert.deepEqual(b.shown.at(-1), { kind: "no-access", text: NO_ACCESS_TEXT });
});

test("a state-changing call that gets 403 is the caller's to report, not the no-access page", async () => {
  const { b, env } = browser();
  const shell = await startShell(env);
  b.status = 403;
  const r = await shell.call("/bff/v1/overrides", { method: "POST" });
  assert.equal(r.status, 403);
  assert.deepEqual(b.shown, [{ kind: "app" }]);
});

test("the shell calls nothing outside /bff/v1/ and /auth/", async () => {
  const { env } = browser();
  const shell = await startShell(env);
  for (const path of ["/v1/floor", "/runs/1", "//elsewhere.example/bff/v1/floor", "/bff/v2/x"]) {
    await assert.rejects(shell.call(path), /\/bff\/v1\/ or \/auth\//);
  }
});

test("an API that fails at start still shows the SPA's page, which reports its own failed reads", async () => {
  const { b, env } = browser({ status: 502 });
  await startShell(env);
  assert.deepEqual(b.shown, [{ kind: "app" }]);
  assert.deepEqual(b.navigations, []);
});
