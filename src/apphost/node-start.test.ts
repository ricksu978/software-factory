import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dockerDesktopPaths, nodeStartDeps } from "./node-start.ts";

test("it looks for Docker Desktop where scripts/factory.ps1 looks", () => {
  assert.deepEqual(dockerDesktopPaths({ LOCALAPPDATA: "L", ProgramFiles: "P" }), [
    join("L", "Programs", "DockerDesktop", "Docker Desktop.exe"),
    join("P", "Docker", "Docker", "Docker Desktop.exe"),
  ]);
  assert.deepEqual(dockerDesktopPaths({}), []);
});

test("git runs in the checkout it was given and returns git's own output", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "node-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "trunk", dir]);
  const deps = nodeStartDeps(dir);
  assert.deepEqual(deps.git(["branch", "--show-current"]), { status: 0, stdout: "trunk\n", stderr: "" });
  const bad = deps.git(["no-such-command"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no-such-command/);
});

test("the clock's sleep waits", async () => {
  const deps = nodeStartDeps(".");
  const before = deps.now();
  await deps.sleep(20);
  assert.ok(deps.now() - before >= 15);
});
