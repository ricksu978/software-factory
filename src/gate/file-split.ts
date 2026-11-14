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

const isHeading = (line: string) => /^#{1,6}\s/.test(line);

/**
 * `body` without any section under `heading`, at any level and in any letter case, each up to the next heading, as the
 * GitHub adapter reads the criteria (PBI 249). The rest of the body is kept in order, and a body with no such section
 * is returned as it is.
 */
export function withoutSection(body: string, heading: string): string {
  const want = heading.trim().toLowerCase();
  const kept: string[] = [];
  let dropping = false;
  let dropped = false;
  for (const line of body.split(/\r?\n/)) {
    if (isHeading(line)) dropping = line.replace(/^#+\s*/, "").trim().toLowerCase() === want;
    if (dropping) dropped = true;
    else kept.push(line);
  }
  return !dropped ? body : kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A child's body: the proposal's body without any criteria section of its own, then the parent's criteria for that
 * child word for word under the heading, then where it came from. A body with no such section is kept whole.
 */
export function childBody(parent: FactoryItem, child: SplitChild, n: number, heading: string): string {
  const own = withoutSection(child.body, heading);
  const criteria = child.criteria.map((c) => `- ${parent.acceptanceCriteria[c - 1]}`).join("\n");
  const from = `Filed by the factory from #${parent.externalId} as child ${n} of its proposed split (${splitMarker(splitKey(parent), n)}).`;
  return `${own ? `${own}\n\n` : ""}## ${heading}\n\n${criteria}\n\n---\n\n${from}\n`;
}


/** The parent's one comment once every child is filed: a link to each child, and how a child enters the factory. */
export function filedComment(filed: ChildIssue[], optInLabel: string): string {
  const list = filed.map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join("\n");
  return `The factory filed this item's split as ${filed.length} child items:\n\n${list}\n\n`
    + `None of them carries the \`${optInLabel}\` label. Add it to a child when it should enter the factory. This item has left the factory.\n`;
}

/** What an earlier filing of this split left: the parent's sub-issues, and each child already filed, by position. */
export type PriorFiling = { subs: string[]; found: (ChildIssue | undefined)[] };

/**
 * Reads what an earlier filing of this split left behind. Returns null when the parent already has a sub-issue this
 * split didn't file, by hand or from an earlier text's split: the parent is already split, so it gets no second set.
 */
export async function priorFiling(parent: FactoryItem, children: SplitChild[], board: SplitBoard): Promise<PriorFiling | null> {
  const repo = parent.repo;
  if (!repo) throw new Error(`item ${parent.externalId} has no repo to file its split in`);
  const key = splitKey(parent);
  const subs = (await board.subIssues(parent.externalId)).map((s) => s.externalId);
  const found: (ChildIssue | undefined)[] = [];
  for (const n of children.keys()) found.push((await board.findIssues(repo, splitMarker(key, n + 1)))[0]);
  const ours = new Set(found.filter((f) => f !== undefined).map((f) => f.externalId));
  return subs.some((id) => !ours.has(id)) ? null : { subs, found };
}

/**
 * Files `children` for `parent`, safe to repeat. A parent that already has a sub-issue this split didn't file gets no
 * second set, and a filing that stopped partway is finished without filing any child twice. Only once every child is
 * filed, linked, placed and blocked does the parent get its one link comment, through `adapter.comment`, and lose its
 * opt-in label. Any failed write throws, so the gate throws and the poller leaves the parent Eligible for the next
 * poll. Returns true when the split is filed, false when the parent was already split another way. `known` is a
 * `priorFiling` the caller already read, so the gate can word its proposal comment without reading twice.
 */
export async function fileSplit(parent: FactoryItem, children: SplitChild[], adapter: BacklogAdapter, deps: FileSplitDeps,
  known?: PriorFiling | null): Promise<boolean> {
  const { board } = deps;
  const prior = known === undefined ? await priorFiling(parent, children, board) : known;
  if (!prior) return false;
  const repo = parent.repo!;
  const key = splitKey(parent);
  const { subs, found } = prior;
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
