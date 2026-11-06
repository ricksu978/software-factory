// The walking skeleton end to end (plan Task 17 Step 1), on the harness in src/e2e.ts.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { startFactory, type Factory } from "./e2e.ts";
import { dbTest, startTestDb } from "./store/test-db.ts";

const FULL_PATH = ["Eligible", "Queued", "InProgress", "SignOff", "InProgress", "InReview", "Queued", "InProgress", "InReview", "Accepted", "Done"];
const NO_REVIEW = ["Eligible", "Queued", "InProgress", "SignOff", "InProgress", "InReview", "Accepted", "Done"];

describe("walking skeleton", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let f: Factory | null = null;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await f?.stop();
    await db.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
    f = await startFactory(db.pool);
  });
  after(async () => {
    await f?.stop();
  });

  /** Readiness, Specify, sign-off, Red to the PR, and a merge, with `review` set when a reviewer asks for changes. */
  async function fullPath(ext: string, signOff: () => Promise<unknown>, review: boolean) {
    await f!.poll();
    await f!.tick();
    await signOff();
    await f!.tick();
    if (review) {
      await f!.requestChanges(ext);
      await f!.tick();
    }
    await f!.merge(ext);
    await f!.tick();
  }

  test("two items reach Done in turn, every transition is logged in order, and each merged run has its own cost", async () => {
    const first = await f!.addItem("Export to CSV", ["Exports every row", "Quotes commas"]);
    await fullPath(first, () => f!.approveInRunDetail(first), true);
    const second = await f!.addItem("Import from CSV", ["Imports every row"]);
    await fullPath(second, () => f!.approveInRunDetail(second), false);

    assert.deepEqual(await f!.states(first), FULL_PATH);
    assert.deepEqual(await f!.states(second), NO_REVIEW);
    for (const ext of [first, second]) {
      const shown = await f!.board.adapter.getItem(ext);
      assert.equal(shown?.status, "Done");
      assert.equal(shown?.closed, true);
    }
    // What /phase0 reports once PBI 15b (#89) builds it: each merged run, oldest merge first, with its cost.
    const merged = await db.pool.query<{ external_id: string; cost: number }>(
      `select i.external_id, (select sum(cost_usd) from stage_run s where s.run_id = r.id)::float as cost
       from run r join item i on i.id = r.item_id where r.merge_sha is not null order by r.started_at`,
    );
    assert.deepEqual(merged.rows.map((r) => r.external_id), [first, second]);
    for (const r of merged.rows) assert.ok(r.cost > 0, `item ${r.external_id} has no cost`);
    // The second item's Red ran with the first item's scenarios already green on main.
    const red = await f!.report(second, "red");
    assert.ok(red);
    for (const [name, verdict] of red) assert.equal(verdict, name.includes(`item ${first} `) ? "green" : "red", name);
  });

  test("an /approve comment signs off the same way the dashboard does", async () => {
    const ext = await f!.addItem("Export to CSV", ["Exports every row"]);
    await fullPath(ext, () => f!.commentOnItem(ext, "/approve"), false);
    assert.deepEqual(await f!.states(ext), NO_REVIEW);
  });

  test("an item with no acceptance criteria goes NotReady with reasons, and an edit re-runs the gate", async () => {
    const ext = await f!.addItem("Vague idea", []);
    await f!.poll();
    assert.equal(await f!.state(ext), "NotReady");
    assert.ok((await f!.board.comments(ext)).length > 0, "no reasons comment");
    await f!.board.seed({ externalId: ext, title: "Vague idea", acceptanceCriteria: ["Has a criterion now"], repo: "acme/app" });
    await f!.poll();
    assert.equal(await f!.state(ext), "Queued");
  });
});
