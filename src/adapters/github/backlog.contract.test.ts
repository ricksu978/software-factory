// The shared backlog contract against real GitHub: a sandbox Project on the owner's personal account, with issues
// seeded in FACTORY_GH_REPO. It runs only with FACTORY_GH_CONTRACT=1, and closes every issue it created when done.
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { after, test } from "node:test";
import { backlogContract, OPT_IN_LABEL } from "../contract.ts";
import { githubBacklog, type FieldMap } from "./backlog.ts";
import type { GitHubClient } from "./repo-host.ts";

const NAMES = ["GITHUB_APP_ID", "GITHUB_APP_KEY", "GITHUB_PROJECT_TOKEN", "FACTORY_GH_INSTALLATION_ID", "FACTORY_GH_OWNER", "FACTORY_GH_PROJECT", "FACTORY_GH_REPO"] as const;

if (process.env.FACTORY_GH_CONTRACT !== "1") {
  test("backlog contract: github", { skip: "set FACTORY_GH_CONTRACT=1 and a sandbox Project to run it" }, () => {});
} else {
  const missing = NAMES.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`the GitHub contract run needs ${missing.join(", ")}`);
  const env = process.env as Record<(typeof NAMES)[number], string>;
  const fieldMap: FieldMap = {
    acceptanceCriteriaHeading: "Acceptance criteria", statusField: "Status", optInLabel: OPT_IN_LABEL, sprintField: null, readinessFields: [],
    statusFor: {} as FieldMap["statusFor"],
  };
  const app = new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_KEY });
  const installationId = Number(env.FACTORY_GH_INSTALLATION_ID);
  const board = new Octokit({ auth: env.GITHUB_PROJECT_TOKEN }) as unknown as GitHubClient;
  const [owner, repo] = env.FACTORY_GH_REPO.split("/");
  const created: number[] = [];
  const gh = async () => (await app.getInstallationOctokit(installationId)) as unknown as GitHubClient;
  let projectId: Promise<string> | undefined;
  const project = () =>
    (projectId ??= board
      .graphql<any>("query($login: String!, $n: Int!) { user(login: $login) { projectV2(number: $n) { id } } }", { login: env.FACTORY_GH_OWNER, n: Number(env.FACTORY_GH_PROJECT) })
      .then((r) => r.user.projectV2.id as string));

  after(async () => {
    const client = await gh();
    for (const n of created) await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: n, state: "closed", state_reason: "not_planned" });
  });

  backlogContract("github", async () => ({
    adapter: githubBacklog({
      app, installationId, owner: { type: "user", login: env.FACTORY_GH_OWNER }, projectToken: env.GITHUB_PROJECT_TOKEN,
      projectNumber: Number(env.FACTORY_GH_PROJECT), fieldMap,
    }),
    async seed(item) {
      const client = await gh();
      const issue = (await client.request("POST /repos/{owner}/{repo}/issues", {
        owner, repo, title: `[contract test] ${item.title ?? "backlog adapter"}`,
        body: item.body ?? "## Acceptance criteria\n\n- it works", labels: item.labels ?? [OPT_IN_LABEL],
      })).data;
      created.push(issue.number);
      if (item.closed) await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: issue.number, state: "closed" });
      await board.graphql("mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }", { p: await project(), c: issue.node_id });
      return String(issue.number);
    },
    async comments(externalId) {
      const list = (await (await gh()).request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: Number(externalId), per_page: 100 })).data as { body: string }[];
      return list.map((c) => c.body);
    },
  }));
}
