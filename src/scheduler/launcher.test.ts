import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { containerAppsLauncher, dockerLauncher, ensureEgress, fakeLauncher, type JobsClient, type Run } from "./launcher.ts";

const token = "a".repeat(64);
const runId = "00000000-0000-4000-8000-000000000001";
const cell = { RUN_ID: runId, ITEM_ID: "item-1", GENERATION: "3", RUN_TOKEN: token, CONTROL_URL: "http://host.docker.internal:7400", RESUME_FROM: "understand" };
// The control plane's own secrets, as Aspire hands them to `control`.
const secrets = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-OWNER-SECRET", GITHUB_APP_KEY: "APP-KEY-SECRET", GITHUB_PROJECT_TOKEN: "gho_PROJECT_SECRET", CELL_SECRET: "CELL-SECRET", GITHUB_WEBHOOK_SECRET: "HOOK-SECRET" };
const proxy = "http://factory-egress:3128";

/** A stubbed `execFile`: records each call and answers from `reply`, which may throw like a failed command. */
function stub(reply: (args: string[]) => string = () => "") {
  const calls: string[][] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: reply(args) };
  };
  return { calls, run };
}
const fail = (stderr: string) => Object.assign(new Error("Command failed"), { stderr });

describe("dockerLauncher", () => {
  test("runs the cell with exactly its variables, on the internal network, and none of the control plane's secrets", async () => {
    Object.assign(process.env, secrets);
    const { calls, run } = stub(() => "abc123\n");
    const id = await dockerLauncher({ image: "factory-cell:local", run }).start(cell);
    assert.equal(id, "abc123");
    const env = {
      ...cell,
      ANTHROPIC_BASE_URL: "http://host.docker.internal:7400/internal/model",
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${runId}.3.${token}`,
      HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
      NODE_USE_ENV_PROXY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    };
    const e = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    assert.deepEqual(calls, [["docker", "run", "-d", "--rm", "--network", "factory-cells", ...e, "factory-cell:local"]]);
    const argv = calls[0]!;
    assert.ok(!argv.includes("CLAUDE_CODE_OAUTH_TOKEN"), "no bare -e that would copy the owner's token by name");
    for (const secret of Object.values(secrets)) assert.ok(argv.every((w) => !w.includes(secret)), secret);
  });

  test("refuses an env with a missing or an extra variable", async () => {
    const { calls, run } = stub();
    const launcher = dockerLauncher({ image: "i", run });
    const { RESUME_FROM: _, ...missing } = cell;
    await assert.rejects(launcher.start(missing), /missing RESUME_FROM/);
    await assert.rejects(launcher.start({ ...cell, CELL_SECRET: "x" }), /may not carry CELL_SECRET/);
    assert.equal(calls.length, 0);
  });

  test("stop runs docker stop, and a cell already gone counts as stopped", async () => {
    const { calls, run } = stub((args) => {
      if (args[1] === "gone") throw fail("Error response from daemon: No such container: gone");
      return "";
    });
    const launcher = dockerLauncher({ image: "i", run });
    await launcher.stop("abc123");
    await launcher.stop("gone");
    assert.deepEqual(calls, [["docker", "stop", "abc123"], ["docker", "stop", "gone"]]);
  });
});

describe("ensureEgress", () => {
  const cfg = { image: "factory-cell:local", controlUrl: "http://host.docker.internal:7400", blob: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=KEY;BlobEndpoint=http://127.0.0.1:7410/devstoreaccount1;" };
  const allow = "EGRESS_ALLOW=github.com:443,api.github.com:443,registry.npmjs.org:443,host.docker.internal:7400,host.docker.internal:7410";
  const verbs = (calls: string[][]) => calls.map((c) => c.slice(1, 3).join(" "));

  /** Boots once against an empty Docker to learn this configuration's label. */
  async function freshLabel(): Promise<string> {
    const { calls, run } = stub((args) => {
      if (args[0] === "inspect") throw fail("Error: No such object: factory-egress");
      return "";
    });
    await ensureEgress({ ...cfg, run });
    const started = calls.find((c) => c[1] === "run")!;
    assert.ok(started.includes(allow), "the proxy gets the allowlist");
    assert.deepEqual(started.slice(started.indexOf("--network"), started.indexOf("--network") + 4), ["--network", "bridge", "--network", "factory-cells"]);
    return started[started.indexOf("--label") + 1]!.split("=")[1]!;
  }

  test("an existing network counts as success", async () => {
    const label = await freshLabel();
    const { calls, run } = stub((args) => {
      if (args[0] === "network") throw fail("Error response from daemon: network with name factory-cells already exists");
      return `true ${label}\n`;
    });
    await ensureEgress({ ...cfg, run });
    assert.deepEqual(calls[0], ["docker", "network", "create", "--internal", "factory-cells"]);
  });

  test("a running proxy with this configuration's label stays as it is", async () => {
    const label = await freshLabel();
    const { calls, run } = stub((args) => (args[0] === "inspect" ? `true ${label}\n` : ""));
    await ensureEgress({ ...cfg, run });
    assert.deepEqual(verbs(calls), ["network create", "inspect --format"]);
  });

  test("a proxy with another label is removed and restarted with the new one", async () => {
    const label = await freshLabel();
    const { calls, run } = stub((args) => (args[0] === "inspect" ? "true 0ld\n" : ""));
    await ensureEgress({ ...cfg, run });
    assert.deepEqual(verbs(calls), ["network create", "inspect --format", "rm -f", "run -d"]);
    assert.ok(calls[3]!.includes(`factory.egress.config=${label}`));
    // A changed pinned port changes the label.
    const moved = stub((args) => (args[0] === "inspect" ? `true ${label}\n` : ""));
    await ensureEgress({ ...cfg, controlUrl: "http://host.docker.internal:7401", run: moved.run });
    assert.deepEqual(verbs(moved.calls), ["network create", "inspect --format", "rm -f", "run -d"]);
  });

  test("any other Docker failure is thrown", async () => {
    const { run } = stub(() => {
      throw fail("Cannot connect to the Docker daemon");
    });
    await assert.rejects(ensureEgress({ ...cfg, run }), /Command failed/);
  });
});

describe("containerAppsLauncher", () => {
  test("starts an execution of the job with the cell's variables and stops it by name", async () => {
    const seen: unknown[][] = [];
    const client: JobsClient = {
      jobs: {
        async beginStart(...args) {
          seen.push(["start", ...args]);
          return { pollUntilDone: async () => ({ name: "caj-factory-cell-x1y2z" }) };
        },
        async beginStopExecution(...args) {
          seen.push(["stop", ...args]);
          return { pollUntilDone: async () => undefined };
        },
      },
    };
    const launcher = containerAppsLauncher({ client, resourceGroup: "rg-factory", job: "caj-factory-cell", image: "acr.io/cell:1" });
    assert.equal(await launcher.start(cell), "caj-factory-cell-x1y2z");
    await launcher.stop("caj-factory-cell-x1y2z");
    const env = Object.entries({ ...cell, ANTHROPIC_BASE_URL: "http://host.docker.internal:7400/internal/model", CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${runId}.3.${token}` }).map(([name, value]) => ({ name, value }));
    assert.deepEqual(seen, [
      ["start", "rg-factory", "caj-factory-cell", { template: { containers: [{ name: "cell", image: "acr.io/cell:1", env }] } }],
      ["stop", "rg-factory", "caj-factory-cell", "caj-factory-cell-x1y2z"],
    ]);
  });

  test("a real ContainerAppsAPIClient fits JobsClient", () => {
    const fits = (c: ContainerAppsAPIClient): JobsClient => c;
    assert.equal(typeof fits, "function");
  });
});

test("fakeLauncher records starts and stops", async () => {
  const f = fakeLauncher();
  assert.equal(await f.start(cell), "cell-1");
  await f.stop("cell-1");
  assert.deepEqual(f.started, [cell]);
  assert.deepEqual(f.stopped, ["cell-1"]);
});
