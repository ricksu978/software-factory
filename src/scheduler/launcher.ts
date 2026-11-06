// Starts and stops cells (plan Task 13): Docker locally, Container Apps jobs in Azure. A cell's env is the six
// Run contract 5 variables, the two model variables, and locally the egress variables. Nothing else, so the
// control plane's own secrets never reach a cell by name or by value.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { JobExecutionTemplate } from "@azure/arm-appcontainers";
import { cellModelEnv } from "../control/model-gateway.ts";

export interface Launcher {
  start(env: Record<string, string>): Promise<string>;
  stop(executionName: string): Promise<void>;
}

/** Runs a program and resolves with its stdout. It rejects as `execFile` does, with `stderr` on the error. */
export type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile);
const defaultRun: Run = (file, args) => execFileAsync(file, args);

export const CELL_NETWORK = "factory-cells";
export const EGRESS = "factory-egress";
const LABEL = "factory.egress.config";
const PROXY = `http://${EGRESS}:3128`;
const cellVars = ["RUN_ID", "ITEM_ID", "GENERATION", "RUN_TOKEN", "CONTROL_URL", "RESUME_FROM"];

// Both cases of each proxy variable, because curl, and so git, reads http_proxy only in lower case.
const egressEnv: Record<string, string> = {
  HTTPS_PROXY: PROXY,
  https_proxy: PROXY,
  HTTP_PROXY: PROXY,
  http_proxy: PROXY,
  NODE_USE_ENV_PROXY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

/** The six cell variables plus the gateway and the run's stand-in token. Any missing or extra name throws. */
function cellEnv(env: Record<string, string>): Record<string, string> {
  const extra = Object.keys(env).filter((k) => !cellVars.includes(k));
  if (extra.length) throw new Error(`cell env may not carry ${extra.join(", ")}`);
  for (const k of cellVars) if (!env[k]) throw new Error(`cell env is missing ${k}`);
  const credential = `${env.RUN_ID}.${env.GENERATION}.${env.RUN_TOKEN}`;
  return { ...env, ...cellModelEnv({ gatewayUrl: `${env.CONTROL_URL}/internal/model`, credential }) };
}

const stderrOf = (e: unknown) => String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? e);

/** Phase 0a. `image` is CELL_IMAGE. Each cell runs on the internal network, reaching out only through factory-egress. */
export function dockerLauncher(cfg: { image: string; run?: Run }): Launcher {
  const run = cfg.run ?? defaultRun;
  return {
    async start(env) {
      const vars = Object.entries({ ...cellEnv(env), ...egressEnv }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return (await run("docker", ["run", "-d", "--rm", "--network", CELL_NETWORK, ...vars, cfg.image])).stdout.trim();
    },
    async stop(id) {
      try {
        await run("docker", ["stop", id]);
      } catch (e) {
        // A cell that already exited was removed by --rm, so it's stopped already.
        if (!/no such container/i.test(stderrOf(e))) throw e;
      }
    },
  };
}

type Poller<T> = { pollUntilDone(): Promise<T> };
/** The two calls the launcher makes on `ContainerAppsAPIClient.jobs`. A real client satisfies it. */
export type JobsClient = {
  jobs: {
    beginStart(resourceGroup: string, job: string, options: { template: JobExecutionTemplate }): Promise<Poller<{ name?: string }>>;
    beginStopExecution(resourceGroup: string, job: string, execution: string): Promise<Poller<unknown>>;
  };
};

/** Phase 0b. Each cell is one execution of the manual-trigger job, and its name is the execution's name. */
export function containerAppsLauncher(cfg: { client: JobsClient; resourceGroup: string; job: string; image: string }): Launcher {
  const { jobs } = cfg.client;
  return {
    async start(env) {
      const vars = Object.entries(cellEnv(env)).map(([name, value]) => ({ name, value }));
      const poller = await jobs.beginStart(cfg.resourceGroup, cfg.job, { template: { containers: [{ name: "cell", image: cfg.image, env: vars }] } });
      const { name } = await poller.pollUntilDone();
      if (!name) throw new Error(`job ${cfg.job} started an execution with no name`);
      return name;
    },
    async stop(name) {
      await (await jobs.beginStopExecution(cfg.resourceGroup, cfg.job, name)).pollUntilDone();
    },
  };
}

/** For tests: records what was started and stopped, and names each start `cell-<n>`. */
export function fakeLauncher(): Launcher & { started: Record<string, string>[]; stopped: string[] } {
  const started: Record<string, string>[] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    async start(env) {
      started.push({ ...env });
      return `cell-${started.length}`;
    },
    async stop(name) {
      stopped.push(name);
    },
  };
}

const proxyScript = readFileSync(new URL("./egress-proxy.mjs", import.meta.url), "utf8");

/** The host:port pairs the proxy admits: GitHub and npm on 443, and the control plane and Azurite on their pinned ports. */
function egressAllow(cfg: { controlUrl: string; blob: string }): string[] {
  const controlPort = new URL(cfg.controlUrl).port;
  const endpoint = /(?:^|;)\s*BlobEndpoint=([^;]+)/i.exec(cfg.blob)?.[1];
  const blobPort = endpoint ? new URL(endpoint).port : "";
  if (!controlPort || !blobPort) throw new Error("the control plane and Azurite need explicit ports for the egress allowlist");
  return ["github.com:443", "api.github.com:443", "registry.npmjs.org:443", `host.docker.internal:${controlPort}`, `host.docker.internal:${blobPort}`];
}

/**
 * Local boot step: the internal network `factory-cells` and the `factory-egress` proxy on it and on the default
 * bridge. `image` is CELL_IMAGE, which has Node; `controlUrl` is CELL_CONTROL_URL and `blob` is FACTORY_BLOB.
 * A running proxy whose label matches this configuration stays, so live cells keep their connections.
 */
export async function ensureEgress(cfg: { image: string; controlUrl: string; blob: string; run?: Run }): Promise<void> {
  const run = cfg.run ?? defaultRun;
  try {
    await run("docker", ["network", "create", "--internal", CELL_NETWORK]);
  } catch (e) {
    if (!stderrOf(e).includes("already exists")) throw e;
  }
  const allow = egressAllow(cfg).join(",");
  const label = createHash("sha256").update(JSON.stringify({ image: cfg.image, allow, proxyScript })).digest("hex");
  let current: string | null = null;
  try {
    current = (await run("docker", ["inspect", "--format", `{{.State.Running}} {{index .Config.Labels "${LABEL}"}}`, EGRESS])).stdout.trim();
  } catch (e) {
    if (!/no such (object|container)/i.test(stderrOf(e))) throw e;
  }
  if (current === `true ${label}`) return;
  if (current !== null) await run("docker", ["rm", "-f", EGRESS]);
  await run("docker", [
    "run", "-d", "--name", EGRESS, "--restart", "unless-stopped", "--label", `${LABEL}=${label}`,
    "--network", "bridge", "--network", CELL_NETWORK, "-e", `EGRESS_ALLOW=${allow}`,
    "--entrypoint", "node", cfg.image, "--input-type=module", "-e", proxyScript,
  ]);
}
