// Filing a proposed split as child PBIs (PBI 144). Once the gate has posted a valid split on an oversized parent, it
// files each child as an issue in the parent's repo: a sub-issue of the parent, on the parent's board in the backlog
// status, and blocked by the earlier children it needs. Each child carries the opt-in label as it's filed, so it
// enters the factory like any item (PBI 237), unless the parent is itself a child the factory filed: then its children
// carry no label and wait for the owner, so a split can't keep splitting without a person looking. Then the parent
// loses its opt-in label and gets one comment linking to each child.
import { createHash } from "node:crypto";
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import { itemTextHash, type SplitChild } from "./split.ts";

/** An issue the factory filed, or found already filed. `url` is its web URL, which the parent's link comment carries. */
export type ChildIssue = { externalId: string; title: string; url: string };

/**
 * A parent's sub-issue, as the board lists it: with its body, and whether the factory's own App opened it, when the
 * board can say. Recovery matches split markers on these, so it never has to search the repo (PBI 226).
 */
export type SubIssue = ChildIssue & { body?: string; openedByApp?: boolean };

/** The board and repo writes filing needs, beyond the BacklogAdapter's. Every write may fail; filing is retried. */
export interface SplitBoard {
  /** The parent's sub-issues, in order. */
  subIssues(parentId: string): Promise<SubIssue[]>;
  /** The issues in `repo` whose title or body holds `text`, so a child filed but not yet linked is found again. */
  findIssues(repo: string, text: string): Promise<ChildIssue[]>;
  /** Files a new issue in `repo`, carrying `labels` as it's filed (PBI 237), or no label when none is given. */
  createIssue(repo: string, title: string, body: string, labels?: string[]): Promise<ChildIssue>;
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
  /**
   * Who opened the issue and who has edited its body since (PBI 264). The factory rewrites a filed child only when its
   * own App opened it, its body carries a split marker, and nobody else has edited the body since. Unset, the board
   * can't say, and the factory edits no issue.
   */
  authorship?(externalId: string): Promise<IssueAuthorship>;
  /** Replaces the issue's body (PBI 264). The factory calls it only for a child it may rewrite. */
  editBody?(externalId: string, body: string): Promise<void>;
}

/**
 * `openedByApp`: the factory's own App opened the issue. `editedByOthers`: anyone but the App has edited its body since
 * it was opened. `editedByApp`: the App has edited its body since it was opened, as a rewrite does.
 */
export type IssueAuthorship = { openedByApp: boolean; editedByOthers: boolean; editedByApp: boolean };

/** What filing needs: the board, the source's opt-in label and backlog status, and the criteria heading it reads. */
export type FileSplitDeps = { board: SplitBoard; optInLabel: string; backlogStatus: string; criteriaHeading: string };

/** Filing's key for this parent and its text: a new text is a new split, and a parent's children never match another's. */
export function splitKey(parent: FactoryItem): string {
  return keyFor(parent.externalId, itemTextHash(parent));
}

/** The split key for a parent's id and the text hash its split was kept for. */
function keyFor(externalId: string, textHash: string): string {
  return createHash("sha256").update(`${externalId}\n${textHash}`).digest("hex").slice(0, 16);
}

/**
 * The children the factory filed for a parent whose move to Split recorded none, as a parent split before PBI 226
 * did (PBI 226). They're the parent's sub-issues that the factory's own App opened and whose body carries the parent's
 * split marker, for one of the splits kept for it (`kept`, newest first, each by its text hash and child count). The
 * markers are matched on the sub-issues as listed, not searched for in the repo, so a child filed long ago is found
 * however many issues came after it. A sub-issue added by hand carries no marker, so it isn't one. Null when no kept
 * split has every child found among the parent's sub-issues.
 */
export async function filedFromMarkers(parentId: string, kept: { textHash: string; count: number }[],
  board: Pick<SplitBoard, "subIssues">): Promise<ChildIssue[] | null> {
  if (kept.length === 0) return null;
  const subs = (await board.subIssues(parentId)).filter((s) => s.openedByApp === true && s.body);
  for (const { textHash, count } of kept) {
    const key = keyFor(parentId, textHash);
    const filed: ChildIssue[] = [];
    for (let n = 1; n <= count; n++) {
      // The marker for child 1 is a prefix of child 10's, so a digit may not follow it.
      const marker = new RegExp(`${splitMarker(key, n)}(?!\\d)`);
      const found = subs.find((s) => marker.test(s.body!));
      if (!found) break;
      filed.push({ externalId: found.externalId, title: found.title, url: found.url });
    }
    if (count > 0 && filed.length === count) return filed;
  }
  return null;
}

/** The token a filed child's body carries, so a child filed but not yet linked is found again instead of filed twice. */
export function splitMarker(key: string, n: number): string {
  return `factory-split-${key}-${n}`;
}

/** Whether the factory filed this item as a child of a split: its body carries a split marker. */
export function factoryFiled(item: FactoryItem): boolean {
  return /factory-split-[0-9a-f]{16}-\d+/.test(item.body);
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

/**
 * The parent's one comment once every child is filed: a link to each child, and whether the children have entered the
 * factory (`optedIn`) or wait for the owner to add the label.
 */
export function filedComment(filed: ChildIssue[], optInLabel: string, optedIn: boolean): string {
  const list = filed.map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join("\n");
  const how = optedIn
    ? `Each of them carries the \`${optInLabel}\` label and has entered the factory. Removing the \`${optInLabel}\` label from a child withdraws that child.`
    : `None of them carries the \`${optInLabel}\` label, because the factory filed this item from a split of its own. Add it to a child when it should enter the factory.`;
  return `The factory filed this item's split as ${filed.length} child items:\n\n${list}\n\n${how} This item has left the factory.\n`;
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
 * poll. A child is labelled only as it's filed, never when found already filed, so a label the owner removed stays off.
 * Returns the filed children, in order, when the split is filed, and null when the parent was already split
 * another way. The poller keeps them on the parent's move to Split, to know when they're all Done (PBI 226),
 * and keeps them for its "Split into" on Floor and Run detail (PBI 227). `known` is a
 * `priorFiling` the caller already read, so the gate can word its proposal comment without reading twice.
 */
export async function fileSplit(parent: FactoryItem, children: SplitChild[], adapter: BacklogAdapter, deps: FileSplitDeps,
  known?: PriorFiling | null): Promise<ChildIssue[] | null> {
  const { board } = deps;
  const prior = known === undefined ? await priorFiling(parent, children, board) : known;
  if (!prior) return null;
  const repo = parent.repo!;
  const key = splitKey(parent);
  const { subs, found } = prior;
  const optedIn = !factoryFiled(parent);
  const labels = optedIn ? [deps.optInLabel] : [];
  const filed: ChildIssue[] = [];
  for (const [i, child] of children.entries()) {
    const issue = found[i] ?? (await board.createIssue(repo, child.title, childBody(parent, child, i + 1, deps.criteriaHeading), labels));
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
  await adapter.comment(parent.externalId, filedComment(filed, deps.optInLabel, optedIn), `split-filed:${key}`);
  await board.removeLabel(parent.externalId, deps.optInLabel);
  return filed;
}
