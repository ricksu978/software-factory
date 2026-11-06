// The backlog and repo host interfaces every adapter implements (plan Task 6). src/adapters/contract.ts checks backlogs.

export type FactoryItem = {
  sourceId: string; externalId: string; title: string; body: string;
  acceptanceCriteria: string[]; labels: string[]; status: string; rank: number;
  repo: string | null; fields: Record<string, string>; closed: boolean; updatedAt: string;
};
// fields holds the values of FieldMap.readinessFields, such as { Size: "8" }

export type FactoryWebhookEvent =
  | { kind: "item_changed"; externalId: string }
  | { kind: "pr_merged"; prNumber: number; repo: string; mergeSha: string }
  | { kind: "pr_closed"; prNumber: number; repo: string }
  | { kind: "checks_completed"; sha: string; repo: string }
  | { kind: "comment"; externalId: string; login: string; body: string; commentId: string }
  | { kind: "review"; prNumber: number; repo: string; state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string }
  | { kind: "ignored" };

export interface BacklogAdapter {
  capabilities: { webhooks: boolean };
  listEligible(cursor: string | null): Promise<{ items: FactoryItem[]; cursor: string }>;
  getItem(externalId: string): Promise<FactoryItem | null>;
  openDependencies(externalId: string): Promise<string[]>;
  claim(externalId: string): Promise<void>;
  release(externalId: string): Promise<void>;
  comment(externalId: string, body: string, dedupeKey: string): Promise<void>;
  setStatus(externalId: string, status: string): Promise<void>;
  linkPr(externalId: string, prUrl: string): Promise<void>;
  close(externalId: string): Promise<void>;
  parseWebhook(headers: Record<string, string>, body: unknown): FactoryWebhookEvent;
}

export type ReviewComment = { threadId: string; path: string; line: number | null; author: string; body: string };

export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure">;
  /** CODEOWNERS first, then `fallback`. */
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>;
  prState(repo: string, prNumber: number, trustedLogins: string[]): Promise<{
    merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; lastChangesRequestedAt: string | null;
  }>;
  closePr(repo: string, prNumber: number, comment: string): Promise<void>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  defaultBranchSha(repo: string): Promise<string>;
  /** Every comment in the PR's unresolved review threads. */
  openReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]>;
}
