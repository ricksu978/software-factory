// GitHub as a RepoHost. The control plane runs it on the App's installation token; a cell gets only the PR methods
// it needs, on the short-lived token from /github-token (Run contract 6).
import { Octokit } from "@octokit/core";
import { matchesPath } from "../../core/glob.ts";
import { factoryThread, standingSummaries, THREAD_SETTLE_MS, type MergeState, type RepoHost, type Review, type ReviewComment } from "../types.ts";

/** The slice of an Octokit client this module uses, so tests can pass a stub. */
export type GitHubClient = {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>;
  graphql<T = any>(query: string, vars?: Record<string, unknown>): Promise<T>;
};
/** The slice of `@octokit/app`'s App this module uses. */
export type AppLike = {
  octokit: Pick<GitHubClient, "request">;
  getInstallationOctokit(installationId: number): Promise<unknown>;
};

// A cell token can push code, open a PR, comment, and post and resolve the PR review stage's own review threads. With nothing on statuses or checks it can't mark its own PR
// green, which only the control plane's risk-approval check may do (spec §9). Without an explicit set, GitHub gives
// the token every permission the App holds.
export const CELL_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write" } as const;

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
};
const notFound = (e: unknown) => (e as { status?: number }).status === 404;

type PrMethods = Pick<RepoHost, "openOrUpdatePr" | "requestReviewers" | "replyToThread" | "commentOnPr" | "prState"
  | "openReviewComments" | "postReview" | "resolveThread">;

const REPLY = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`;

function prMethods(client: () => Promise<GitHubClient>): PrMethods {
  return {
    async replyToThread(_repo, threadId, body) {
      await (await client()).graphql(REPLY, { thread: threadId, body });
    },

    async commentOnPr(repo, prNumber, body) {
      await (await client()).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...split(repo), issue_number: prNumber, body });
    },

    async openReviewComments(repo, prNumber) {
      const r = split(repo);
      const res = await (await client()).graphql<any>(THREADS, { owner: r.owner, repo: r.repo, number: prNumber });
      const threads = res.repository.pullRequest.reviewThreads.nodes as { id: string; isResolved: boolean; path: string; line: number | null; comments: { nodes: { author: Author; body: string }[] } }[];
      const comments = threads.filter((t) => !t.isResolved).flatMap((t) =>
        t.comments.nodes.map((c): ReviewComment => ({ threadId: t.id, path: t.path, line: t.line, author: authorLogin(c.author), body: c.body })),
      );
      // ponytail: one page of 100 reviews, oldest first, as in prState; a PR with more would miss the newest summaries.
      const reviews = (res.repository.pullRequest.reviews.nodes as { id: string; state: string; body: string; author: Author }[])
        .filter((v) => v.state !== "PENDING")
        .map((v): Review => ({ id: v.id, author: authorLogin(v.author), state: v.state.toLowerCase() as Review["state"], body: v.body }));
      return [...comments, ...standingSummaries(reviews)];
    },

    async postReview({ repo, prNumber, commitSha, body, comments }) {
      const gh = await client();
      const r = split(repo);
      // Built field by field, so an event a caller slips in never reaches GitHub. Only COMMENT is ever sent.
      const review = (await gh.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        ...r, pull_number: prNumber, commit_id: commitSha, body, event: "COMMENT",
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      })).data as { id: number };
      if (!comments.length) return { threads: [] };
      // REST answers with the review, not its threads, so the threads whose first comment belongs to it are looked up.
      // ponytail: the PR's first 100 threads; on a PR with more, a new thread past them goes untracked.
      const res = await gh.graphql<any>(OWN_THREADS, { owner: r.owner, repo: r.repo, number: prNumber });
      const nodes = res.repository.pullRequest.reviewThreads.nodes as { id: string; path: string; line: number | null; comments: { nodes: { body: string; pullRequestReview: { databaseId: number | null } | null }[] } }[];
      return { threads: nodes.filter((t) => t.comments.nodes[0]?.pullRequestReview?.databaseId === review.id)
        .map((t) => ({ threadId: t.id, path: t.path, line: t.line ?? 0, body: t.comments.nodes[0].body })) };
    },

    async resolveThread(_repo, threadId) {
      // GitHub answers resolveReviewThread on a resolved thread with the thread as it stands, so a second call is a no-op.
      // Checked live on 2026-11-09: isResolved and resolvedBy came back unchanged, with no error.
      await (await client()).graphql(RESOLVE, { thread: threadId });
    },

    // A cell asks it too, with no trusted logins, to learn whether its branch's PR already merged (PBI 142).
    async prState(repo, prNumber, trustedLogins, trustedBot) {
      const gh = await client();
      const r = split(repo);
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: prNumber })).data;
      // ponytail: one page of 100 reviews; a PR with more would miss the newest ones.
      const reviews = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { ...r, pull_number: prNumber, per_page: 100 })).data as { id: number; state: string; body: string | null; submitted_at: string | null; user: { login: string } | null }[];
      const trusted = new Set(trustedLogins.map((l) => l.toLowerCase()));
      // A review that only comments still asks for changes when it leaves a thread open, as the PR reviewer's do.
      // Only an open PR needs it, so a failed GraphQL call can't hold up merge and close detection.
      // ponytail: the first 100 threads and 100 comments each, oldest first; past that the newest, which trigger, are cut.
      // A comment counts once it has stood for THREAD_SETTLE_MS.
      const res = trusted.size && pr.state === "open" ? await gh.graphql<any>(THREADS, { owner: r.owner, repo: r.repo, number: prNumber }) : null;
      const settled = Date.now() - THREAD_SETTLE_MS;
      const threads = ((res?.repository.pullRequest.reviewThreads.nodes ?? []) as { isResolved: boolean; comments: { nodes: { author: Author; pullRequestReview: { databaseId: number | null; submittedAt: string | null } | null }[] } }[])
        .filter((t) => !factoryThread(t.comments.nodes[0] && authorLogin(t.comments.nodes[0].author), trustedBot));
      // A review that requests changes counts only when it has a summary or a comment outside the factory's threads. One
      // whose only text is a reply inside the factory's thread would hand the address run nothing to read (PBI 130).
      const withText = new Set(threads.flatMap((t) => t.comments.nodes.map((c) => c.pullRequestReview?.databaseId)));
      const requested = reviews.filter((v) => v.state === "CHANGES_REQUESTED" && v.submitted_at && trusted.has(String(v.user?.login).toLowerCase())
        && ((v.body ?? "").trim() !== "" || withText.has(v.id))).map((v) => v.submitted_at as string);
      const open = threads.filter((t) => !t.isResolved).flatMap((t) => t.comments.nodes)
        .filter((c) => c.pullRequestReview?.submittedAt && Date.parse(c.pullRequestReview.submittedAt) <= settled && trusted.has(authorLogin(c.author).toLowerCase()))
        .map((c) => c.pullRequestReview!.submittedAt!);
      const times = [...requested, ...open].sort();
      return {
        merged: Boolean(pr.merged), mergeSha: pr.merged ? pr.merge_commit_sha : null, open: pr.state === "open",
        mergeable: pr.mergeable ?? null, lastChangesRequestedAt: times.at(-1) ?? null,
      };
    },

    async openOrUpdatePr({ repo, branch, base, title, body }) {
      const gh = await client();
      const r = split(repo);
      const open = (await gh.request("GET /repos/{owner}/{repo}/pulls", { ...r, head: `${r.owner}:${branch}`, state: "open" })).data as { number: number; html_url: string }[];
      if (open[0]) {
        await gh.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: open[0].number, base, title, body });
        return { number: open[0].number, url: open[0].html_url };
      }
      const created = (await gh.request("POST /repos/{owner}/{repo}/pulls", { ...r, head: branch, base, title, body })).data;
      return { number: created.number, url: created.html_url };
    },

    async requestReviewers(repo, prNumber, fallback) {
      const gh = await client();
      const r = split(repo);
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: prNumber })).data;
      const rules = await codeowners(gh, r, pr.base.ref);
      const author = String(pr.user?.login ?? "").toLowerCase();
      const clean = (list: string[]) => list.map((o) => o.replace(/^@/, "")).filter((o) => !o.includes("@") && o.toLowerCase() !== author);
      let names: string[] = [];
      if (rules) {
        // ponytail: one page of 100 files; a bigger PR asks owners of its first 100 files only.
        const files = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...r, pull_number: prNumber, per_page: 100 })).data as { filename: string }[];
        names = clean([...new Set(files.flatMap((f) => ownersOf(rules, f.filename)))]);
      }
      // No CODEOWNERS, or it names nobody but the author for these files: the PR would otherwise get no reviewer.
      if (!names.length) names = clean(fallback);
      const reviewers = names.filter((o) => !o.includes("/"));
      const teams = names.filter((o) => o.includes("/")).map((o) => o.split("/")[1]);
      if (reviewers.length || teams.length) {
        await gh.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...r, pull_number: prNumber, reviewers, team_reviewers: teams });
      }
      return names;
    },
  };
}

type Rule = { pattern: string; owners: string[] };

async function codeowners(gh: GitHubClient, r: { owner: string; repo: string }, ref: string): Promise<Rule[] | null> {
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const text = await readText(gh, r, ref, path);
    if (text !== null) {
      return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => {
        const [pattern, ...owners] = l.split(/\s+/);
        return { pattern, owners };
      });
    }
  }
  return null;
}

/** The owners of a path: the last matching CODEOWNERS rule wins, as GitHub documents. */
export function ownersOf(rules: Rule[], path: string): string[] {
  let owners: string[] = [];
  for (const { pattern, owners: o } of rules) if (globsFor(pattern).some((g) => matchesPath(path, g))) owners = o;
  return owners;
}

// ponytail: covers the common CODEOWNERS forms (anchored, unanchored, directory, *); full gitignore escaping isn't handled.
function globsFor(pattern: string): string[] {
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  let p = pattern.replace(/^\//, "");
  if (p.endsWith("/")) p += "**";
  const base = anchored ? p : `**/${p}`;
  return /[*?[]/.test(p) && !p.endsWith("**") ? [base] : [base, `${base}/**`];
}

async function readText(gh: GitHubClient, r: { owner: string; repo: string }, ref: string, path: string): Promise<string | null> {
  try {
    const data = (await gh.request("GET /repos/{owner}/{repo}/contents/{path}", { ...r, path, ref })).data;
    return data.type === "file" ? Buffer.from(data.content, "base64").toString("utf8") : null;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

async function checksOn(gh: GitHubClient, r: { owner: string; repo: string }, sha: string): Promise<"pending" | "success" | "failure" | "none"> {
  // ponytail: check runs only, one page of 100; commit statuses aren't read, since this repo's CI reports as check runs.
  const runs = (await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...r, ref: sha, per_page: 100 })).data.check_runs as { status: string; conclusion: string | null }[];
  if (runs.some((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? ""))) return "failure";
  if (runs.length === 0) {
    // "none" only when no commit status has reported either, so a repo whose CI reports statuses still reads pending.
    const statuses = (await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { ...r, ref: sha })).data.total_count;
    return statuses === 0 ? "none" : "pending";
  }
  return runs.some((c) => c.status !== "completed") ? "pending" : "success";
}

/** PBI 234: each check run not yet completed, by name, and each commit status still pending, by context. */
async function pendingChecksOn(gh: GitHubClient, r: { owner: string; repo: string }, sha: string): Promise<string[]> {
  // ponytail: one page of 100 check runs and the combined status's statuses, as checksOn reads.
  const runs = (await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...r, ref: sha, per_page: 100 })).data.check_runs as { name: string; status: string }[];
  const statuses = ((await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { ...r, ref: sha })).data.statuses ?? []) as { context: string; state: string }[];
  return [...runs.filter((c) => c.status !== "completed").map((c) => c.name), ...statuses.filter((s) => s.state === "pending").map((s) => s.context)];
}

const THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved path line comments(first: 100) { nodes { author { __typename login } body pullRequestReview { databaseId submittedAt } } } } }
  reviews(first: 100) { nodes { id state body author { __typename login } } } } } }`;

type Author = { __typename: string; login: string } | null;

/** GraphQL names a bot without the "[bot]" suffix REST adds. Adding it back keeps a user with the same name apart (issue #79). */
function authorLogin(a: Author): string {
  if (!a) return "ghost";
  return a.__typename === "Bot" ? `${a.login}[bot]` : a.login;
}

const OWN_THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id path line comments(first: 1) { nodes { body pullRequestReview { databaseId } } } } } } } }`;

const RESOLVE = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`;

/** RepoHost on the App's installation token. The control plane alone holds the App key. */
export function githubRepoHost(app: AppLike, installationId: number): RepoHost {
  let cached: Promise<GitHubClient> | undefined;
  const client = () => (cached ??= app.getInstallationOctokit(installationId) as Promise<GitHubClient>);
  return {
    ...prMethods(client),

    async cellToken(repo) {
      const { data } = await app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: installationId, repositories: [split(repo).repo], permissions: { ...CELL_PERMISSIONS },
      });
      return { token: data.token, expiresAt: data.expires_at };
    },

    async checksOnSha(repo, sha) {
      return checksOn(await client(), split(repo), sha);
    },

    async pendingChecksOnSha(repo, sha) {
      return pendingChecksOn(await client(), split(repo), sha);
    },

    async checksOnHead(repo, prNumber) {
      const gh = await client();
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...split(repo), pull_number: prNumber })).data;
      const state = await checksOn(gh, split(repo), pr.head.sha);
      return state === "none" ? "pending" : state;
    },

    async onBranch(repo, branch, sha) {
      // "ahead" means the branch contains the sha and "identical" means it is the head; "diverged" and "behind" don't.
      try {
        const { status } = (await (await client()).request("GET /repos/{owner}/{repo}/compare/{basehead}", { ...split(repo), basehead: `${sha}...${branch}` })).data;
        return status === "ahead" || status === "identical";
      } catch (e) {
        if (notFound(e)) return false; // a sha GitHub doesn't know
        throw e;
      }
    },

    async closePr(repo, prNumber, comment) {
      const gh = await client();
      const r = split(repo);
      await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...r, issue_number: prNumber, body: comment });
      await gh.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: prNumber, state: "closed" });
    },

    async readFile(repo, ref, path) {
      return readText(await client(), split(repo), ref, path);
    },

    async defaultBranchSha(repo) {
      const gh = await client();
      const r = split(repo);
      const branch = (await gh.request("GET /repos/{owner}/{repo}", r)).data.default_branch;
      return (await gh.request("GET /repos/{owner}/{repo}/branches/{branch}", { ...r, branch })).data.commit.sha;
    },

    // PBI 181: what decides the factory's merge. GitHub computes mergeable_state lazily, so a first read can say
    // `unknown`, which holds the merge until a later poll.
    async mergeView(repo, prNumber) {
      const gh = await client();
      const r = split(repo);
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: prNumber })).data;
      // ponytail: one page of 100 reviews, oldest first, as in prState; a PR with more would miss the newest ones.
      const reviews = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { ...r, pull_number: prNumber, per_page: 100 })).data as { state: string; user: { login: string } | null }[];
      // A reviewer's latest review that isn't a plain comment is the one that stands, as on GitHub.
      const latest = new Map<string, { login: string; state: string }>();
      for (const v of reviews) {
        if (!v.user || v.state === "COMMENTED" || v.state === "PENDING") continue;
        latest.set(v.user.login.toLowerCase(), { login: v.user.login, state: v.state });
      }
      return {
        mergeState: (pr.mergeable_state ?? "unknown") as MergeState, headSha: pr.head?.sha ?? null, body: pr.body ?? "",
        approvedBy: [...latest.values()].filter((v) => v.state === "APPROVED").map((v) => v.login),
      };
    },

    // GitHub answers a merge it refuses with 405 (not mergeable), 409 (the head moved) or 422, and its message says why.
    async mergePr(repo, prNumber, { method, headSha }) {
      const gh = await client();
      try {
        const res = (await gh.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          ...split(repo), pull_number: prNumber, merge_method: method, ...(headSha ? { sha: headSha } : {}),
        })).data as { merged: boolean; sha: string; message?: string };
        return res.merged ? { merged: true, sha: res.sha } : { merged: false, reason: res.message ?? "GitHub didn't merge the PR" };
      } catch (e) {
        const err = e as { status?: number; message?: string; response?: { data?: { message?: string } } };
        if (err.status !== 405 && err.status !== 409 && err.status !== 422) throw e;
        return { merged: false, reason: err.response?.data?.message ?? err.message ?? `GitHub answered ${err.status}` };
      }
    },

  };
}

/** What a cell may do on GitHub, on the token the control plane minted for its run. Checks come through the cell API. */
export function cellRepoHost(getToken: () => Promise<string>): PrMethods {
  return prMethods(async () => new Octokit({ auth: await getToken() }) as unknown as GitHubClient);
}
