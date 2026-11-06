// The walking skeleton's harness (plan Task 17): the whole factory in one process, on the fake backlog and a fake
// repo host backed by a real bare git origin. The scheduler's launcher runs `runCell` in process against the real
// cell API, with a scripted agent standing in for the model. src/e2e.test.ts and the PBI 17 scenarios both drive it.
import { execFile, execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import type { ContractTarget } from "./adapters/contract.ts";
import { fakeBacklog, fakeRepoHost } from "./adapters/fake.ts";
import type { FactoryWebhookEvent } from "./adapters/types.ts";
import type { AgentArgs, AgentResult } from "./agent/run.ts";
import { classify } from "./bdd/messages.ts";
import { loadSop } from "./config/sop.ts";
import { applyComment, decideAndAnnounce } from "./control/decisions.ts";
import { mirrorBoard } from "./control/board.ts";
import { cellApi } from "./control/cell-api.ts";
import { httpCellApi } from "./cell/api-client.ts";
import { loadInputs, runCell } from "./cell/engine.ts";
import { cloneRun, shellGit } from "./cell/git.ts";
import { startServer } from "./http/server.ts";
import type { Launcher } from "./scheduler/launcher.ts";
import { tick } from "./scheduler/scheduler.ts";
import { handleWebhook } from "./watcher/webhook.ts";
import { pollOnce } from "./watcher/poller.ts";

const exec = promisify(execFile);
const SECRET = "cell-secret";
const WEBHOOK_SECRET = "webhook-secret";
export const REPO = "acme/app";
export const OWNER_LOGIN = "owner";
const sop = loadSop(readFileSync(join(import.meta.dirname, "..", "sop", "default.yml"), "utf8"));
const fwd = (p: string) => p.replace(/\\/g, "/");

type Scenario = { name: string; tags: string[]; item: string };

/** A Cucumber Messages report with one Action and one Outcome step per scenario, in the shape `classify` reads. */
function report(scenarios: Scenario[], green: (s: Scenario) => boolean): string {
  return scenarios.flatMap((s, i) => [
    { pickle: { id: `p${i}`, name: s.name, tags: s.tags.map((name) => ({ name })),
      steps: [{ id: `s${i}a`, type: "Action", text: "the thing runs" }, { id: `s${i}b`, type: "Outcome", text: "it works" }] } },
    { testCase: { id: `c${i}`, pickleId: `p${i}`, testSteps: [{ id: `t${i}a`, pickleStepId: `s${i}a` }, { id: `t${i}b`, pickleStepId: `s${i}b` }] } },
    { testCaseStarted: { id: `r${i}`, testCaseId: `c${i}` } },
    { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}a`, testStepResult: { status: "PASSED" } } },
    { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}b`, testStepResult: green(s) ? { status: "PASSED" } : { status: "FAILED", message: "AssertionError" } } },
  ].map((m) => JSON.stringify(m))).join("\n") + "\n";
}

export type Factory = Awaited<ReturnType<typeof startFactory>>;

/**
 * Starts the factory on `pool`, which must hold no items, users or sources yet. Call `stop` when done. Setting
 * `ci.redOnMerge` makes CI fail on every merge commit from then on, as when a merged change breaks main.
 */
export async function startFactory(pool: pg.Pool) {
  const ci = { redOnMerge: false };
  const root = mkdtempSync(join(tmpdir(), "e2e-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  // The target repo: a config whose bdd commands copy the scripted agent's report, a DoD with one run: line, and
  // no other policy file, so the factory's defaults run.
  const cp = (name: string) => `mkdir -p reports && cp "${fwd(join(fixtures, name))}" reports/bdd.ndjson`;
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "person@example.com");
  git(seed, "config", "user.name", "person");
  mkdirSync(join(seed, ".factory"));
  const config = `bdd:\n  parse: ${JSON.stringify(cp("parse.ndjson"))}\n  run: ${JSON.stringify(cp("run.ndjson"))}\n  report: reports/bdd.ndjson\ncommands:\n  test: "true"\n  lint: "true"\n`;
  const dod = "- [ ] Tests pass. `run: true`\n";
  writeFileSync(join(seed, ".factory", "config.yml"), config);
  writeFileSync(join(seed, ".factory", "dod.md"), dod);
  writeFileSync(join(seed, ".gitignore"), "reports/\n");
  writeFileSync(join(seed, "app.txt"), "app\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  const board: ContractTarget = fakeBacklog();
  const host = fakeRepoHost();
  const setMain = (sha: string) => {
    host.heads.set(REPO, sha);
    host.files.set(`${REPO}@${sha}:.factory/config.yml`, config);
    host.files.set(`${REPO}@${sha}:.factory/dod.md`, dod);
  };
  setMain(git(seed, "rev-parse", "HEAD"));
  // The origin answers which commits a branch holds, and CI passes everywhere except, when asked, on merge commits.
  const mergeShas = new Set<string>();
  host.onBranch = async (_repo, branch, sha) => {
    try {
      await exec("git", ["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`], { cwd: origin });
      return true;
    } catch {
      return false;
    }
  };
  host.checksOnSha = async (_repo, sha) => (ci.redOnMerge && mergeShas.has(sha) ? "failure" : "success");

  await pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]')", [`https://github.com/${REPO}`]);
  const fieldMap = {
    optInLabel: "factory",
    statusFor: { Queued: "Todo", InProgress: "In Progress", SignOff: "In Progress", NeedsInput: "In Progress", InReview: "In Review", Done: "Done", Failed: "Failed" },
  };
  const sourceId = (await pool.query<{ id: string }>(
    "insert into backlog_source (adapter, url, field_map) values ('fake', 'fake:' || gen_random_uuid(), $1) returning id",
    [JSON.stringify(fieldMap)],
  )).rows[0].id;
  const ownerId = (await pool.query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', 'owner', $1, 'owner', true) returning id`,
    [OWNER_LOGIN],
  )).rows[0].id;
  const backlogFor = () => board.adapter;

  // Where cells upload transcripts and reports, so a test can read the evidence back.
  const blobs = new Map<string, string>();
  const blobServer: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      blobs.set(decodeURIComponent((req.url ?? "/").slice(1)), body);
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => blobServer.listen(0, "127.0.0.1", r));
  const blobBase = `http://127.0.0.1:${(blobServer.address() as AddressInfo).port}`;

  const ids = sop.stages.map((s) => s.id);
  const api = cellApi({
    pool, secret: SECRET, repoHost: host, backlogFor,
    // Phase 0's SOP order up to open-pr. Address hands the item back through pr_opened, and decide sets red.
    stageAfter: (_v, stageId) => (stageId === "open-pr" || stageId === "address" ? null : ids[ids.indexOf(stageId as never) + 1] ?? null),
    uploadUrl: async (path) => `${blobBase}/${path}`,
    gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "unused" },
    webToolsOf: () => [],
    killSwitch: () => false,
  });
  const server = await startServer([api], { port: 0 });
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const off = mirrorBoard({ pool, backlogFor, repoHost: host });

  // Every scenario any item wrote, and the items whose code is in, so each bdd run reports them the way a real
  // runner would: an item's own scenarios red until its Green, and everyone else's green.
  const scenarios: Scenario[] = [];
  const built = new Set<string>();
  const writeRun = () => writeFileSync(join(fixtures, "run.ndjson"), report(scenarios, (s) => built.has(s.item)));

  const agentFor = (cell: { stage: string }, ext: string, criteria: number) => async (a: AgentArgs): Promise<AgentResult> => {
    let text = "done";
    const judged = [...a.prompt.matchAll(/^\{"index":(\d+),"criterion":".*"\}$/gm)];
    if (a.mode === "judge" && a.prompt.includes('{"tier":')) text = JSON.stringify({ tier: "Low", reason: "the scripted classifier" });
    else if (a.mode === "judge" && a.prompt.includes('{"needsPerson":')) text = JSON.stringify({ needsPerson: false, reason: "the scripted classifier" });
    else if (a.agent === "factory-self-reviewer") text = judged.map((m) => JSON.stringify({ index: Number(m[1]), status: "passed", reason: "ok" })).join("\n") + "\nAPPROVED";
    else if (judged.length) text = judged.map((m) => JSON.stringify({ index: Number(m[1]), status: "passed", reason: "ok" })).join("\n");
    else if (cell.stage === "understand") text = Array.from({ length: criteria }, (_, i) => `@ac-${i + 1}: understood`).join("\n");
    else if (cell.stage === "specify") {
      const mine = Array.from({ length: criteria }, (_, i): Scenario => ({ name: `Criterion ${i + 1} of item ${ext} holds`, tags: [`@pbi-${ext}`, `@ac-${i + 1}`], item: ext }));
      scenarios.push(...mine);
      mkdirSync(join(a.cwd, "features"), { recursive: true });
      writeFileSync(join(a.cwd, "features", `pbi-${ext}.feature`), [`@pbi-${ext}`, `Feature: Item ${ext}`, "",
        ...mine.flatMap((s) => [`  ${s.tags[1]}`, `  Scenario: ${s.name}`, "    When the thing runs", "    Then it works", ""])].join("\n"));
      writeFileSync(join(fixtures, "parse.ndjson"), report(scenarios, () => false));
    } else if (cell.stage === "red") writeRun();
    else if (cell.stage === "green") {
      built.add(ext);
      writeRun();
      writeFileSync(join(a.cwd, `item-${ext}.txt`), "built\n");
    } else if (cell.stage === "address") writeFileSync(join(a.cwd, `item-${ext}.txt`), "built, review addressed\n");
    else if (cell.stage === "open-pr") text = `Builds item ${ext}.`;
    return { ok: true, text, costUsd: 0.25, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };

  // The in-process launcher. Each start runs one cell the way src/cell/main.ts does, against the real cell API.
  const running: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  let cells = 0;
  const launcher: Launcher = {
    async start(env) {
      const n = ++cells;
      running.push(runOne(env, n).catch((e) => errors.push(e)));
      return `cell-${n}`;
    },
    async stop() {},
  };
  async function runOne(env: Record<string, string>, n: number) {
    const http = httpCellApi({ controlUrl: env.CONTROL_URL, runId: env.RUN_ID, runToken: env.RUN_TOKEN, generation: Number(env.GENERATION) });
    const cell = { stage: "" };
    const api = { ...http, stage: async (b: Parameters<typeof http.stage>[0]) => { if (b.status === "started") cell.stage = b.stageId; await http.stage(b); } };
    const ctx = await http.context();
    const dir = join(root, `cell-${n}`);
    await cloneRun(origin, ctx.branch, ctx.base, dir, "!true");
    const read = async (path: string) => {
      try {
        return (await exec("git", ["show", `${ctx.configSha}:${path}`], { cwd: dir })).stdout;
      } catch {
        return null;
      }
    };
    const inputs = await loadInputs(read, ctx.configSha);
    if ("blocked" in inputs) throw new Error(`the cell blocked on its inputs: ${inputs.blocked}`);
    return runCell({
      api, ctx, agent: agentFor(cell, ctx.externalId, ctx.acceptanceCriteria.length), git: shellGit(dir, ctx.branch), dir,
      repoHost: host, sop, config: inputs.config, policies: inputs.policies, now: () => new Date(), sleep: async () => {},
    });
  }

  const itemId = async (ext: string) =>
    (await pool.query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [sourceId, ext])).rows[0]?.id;
  const openRun = async (ext: string) => (await pool.query<{ id: string; branch: string | null; run_number: number; pr_number: number | null }>(
    "select r.id, r.branch, r.run_number, r.pr_number from run r join item i on i.id = r.item_id where i.source_id = $1 and i.external_id = $2 and r.ended_at is null",
    [sourceId, ext],
  )).rows[0];

  /** Delivers one signed GitHub webhook, and waits for anything it set off, such as an /approve comment. */
  const deliver = async (event: FactoryWebhookEvent, githubEvent: string) => {
    const rawBody = Buffer.from(JSON.stringify({ event }));
    const after: Promise<unknown>[] = [];
    const r = await handleWebhook({
      pool, secret: WEBHOOK_SECRET, parse: () => event,
      onComment: (e) => {
        const p = applyComment({ pool, adapter: board.adapter, sourceId }, e);
        after.push(p);
        return p;
      },
    }, {
      headers: {
        "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`,
        "x-github-delivery": randomUUID(), "x-github-event": githubEvent,
      },
      rawBody,
    });
    await Promise.all(after);
    return r.status;
  };

  const f = {
    pool, board, host, sourceId, ownerId, blobs, scenarios, errors, ci,
    /** A labelled item on the board, in the repo, with these criteria. Returns its external id. */
    addItem: (title: string, criteria: string[]) => board.seed({ title, acceptanceCriteria: criteria, repo: REPO }),
    /** One poll, with a judge that passes every dor.md criterion by index. */
    poll: () => pollOnce({
      pool, adapter: board.adapter, repoHost: host, sourceId,
      judge: async (_item, dor) => [...dor.criteria.map((c) => JSON.stringify({ index: c.index, status: "passed", reason: "ok" })), '{"flags":[]}'].join("\n"),
    }),
    /** One scheduler tick, then waits for the cell it started, if any, to finish. */
    async tick() {
      await tick({ pool, launcher, now: new Date(), killFlag: false, repoHost: host, backlogFor, secret: SECRET, controlUrl, sopVersion: sop.version });
      await Promise.all(running.splice(0));
      if (errors.length) throw errors[0];
    },
    async approveInRunDetail(ext: string) {
      return decideAndAnnounce({ pool, adapter: board.adapter }, { itemId: (await itemId(ext))!, userId: ownerId, kind: "approve", text: "", via: "dashboard" }, ext);
    },
    commentOnItem: (ext: string, body: string) => deliver({ kind: "comment", externalId: ext, repo: REPO, login: OWNER_LOGIN, body, commentId: randomUUID() }, "issue_comment"),
    /** A trusted reviewer requests changes with a summary, as GitHub would show it and deliver it. */
    async requestChanges(ext: string) {
      const run = await openRun(ext);
      const pr = host.prs.find((p) => p.number === run.pr_number)!;
      const submittedAt = new Date().toISOString();
      pr.reviews.push({ state: "changes_requested", submittedAt, author: OWNER_LOGIN, body: "Rename the export column." });
      return deliver({ kind: "review", prNumber: pr.number, repo: REPO, state: "changes_requested", submittedAt, author: OWNER_LOGIN }, "pull_request_review");
    },
    /** A person merges the item's PR into main on the origin, and GitHub delivers pr_merged. */
    async merge(ext: string) {
      const run = await openRun(ext);
      const pr = host.prs.find((p) => p.number === run.pr_number)!;
      git(seed, "fetch", "-q", "origin");
      git(seed, "checkout", "-q", "main");
      git(seed, "merge", "-q", "--ff-only", "origin/main");
      git(seed, "merge", "-q", "--no-ff", "-m", `Merge pull request #${pr.number}`, `origin/${pr.branch}`);
      git(seed, "push", "-q", "origin", "main");
      const sha = git(seed, "rev-parse", "HEAD");
      mergeShas.add(sha);
      setMain(sha);
      Object.assign(pr, { merged: true, open: false, mergeSha: sha });
      await deliver({ kind: "pr_merged", prNumber: pr.number, repo: REPO, mergeSha: sha }, "pull_request");
      return sha;
    },
    async state(ext: string) {
      return (await pool.query<{ state: string }>("select state from item where id = $1", [await itemId(ext)])).rows[0]?.state;
    },
    /** Every state the item has been in, in order, from its transition events. */
    async states(ext: string) {
      const r = await pool.query<{ to: string }>("select payload->>'to' as to from event where item_id = $1 and kind = 'transition' order by at", [await itemId(ext)]);
      return ["Eligible", ...r.rows.map((x) => x.to)];
    },
    /** The verdicts in the item's latest uploaded report from `stage`, by scenario name. */
    async report(ext: string, stage: string) {
      const run = await openRun(ext) ?? (await pool.query<{ id: string }>("select r.id from run r join item i on i.id = r.item_id where i.external_id = $1 order by r.run_number desc limit 1", [ext])).rows[0];
      const key = [...blobs.keys()].filter((k) => k.startsWith(`reports/${run.id}/${stage}-`)).sort().at(-1);
      if (!key) return null;
      return new Map([...classify(blobs.get(key)!).values()].map((v) => [v.name, v.verdict]));
    },
    async stop() {
      off();
      await new Promise((r) => server.close(r));
      await new Promise((r) => blobServer.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
