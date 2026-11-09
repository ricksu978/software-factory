// Filing a proposed split as child PBIs (PBI 144). Once the gate has posted a valid split on an oversized parent, it
// files each child as an issue in the parent's repo, for the owner to approve: a sub-issue of the parent, on the
// parent's board in the backlog status, blocked by the earlier children it needs, and without the opt-in label. Then
// the parent loses its opt-in label and gets one comment linking to each child.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import type { SplitChild } from "./split.ts";

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

/**
 * Files `children` for `parent`, safe to repeat. A parent that already has its sub-issues gets no second set, and a
 * filing that stopped partway is finished without filing any child twice. Only once every child is filed, linked,
 * placed and blocked does the parent lose its opt-in label and get its one link comment, through `adapter.comment`.
 * Any failed write throws, so the gate throws and the poller leaves the parent Eligible for the next poll.
 */
export async function fileSplit(_parent: FactoryItem, _children: SplitChild[], _adapter: BacklogAdapter, _deps: FileSplitDeps): Promise<void> {
  // Stub (PBI 144, red stage): files nothing yet.
}
