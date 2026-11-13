// The worker as its own process, for features/pbi-157-worker-lock.feature: the process path of src/worker/main.ts,
// runProcess, around startWorker with fakes in place of the board, repo host, launcher, egress proxy and judge, so it
// needs no GitHub App or Docker. FACTORY_DB_URI is the scenario's database and SOURCE_ID its board.
// It sits outside features/steps, so cucumber doesn't load it as step definitions.
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { createPool } from "../../src/store/db.ts";
import { runProcess, startWorker } from "../../src/worker/main.ts";

const pool = createPool(process.env.FACTORY_DB_URI);
const repoHost = fakeRepoHost();
const judge = async (_item: FactoryItem, dor: Policy) =>
  [...dor.criteria.map((cr) => JSON.stringify({ index: cr.index, status: "passed", reason: "ok" })), '{"flags":[]}'].join("\n");

runProcess(() => startWorker({
  pool,
  sources: [{ id: process.env.SOURCE_ID!, adapter: fakeBacklog().adapter }],
  repoHost,
  launcher: { start: async () => "cell-1", stop: async () => {} },
  egress: async () => {},
  image: "factory-cell:scenario",
  controlUrl: "http://host.docker.internal:7400",
  blob: "unused",
  judge,
  killFlag: false,
  secret: "scenario-secret",
  sopVersion: "default@1",
  tickMs: 100,
  pollMs: 1_000,
}));
