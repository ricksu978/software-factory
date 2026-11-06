// GitHub as a RepoHost. The control plane runs it on the App's installation token; a cell gets only the two methods
// it needs, on the short-lived token from /github-token (Run contract 6).
import { Octokit } from "@octokit/core";
import { matchesGlob } from "node:path";
import type { RepoHost, ReviewComment } from "../types.ts";

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

// A cell token can push code, open a PR and comment. With nothing on statuses or checks it can't mark its own PR
// green, which only the control plane's risk-approval check may do (spec §9). Without an explicit set, GitHub gives
// the token every permission the App holds.
export const CELL_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write" } as const;

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
};
const notFound = (e: unknown) => (e as { status?: number }).status === 404;

function prMethods(client: () => Promise<GitHubClient>): Pick<RepoHost, "openOrUpdatePr" | "requestReviewers"> {
  return {
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
      let wanted = fallback;
      if (rules) {
        // ponytail: one page of 100 files; a bigger PR asks owners of its first 100 files only.
        const files = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...r, pull_number: prNumber, per_page: 100 })).data as { filename: string }[];
        wanted = [...new Set(files.flatMap((f) => ownersOf(rules, f.filename)))];
      }
      const author = String(pr.user?.login ?? "").toLowerCase();
      const names = wanted.map((o) => o.replace(/^@/, "")).filter((o) => !o.includes("@") && o.toLowerCase() !== author);
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
  for (const { pattern, owners: o } of rules) if (globsFor(pattern).some((g) => matchesGlob(path, g))) owners = o;
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

async function checksOn(gh: GitHubClient, r: { owner: string; repo: string }, sha: string): Promise<"pending" | "success" | "failure"> {
  // ponytail: check runs only, one page of 100; commit statuses aren't read, since this repo's CI reports as check runs.
  const runs = (await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...r, ref: sha, per_page: 100 })).data.check_runs as { status: string; conclusion: string | null }[];
  if (runs.some((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? ""))) return "failure";
  if (runs.length === 0 || runs.some((c) => c.status !== "completed")) return "pending";
  return "success";
}

const THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved path line comments(first: 100) { nodes { author { login } body } } } } } } }`;

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

    async checksOnHead(repo, prNumber) {
      const gh = await client();
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...split(repo), pull_number: prNumber })).data;
      return checksOn(gh, split(repo), pr.head.sha);
    },

    async prState(repo, prNumber, trustedLogins) {
      const gh = await client();
      const r = split(repo);
      const pr = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...r, pull_number: prNumber })).data;
      // ponytail: one page of 100 reviews; a PR with more would miss the newest ones.
      const reviews = (await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { ...r, pull_number: prNumber, per_page: 100 })).data as { state: string; submitted_at: string | null; user: { login: string } | null }[];
      const trusted = new Set(trustedLogins.map((l) => l.toLowerCase()));
      const times = reviews.filter((v) => v.state === "CHANGES_REQUESTED" && v.submitted_at && trusted.has(String(v.user?.login).toLowerCase())).map((v) => v.submitted_at as string).sort();
      return {
        merged: Boolean(pr.merged), mergeSha: pr.merged ? pr.merge_commit_sha : null, open: pr.state === "open",
        mergeable: pr.mergeable ?? null, lastChangesRequestedAt: times.at(-1) ?? null,
      };
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

    async openReviewComments(repo, prNumber) {
      const r = split(repo);
      const res = await (await client()).graphql<any>(THREADS, { owner: r.owner, repo: r.repo, number: prNumber });
      const threads = res.repository.pullRequest.reviewThreads.nodes as { id: string; isResolved: boolean; path: string; line: number | null; comments: { nodes: { author: { login: string } | null; body: string }[] } }[];
      return threads.filter((t) => !t.isResolved).flatMap((t) =>
        t.comments.nodes.map((c): ReviewComment => ({ threadId: t.id, path: t.path, line: t.line, author: c.author?.login ?? "ghost", body: c.body })),
      );
    },
  };
}

/** What a cell may do on GitHub, on the token the control plane minted for its run. Checks come through the cell API. */
export function cellRepoHost(getToken: () => Promise<string>): Pick<RepoHost, "openOrUpdatePr" | "requestReviewers"> {
  return prMethods(async () => new Octokit({ auth: await getToken() }) as unknown as GitHubClient);
}
