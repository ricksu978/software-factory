import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BacklogAdapter, FactoryItem } from "./types.ts";

/** What a contract case gets from `make`: the adapter, a way to add an item, and a way to read an item's comments. */
export type ContractTarget = {
  adapter: BacklogAdapter;
  seed(item: Partial<FactoryItem>): Promise<string>;
  comments(externalId: string): Promise<string[]>;
};

export const OPT_IN_LABEL = "factory";
export const CLAIM_MARKER = "factory:in-progress";

/** Registers the shared backlog contract as node:test cases. Each case calls `make` for a fresh adapter. */
export function backlogContract(name: string, make: () => Promise<ContractTarget>): void {
  describe(`backlog contract: ${name}`, () => {
    test("listEligible returns only open items with the opt-in label", async () => {
      const t = await make();
      const open = await t.seed({ labels: [OPT_IN_LABEL] });
      const unlabelled = await t.seed({ labels: [] });
      const closed = await t.seed({ labels: [OPT_IN_LABEL], closed: true });
      const ids = (await t.adapter.listEligible(null)).items.map((i) => i.externalId);
      assert.deepEqual(ids.filter((id) => [open, unlabelled, closed].includes(id)), [open]);
    });

    test("comment twice with one dedupe key leaves one comment", async () => {
      const t = await make();
      const id = await t.seed({ labels: [OPT_IN_LABEL] });
      await t.adapter.comment(id, "hello", "contract:1");
      await t.adapter.comment(id, "hello", "contract:1");
      assert.equal((await t.comments(id)).length, 1);
    });

    test("claim shows the in-progress marker and release clears it", async () => {
      const t = await make();
      const id = await t.seed({ labels: [OPT_IN_LABEL] });
      await t.adapter.claim(id);
      assert.ok((await t.adapter.getItem(id))?.labels.includes(CLAIM_MARKER));
      await t.adapter.release(id);
      const labels = (await t.adapter.getItem(id))?.labels ?? [];
      assert.ok(!labels.includes(CLAIM_MARKER));
      assert.ok(labels.includes(OPT_IN_LABEL));
    });

    test("setStatus round-trips through getItem", async () => {
      const t = await make();
      const id = await t.seed({ labels: [OPT_IN_LABEL] });
      await t.adapter.setStatus(id, "Done");
      assert.equal((await t.adapter.getItem(id))?.status, "Done");
    });

    test("parseWebhook on an unknown payload returns ignored", async () => {
      const t = await make();
      for (const body of [{}, null, "x", { action: "nonsense" }]) {
        assert.deepEqual(t.adapter.parseWebhook({ "x-github-event": "nonsense" }, body), { kind: "ignored" });
      }
      assert.deepEqual(t.adapter.parseWebhook({}, undefined), { kind: "ignored" });
    });

    test("close shows closed through getItem", async () => {
      const t = await make();
      const id = await t.seed({ labels: [OPT_IN_LABEL] });
      await t.adapter.close(id);
      assert.equal((await t.adapter.getItem(id))?.closed, true);
      assert.ok(!(await t.adapter.listEligible(null)).items.some((i) => i.externalId === id));
    });
  });
}
