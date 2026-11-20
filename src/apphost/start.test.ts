import assert from "node:assert/strict";
import { test } from "node:test";
import { APPHOST_CHANGED, appHostResources, DOCKER_NOT_INSTALLED, DOCKER_TIMED_OUT, DOCKER_WAIT_MS, StartStopped, startAppHost, type GitResult, type StartDeps } from "./start.ts";

type Fake = {
  deps: StartDeps;
  log: string[];
  said: string[];
  warned: string[];
  clock: { now: number };
};

/** Fakes for a start. `git` answers each command by its first argument; Docker answers once `answersAt` has passed. */
function fake(opts: { branch?: string; pull?: GitResult; diff?: GitResult; dockerUp?: boolean; installed?: boolean; answersAfterLaunchMs?: number | null } = {}): Fake {
  const log: string[] = [];
  const said: string[] = [];
  const warned: string[] = [];
  const clock = { now: 0 };
  let launchedAt: number | null = null;
  const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
  const deps: StartDeps = {
    git(args) {
      log.push(`git ${args.join(" ")}`);
      if (args[0] === "branch") return ok(`${opts.branch ?? "main"}\n`);
      if (args[0] === "rev-parse") return ok("abc123\n");
      if (args[0] === "pull") return opts.pull ?? ok("Already up to date.\n");
      if (args[0] === "diff") return opts.diff ?? ok();
      return ok();
    },
    async dockerAnswers() {
      const delay = opts.answersAfterLaunchMs;
      const up = (opts.dockerUp ?? true) || (launchedAt !== null && delay != null && clock.now >= launchedAt + delay);
      log.push(`docker ${up ? "up" : "down"}`);
      return up;
    },
    findDockerDesktop: () => ((opts.installed ?? true) ? "Docker Desktop.exe" : null),
    launch(exe) {
      launchedAt = clock.now;
      log.push(`launch ${exe}`);
    },
    async sleep(ms) {
      clock.now += ms;
      if (clock.now > 3_600_000) throw new Error("waited over an hour");
    },
    now: () => clock.now,
    say: (l) => void said.push(l),
    warn: (l) => void warned.push(l),
    dockerBuild: async () => 0,
    async startResources() {
      log.push("start");
    },
  };
  return { deps, log, said, warned, clock };
}

async function stops(f: Fake): Promise<StartStopped> {
  try {
    await startAppHost(f.deps);
  } catch (e) {
    assert.ok(e instanceof StartStopped, `threw ${String(e)}`);
    return e;
  }
  assert.fail("the start didn't stop");
}

test("on main it pulls fast-forward-only, then checks Docker, then starts the resources", async () => {
  const f = fake();
  await startAppHost(f.deps);
  assert.deepEqual(f.log, [
    "git branch --show-current",
    "git rev-parse HEAD",
    "git pull --ff-only",
    "git diff --name-only abc123 HEAD -- aspire-apphost/",
    "docker up",
    "start",
  ]);
  assert.deepEqual(f.warned, []);
});

test("a pull that changes aspire-apphost/ asks for aspire run again, and still starts", async () => {
  const f = fake({ diff: { status: 0, stdout: "aspire-apphost/apphost.mts\n", stderr: "" } });
  await startAppHost(f.deps);
  assert.deepEqual(f.warned, [APPHOST_CHANGED]);
  assert.match(f.warned[0]!, /aspire run/);
  assert.ok(f.log.includes("start"));
});

test("a pull that changes only src/ asks for no restart", async () => {
  const f = fake({ diff: { status: 0, stdout: "", stderr: "" } });
  await startAppHost(f.deps);
  assert.deepEqual(f.warned, []);
});

test("a failed pull runs no diff", async () => {
  const f = fake({ pull: { status: 1, stdout: "", stderr: "fatal: nope\n" } });
  await stops(f);
  assert.ok(!f.log.some((l) => l.startsWith("git diff")));
});

test("a failed pull stops the start with git's message and starts nothing", async () => {
  const f = fake({ pull: { status: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" } });
  const e = await stops(f);
  assert.match(e.message, /git pull --ff-only failed/);
  assert.match(e.message, /fatal: Not possible to fast-forward, aborting\./);
  assert.ok(!f.log.includes("start"));
  assert.ok(!f.log.some((l) => l.startsWith("docker")), "it checked Docker after the pull failed");
});

test("a failed pull with no message of git's still says the pull failed", async () => {
  const e = await stops(fake({ pull: { status: 128, stdout: "", stderr: "" } }));
  assert.match(e.message, /git pull --ff-only failed/);
});

test("on another branch it warns, pulls nothing and starts the checkout as it is", async () => {
  const f = fake({ branch: "my-work" });
  await startAppHost(f.deps);
  assert.deepEqual(f.log, ["git branch --show-current", "docker up", "start"]);
  assert.equal(f.warned.length, 1);
  assert.match(f.warned[0]!, /'my-work', not 'main'.*as it is/);
});

test("on no branch it warns that it is not on main and pulls nothing", async () => {
  const f = fake({ branch: "" });
  await startAppHost(f.deps);
  assert.deepEqual(f.log, ["git branch --show-current", "docker up", "start"]);
  assert.match(f.warned[0]!, /not on 'main'.*as it is/);
});

test("when git can't name the branch, the start stops with git's message", async () => {
  const f = fake();
  f.deps.git = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\n" });
  const e = await stops(f);
  assert.match(e.message, /fatal: not a git repository/);
});

test("with Docker stopped it launches Docker Desktop once and starts the resources once Docker answers", async () => {
  const f = fake({ dockerUp: false, answersAfterLaunchMs: 40_000 });
  await startAppHost(f.deps);
  assert.equal(f.log.filter((l) => l.startsWith("launch")).length, 1);
  assert.match(f.said.join("\n"), /Starting Docker Desktop/);
  const up = f.log.indexOf("docker up");
  assert.ok(up >= 0 && up < f.log.indexOf("start"));
});

test("it waits just inside 3 minutes for Docker", async () => {
  const f = fake({ dockerUp: false, answersAfterLaunchMs: DOCKER_WAIT_MS - 10_000 });
  await startAppHost(f.deps);
  assert.ok(f.log.includes("start"));
});

test("Docker that doesn't answer within 3 minutes stops the start, not before", async () => {
  const f = fake({ dockerUp: false, answersAfterLaunchMs: null });
  const e = await stops(f);
  assert.equal(e.message, DOCKER_TIMED_OUT);
  assert.ok(f.clock.now >= DOCKER_WAIT_MS && f.clock.now <= DOCKER_WAIT_MS + 10_000, `stopped at ${f.clock.now}`);
  assert.ok(!f.log.includes("start"));
});

test("with Docker Desktop not installed it stops with today's message and launches nothing", async () => {
  const f = fake({ dockerUp: false, installed: false });
  const e = await stops(f);
  assert.equal(e.message, DOCKER_NOT_INSTALLED);
  assert.ok(!f.log.some((l) => l.startsWith("launch") || l === "start"));
});

test("the worker waits for migrate and for cell-image, which builds the cell image", async () => {
  const builds: string[] = [];
  const resources = appHostResources({
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    dockerBuild: async (b) => (builds.push(b.tag), 0),
  });
  const byName = new Map(resources.map((r) => [r.name, r]));
  assert.deepEqual(byName.get("worker")?.waitsFor.toSorted(), ["cell-image", "migrate"]);
  assert.deepEqual(byName.get("cell-image")?.waitsFor, []);
  await byName.get("cell-image")?.run?.(() => {});
  assert.deepEqual(builds, ["factory-cell:local"]);
});

test("the start hands the resources a cell-image resource", async () => {
  const f = fake();
  let names: string[] = [];
  await startAppHost({ ...f.deps, startResources: async (rs) => void (names = rs.map((r) => r.name)) });
  assert.ok(names.includes("cell-image"), JSON.stringify(names));
});

test("a test run (FACTORY_FLOAT_PORTS=1) on main runs no git at all, checks Docker and starts the checkout as it is", async () => {
  const f = fake();
  f.deps.env = { FACTORY_FLOAT_PORTS: "1" };
  await startAppHost(f.deps);
  assert.deepEqual(f.log, ["docker up", "start"]);
  assert.deepEqual(f.warned, []);
  assert.equal(f.said.length, 1);
  assert.match(f.said[0]!, /test run.*pulls nothing/i);
});

test("a test run still launches Docker Desktop when Docker doesn't answer", async () => {
  const f = fake({ dockerUp: false, answersAfterLaunchMs: 6_000 });
  f.deps.env = { FACTORY_FLOAT_PORTS: "1" };
  await startAppHost(f.deps);
  assert.ok(f.log.includes("launch Docker Desktop.exe"));
  assert.equal(f.log.at(-1), "start");
  assert.ok(!f.log.some((l) => l.startsWith("git ")));
});

for (const value of [undefined, "0", ""]) {
  test(`with FACTORY_FLOAT_PORTS ${value === undefined ? "unset" : JSON.stringify(value)} it is no test run, and pulls main`, async () => {
    const f = fake();
    f.deps.env = value === undefined ? {} : { FACTORY_FLOAT_PORTS: value };
    await startAppHost(f.deps);
    assert.ok(f.log.includes("git pull --ff-only"));
  });
}
