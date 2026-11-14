import assert from "node:assert/strict";
import { test } from "node:test";
import { githubFailed } from "./errors.ts";

const http = (status: number, cause?: unknown) => Object.assign(new Error("x"), { name: "HttpError", status, cause });

test("GitHub's own 5xx, and Octokit's 500 for a fetch that failed or timed out, are GitHub failures", () => {
  for (const s of [500, 502, 503, 504]) assert.ok(githubFailed(http(s)), String(s));
  assert.ok(githubFailed(http(500, new TypeError("fetch failed"))));
  assert.ok(githubFailed(Object.assign(new DOMException("aborted", "AbortError"), { status: 500 })));
});

test("a 4xx from GitHub or an error of the factory's own isn't", () => {
  for (const s of [400, 401, 403, 404, 422]) assert.ok(!githubFailed(http(s)), String(s));
  assert.ok(!githubFailed(new Error("a bug")));
  assert.ok(!githubFailed(Object.assign(new Error("db"), { status: 503 })));
  assert.ok(!githubFailed("boom"));
});
