// Filing a proposed split as child PBIs (PBI 144). Once the gate has posted a valid split on an oversized parent, it
// files each child as an issue in the parent's repo, for the owner to approve: a sub-issue of the parent, on the
// parent's board in the backlog status, blocked by the earlier children it needs, and without the opt-in label. Then
// the parent loses its opt-in label and gets one comment linking to each child.
import { createHash } from "node:crypto";
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import { itemTextHash, type SplitChild } from "./split.ts";

/** An issue the factory filed, or found already filed. `url` is its web URL, which the parent's link comment carries. */
export type ChildIssue = { externalId: string; title: string; url: string };

/** The board and repo writes filing needs, beyond the BacklogAdapter's. Every write may fail; filing is retried. */
export interface SplitBoard {
  /** The parent's sub-issues, in order. */
  subIssues(parentId: string): Promise<ChildIssue[]>;
  /** The issues in `repo` whose title or body holds `text`, so a child filed but not yet linked is found again. */
  findIssues(repo: string, text: string): Promise<ChildIssue[]>;
  /** Files a new issue in `repo`, with no label. */
  createIssue(repo: string, title: string, body: string): Promise<ChildIssue>;
  /** Makes `childId` the parent's last sub-issue. */
  addSubIssue(parentId: string, childId: string): Promise<void>;
  /** The issue's status on the parent's board, or null when it isn't on that board. */
  boardStatus(externalId: string): Promise<string | null>;
  /** Adds the issue to the parent's board with `status`. */
  addToBoard(externalId: string, status: string): Promise<void>;
  /** The issues that block this one. */
  blockedBy(externalId: string): Promise<string[]>;
  /** Marks `externalId` blocked by `blockerId`. */
  addBlockedBy(externalId: string, blockerId: string): Promise<void>;
  /** Takes `label` off the issue. Taking off a label it lacks succeeds. */
  removeLabel(externalId: string, label: string): Promise<void>;
}

/** What filing needs: the board, the source's opt-in label and backlog status, and the criteria heading it reads. */
export type FileSplitDeps = { board: SplitBoard; optInLabel: string; backlogStatus: string; criteriaHeading: string };

/** Filing's key for this parent and its text: a new text is a new split, and a parent's children never match another's. */
export function splitKey(parent: FactoryItem): string {
  return createHash("sha256").update(`${parent.externalId}\n${itemTextHash(parent)}`).digest("hex").slice(0, 16);
}

/** The token a filed child's body carries, so a child filed but not yet linked is found again instead of filed twice. */
export function splitMarker(key: string, n: number): string {
  return `factory-split-${key}-${n}`;
}

/** A child's body: the proposal's body, its criteria word for word under the heading, then where it came from. */
export function childBody(parent: FactoryItem, child: SplitChild, n: number, heading: string): string {
  const criteria = child.criteria.map((c) => `- ${parent.acceptanceCriteria[c - 1]}`).join("\n");
  const from = `Filed by the factory from #${parent.externalId} as child ${n} of its proposed split (${splitMarker(splitKey(parent), n)}).`;
  return `${child.body}\n\n## ${heading}\n\n${criteria}\n\n---\n\n${from}\n`;
}

/** The parent's one comment once every child is filed: a link to each child, and how a child enters the factory. */
export function filedComment(filed: ChildIssue[], optInLabel: string): string {
  const list = filed.map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join("\n");
  return `The factory filed this item's split as ${filed.length} child items:\n\n${list}\n\n`
    + `None of them carries the \`${optInLabel}\` label. Add it to a child when it should enter the factory. This item has left the factory.\n`;
}

/**
 * Files `children` for `parent`, safe to repeat. A parent that already has a sub-issue this split didn't file gets no
 * second set, and a filing that stopped partway is finished without filing any child twice. Only once every child is
 * filed, linked, placed and blocked does the parent get its one link comment, through `adapter.comment`, and lose its
 * opt-in label. Any failed write throws, so the gate throws and the poller leaves the parent Eligible for the next
 * poll. Returns true when the split is filed, false when the parent was already split another way.
 */
export async function fileSplit(parent: FactoryItem, children: SplitChild[], adapter: BacklogAdapter, deps: FileSplitDeps): Promise<boolean> {
  const { board } = deps;
  const repo = parent.repo;
  if (!repo) throw new Error(`item ${parent.externalId} has no repo to file its split in`);
  const key = splitKey(parent);
  const subs = (await board.subIssues(parent.externalId)).map((s) => s.externalId);
  const found: (ChildIssue | undefined)[] = [];
  for (const n of children.keys()) found.push((await board.findIssues(repo, splitMarker(key, n + 1)))[0]);
  const ours = new Set(found.filter((f) => f !== undefined).map((f) => f.externalId));
  // Any other sub-issue, by hand or from an earlier text's split, means the parent is already split.
  if (subs.some((id) => !ours.has(id))) return false;
  const filed: ChildIssue[] = [];
  for (const [i, child] of children.entries()) {
    const issue = found[i] ?? (await board.createIssue(repo, child.title, childBody(parent, child, i + 1, deps.criteriaHeading)));
    filed.push(issue);
    if (!subs.includes(issue.externalId)) {
      await board.addSubIssue(parent.externalId, issue.externalId);
      subs.push(issue.externalId);
    }
    // An issue on the board without a status was added but never placed. One the owner has moved stays where it is.
    if (!(await board.boardStatus(issue.externalId))) await board.addToBoard(issue.externalId, deps.backlogStatus);
    const blockers = await board.blockedBy(issue.externalId);
    for (const need of child.needs) {
      const blocker = filed[need - 1].externalId;
      if (!blockers.includes(blocker)) await board.addBlockedBy(issue.externalId, blocker);
    }
  }
  // The comment goes before the label comes off: a parent without its label is never gated again to post it.
  await adapter.comment(parent.externalId, filedComment(filed, deps.optInLabel), `split-filed:${key}`);
  await board.removeLabel(parent.externalId, deps.optInLabel);
  return true;
}
