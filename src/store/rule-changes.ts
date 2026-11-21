// What the readiness check read from an item's "## Changes the factory's rules" section, and the owner's approval of
// it (PBI 395).
import type pg from "pg";
import { ruleChangesHash, type RuleChangeRead } from "../gate/rule-changes.ts";
import { transitionItem } from "./items.ts";
import { appendEvent } from "./events.ts";

/** Where a rule lives: a section of the factory's spec, such as "§6", or one of its policy files, such as "policy/dor.md". */
export type RulePlace = { kind: "spec"; section: string } | { kind: "policy"; path: string };

/** One rule the item changes: its place, its current text quoted as Before, and its text once the item ships as After. Null when the entry gives none. */
export type RuleChange = { place: RulePlace; before: string | null; after: string | null };

/** The kind of the event that logs the owner's approval of an item's rule changes. Its payload holds `rulesHash` and `changes`. */
export const RULE_CHANGE_APPROVED = "rule_change_approved";
/** The dor.md result's criterion that says the item waits for the owner's approval of its rule changes. */
export const APPROVAL_CRITERION = "rule change approval";

const plain = (r: RuleChangeRead): RuleChange => ({ place: r.place, before: r.before, after: r.after });

/**
 * The rule changes the item's last readiness check read from its "## Changes the factory's rules" section, in the
 * section's order: an empty list when the item has no such section, and null when no readiness check has read the
 * item since the factory began reading the section.
 */
export async function ruleChangesRead(pool: pg.Pool, itemId: string): Promise<RuleChange[] | null> {
  const got = await ruleChangesChecked(pool, itemId);
  return got && got.map(plain);
}

/** As ruleChangesRead, with what the check found wrong with each entry. */
export async function ruleChangesChecked(pool: pg.Pool | pg.ClientBase, itemId: string): Promise<RuleChangeRead[] | null> {
  const r = await pool.query<{ rule_changes: RuleChangeRead[] | null }>("select rule_changes from item where id = $1", [itemId]);
  return r.rows[0]?.rule_changes ?? null;
}

/** The hash of the rule changes the owner last approved on the item, or null when the owner never approved any. */
export async function approvedRulesHash(pool: pg.Pool | pg.ClientBase, itemId: string): Promise<string | null> {
  return (await latestApproval(pool, itemId))?.rulesHash ?? null;
}

export type RuleApproval = { rulesHash: string; by: string; at: Date };

/** The owner's latest approval of the item's rule changes, with who gave it, or null. */
export async function latestApproval(pool: pg.Pool | pg.ClientBase, itemId: string): Promise<RuleApproval | null> {
  const r = await pool.query<{ hash: string | null; by: string | null; at: Date }>(
    `select e.payload->>'rulesHash' as hash, coalesce(u.github_login, u.email, u.subject, e.actor_id) as by, e.at
     from event e left join "user" u on u.id::text = e.actor_id
     where e.item_id = $1 and e.kind = $2 order by e.at desc, e.id desc limit 1`,
    [itemId, RULE_CHANGE_APPROVED],
  );
  const row = r.rows[0];
  return row?.hash ? { rulesHash: row.hash, by: row.by ?? "", at: row.at } : null;
}

/** True when the item is NotReady and its last readiness check left it waiting for the owner to approve its rule changes. */
export async function waitsForApproval(c: pg.Pool | pg.ClientBase, itemId: string): Promise<boolean> {
  const r = await c.query(
    `select 1 from item i where i.id = $1 and i.state = 'NotReady' and exists (
       select 1 from policy_result p where p.item_id = i.id and p.file = 'dor' and p.run_id is null
         and p.criterion = $2 and p.status = 'failed'
         and p.at = (select max(at) from policy_result where item_id = i.id and file = 'dor' and run_id is null))`,
    [itemId, APPROVAL_CRITERION],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The owner approves the rule changes the item's last readiness check read. Inside a transaction: the item is locked,
 * and only one that still waits for that approval is approved. The approval is logged as `rule_change_approved` at `at`,
 * by the owner, and the item moves from NotReady to Eligible through the event of that name, so the next poll runs the
 * rest of the readiness check. Returns "unknown" for no such item and "not_waiting" for one that doesn't wait.
 */
export async function approveRuleChange(c: pg.PoolClient, a: { itemId: string; userId: string; at: Date }): Promise<"approved" | "unknown" | "not_waiting"> {
  const row = (await c.query<{ rule_changes: RuleChangeRead[] | null }>("select rule_changes from item where id = $1 for update", [a.itemId])).rows[0];
  if (!row) return "unknown";
  if (!row.rule_changes?.length || !(await waitsForApproval(c, a.itemId))) return "not_waiting";
  const changes = row.rule_changes.map(plain);
  const actor = { actor: "human" as const, actorId: a.userId };
  await appendEvent(c, { ...actor, itemId: a.itemId, kind: RULE_CHANGE_APPROVED, payload: { rulesHash: ruleChangesHash(changes), changes }, at: a.at });
  await transitionItem(c, a.itemId, "rule_change_approved", actor);
  return "approved";
}
