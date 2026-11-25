import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dockerBuild, dockerBuildArgs, dockerDesktopPaths, nodeStartDeps } from "./node-start.ts";
import { APPHOST_CHANGED, startAppHost } from "./start.ts";

test("it looks for Docker Desktop where Windows installs it, per user and machine-wide", () => {
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

/** A bare origin, a seed clone that pushes to it, and the checkout a start pulls into, each on `main`. */
function realCheckout(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "node-start-pull-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  const [origin, seed, checkout] = ["origin.git", "seed", "checkout"].map((d) => join(root, d)) as [string, string, string];
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-B", "main");
  const commit = (path: string) => {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), `${path} ${Math.random()}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", path);
    git(seed, "push", "-q", "-u", "origin", "main");
  };
  commit("aspire-apphost/apphost.mts");
  commit("src/main.ts");
  git(root, "clone", "-q", origin, checkout);
  return { checkout, commit };
}

/** Runs a start in the checkout with the real git and a Docker that answers, and returns what it warned. */
async function startIn(checkout: string): Promise<string[]> {
  const warned: string[] = [];
  const real = nodeStartDeps(checkout);
  await startAppHost({ ...real, dockerAnswers: async () => true, say() {}, warn: (l) => warned.push(l), startResources: async () => {} });
  return warned;
}

test("with the real git, a pull that changes aspire-apphost/ asks for aspire run again", async (t) => {
  const r = realCheckout(t);
  r.commit("aspire-apphost/apphost.mts");
  assert.deepEqual(await startIn(r.checkout), [APPHOST_CHANGED]);
});

test("with the real git, a pull that changes only src/ asks for no restart", async (t) => {
  const r = realCheckout(t);
  r.commit("src/main.ts");
  assert.deepEqual(await startIn(r.checkout), []);
});

test("docker build gets the Dockerfile, the tag, each label and the context, in that order", () => {
  assert.deepEqual(dockerBuildArgs({ tag: "factory-cell:local", dockerfile: "cell/Dockerfile", context: ".", labels: { a: "1", b: "2" } }), [
    "build", "--progress=plain", "-f", "cell/Dockerfile", "-t", "factory-cell:local", "--label", "a=1", "--label", "b=2", ".",
  ]);
});

/** A stand-in for the docker CLI that prints its arguments and cwd, an error line, then exits with `exit`. */
function fakeDocker(t: { after(fn: () => void): void }, exit: number): { dir: string; docker: string } {
  const dir = mkdtempSync(join(tmpdir(), "node-start-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nconsole.error("ERROR: failed to solve");\nprocess.exit(${exit});\n`);
  chmodSync(docker, 0o755);
  return { dir, docker };
}

const posixOnly = { skip: process.platform === "win32" ? "the fake docker is a shebang script" : false };

test("docker build runs in the repo, logs each line it prints and resolves to its exit status", posixOnly, async (t) => {
  const { dir, docker } = fakeDocker(t, 3);
  const log: string[] = [];
  const exit = await dockerBuild(dir, { tag: "t", dockerfile: "cell/Dockerfile", context: ".", labels: {} }, (l) => void log.push(l), docker);
  assert.equal(exit, 3);
  const said = JSON.parse(log.find((l) => l.startsWith("{")) ?? "{}") as { args: string[]; cwd: string };
  assert.deepEqual(said.args, ["build", "--progress=plain", "-f", "cell/Dockerfile", "-t", "t", "."]);
  assert.equal(realpathSync(said.cwd), realpathSync(dir));
  assert.ok(log.includes("ERROR: failed to solve"), JSON.stringify(log));
});

test("a docker CLI that can't be run logs why and resolves to 1", async () => {
  const log: string[] = [];
  const exit = await dockerBuild(".", { tag: "t", dockerfile: "f", context: ".", labels: {} }, (l) => void log.push(l), "no-such-docker-cli-206");
  assert.equal(exit, 1);
  assert.match(log.join("\n"), /no-such-docker-cli-206/);
});

test("the real deps take the AppHost's environment, the process's by default", () => {
  assert.deepEqual(nodeStartDeps(".", { FACTORY_FLOAT_PORTS: "1" }).env, { FACTORY_FLOAT_PORTS: "1" });
  assert.deepEqual(nodeStartDeps(".", {}).env, { FACTORY_FLOAT_PORTS: undefined });
  assert.equal(nodeStartDeps(".").env?.FACTORY_FLOAT_PORTS, process.env.FACTORY_FLOAT_PORTS);
});
