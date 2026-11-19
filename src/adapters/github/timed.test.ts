import assert from "node:assert/strict";
import { test } from "node:test";
import { Octokit } from "@octokit/core";
import { githubFailed } from "./errors.ts";
import { GITHUB_REQUEST_TIMEOUT_MS, timedFetch } from "./timed.ts";

/** A fetch that never answers until its signal aborts, as a GitHub that hangs. */
const hung = ((_: unknown, init?: RequestInit) =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;

test("a GitHub request is limited well under the cell's 90 seconds per call", () => {
  assert.ok(GITHUB_REQUEST_TIMEOUT_MS <= 45_000);
});

test("a GitHub that hangs fails within the limit, as an error githubFailed reads as GitHub failing", async () => {
  const octokit = new Octokit({ request: { fetch: timedFetch(50, hung) } });
  const started = Date.now();
  const error = await octokit.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" }).then(() => null, (e: unknown) => e);
  assert.ok(Date.now() - started < 2_000);
  assert.ok(githubFailed(error), String(error));
});

test("the limit keeps a signal the caller passed", async () => {
  const caller = new AbortController();
  const pending = timedFetch(60_000, hung)("https://api.github.com/", { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending);
});
