// A GitHub Projects (v2) board as a BacklogAdapter. Board reads and writes use the project token on a user-owned
// board and the App on an org one. Issue comments, labels and closing always go through the App.
import { Octokit } from "@octokit/core";
import type { ItemState } from "../../core/states.ts";
import { CLAIM_MARKER } from "../contract.ts";
import type { BacklogAdapter, FactoryItem, FactoryWebhookEvent } from "../types.ts";
import type { AppLike, GitHubClient } from "./repo-host.ts";

export type FieldMap = {
  acceptanceCriteriaHeading: string;
  statusField: string;
  statusFor: Record<ItemState, string | null>;
  optInLabel: string;
  sprintField: string | null;
  readinessFields: string[];
};

export type GitHubBacklogConfig = {
  app: AppLike;
  installationId: number;
  owner: { type: "user" | "org"; login: string };
  projectToken: string | null;
  projectNumber: number;
  fieldMap: FieldMap;
};

type Field = { id: string; name: string; options?: { id: string; name: string }[] };
type Project = { id: string; fields: Field[] };
type RawItem = {
  id: string; updatedAt: string;
  fieldValues: { nodes: { text?: string; number?: number; name?: string; field?: { name: string } }[] };
  content: { number?: number; title?: string; body?: string; state?: string; updatedAt?: string; repository?: { nameWithOwner: string }; labels?: { nodes: { name: string }[] } } | null;
};
type Located = { item: FactoryItem; itemId: string };

const PROJECT = (scope: "user" | "organization") => `query($login: String!, $number: Int!) {
  ${scope}(login: $login) { projectV2(number: $number) { id fields(first: 50) { nodes {
    ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`;

const ITEMS = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id updatedAt
    fieldValues(first: 30) { nodes {
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } } }
    content { ... on Issue { number title body state updatedAt repository { nameWithOwner } labels(first: 50) { nodes { name } } } } } } } } }`;

const SET_STATUS = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`;

/** The list items under the `heading` heading of an issue body, up to the next heading. */
export function acceptanceCriteria(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * Maps a GitHub webhook to a factory event. Comments and reviews by bot users, the App's own included, map to
 * `ignored`, so the factory never reacts to its own posts. Anything unknown or malformed is `ignored`; it never throws.
 */
export function parseGitHubWebhook(headers: Record<string, string>, body: unknown): FactoryWebhookEvent {
  try {
    const b = body as any;
    const event = headers["x-github-event"];
    if (!b || typeof b !== "object") return { kind: "ignored" };
    const repo = str(b.repository?.full_name);
    const bot = (u: any) => u?.type === "Bot" || str(u?.login).endsWith("[bot]");
    if (event === "issues" && b.issue?.number) return { kind: "item_changed", externalId: str(b.issue.number) };
    if (event === "issue_comment" && b.action === "created" && b.issue?.number && b.comment) {
      if (bot(b.comment.user)) return { kind: "ignored" };
      return { kind: "comment", externalId: str(b.issue.number), login: str(b.comment.user?.login), body: str(b.comment.body), commentId: str(b.comment.id) };
    }
    if (event === "pull_request" && b.action === "closed" && b.pull_request?.number && repo) {
      return b.pull_request.merged
        ? { kind: "pr_merged", prNumber: b.pull_request.number, repo, mergeSha: str(b.pull_request.merge_commit_sha) }
        : { kind: "pr_closed", prNumber: b.pull_request.number, repo };
    }
    if (event === "pull_request_review" && b.action === "submitted" && b.review && b.pull_request?.number && repo) {
      if (bot(b.review.user)) return { kind: "ignored" };
      const state = str(b.review.state).toLowerCase();
      if (state !== "approved" && state !== "changes_requested" && state !== "commented") return { kind: "ignored" };
      return { kind: "review", prNumber: b.pull_request.number, repo, state, submittedAt: str(b.review.submitted_at), author: str(b.review.user?.login) };
    }
    if (event === "check_suite" && b.action === "completed" && b.check_suite?.head_sha && repo) {
      return { kind: "checks_completed", sha: str(b.check_suite.head_sha), repo };
    }
    // ponytail: a dependency change re-reads the blocked issue; the payload field is read defensively.
    if (event === "issue_dependencies" && (b.blocked_issue?.number ?? b.issue?.number)) {
      return { kind: "item_changed", externalId: str(b.blocked_issue?.number ?? b.issue?.number) };
    }
    // projects_v2_item names an item node, not an issue number, so the next poll picks the change up instead.
    return { kind: "ignored" };
  } catch {
    return { kind: "ignored" };
  }
}

export function githubBacklog(cfg: GitHubBacklogConfig): BacklogAdapter {
  if (cfg.owner.type === "user" && !cfg.projectToken) {
    throw new Error("githubBacklog: a user-owned project needs the github-project-token secret, and projectToken is null");
  }
  let installation: Promise<GitHubClient> | undefined;
  const app = () => (installation ??= cfg.app.getInstallationOctokit(cfg.installationId) as Promise<GitHubClient>);
  const userBoard = cfg.projectToken ? (new Octokit({ auth: cfg.projectToken }) as unknown as GitHubClient) : null;
  const board = async () => (cfg.owner.type === "user" && userBoard ? userBoard : app());

  let project: Promise<Project> | undefined;
  const resolve = (): Promise<Project> =>
    (project ??= (async () => {
      const scope = cfg.owner.type === "user" ? "user" : "organization";
      const res = await (await board()).graphql<any>(PROJECT(scope), { login: cfg.owner.login, number: cfg.projectNumber });
      const p = res[scope].projectV2;
      return { id: p.id, fields: p.fields.nodes.filter((f: Field) => f.id) };
    })());

  const toItem = (raw: RawItem, rank: number, projectId: string): FactoryItem | null => {
    const c = raw.content;
    if (!c?.number || !c.repository) return null;
    const values = new Map(raw.fieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field!.name, str(v.text ?? v.number ?? v.name)]));
    return {
      sourceId: projectId, externalId: String(c.number), title: c.title ?? "", body: c.body ?? "",
      acceptanceCriteria: acceptanceCriteria(c.body ?? "", cfg.fieldMap.acceptanceCriteriaHeading),
      labels: (c.labels?.nodes ?? []).map((l) => l.name), status: values.get(cfg.fieldMap.statusField) ?? "", rank,
      repo: c.repository.nameWithOwner,
      fields: Object.fromEntries(cfg.fieldMap.readinessFields.filter((f) => values.has(f)).map((f) => [f, values.get(f)!])),
      closed: c.state !== "OPEN", updatedAt: [raw.updatedAt, c.updatedAt ?? ""].sort().at(-1)!,
    };
  };

  // ponytail: every read scans the whole board, 100 items a page; fine for a personal board, index by issue if it grows.
  // externalId is the issue number, so a board mixing repos with clashing numbers resolves to the first one.
  const scan = async (): Promise<Located[]> => {
    const p = await resolve();
    const gh = await board();
    const out: Located[] = [];
    let after: string | null = null;
    do {
      const res: any = await gh.graphql(ITEMS, { id: p.id, after });
      const page = res.node.items;
      for (const raw of page.nodes as RawItem[]) {
        const item = toItem(raw, out.length + 1, p.id);
        if (item) out.push({ item, itemId: raw.id });
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  };
  const locate = async (externalId: string): Promise<Located> => {
    const found = (await scan()).find((l) => l.item.externalId === externalId);
    if (!found) throw new Error(`no issue #${externalId} on project ${cfg.projectNumber}`);
    return found;
  };
  const issue = async (externalId: string) => {
    const { item } = await locate(externalId);
    const [owner, repo] = (item.repo as string).split("/");
    return { owner, repo, issue_number: Number(externalId) };
  };

  return {
    capabilities: { webhooks: true },

    async listEligible(cursor) {
      const all = await scan();
      const since = cursor ?? "";
      // >= rather than >: timestamps have one-second precision, and the poller's upsert makes a repeat harmless.
      const items = all.map((l) => l.item).filter((i) => !i.closed && i.labels.includes(cfg.fieldMap.optInLabel) && i.updatedAt >= since);
      const newest = all.map((l) => l.item.updatedAt).sort().at(-1);
      return { items, cursor: newest ?? since };
    },

    async getItem(externalId) {
      return (await scan()).find((l) => l.item.externalId === externalId)?.item ?? null;
    },

    async openDependencies(externalId) {
      const i = await issue(externalId);
      const blockers = (await (await app()).request("GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", { ...i, per_page: 100 })).data as { number: number; state: string }[];
      return blockers.filter((b) => b.state === "open").map((b) => String(b.number));
    },

    async claim(externalId) {
      await (await app()).request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...(await issue(externalId)), labels: [CLAIM_MARKER] });
    },

    async release(externalId) {
      try {
        await (await app()).request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...(await issue(externalId)), name: CLAIM_MARKER });
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
    },

    async comment(externalId, body, dedupeKey) {
      const gh = await app();
      const i = await issue(externalId);
      const marker = `<!-- factory:${dedupeKey} -->`;
      // ponytail: one page of 100 comments is checked for the marker; an issue with more could get a repeat.
      const existing = (await gh.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...i, per_page: 100 })).data as { body?: string }[];
      if (existing.some((c) => c.body?.includes(marker))) return;
      await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...i, body: `${marker}\n${body}` });
    },

    async setStatus(externalId, status) {
      const p = await resolve();
      const field = p.fields.find((f) => f.name === cfg.fieldMap.statusField);
      const option = field?.options?.find((o) => o.name === status);
      if (!field || !option) throw new Error(`project ${cfg.projectNumber} has no ${cfg.fieldMap.statusField} option "${status}"`);
      const { itemId } = await locate(externalId);
      await (await board()).graphql(SET_STATUS, { project: p.id, item: itemId, field: field.id, option: option.id });
    },

    async linkPr(externalId, prUrl) {
      await this.comment(externalId, `Pull request: ${prUrl}`, `pr:${prUrl}`);
    },

    async close(externalId) {
      await (await app()).request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { ...(await issue(externalId)), state: "closed", state_reason: "completed" });
    },

    parseWebhook: parseGitHubWebhook,
  };
}
