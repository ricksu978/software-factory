# Software Factory Phase 0 Implementation Plan

> **For agentic workers.** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Build the Phase 0 walking skeleton from spec §13, in two stages. Phase 0a, Tasks 1 to 18, runs it on the owner's machine under Aspire. Phase 0b, Tasks 19 and 20, moves it to Azure. One personal GitHub repo, which is this repo, and one personal Project as its backlog, fixed WIP of 1, SOP stages 1 to 7 plus a thin stage 8 that addresses review feedback. A person merges and the item reaches Done once CI on main is green. The risk classifier runs in shadow mode, and the dashboard has Floor with its three strips, Run detail and five overrides: pause, drain, stop a run, hold an item and re-queue one.

**Architecture.** One TypeScript codebase with two entry points. The control plane runs the watcher, scheduler, dashboard and cell API in one process: a Node process under Aspire in Phase 0a, and a single always-on Container App in Phase 0b. A cell runs once per PBI, as a local Docker container in Phase 0a and a Container Apps job execution in Phase 0b, and drives the Claude Agent SDK through the SOP stages. Cells never touch Postgres. They talk to the control plane's cell API with a per-run token fenced by the lease generation. Postgres is the only state store, and every state change appends to the `event` table.

**Tech Stack.** Node 26.13.0 LTS running `.ts` files directly through type stripping, `node:test`, TypeScript 7.0.2 for type checks only, `pg` 8.23.1, `yaml` 2.9.1, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@octokit/app` 16.1.4, `@azure/identity` 4.14.1, `@azure/arm-appcontainers` 4.0.0, `@azure/storage-blob` 12.34.0, `@testcontainers/postgresql` 12.2.1, `@cucumber/cucumber` 13.3.0 for the Gherkin runner, `@types/node` 26.6.6 and `@types/pg` 8.23.1 for the type check, Bicep for infrastructure.

**Spec.** `docs/superpowers/specs/2026-11-05-software-factory-design.html`, as revised on this plan's branch with the 14 flow-review fixes. §13's Phase 0 row is the scope. §14 lists the settled decisions this plan does not reopen.

## Global Constraints

- Phase 0a runs locally. `aspire run` on `apphost.mts` starts:
  - Postgres;
  - the Azurite storage emulator;
  - a one-shot `migrate` resource;
  - the control plane as a Node process.

  Cells run as Docker containers that the control plane starts from `factory-cell:local`, built for the machine's own architecture and never pushed. GitHub can't reach the machine, so the poller does all intake. Sign-in is a dev identity that only `FACTORY_ENV=local` accepts. Postgres and Azurite keep their data in Aspire data volumes, so stopping `aspire run` loses nothing. Docker Desktop must be running.
- Phase 0b, in Azure: region australiaeast. Control plane is one Container App at 0.5 vCPU and 1 GiB with external ingress. Cells are a Container Apps job, manual trigger, 2 vCPU and 4 GiB per replica, retry limit at least 1.
- Azure images are `linux/amd64` and build in CI. No image built on the ARM64 dev machine is ever pushed. The local `factory-cell:local` image is the one native build, and it never leaves the machine.
- In Azure, Postgres is a Flexible Server, Burstable B1ms, with Microsoft Entra authentication through managed identities and no stored password.
- Transcripts go to Blob Storage, Hot LRS in Azure and Azurite locally, and `stage_run.transcript_ref` points at them. In Azure, container logs go to Log Analytics.
- Key Vault holds the GitHub App private key and the Claude OAuth token in Azure, and Aspire secret parameters hold them locally. Cells never hold the Claude token. Each gets a stand-in for its run and sends model calls to the control plane's model gateway, which swaps in the real token (issue #33). Cells never run with `--bare`.
- Model IDs live in the SOP file only: `coding: claude-opus-5-5`, `triage: claude-haiku-5-5`.
- Phase 0 dogfoods: the target repo is this repo, `ricksu978/software-factory`, owned by a personal account, and the backlog is a Project on that same account. The GitHub App, installed on the account, does all repo work. The board is reached with the owner's `gh` CLI OAuth token, because GitHub documents Project access by GitHub Apps only for organizations. That token is far broader than the board, which spec §9 records as the owner's decision. Board edits therefore show as the account owner, and board changes arrive only through the 5-minute poll, since `projects_v2_item` webhooks are organization-only. This is a Phase 0 exception to spec §9's one-bot-identity rule, decided 2026-11-06. An org-owned board can replace it later without code changes, through the adapter's `owner` setting.
- Eligibility label `factory`. Quality criteria live in the repo's policy files, per Run contract 11. A repo with no `.factory/dod.md` fails readiness for every item.
- Poll every 5 minutes, on top of webhooks in Phase 0b. Leases renew every 60 seconds and expire after 5 missed renewals. A cell stops itself after 3 minutes of failed renewals.
- `lease_generation` changes only as Run contract 2 says. A cell checks its generation before every push, comment and state write.
- NeedsInput and SignOff items get reminders at day 2 and day 4, and move to Abandoned after 5 days with no answer. An operator re-queue or a late answer brings an Abandoned item back.
- The scheduler starts nothing new while the waiting count (Run contract 3) reaches `review_capacity`, default 3, or while the last reported usage utilization is at or above `usage_reserve_at`, default 0.7.
- The factory owns board status. The project's built-in status workflows are off, factory PRs reference their item with `Refs #n`, and the factory closes the item at Done.
- Sign-off (`/approve`, `/changes <note>`) and answers (`/answer <text>`) are accepted in Run detail. In Phase 0b, once webhooks arrive, they are also accepted as item comments from GitHub logins mapped to allowlisted users.
- An override takes effect within 30 seconds. The kill switch stops every cell within a minute.
- Cell GitHub tokens are minted with explicit `permissions`: write on `contents`, `pull_requests` and `issues`, and nothing on `statuses` or `checks`.
- Phase 0 runs WIP fixed at 1, SOP stages 1 to 7, a thin stage 8, and the risk classifier in shadow mode. The thin stage 8 runs `pr-addresser` on requested changes and merge conflicts. Shadow mode records a tier on every PR and posts no `risk-approval` check.
- A merged item reaches Done once CI on main is green for the merge commit, so the target repo's CI runs its scenarios. `pr-reviewer`, stage 10's post-merge verification, stage 11, budget caps, Inbox, Cost view and quarantine belong to Phase 1.
- In Phase 0b, sign-in goes through Container Apps built-in auth with Microsoft (any Entra directory and personal accounts) and Google. Phase 0a uses the dev identity from Task 15. In both, the app's own `user` table decides access, and roles are viewer, operator and owner.
- A cell has no Docker daemon, so it skips what needs one. Test files that need Docker use `dbTest` from `src/store/test-db.ts`, which skips them when `FACTORY_DB_TESTS=skip`, and scenarios that need a database carry `@db`, which this repo's `bdd.run` filters out (Task 4). Only this repo's `.factory/dod.md` and `.factory/config.yml` set the variable or the `@db` filter. CI uses neither, so the database suites and scenarios still gate every PR through its checks (Run contract 6). Scenarios that need the owner's machine carry `@local`, which cells and CI both skip (Task 4).
- This repo is public, decided 2026-11-06. On the Free plan that's what makes branch protection and deployment environments with required reviewers available ([GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)). `main` takes changes only through a PR with one approving review and a green `lint` check, and refuses force pushes and deletions. Admins bypass every one of those rules, because `enforce_admins` is off and "the restrictions of a branch protection rule do not apply to people with admin permissions" by default ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). That lets the owner merge their own PRs, which GitHub won't let them approve. The factory's App holds no admin or bypass rights, so a cell's push token can't write to `main`. Task 1 adds its CI job to the required checks, and Task 19 adds the `production` environment.

## Review Focus

1. **Planted instructions in PBI text.** An item body that asks for secrets, CI changes or access outside the repo is flagged NotReady by the gate, and no cell token can post a status or check. Tests in Task 9 and Task 7.
2. **Zombie cell after lease expiry.** An old cell whose lease was re-claimed gets 409 on every cell API write, so it can't push, comment or move state. Test in Task 12.
3. **Duplicate or replayed webhook deliveries.** The same `X-GitHub-Delivery` id processed twice yields one event. A bad or missing signature yields 401 and no event. Tests in Task 7.
4. **Spoofed identity headers.** A request that carries `X-MS-CLIENT-PRINCIPAL` on an auth-excluded path never authenticates a dashboard action, and an unknown signed-in subject gets the no-access page. Tests in Task 15, plus a live check in Task 19.
5. **Control plane restart mid-run.** A fresh scheduler process sees the running cell's live lease and starts no second cell for that item. Test in Task 13.

## Run contract

These rules hold across every task. A task that touches one of them follows this section and does not restate it.

1. **Resume pointer.** `run.next_stage` names the stage the next cell runs, and the scheduler passes it to the cell as `RESUME_FROM`. These are its only writers:
   - `/stage` with `passed` sets it to the next stage in the pinned SOP;
   - a passed `specify` leaves it at `sign-off`, which no cell runs;
   - `decide` sets it to `red` on approve, and to `specify` on changes;
   - `changes_requested` sets it to `address`;
   - `requeued` sets it to `open-pr` when `prState` reports the run's PR closed without a merge, so `openOrUpdatePr` opens a fresh PR from the kept branch;
   - a new run starts it at `understand`.
2. **Leases and generations.** `lease_generation` goes up by 1 exactly twice in a lease's life: when a claim moves an item into InProgress, and when any transition moves an item out of InProgress. The second bump fences the old cell, so its next cell API call gets 409. Leaving InProgress also clears `lease_owner` and `lease_expires`. `expireLeases` looks only at InProgress items. No other transition touches the generation.
3. **Waiting on people.** The waiting count is the number of SignOff and NeedsInput items whose question is still unanswered, plus every InReview item. Answered and Abandoned items don't count. The brake gates only claims that start new work: a Queued item with no open run, or whose open run has no `stage_run` row yet. Every other claim resumes work already in flight and is never gated. That covers an answered SignOff or NeedsInput item, and a Queued item back from `changes_requested`, `lease_expired`, `usage_limited` or a late answer. So answering never deadlocks the line, and an address run never waits behind the brake.
4. **Item scope.** Specify tags every feature file it writes with `@pbi-<externalId>` at Feature level.
   - `redGate` and `traceability` consider only scenarios carrying that tag.
   - `greenGate` requires every scenario in the suite to be green, which keeps earlier items' scenarios as regression tests.
   - At sign-off, `run.locked_files` records the files carrying the tag, and `matchesLock` diffs only those files. So other items merged into the base never trip the lock.
5. **Cell context.** The cell's env holds only `RUN_ID`, `ITEM_ID`, `GENERATION`, `RUN_TOKEN`, `CONTROL_URL` and `RESUME_FROM`, plus the two model variables from `cellModelEnv` in `src/control/model-gateway.ts`. The scheduler passes the six. `ANTHROPIC_BASE_URL` points at the control plane's model gateway, `<CONTROL_URL>/internal/model`, and `CLAUDE_CODE_OAUTH_TOKEN` holds a stand-in, `sk-ant-oat01-<runId>.<generation>.<runToken>`, never the owner's token (issue #33). The gateway checks the stand-in the way the cell API checks a run token, so a leaked stand-in reaches only the gateway's allowlisted model paths and dies with the run's generation. In Azure the gateway is on public ingress, so until then it works from anywhere. Locally `dockerLauncher` also adds the egress variables from Task 13: the proxy variables in both cases, `NODE_USE_ENV_PROXY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `ENABLE_CLAUDEAI_MCP_SERVERS`. None of them carries a secret. Everything else comes from `GET /internal/cells/:runId/context`:
   - the item's external id, title and acceptance criteria;
   - `nextStage`;
   - the latest decision or answer, with its note;
   - `lockSha` and `lockedFiles`;
   - `prNumber`, `repo`, `base` and `branch`;
   - `configSha` and `sopVersion`;
   - `dodVerdicts`, the latest `dod.md` verdicts from `policy_result`, so a cell resumed at open-pr still gives the classifier the `person` lines, and `dodCheckedSha`, the commit they were checked at;
   - `trustedComments`, for an address run, under Run contract 10.
6. **CI status.** Only the control plane reads checks, with the App's own `RepoHost`. The cell reports its PR through `POST /pr` as soon as the PR exists. After every push, the cell asks about the exact commit it pushed with `GET /internal/cells/:runId/checks?sha=<sha>`. The control plane polls the checks on each sha it has been asked about, and on every merge commit. A sha with no checks reported 10 minutes after the control plane first saw it returns `none`. The engine treats `none` as `blocked`, with "no CI ran on the PR". Phase 0 requires CI on the target repo. Cell tokens keep the permissions in Global Constraints. The cell's own repo calls go through `cellRepoHost`, which opens PRs and requests reviewers with the token from `/github-token`.
7. **Branches and runs.** A run's branch is `factory/pbi-<externalId>-r<runNumber>`. These start a new run on a new branch from the base:
   - `criteria_changed`;
   - a re-queue of an item whose PR already merged.

   The previous PR, if still open, is closed with a comment that names the kept branch.
8. **Board mirroring.** One `onTransition(itemId, from, to, event)` hook runs after every committed transition.
   - It writes `fieldMap.statusFor[to]` through `setStatus`. A null entry leaves the board's status as it is.
   - It calls `claim` on every move into InProgress, which is idempotent, so a revived item gets its marker back. It calls `release` on reaching Done, Failed or Abandoned, and `linkPr` on `pr_opened`.
   - It closes the item at Done.
   - Whenever an item with an open PR reaches Abandoned, through `withdrawn` from any state, the PR is closed with a comment that names the kept branch.
9. **End-of-stage order.** A stage ends with these calls in this order: `/stage` with `passed`, then every `/upload-url` upload, then `/pr` when the stage opened a PR, and the `/transition` last. The transition is the call that raises the generation, so any call after it would get 409.
10. **Review triggers.** Requested changes count only when a changes-requested review was submitted after `run.reviews_seen_at`. Two writes set that column:
    - the first `pr_opened`;
    - the claim that starts an address run, set to that claim's time.

    A review left while address is running is newer than the claim, so the next poll still catches it once the item is back in InReview. The webhook compares the review's `submitted_at`, and the poll compares the newest such review from `prState`. GitHub's aggregate `reviewDecision` isn't used, because it can stay `CHANGES_REQUESTED` after the fix is pushed.

    **Trusted reviewers.** The repo is public, and "Anyone with read access can review and comment on proposed changes" ([GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)). So a review, and each review comment, counts only when its author's login is the `github_login` of an allowlisted user, the same rule item comments follow. Trust is per comment, because anyone can reply inside a thread a trusted reviewer opened. An untrusted review requeues nothing. `GET /context` gives an address run `trustedComments`, the comments in unresolved threads written by trusted authors or by the App's own bot user, with their thread, path, line and body. The bot's comments are the addresser's earlier replies. They came from a brief that held only trusted text, and without them a second round would see a reviewer's follow-up but not the reply it answers. The engine gives the addresser that list and nothing else from the PR, so an untrusted comment never reaches its brief.
11. **Policy files.** The factory hard-codes no quality criteria. Spec §6 "Policy files" defines five files: `dor.md`, `scenarios.md`, `pr-review.md`, `risk.md` and `dod.md`.
    - **Loading.** The factory reads them from the repo's `.factory/` at the run's pinned `config_sha`. Readiness has no run yet, so it reads the default branch head. A read that returns 404 means the file is absent. Any other read error throws, and the step retries on its next turn. A read error never falls back to a default.
    - **Defaults.** An absent file falls back to `$FACTORY_POLICY_DIR/<name>.md`, except `dod.md`, which has no default. A `Policy.sha` is the SHA-256 of its raw text, whether it came from the repo or a default, so a changed default counts as a policy change. Both images copy the factory's `policy/` folder to `/app/policy`, which is the default value of `FACTORY_POLICY_DIR`. A repo file replaces its default whole.
    - **Criteria.** Only `dor.md`, `pr-review.md` and `dod.md` have criteria, one per top-level `- [ ]` line, numbered from 1 in file order. The judge answers one JSON line per criterion: `{"index","status","reason"}`, where `status` is `passed`, `failed` or, in `dod.md` only, `person`. `person` means the line can only be met by a person or after merge, such as "deployed to staging". It goes to the PR checklist unticked and never counts as a fail. A missing index fails, and when an index appears twice, a fail wins. `scenarios.md` and `risk.md` are guidance, given whole to the agent that uses them.
    - **Commands.** A criterion holding `` `run: <command>` `` is allowed only in `dod.md`. `loadPolicy` rejects it in any other file with `PolicyError`. The cell runs `dod.md` commands at the end of green, in the checkout, as `execFile("sh", ["-c", command], { cwd, timeout: 900_000, env: { PATH, HOME, CI: "true", ...proxy } })`, where `proxy` is the four proxy variables when the cell has them (Run contract 5). Without them a command that needs the network, such as `npm ci`, fails locally. That env carries none of the cell's tokens. It isn't a sandbox, though: the command runs as the cell's own user, as `commands.test` does and as the agent does. So it has no more reach than the agent that wrote the code already has. The `bdd.*` and `commands.*` lines in `config.yml` run the same way, through `sh -c` in the checkout, so they may use shell syntax such as `VAR=value` and `$(...)`.
    - **Fresh DoD.** Self-review and address can push code after green, and CI may not run a `run:` line such as `run: npm run e2e`. So each `dod.md` verdict records the commit it was checked at, in `policy_result.checked_sha`. Open-pr, and address before it posts `pr_opened`, check `dod.md` again whenever `git.head()` differs from `ctx.dodCheckedSha`. A failed line found there sends open-pr back to green, counted against green's retries, and counts as a failed address attempt. The PR checklist names the commit its verdicts were checked at.
    - **Results.** Every result is stored in `policy_result`, with `source` set to `repo` or `default`. The control plane writes readiness rows itself, and the cell sends its rows through `POST /policy-results` (Task 12).
    - **Re-gating.** `readinessSha(texts)` (Task 9) is the SHA-256 over every file the readiness check reads: the five policy files and `.factory/config.yml`. Each file contributes its raw text as read, the default's text when the repo has none, or the word `absent` for a missing `dod.md` or `config.yml`. Raw text means a file that fails to load, such as a `pr-review.md` with a `run:` line, still counts, and fixing it changes the hash. `item.readiness_policy_sha` records the value from the item's last check. When it changes, because a team fixed any of those files or a deploy changed a default, the poller re-runs the gate on the item.
    - **Engine rules.** The rules no policy file can weaken are the list under "What stays in the engine" in spec §6. They live in code and prompts that the factory owns.

---

## File structure

```
package.json, tsconfig.json
aspire-apphost/apphost.mts         Aspire app host for Phase 0a, with aspire.config.json at the root
config/sources.yml                 the repos and boards migrate upserts
.factory/config.yml, dod.md, dor.md   this repo's own policy as a target
features/*.feature, features/steps/*.ts   Gherkin scenarios and step definitions
.github/workflows/ci.yml           typecheck, tests and scenarios on every push
.github/workflows/deploy.yml       amd64 images to ACR, bicep deploy
infra/main.bicep, infra/main.bicepparam
db/migrations/001_init.sql
src/core/states.ts                 state machine, pure
src/store/db.ts                    pool, migrate(), withTx()
src/store/items.ts                 transitions, leases, claim
src/store/runs.ts                  runs, stage_runs, questions
src/store/events.ts                appendEvent, LISTEN feed
src/store/overrides.ts             active overrides, kill flag
src/adapters/types.ts              BacklogAdapter, RepoHost, FactoryItem
src/adapters/contract.ts           shared contract suite
src/adapters/fake.ts               in-memory adapter
src/adapters/github/*.ts           GitHub App auth, backlog, repo host
src/watcher/webhook.ts, poller.ts
src/config/repo-config.ts, sop.ts
src/gate/readiness.ts
src/policy/policy.ts               load, default, parse and judge policy files (Run contract 11)
policy/dor.md, scenarios.md, pr-review.md, risk.md   the factory's defaults
src/bdd/messages.ts, lock.ts
src/risk/shadow.ts
src/agent/run.ts                   the only file that imports the Agent SDK
src/cell/engine.ts, api-client.ts, main.ts
src/control/cell-api.ts            /internal/cells/* routes
src/control/model-gateway.ts       the model gateway that keeps the Claude token out of cells (issue #33)
src/control/decisions.ts           decide(): sign-off and answers from both channels
src/scheduler/scheduler.ts, launcher.ts
src/http/server.ts, auth.ts, views.ts, routes.ts
src/main.ts                        control plane entry
sop/default.yml, sop/prompts/*.md
cell/Dockerfile, cell/claude/agents/factory-self-reviewer.md, cell/claude/agents/factory-pr-addresser.md
Dockerfile                         control plane image
spike/hello.ts, spike/sdk-oauth.ts, spike/db-probe.ts
docs/superpowers/spikes/2026-11-local-platform.md, 2026-11-phase-0-platform.md
```

Tests sit next to their code as `*.test.ts` and run with `node --test "src/**/*.test.ts"`.

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `.gitignore`, `src/core/smoke.test.ts`, `features/pbi-5-project-skeleton.feature`, `features/steps/pbi-5.steps.ts`, `.factory/config.yml`

**Interfaces:**
- Produces: `npm test` runs `node --test "src/**/*.test.ts"`. `npm run typecheck` runs `tsc --noEmit`. `npm run bdd` runs every feature file with cucumber-js and writes Cucumber Messages to `reports/bdd.ndjson`, the report Task 10 reads. Imports use explicit `.ts` extensions.

- [ ] **Step 1: Write `package.json`** with `"type": "module"`, `"engines": {"node": ">=26.13.0"}`, the exact versions from the Tech Stack line, and scripts `test`, `typecheck`, `bdd` (`cucumber-js --import "features/steps/**/*.ts" --format message:reports/bdd.ndjson`), `start:control` (`node src/main.ts`) and `start:cell` (`node src/cell/main.ts`).
- [ ] **Step 2: Write `tsconfig.json`** with `strict`, `noEmit`, `module: nodenext`, `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`. Erasable syntax means no `enum`, `namespace` or parameter properties anywhere in the codebase.
- [ ] **Step 3: Write one smoke test** `src/core/smoke.test.ts` that asserts `1 + 1 === 2`, then run `npm test`. Expected: 1 pass.
- [ ] **Step 4: Write the item's scenarios.** PBI 1's own feature file, `features/pbi-5-project-skeleton.feature`, holds one scenario per acceptance criterion, and `features/steps/pbi-5.steps.ts` defines their steps. One of them runs `npm run bdd` in a scratch copy of the project and checks its report, so no separate smoke scenario is needed. Run `npm run bdd`. Expected: every scenario passes, and `reports/bdd.ndjson` holds a `testCaseFinished` message for each. cucumber-js 13.3.0 loads the `.ts` step files through Node 26's type stripping with no loader.
- [ ] **Step 5: Run `npm run typecheck`.** Expected: exit 0.
- [ ] **Step 6: Write `.factory/config.yml`** in the shape Task 9's `parseRepoConfig` reads. `bdd.parse` is `npm run bdd -- --dry-run`, which writes the same report and doesn't fail on undefined steps ([cucumber-js](https://raw.githubusercontent.com/cucumber/cucumber-js/main/docs/dry_run.md)), `bdd.run` is `npm run bdd -- --tags "not @db and not @local"` (Task 4), `bdd.report` is `reports/bdd.ndjson`, `commands.test` is `FACTORY_DB_TESTS=skip npm test`, and `commands.lint` is the prose lint line from `.factory/dod.md`.
- [ ] **Step 7: Write `ci.yml`** to run on push and PR with `actions/setup-node` at `26.13.0`, `npm ci`, `npm run typecheck`, `npm test` and `npm run bdd -- --tags "not @local"` (Task 4). Docker must be available on the runner for Testcontainers, so use `ubuntu-latest`. Add `reports/` to `.gitignore`. Once `ci.yml` is on `main`, add its job to `main`'s required status checks beside `lint`.
- [ ] **Step 8: Commit** `chore: project skeleton with a Gherkin runner`.

---

### Task 2: Local platform on Aspire

Phase 0a runs the whole walking skeleton on the owner's machine before anything touches Azure. An Aspire AppHost starts every dependency, so `aspire run` brings up the factory. Azure comes in Task 19.

**Files:**
- Create: `aspire-apphost/apphost.mts` and the files `aspire init --language typescript` scaffolds with it (`aspire.config.json` at the root and the `aspire-apphost/` package), `cell/Dockerfile`, `Dockerfile`, `.dockerignore`, `spike/hello.ts`, `spike/sdk-oauth.ts`, `spike/db-probe.ts`, `docs/superpowers/spikes/2026-11-local-platform.md`, `features/pbi-6-local-platform.feature`, `features/steps/pbi-6.steps.ts`

**Interfaces:**
- Produces: the local resources below, which Tasks 4, 12, 13 and 15 run against, the three spike scripts, which Task 19 reuses in Azure, and the local spike record, which Tasks 6, 11 and 14 read before they start.

- [ ] **Step 1: Install Node 26.13.0 locally.** The plan pins Node 26, while the machine has v24.20.0 (`node --version`). Aspire's own prerequisite is "Node.js 20.19+, 22.13+, or 24+" ([aspire.dev](https://aspire.dev/get-started/prerequisites/)), so Node 26 meets both.
- [ ] **Step 2: Scaffold the AppHost.** Run `aspire init --language typescript --non-interactive --suppress-agent-init --skills none --skill-locations none` at the repo root. Aspire CLI 13.6.4 creates `aspire-apphost/apphost.mts` in its own npm package, writes `aspire.config.json` at the root, and adds `aspire:*` scripts to the root `package.json`. Then add the integrations with `aspire add Aspire.Hosting.PostgreSQL` and `aspire add azure-storage`. They generate the typed SDK under `aspire-apphost/.aspire/modules/`, which is gitignored and regenerated. The TypeScript AppHost keeps the repo in one language, and it carries every resource below.
- [ ] **Step 3: Declare the resources** in `apphost.mts`:
  - Postgres with a data volume and one database: `addPostgres("pg")`, then `withDataVolume()` on it, then `addDatabase("factory-db", { databaseName: "factory" })` ([aspire.dev](https://aspire.dev/integrations/databases/postgres/postgres-host/)). The volume is what keeps items, runs and events across restarts, because a container with the default session lifetime is disposed of when the AppHost stops ([aspire.dev](https://aspire.dev/app-host/resource-lifetimes/)).
  - The storage emulator with a data volume and blobs: `addAzureStorage("storage").runAsEmulator({ configureContainer: async (azurite) => { await azurite.withDataVolume(); } }).addBlobs("blobs")`, which runs Azurite ([aspire.dev](https://aspire.dev/integrations/cloud/azure/azure-storage-blobs/azure-storage-blobs-host/)).
  - Secret parameters: `claude-oauth-token`, `github-app-key`, `github-project-token`, `cell-secret` and `github-webhook-secret`, each `addParameter(name, { secret: true })`. Values come from user secrets or from environment variables named `Parameters__<name>` with each dash written as a single underscore, such as `Parameters__claude_oauth_token` ([aspire.dev](https://aspire.dev/fundamentals/external-parameters/)).
  - Plain parameters: `dev-login`, the owner's GitHub login; `github-app-id`; and `claude-token-created-at`, the date you ran `claude setup-token`.
  - A `migrate` Node resource, `addNodeApp("migrate", "..", "spike/db-probe.ts")`, that waits for the database with `waitFor`. Task 4 swaps in `src/store/migrate-cli.ts`. Aspire gives each Node app an installer resource that runs `npm install` in its folder. Both apps share the repo root, and two installs there at once fail with `EBUSY` on Windows, so `migrate` alone installs.
  - A `control` Node resource that runs after `migrate` exits, through `waitForCompletion(migrate)`, which the TypeScript AppHost documents as `await operator.waitForCompletion(podinfo);` ([aspire.dev](https://aspire.dev/llms-full.txt)). It has `withNpm({ install: false })`, and `withHttpEndpoint({ port: 7400, env: "PORT" })`, so the port cells use never moves ([aspire.dev](https://aspire.dev/app-host/typescript-apphost/)). It runs `spike/hello.ts` until Task 15 swaps in `src/main.ts`.
- [ ] **Step 4: Wire the environment.** Both `migrate` and `control` get:
  - `FACTORY_ENV=local` and `FACTORY_DEV_LOGIN` from `dev-login`, set only when `executionContext().isRunMode()` is true ([aspire.dev](https://aspire.dev/app-host/typescript-apphost/)), so nothing published from this AppHost carries them.
  - `FACTORY_DB_URI` from the database's `uriExpression()`, a `postgresql://` URI that `pg` reads. Passing the database resource itself would give a key-value connection string, which `pg` can't parse.

  `control` also gets:
  - `FACTORY_BLOB` from the blob resource's `ConnectionString`. For Azurite that string holds a `BlobEndpoint` on `localhost` ([aspire.dev](https://aspire.dev/integrations/cloud/azure/azure-storage-blobs/azure-storage-blobs-connect/)), on a port Aspire picks, which a cell container can't reach as written.
  - The five secrets as `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_KEY`, `GITHUB_PROJECT_TOKEN`, `CELL_SECRET` and `GITHUB_WEBHOOK_SECRET`, plus `GITHUB_APP_ID` and `CLAUDE_TOKEN_CREATED_AT`.
  - `FACTORY_POLICY_DIR=./policy`.
  - `CELL_IMAGE=factory-cell:local`.
  - `CELL_CONTROL_URL=http://host.docker.internal:7400` and `CELL_BLOB_HOST=host.docker.internal`, so cell containers reach the control plane and Azurite through Docker Desktop. `CELL_BLOB_HOST` names the host only, because Aspire maps Azurite to a port of its own choosing, which the connection string carries.
- [ ] **Step 5: Register the GitHub App and the project token.**
  - Register the factory GitHub App on the personal account. Repository permissions: write on contents, pull requests and issues, read on checks, commit statuses and metadata. No organization permissions. Leave its webhook inactive for now, because GitHub can't reach a local machine. Phase 0a runs on the 5-minute poll, and Task 19 turns the webhook on.
  - Register it through GitHub's App Manifest flow, since no API creates an App outright. A local page posts the manifest to `https://github.com/settings/apps/new`, and the owner presses Create. GitHub redirects to `localhost` with a code, and `gh api -X POST /app-manifests/{code}/conversions` returns the App id, private key and webhook secret ([GitHub](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)). Those go straight into the AppHost's user secrets, under the keys `Parameters:github-app-id`, `Parameters:github-app-key` and `Parameters:github-webhook-secret`.
  - Install the App on this repo only. Record the App id and the installation id.
  - Set `github-project-token` to the owner's `gh` CLI OAuth token, read with `gh auth token` and written straight into the user secrets. That's the owner's decision on 2026-11-06, in place of a `project`-only classic token. `gh` can't mint a narrower token, since "The minimum required scopes for the token are: `repo`, `read:org`, and `gist`" (`gh auth login --help`), so the control plane holds far more than board access, which spec §9 records. The token has no expiry, and neither a new `gh` login nor `gh auth logout` revokes it: "This command does not revoke authentication tokens" (`gh auth logout --help`). The only way to revoke the control plane's copy is to revoke the GitHub CLI's access in GitHub's settings, which signs out every `gh` session.
  - Run `claude setup-token` for the Claude token.
  - Set all five secret parameters and the three plain ones. Aspire prompts for any parameter left without a value: "If no value is found, the dashboard or CLI prompts for the value" ([aspire.dev](https://aspire.dev/fundamentals/external-parameters/)).
  - **Bot assignment probe.** Try to assign the App's bot user to an issue in this repo: `gh api repos/<o>/<r>/issues/<n>/assignees -f assignees[]=<app-slug>[bot]` with an installation token. Record whether GitHub accepts it. Task 6 reads the result.
- [ ] **Step 6: Write the spikes.**
  - `spike/db-probe.ts` connects with `FACTORY_DB_URI`, adds a row to a `probe_runs` table, prints the row count and exits 0. The count going up by one across a restart is what proves the data volume.
  - `spike/hello.ts` is a `node:http` server on `PORT` with these routes:
    - `GET /`, which returns every request header that starts with `x-ms-client-principal`;
    - `POST /webhooks/github`, which verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` and returns 204 or 401;
    - `POST /internal/cells/ping`, which returns 204;
    - `GET /probe/sas`, only when `FACTORY_ENV=local`, which returns a write-only SAS URL for a new blob signed from `FACTORY_BLOB`, with its host name swapped for `CELL_BLOB_HOST`. Task 12's `/upload-url` makes the same swap locally;
    - `GET /probe/env`, only locally, which returns the names of its environment variables and never their values;
    - `GET /probe/runs`, only locally, which returns the `probe_runs` count.
  - `spike/sdk-oauth.ts` calls `query({ prompt: "Reply with the word ready.", options: { model: "claude-haiku-5-5", maxTurns: 1, settingSources: [] } })` and prints each message's `type`, then the result's `subtype`, `is_error`, `total_cost_usd` and `modelUsage`. With the argument `sandbox` it runs the sandbox probe instead: `query()` with `sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains: ["api.github.com", "github.com", "registry.npmjs.org"], strictAllowlist: true } }`, asking it to run `curl -sI https://example.com` and then `curl -sI https://api.github.com`.
- [ ] **Step 7: Run it.** `aspire run`. Expected:
  - The Postgres and Azurite containers are healthy.
  - `migrate` exits 0.
  - `control` serves `spike/hello.ts` on port 7400.

  Stop and start `aspire run` once, and confirm `migrate` connects to the same database. Record in the spike file the exact env var names each resource received for the database and blobs, and whether the TypeScript AppHost carried every resource above.
- [ ] **Step 8: Cell container probes.** Write `cell/Dockerfile` on `node:26.13.0-bookworm` with `git`, `curl`, `bubblewrap` and `socat`. Build it for this machine's own architecture: `docker build -f cell/Dockerfile -t factory-cell:local .`. That image stays local and is never pushed. Then, from inside a `factory-cell:local` container:
  - `curl -fsS -X POST $CELL_CONTROL_URL/internal/cells/ping`. Expected: 204.
  - Fetch `/probe/sas` from the control plane, then `curl -fsS -X PUT -H "x-ms-blob-type: BlockBlob" --data hi "<url>"`. Expected: 201. A SAS signature covers the account, container and blob, and not the host, so the swapped host should still verify. That's an inference this probe checks.
  - `spike/sdk-oauth.ts` with `CLAUDE_CODE_OAUTH_TOKEN` passed as `-e CLAUDE_CODE_OAUTH_TOKEN`. Expected: `subtype: "success"`. If the SDK refuses the token, run `claude -p "Reply with the word ready." --output-format json` in the same image, which §14 names as the fallback, and record which one works.
  - `spike/sdk-oauth.ts sandbox`. Expected: example.com blocked, api.github.com allowed. If the result is `error_during_execution` because bubblewrap can't start under Docker Desktop, record that. The egress allowlist then needs another mechanism, and locally the owner chose Task 13's egress proxy. A direct `bwrap --ro-bind / / --dev /dev true` in the container already fails with "Creating new namespace failed: Operation not permitted", under the default `docker run` and with `--security-opt seccomp=unconfined` too.
- [ ] **Step 9: Record and commit.** Write each probe's expected and actual result to `docs/superpowers/spikes/2026-11-local-platform.md`, then commit `chore: local platform on Aspire`.

---

### Task 3: State machine

**Files:**
- Create: `src/core/states.ts`, `src/core/states.test.ts`

**Interfaces:**
- Produces:
  - `type ItemState = "Eligible" | "NotReady" | "Queued" | "InProgress" | "SignOff" | "NeedsInput" | "InReview" | "Accepted" | "Done" | "Failed" | "Abandoned"`
  - `type ItemEvent = "readiness_failed" | "item_edited" | "ready" | "claimed" | "scenarios_written" | "blocked" | "pr_opened" | "changes_requested" | "merged" | "approvals_met" | "dod_verified" | "dod_failed" | "retries_exhausted" | "timed_out" | "lease_expired" | "usage_limited" | "policy_changed" | "requeued" | "reopened_signoff" | "reopened_question" | "criteria_changed" | "withdrawn"`. `approvals_met` is reserved for Phase 1. In Phase 0 a person's merge is `merged`.
  - `function next(from: ItemState, event: ItemEvent): ItemState | null`, which returns null for an edge the diagram doesn't draw.
  - `function overrideTo(from: ItemState, to: ItemState): ItemState`, which always succeeds. The caller logs it as an override event.

- [ ] **Step 1: Write the failing table test.** It asserts every edge in the spec §5 diagram, plus the withdrawal and criteria-change moves that §5's "Backlog changes" bullet describes in prose:

```ts
const edges: [ItemState, ItemEvent, ItemState][] = [
  ["Eligible", "readiness_failed", "NotReady"], ["NotReady", "item_edited", "Eligible"],
  ["NotReady", "policy_changed", "Eligible"],
  ["Eligible", "ready", "Queued"], ["Queued", "claimed", "InProgress"],
  ["SignOff", "claimed", "InProgress"], ["NeedsInput", "claimed", "InProgress"],
  ["InProgress", "scenarios_written", "SignOff"], ["InProgress", "blocked", "NeedsInput"],
  ["InProgress", "pr_opened", "InReview"], ["InReview", "changes_requested", "Queued"],
  ["InReview", "merged", "Accepted"], ["InProgress", "merged", "Accepted"],
  ["InReview", "approvals_met", "Accepted"], ["Accepted", "dod_verified", "Done"],
  ["Accepted", "dod_failed", "Failed"], ["InProgress", "retries_exhausted", "Failed"],
  ["NeedsInput", "timed_out", "Abandoned"], ["SignOff", "timed_out", "Abandoned"],
  ["InProgress", "lease_expired", "Queued"], ["InProgress", "usage_limited", "Queued"],
  ["Failed", "requeued", "Queued"], ["Abandoned", "requeued", "Queued"],
  ["Abandoned", "reopened_signoff", "SignOff"], ["Abandoned", "reopened_question", "NeedsInput"],
  ...(["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"] as const).flatMap((s) => [
    [s, "withdrawn", "Abandoned"], [s, "criteria_changed", "Queued"]] as [ItemState, ItemEvent, ItemState][]),
];
for (const [from, ev, to] of edges) test(`${from} --${ev}--> ${to}`, () => assert.equal(next(from, ev), to));
test("undrawn edge is null", () => assert.equal(next("Done", "claimed"), null));
test("answer alone does not move state", () => assert.equal(next("NeedsInput", "ready"), null));
```

  Every move that needs a cell again goes to Queued, or to a waiting state, and then through `claimed`, because the item holds no slot until it's claimed. That covers `changes_requested`, `criteria_changed` and `usage_limited`. `criteria_changed` starts a new run, per Run contract 7. The spec draws "SignOff to InProgress" and "NeedsInput to InProgress" directly. Here both go through `claimed`, and the answer itself is recorded on the `question` row. `reopened_signoff` and `reopened_question` return a re-queued Abandoned item to waiting when its question is still open.
- [ ] **Step 2: Run `node --test src/core/states.test.ts`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `next` and `overrideTo`** in `src/core/states.ts` as a lookup table keyed `` `${from}:${event}` ``.
- [ ] **Step 4: Run the test.** Expected: every case passes.
- [ ] **Step 5: Commit** `feat(core): PBI state machine`.

---

### Task 4: Schema and store basics

**Files:**
- Modify: `aspire-apphost/apphost.mts`, so `migrate` runs `src/store/migrate-cli.ts` in place of `spike/db-probe.ts`. In local mode `migrate-cli.ts` still adds a `probe_runs` row, so PBI 2's restart scenario keeps passing.
- Create: `db/migrations/001_init.sql`, `src/store/db.ts`, `src/store/items.ts`, `src/store/events.ts`, `src/store/runs.ts`, `src/store/migrate-cli.ts`, `src/store/test-db.ts`, `src/store/items.test.ts`. `migrate-cli.ts` is the migrate entry point, for the `migrate` resource locally and the migrate job in Azure. It runs `migrate()`, then upserts one `repo` row and one `backlog_source` row for each entry in the YAML file at `FACTORY_SOURCES`, default `config/sources.yml`, and skips that step when the file is absent. Each entry names `repo`, `installationId`, `owner`, `projectNumber` and `fieldMap`, so a fresh database knows its board without a manual insert. When `FACTORY_APP_PRINCIPAL` is set, which only the Azure migrate job does, it makes that Entra principal a member of `factory_app` (Task 19). When `FACTORY_ENV=local` it also upserts the dev owner from `FACTORY_DEV_LOGIN`, with provider `dev`, the owner role, `product_owner` and `github_login` set to the same login, so the local dashboard works after every start and the owner's own PR reviews count under Run contract 10. When its first argument is the word `seed-owner`, it hands the remaining `key=value` words to `scripts/seed-owner.ts` from Task 15. Arguments carry no leading dashes, because `az containerapp job start --args` reads any dash-prefixed word as one of its own options. It exits 1 on any word it doesn't recognise, so a mistyped seed never passes as a plain migration.

**Interfaces:**
- Consumes: `next`, `ItemState`, `ItemEvent` from Task 3.
- Produces:
  - `createPool(url?: string): pg.Pool`. Locally the caller passes `FACTORY_DB_URI` from Aspire. Without a URL it connects as the managed identity, using an Entra token from `@azure/identity` `DefaultAzureCredential` with scope `https://ossrdbms-aad.database.windows.net/.default`. That path reads `PGHOST`, `PGUSER` (the identity's Postgres principal name) and `PGDATABASE`, and `DefaultAzureCredential` needs `AZURE_CLIENT_ID` to pick the user-assigned identity. Task 19 sets all four, on the control app and on the migrate job, each for its own identity.
  - `migrate(pool): Promise<void>`, which applies `db/migrations/*.sql` in name order and tracks them in `schema_migrations`.
  - `withTx<T>(pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>`, plus `runAfterCommit(c, fn)`, which queues work that runs only once that transaction commits, after the connection is back in the pool, and is dropped on rollback. A failing job is logged and never turns the committed transaction into an error. `runAfterCommit` throws outside `withTx`. `transitionItem` uses it for `onTransition` hooks, and refuses to run outside `withTx` before any write, because its row lock and its atomicity depend on that transaction.
  - `appendEvent(c, e: { actor: "agent" | "human" | "system"; actorId: string; itemId: string | null; kind: string; payload: unknown }): Promise<void>`. It also runs `NOTIFY factory_events`.
  - `transitionItem(c, itemId: string, event: ItemEvent, actor: Actor, detail?: Record<string, unknown>): Promise<ItemState>`. It throws `IllegalTransition` when `next` returns null. It writes `item.state` and the event row in one transaction, and applies Run contract 2 to the lease columns. `detail` adds fields to the event's payload, such as the attempts Task 12 records on `retries_exhausted`.
  - `onTransition(hook: (itemId: string, from: ItemState, to: ItemState, event: ItemEvent) => Promise<void>): () => void` registers the hook that runs after each committed transition, and returns the call that removes it, so a test can drop its hook. Task 12 registers the board mirroring from Run contract 8.
  - `upsertItem(c, item: { sourceId; externalId; title }): Promise<string>`, keyed on `(source_id, external_id)`, which inserts a new item as Eligible. Task 6 widens the input to `FactoryItem`, which doesn't exist before it.
  - `startTestDb(): Promise<{ pool: pg.Pool; url: string; stop(): Promise<void> }>`, which uses `@testcontainers/postgresql` with image `postgres:17` and runs `migrate`.
  - `dbTest`, the options object every `describe` that calls `startTestDb` passes: `{ skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" }`.
  - A scenario whose steps need a database is tagged `@db`. This repo's `bdd.run` passes `--tags "not @db and not @local"`, so a cell never runs it, and CI runs every scenario except `@local` ones.
  - A scenario that needs Docker, the Aspire CLI and the owner's secrets is tagged `@local`, such as PBI 2's `aspire run` scenarios. Neither a cell nor CI can run it, so only the owner's machine does. The owner runs every `@local` scenario, and the PR records that run, whenever a PR adds or changes one or touches `aspire-apphost/`, `spike/`, `cell/`, `Dockerfile`, `src/main.ts` or `src/store/migrate-cli.ts`, which they exercise. An item with an `@local` scenario of its own fails Red in a cell for the same reason as below, so the owner builds it by hand. `greenGate` reads the cell's report, so it needs every scenario the cell ran to be green, and the `@db` ones gate the PR through CI's checks. An item with any `@db` scenario of its own fails Red with "not run in the cell" (Task 10), so it waits for PBI 22, which gives cells a test database. Red proof never skips a scenario.

- [ ] **Step 1: Write `001_init.sql`** with the §12 tables Phase 0 uses: `backlog_source`, `repo`, `user`, `item`, `run`, `stage_run`, `event`, `question`, `override`, `wip_policy` and `policy_result`. Use the merged spec's columns, plus these Phase 0 columns:
  - `item.held boolean default false`, for the hold override.
  - `item.priority int default 0`, for factory queue order.
  - `user.product_owner boolean default false`. Only product owners sign off scenarios.
  - `user.github_login text unique`, which maps item comments to a user.
  - `item.criteria_hash text`, the SHA-256 of the acceptance criteria the run started from.
  - `question.reminders_sent int default 0`, and `question.closed_at timestamptz`, set when a question closes without an answer, such as on `criteria_changed`. A question is open while both `answer` and `closed_at` are null.
  - `item.backlog_rank numeric`, so the scheduler orders by rank as a number, not as text.
  - `wip_policy.usage_reserve_at numeric default 0.7` and `wip_policy.usage_paused_until timestamptz`.
  - `run.next_stage text`, the resume pointer from Run contract 1.
  - `run.run_number int`, counting runs per item, for the branch name in Run contract 7.
  - `run.scenarios_sha text` and `run.locked_files text[]`, written when Specify posts scenarios. `decide` copies `scenarios_sha` into `features_lock_sha` on approve.
  - `run.pr_number int`, `run.reviews_seen_at timestamptz` (Run contract 10) and `run.merge_sha text`.
  - `run.resume_at timestamptz`, for usage-limit stalls.
  - `run.execution_name text`, the Container Apps execution.
  - `stage_run.report_ref text`, the BDD report a red or green stage uploaded.
  - `webhook_delivery(id text primary key, received_at timestamptz)`, for dedupe.
  - `backlog_source.owner_type`, `owner_login`, `project_number` and a unique `url`, and `repo.installation_id` with a unique `url`, which `migrate-cli.ts` upserts from the sources file. `backlog_source.cursor` holds Task 8's poll cursor.
  - `wip_policy` starts with one row, `mode = 'fixed'` and `current_wip = 1`, which Task 13 reads.
  - `item.readiness_policy_sha text`, for the re-gate in Run contract 11.

  Skip `increment` and `approval`, which belong to Phase 1. The migration also creates role `factory_app` with the grants Task 19 names. Locally the control plane connects as Aspire's database user, so the append-only grant is enforced only in Azure. The test below checks the grant itself. Its `event` grant is `SELECT, INSERT` only.
- [ ] **Step 2: Write failing tests** in `items.test.ts` against `startTestDb()`:
  - `transitionItem` moves Eligible to Queued on `ready` and writes exactly one event with `kind = "transition"` and `payload = { from: "Eligible", to: "Queued", event: "ready" }`.
  - `transitionItem` on `Done` with `claimed` throws `IllegalTransition`, and both the item and the event table are unchanged.
  - `upsertItem` called twice with the same `(source_id, external_id)` returns the same id.
  - **Generations.** A transition out of InProgress raises `lease_generation` by 1 and clears `lease_owner` and `lease_expires`. A transition between two non-InProgress states leaves all three untouched.
  - **Append-only.** Connected as `factory_app`, an `UPDATE event` fails with a permission error.
  - **Migrate entry point.** Running `migrate-cli.ts` twice with `FACTORY_ENV=local`, `FACTORY_DEV_LOGIN=octo` and a sources file with one entry leaves one `repo` row, one `backlog_source` row and one owner `octo` with `product_owner` and `github_login = 'octo'`. Without `FACTORY_ENV`, it seeds no user.
- [ ] **Step 3: Run `node --test src/store/items.test.ts`.** Expected: FAIL.
- [ ] **Step 4: Implement** `db.ts`, `events.ts`, the item functions in `items.ts`, and the empty `runs.ts` exports used later.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(store): schema, transitions and event log`.

---

### Task 5: Leases and claiming

**Files:**
- Create: `db/migrations/002_item_blocked_by.sql`, which adds `item.blocked_by text[] not null default '{}'`, the item's open dependencies by external id. Task 8's poller fills it.
- Modify: `src/store/items.ts`
- Test: `src/store/leases.test.ts`

**Interfaces:**
- Produces:
  - `claimNext(c, owner: string, now: Date): Promise<{ itemId: string; runId: string; generation: number } | null>`
  - `renewLease(c, itemId: string, generation: number, now: Date): Promise<"ok" | "lost">`
  - `expireLeases(c, now: Date): Promise<string[]>`, which returns the items it sent back to Queued.
  - `releaseLease(c, itemId: string, generation: number): Promise<void>`
  - Constants `LEASE_RENEW_MS = 60_000` and `LEASE_EXPIRY_MS = 300_000`.

- [ ] **Step 1: Write failing tests:**
  - **Claim order.** `claimNext` picks a SignOff or NeedsInput item whose `question` has an answer before any Queued item. Among Queued items it picks highest `priority`, then lowest `backlog_rank`. It skips `held` items and items with an open dependency, which is any item whose `blocked_by` isn't empty. An answered item with a newer open question isn't claimable. It moves the claimed item to InProgress through `transitionItem(..., "claimed")`.
  - **Generations.** Each claim sets `lease_generation` to the previous value plus 1, and `lease_expires = now + 300s`. That is the claim half of Run contract 2.
  - **Renewal.** `renewLease` with the current generation returns `"ok"` and pushes `lease_expires` out. With an older generation it returns `"lost"` and changes nothing.
  - **Expiry.** `expireLeases(now + 301s)` returns the item, moves it to Queued through `lease_expired`, and leaves `run.next_stage` unchanged, so a new cell resumes there. An expired `lease_expires` on an item that isn't InProgress is ignored.
  - **Concurrency.** Two concurrent `claimNext` calls with one Queued item return one claim and one null. Use `SELECT ... FOR UPDATE SKIP LOCKED`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the four functions. A claim of an item with no open run creates a `run` row at `understand`, numbered one above the item's last run. A claim of an item with an open run reuses it, and when that run's `next_stage` is `address`, it sets `run.reviews_seen_at` to the claim's time (Run contract 10). `renewLease` also needs the item to be InProgress. `releaseLease` clears `lease_owner` and `lease_expires` for the current generation and leaves the generation alone. It skips an InProgress item, because one with no `lease_expires` would never expire and never be claimed again. Every exit from InProgress already clears the lease through `transitionItem` (Run contract 2), so no row the factory writes needs `releaseLease`, and Task 12 doesn't call it. The scheduler fills `sop_version`, `config_sha` and `repo_id` right after the claim, in Task 13.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(store): leases with generation fencing`.

---

### Task 6: Adapter interfaces, fake and contract suite

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/fake.ts`, `src/adapters/contract.ts`, `src/adapters/fake.test.ts`

**Interfaces:**
- Produces, in `types.ts`:

```ts
export type FactoryItem = { sourceId: string; externalId: string; title: string; body: string;
  acceptanceCriteria: string[]; labels: string[]; status: string; rank: number;
  repo: string | null; fields: Record<string, string>; closed: boolean; updatedAt: string };
// fields holds the values of FieldMap.readinessFields, such as { Size: "8" }
export type FactoryWebhookEvent =
  | { kind: "item_changed"; externalId: string } | { kind: "pr_merged"; prNumber: number; repo: string; mergeSha: string }
  | { kind: "pr_closed"; prNumber: number; repo: string } | { kind: "checks_completed"; sha: string; repo: string }
  | { kind: "comment"; externalId: string; login: string; body: string; commentId: string }
  | { kind: "review"; prNumber: number; repo: string; state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string }
  | { kind: "ignored" };
export interface BacklogAdapter {
  capabilities: { webhooks: boolean };
  listEligible(cursor: string | null): Promise<{ items: FactoryItem[]; cursor: string }>;
  getItem(externalId: string): Promise<FactoryItem | null>;
  openDependencies(externalId: string): Promise<string[]>;
  claim(externalId: string): Promise<void>; release(externalId: string): Promise<void>;
  comment(externalId: string, body: string, dedupeKey: string): Promise<void>;
  setStatus(externalId: string, status: string): Promise<void>;
  linkPr(externalId: string, prUrl: string): Promise<void>;
  close(externalId: string): Promise<void>;
  parseWebhook(headers: Record<string, string>, body: unknown): FactoryWebhookEvent;
}
export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure" | "none">; // "none": no check has reported on the sha at all
  onBranch(repo: string, branch: string, sha: string): Promise<boolean>; // the branch head or one of its ancestors (Task 12)
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>; // CODEOWNERS first
  prState(repo: string, prNumber: number, trustedLogins: string[]): Promise<{ merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; lastChangesRequestedAt: string | null }>;
  closePr(repo: string, prNumber: number, comment: string): Promise<void>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  defaultBranchSha(repo: string): Promise<string>;
  openReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]>; // every comment in the PR's unresolved review threads
}
export type ReviewComment = { threadId: string; path: string; line: number | null; author: string; body: string };
```

  `contract.ts` exports `backlogContract(name: string, make: () => Promise<ContractTarget>)`, where `ContractTarget` is `{ adapter: BacklogAdapter; seed(item: Partial<FactoryItem>): Promise<string>; comments(externalId: string): Promise<string[]> }`. `BacklogAdapter` has no method that lists comments, so `comments` is how the dedupe case reads them, and Task 7's GitHub `make` reads the issue's comments. It registers `node:test` cases under the names the PBI 6 scenarios check, so a renamed or missing case fails the scenario. It also exports `OPT_IN_LABEL = "factory"` and `CLAIM_MARKER = "factory:in-progress"`.

- [ ] **Step 1: Write the contract suite.** Each case runs against the adapter that `make` returns:
  - `listEligible` returns only open items carrying the opt-in label. A closed item, such as one the factory closed at Done, never comes back as new work.
  - Calling `comment` twice with the same `dedupeKey` leaves one comment, which is the spec §10 idempotency rule.
  - `claim` followed by `getItem` shows the factory's in-progress marker, and `release` clears it.
  - `setStatus("Done")` round-trips through `getItem().status`.
  - `parseWebhook` on an unknown payload returns `{ kind: "ignored" }` and never throws.
  - `close` followed by `getItem` shows `closed: true`.
- [ ] **Step 2: Write `fake.test.ts`**, which calls `backlogContract("fake", ...)`. Run it. Expected: FAIL.
- [ ] **Step 3: Implement `fake.ts`** as an in-memory map. `fakeBacklog()` returns a `ContractTarget`, so `fake.test.ts` passes it straight to `backlogContract`. Its cursor is a change counter, so a `listEligible` from the returned cursor sees only items changed since. Its `openDependencies` returns an empty list, and Task 8 adds a way to seed dependencies when its tests need one. It also exports `fakeRepoHost()`, an in-memory `RepoHost` holding PRs, checks, files and review comments, which the tests in Tasks 7 to 17 use. Tests set its state directly: `prs`, `checks` by `repo@sha`, `files` by `repo@ref:path`, `heads` by repo and `reviewComments` by `repo#number`. A review comment marked `resolved: true` sits in a resolved thread, so `openReviewComments` leaves it out, which is the case Task 7 asserts. The backlog stores deep copies, so a test's input and the items it reads back never share arrays with the fake's state. The claim marker is a `factory:in-progress` label. The bot assignment probe in Task 2 Step 5 decides whether the GitHub adapter also assigns the App.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(adapters): interfaces, fake adapter, contract suite`.

---

### Task 7: GitHub adapters and webhook intake

**Files:**
- Create: `src/adapters/github/backlog.ts`, `src/adapters/github/backlog.test.ts`, `src/adapters/github/repo-host.ts`, `src/adapters/github/repo-host.test.ts`, `src/adapters/github/backlog.contract.test.ts`, `src/watcher/webhook.ts`, `src/watcher/webhook.test.ts`. Callers build the App with `new App({ appId, privateKey })` from `@octokit/app`, so there's no wrapper module.

**Interfaces:**
- Consumes: `BacklogAdapter`, `RepoHost` and `backlogContract` from Task 6, and `appendEvent` from Task 4.
- Produces:
  - `githubBacklog(cfg: { app: App; installationId: number; owner: { type: "user" | "org"; login: string }; projectToken: string | null; projectNumber: number; fieldMap: FieldMap }): BacklogAdapter`, with `capabilities.webhooks = true`. It resolves the project's node id once, through GraphQL `user(login:)` or `organization(login:)` and `projectV2(number:)`, so `config/sources.yml` holds only the number the board's URL shows.
    - **Events.** Issue, PR, check and dependency events come from the App webhook. Project item changes come only through the 5-minute poll. A user-owned project has no `projects_v2_item` webhook, and an organization's names an item node rather than an issue number, so `parseWebhook` maps it to `ignored` and the next poll picks the change up.
    - **Tokens.** Board reads and writes use `projectToken` when `owner.type` is `user`, and the App's installation token when it's `org`. Issue comments, labels and closing go through the App in both cases.
    - **Test.** A user-owned config with a null `projectToken` throws at construction, naming the missing secret.
  - `githubRepoHost(app: App, installationId: number): RepoHost`, used only in the control plane, which holds the App key.
    - **`onBranch`.** `GET /repos/{o}/{r}/compare/{sha}...{branch}` answers `status: "ahead"` when the branch contains the sha and `"identical"` at its head, and `"diverged"` or `"behind"` otherwise, so only the first two are true. The probe on this repo: `compare/5d86133...main` gave `ahead` and `compare/9a850c6...main`, a commit only on a factory branch, gave `diverged`.
    - **`checksOnSha` and `none`.** `none` means `GET .../commits/{sha}/check-runs` and `GET .../commits/{sha}/status` both report `total_count: 0`. A `githubRepoHost` that never returns `none` leaves the cell API answering `pending` for good, instead of `none` after 10 minutes.
  - `cellRepoHost(getToken: () => Promise<string>): Pick<RepoHost, "openOrUpdatePr" | "requestReviewers">`, used in the cell with the token from `/github-token`. Checks reach the cell only through the cell API, per Run contract 6.
  - `verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean`
  - `handleWebhook(deps: { pool; secret: string; parse: BacklogAdapter["parseWebhook"] }, req: { headers; rawBody: Buffer }): Promise<{ status: 204 | 401 | 200 | 400 }>`. A bad signature, or an empty secret, gets 401 with nothing written. A signed body with no delivery id or no JSON gets 400. Otherwise the delivery id and one event of kind `webhook`, with payload `{ deliveryId, githubEvent, event }` where `event` is `parse`'s `FactoryWebhookEvent`, go in one transaction: 204 the first time, 200 and no event for a redelivery.
  - A `comment` dedupe marker counts only in a comment by a bot user, so a person can't post a guessable key first and suppress the factory's comment.
- `FieldMap` mirrors the spec: `{ acceptanceCriteriaHeading: string; statusField: string; statusFor: Record<ItemState, string | null>; optInLabel: string; sprintField: string | null; readinessFields: string[] }`. `readinessFields` names board fields, such as Size, that the readiness check passes to the judge, so `dor.md` can refer to them. `statusFor` names the board status for each factory state, and a null entry leaves the board alone. For example, Queued maps to "Todo", InProgress, SignOff and NeedsInput map to "In Progress", InReview maps to "In Review", Done maps to "Done", and Eligible maps to null.

- [ ] **Step 1: Write failing tests:**
  - `verifySignature` returns true for `sha256=` plus the HMAC-SHA256 hex digest of the body. It returns false for a one-character change, a missing header and a `sha1=` header.
  - Calling `handleWebhook` twice with the same `X-GitHub-Delivery` stores one `webhook_delivery` row and one event. The second call returns 200 with no event.
  - `handleWebhook` with a bad signature returns 401 and writes nothing.
  - `cellToken` sends `permissions: { contents: "write", pull_requests: "write", issues: "write" }` and `repositories: [repo]`, and the body has no `statuses` or `checks` key. Assert this against a stubbed `app.octokit.request`.
  - `parseWebhook` maps an `issue_comment` with action `created` to `{ kind: "comment" }`, and a `pull_request_review` with action `submitted` to `{ kind: "review" }` with the review's state lowercased and its author's login. A comment or review by any bot user, the App's own included, maps to `ignored`, so the factory never reacts to its own posts.
  - `requestReviewers` returns the CODEOWNERS owners of the changed files when the repo has a CODEOWNERS file, and `fallback` when it has none or names nobody but the PR author.
  - `prState` reports `lastChangesRequestedAt` as the `submitted_at` of the newest review in state `CHANGES_REQUESTED` whose author is in `trustedLogins`, and null when there is none. A newer `CHANGES_REQUESTED` review from a login outside the list leaves it unchanged (Run contract 10). That is the poller's backstop for a missed review webhook, under Run contract 10.
  - `openReviewComments` returns every comment, with its author, from the PR's unresolved review threads, and none from resolved ones. Assert this against a stubbed GraphQL `reviewThreads` reply that has one resolved and one unresolved thread. `fakeRepoHost` from Task 6 passes the same case. The control plane uses it to build `/context`'s `trustedComments` (Task 12).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `verifySignature` uses `crypto.createHmac` and `crypto.timingSafeEqual` after a length check.
  - The backlog adapter reads Project v2 items through GraphQL `node(id:) { ... on ProjectV2 { items } }`.
  - Acceptance criteria come from the list under the `acceptanceCriteriaHeading` heading in the issue body.
  - Dependencies come from `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by`, filtered to open issues.
  - `comment` stores the `dedupeKey` as an HTML comment, `<!-- factory:KEY -->`, and checks for it before posting.
- [ ] **Step 4: Run the unit tests.** Expected: PASS.
- [ ] **Step 5: Run the contract suite against GitHub.** `backlog.contract.test.ts` calls `backlogContract("github", ...)` against a sandbox Project on your personal account, using `github-project-token`, and only when `FACTORY_GH_CONTRACT=1` is set. It seeds issues in `FACTORY_GH_REPO`, a sandbox repo the App is installed on, `ricksu978/factory-sandbox`. It refuses a repo with a `.factory/config.yml`, because the live board auto-adds this repo's `factory` issues, and a poller could take test issues as real work. Run it with that variable. Expected: every contract case passes.
- [ ] **Step 6: Commit** `feat(github): backlog and repo host adapters, webhook intake`.

---

### Task 8: Poller and watcher loop

**Files:**
- Create: `src/watcher/poller.ts`, `src/watcher/poller.test.ts`

**Interfaces:**
- Consumes: `BacklogAdapter`, `upsertItem`, `transitionItem`, and `gate`, `parseRepoConfig` and `loadPolicy` from Task 9.
- Produces: `pollOnce(deps: { pool; adapter: BacklogAdapter; repoHost: RepoHost; judge: (item: FactoryItem, dor: Policy) => Promise<string>; sourceId: string }): Promise<{ seen: number; cursor: string }>`. It writes the gate's verdicts to `policy_result`, and stores `item.readiness_policy_sha` from `readinessSha` over the six raw readiness texts (Run contract 11), which it also passes to `gate` as `ctx.readinessSha`. Also `POLL_INTERVAL_MS = 300_000`.
- Each `pollOnce` does five things:
  - lists new and changed eligible items from the cursor;
  - calls `getItem` for every item the factory holds in Queued, InProgress, SignOff, NeedsInput or InReview, because `listEligible` can't see an item that lost its label or closed;
  - writes `openDependencies` into `item.blocked_by` for every Queued, SignOff and NeedsInput item, so `claimNext` skips an item whose dependency reopened after the gate passed it (Task 5);
  - runs `gate` on every Eligible item;
  - reads `prState` for every InReview item.
- The moves below leave InProgress where the item was running, so `transitionItem` fences the old cell per Run contract 2.

- [ ] **Step 1: Write failing tests** with the fake adapter:
  - A new labelled item becomes an `item` row in Eligible.
  - An edit to a NotReady item moves it to Eligible through `item_edited`.
  - A Done item that loses its label is left alone.
  - The cursor persists in `backlog_source.cursor`, so a second `pollOnce` with no changes upserts nothing.
  - A paused `backlog_source` is skipped.
  - **Dependencies.** A Queued item whose `openDependencies` returns `["12"]` gets `blocked_by = {12}`, and the next poll, with the list empty, clears it.
  - **Gate.** An Eligible item that passes `gate` moves to Queued through `ready`. One that fails moves to NotReady through `readiness_failed` with a reasons comment. The gate's `configValid` comes from `parseRepoConfig` on the repo's `.factory/config.yml` at the default branch. Its `dor` comes from `loadPolicy` on the same commit, and `dodExists` is whether `loadPolicy(..., "dod")` returned a file.
  - **Criteria change.** An InReview item whose criteria now hash differently from `item.criteria_hash` moves to Queued through `criteria_changed`. In the same transaction:
    - `item.criteria_hash` takes the new value, so the next poll sees no change and fires nothing more;
    - a new `run` row, numbered one above the item's last run, starts at `understand` on a new branch, per Run contract 7;
    - its PR is closed with a comment, and the open question, if any, closes.

    The item gets a comment saying the scenarios need a new sign-off. The same holds from Queued, InProgress, SignOff and NeedsInput, and a second `pollOnce` after the change fires nothing.
  - **Withdrawal.** An InProgress item returned by `getItem` with the label gone, or with `closed: true`, moves to Abandoned through `withdrawn`, which fences its cell. An InReview item does the same. Either way an open PR is closed by Run contract 8.
  - **Conflict or requested changes.** An InReview item whose PR reports `mergeable: false`, or a `lastChangesRequestedAt` after `run.reviews_seen_at`, moves to Queued through `changes_requested`, with `run.next_stage = "address"`. Two tests cover the edges:
    - **Addressed review.** After address has run, a review older than its claim leaves the item in InReview on the next poll.
    - **Review during address.** A review submitted while address was running requeues the item on the first poll after it returns to InReview.
    - **Stranger's review.** A changes-requested review from a login that maps to no allowlisted user leaves the item in InReview, because the poller passes only allowlisted `github_login` values to `prState`. The same review from the dev owner's login requeues the item to address.
  - **Policy change.** After any readiness input changes on the default branch, so `readinessSha` no longer matches `item.readiness_policy_sha`, the next `pollOnce` moves every NotReady item to Eligible through `policy_changed`. The gate then runs as usual, and an item that now passes moves to Queued. A repo on the default file gets the same re-gate when a deploy changes `policy/dor.md`, because the default's sha is the SHA-256 of its text. Adding a missing `dod.md`, or fixing a `pr-review.md` that held a `run:` line, re-gates too, and posts a fresh comment.
  - **Judge failure.** A `judge` that throws, as `haikuJudge` does on a usage limit (Task 11), leaves that item in Eligible with no comment. The same `pollOnce` still gates the other items, reads every `prState` and saves its cursor, so a limit that lasts days never stops merge or withdrawal detection.
  - **Missed merge.** An InReview item whose PR reports `merged: true` moves to Accepted through `merged`, recording `merge_sha`.
  - **Closed PR.** An InReview item whose PR reports `open: false` and `merged: false` moves to Abandoned through `withdrawn`, as the `pr_closed` webhook does in Task 17. Without this, Phase 0a, which has no webhooks, would keep such an item in InReview and in the waiting count for good.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `pollOnce`.** The control plane calls it every 5 minutes and also on each `item_changed` webhook event, which Task 7's intake stores as an event of kind `webhook` whose `payload.event.kind` is `item_changed`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(watcher): polling with cursor`.

---

### Task 9: Repo config, SOP loader, policy files and readiness gate

**Files:**
- Create: `src/config/repo-config.ts`, `src/config/sop.ts`, `src/gate/readiness.ts`, `src/policy/policy.ts`, and a `*.test.ts` next to each. Also `policy/dor.md`, `policy/scenarios.md`, `policy/pr-review.md` and `policy/risk.md`.

**Interfaces:**
- Produces:
  - `parseRepoConfig(yamlText: string | null): RepoConfig`, where `RepoConfig = { sensitivePaths: string[]; reviewers: string[]; webTools: WebTool[]; bdd: { parse: string; run: string; report: string }; commands: { test: string; lint: string } }` and `type WebTool = "WebSearch" | "WebFetch"`. Defaults: `sensitivePaths: []`, `reviewers: []` and `webTools: []`, read from the YAML key `web_tools`. A missing `bdd` or `commands` key throws `ConfigError` naming the key.
  - `loadSop(yamlText: string): Sop`, which validates stage ids, `models.coding` and `models.triage`. A stage `model` must name a key in `models`. The valid ids are `STAGE_IDS`: `understand`, `specify`, `sign-off`, `red`, `green`, `self-review`, `open-pr` and `address`, each at most once. Those are Task 14's prompts plus `sign-off`, which no cell runs.
  - In `src/policy/policy.ts`, per Run contract 11:
    - `type Criterion = { index: number; text: string; run: string | null }` and `type Verdict = { index: number; criterion: string; status: "passed" | "failed" | "person"; reason: string }`. `person` is valid only in `dod.md`, and anywhere else it counts as `failed`.
    - `type Policy = { name: "dor" | "scenarios" | "pr-review" | "risk" | "dod"; source: "repo" | "default"; sha: string; text: string; criteria: Criterion[] }`. `criteria` is empty for `scenarios` and `risk`.
    - `loadPolicy(read: (path: string) => Promise<string | null>, name: Policy["name"]): Promise<Policy | null>`. `read` returns null only on a 404 and throws on any other error. `loadPolicy` returns null only for a missing `dod.md`, and throws `PolicyError` when a file other than `dod.md` holds a `run:` line.
    - `parseCriteria(markdown: string): Criterion[]`
    - `parseJudgement(reply: string, policy: Policy): Verdict[]`, keyed by index per Run contract 11
    - `readinessSha(texts: Record<"dor" | "scenarios" | "pr-review" | "risk" | "dod" | "config", string | null>): string`, which hashes the six texts in that key order, with `absent` for null, per Run contract 11. The caller reads the raw texts once, before any `loadPolicy`, so a file that later throws still counts.
  - `gate(item: FactoryItem, ctx: { readinessSha: string; dor: Policy | null; dodExists: boolean; configValid: boolean; repoKnown: boolean; openDeps: string[]; judge: (item: FactoryItem, dor: Policy) => Promise<string>; adapter: BacklogAdapter; policyErrors?: string[] }): Promise<{ ready: boolean; results: Verdict[] }>`. `dor` is null when the repo is unknown, or when loading it threw, and the engine's rules fail the item before any policy is read. `adapter` is where the gate posts its comment. `policyErrors` holds the message of each `PolicyError` the caller hit loading the five files, and each becomes a named reason.
  - Tests pass a fake `judge`. The real one, `haikuJudge`, comes in Task 11.
  - Write the four default files under `policy/`. `dor.md` holds three criteria: every acceptance criterion can become a Given/When/Then scenario, the scope is clear enough to build without guessing, and the item fits one Sprint. `scenarios.md` holds the spec's business-language rules. `pr-review.md` holds the rubric the vendored reviewer used to carry: correctness and security, what the linked item asks for, and following the repo's `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`. `risk.md` holds the examples column of the spec's Risk tiers table, as guidance.

- [ ] **Step 1: Write failing tests:**
  - `parseRepoConfig(null)` throws `ConfigError("bdd")`. A repo with no config can't run BDD, so it can't be ready.
  - `web_tools: [WebSearch]` gives `webTools: ["WebSearch"]`, and `web_tools: [Bash]` throws `ConfigError("web_tools")`, so a typo can't widen what a cell may do.
  - `gate` rule checks run first, and the judge isn't called when any rule fails. Rules:
    - The DoD file is missing: "No .factory/dod.md in this repo".
    - The repo config is missing or invalid: "No valid .factory/config.yml in this repo".
    - There are zero acceptance criteria. The engine keeps this rule because scenarios trace to criteria.
    - There is an open dependency, and the reason names it.
    - The repo is unknown.
  - A judge reply with every criterion passed but `flags: ["asks for credentials"]` makes the item not ready, and the results include the flag. This is Review Focus 1.
  - A judge reply that doesn't parse fails every criterion with "readiness check output unreadable".
  - **Policy loading.**
    - With no `.factory/dor.md` in the repo, `loadPolicy` returns the factory's `policy/dor.md` with `source: "default"`.
    - With one, it returns the repo file with `source: "repo"`, and none of the default's text.
    - With no `.factory/dod.md`, it returns null.
  - **Criteria.**
    - `parseCriteria` on a file with two `- [ ]` lines, prose and a nested `- [ ]` returns the two top-level lines only.
    - `` - [ ] E2E suite passes `run: npm run e2e` `` parses with `run: "npm run e2e"`.
  - **Judgement.**
    - `parseJudgement` on a reply that omits index 2 marks criterion 2 failed with "not judged", even when the model paraphrased the criterion's text elsewhere.
    - A reply with index 1 both passed and failed records a fail.
  - **Command placement.** A `dor.md` holding a `run:` line makes `loadPolicy` throw `PolicyError`, and the item stays NotReady with "dor.md: run: lines are allowed only in dod.md".
  - **Read errors.** A `read` that throws a 500 makes `loadPolicy` throw, and it never returns the default.
  - **Readiness hash.** `readinessSha` changes when any one of the six texts changes, including a `pr-review.md` that `loadPolicy` rejects, and stays the same when none does. A null `dod.md` and an empty `dod.md` give different hashes.
  - **Repo wording.** With a repo `dor.md` whose only line is "Has a Size of 5 or less", and an item whose readiness field Size is 8, the fake judge's failure for that line becomes the item's NotReady comment, word for word.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The gate parses the judge's reply with `parseJudgement`, plus a last line `{"flags":[]}`. The item is ready only when every `dor.md` criterion passed and `flags` is empty. The caller writes every result to `policy_result` with a null `run_id`. An engine rule or a flag comes back as a failed verdict with index 0, so it sits in the same results and the same comment. Every `{"flags":[...]}` line in the reply counts, so an echoed empty one can't cancel a real flag. A reply with no flags line fails the item as unreadable, even when `dor.md` has no criteria. The gate comments the failed lines by name, in the repo's own words, through `ctx.adapter.comment`, under `dedupeKey = "readiness:" + item.updatedAt + ":" + ctx.readinessSha`, so a re-gate after any readiness input changes posts a new comment. It never edits the item.
  - **Validate everything at readiness.** The caller also runs `loadPolicy` on `scenarios`, `pr-review` and `risk`. A `PolicyError` from any of the five files fails the item, with the error as a named reason, so a broken file never reaches a cell. The caller passes each message in `ctx.policyErrors`, and passes `dor: null` when `dor.md` was the file that threw.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gate): repo config, SOP loader, readiness gate`.

---

### Task 10: BDD evidence: red, green and the lock

**Files:**
- Create: `src/bdd/messages.ts`, `src/bdd/lock.ts`, `src/bdd/messages.test.ts`, `src/bdd/lock.test.ts`, `src/bdd/fixtures/*.ndjson`

**Interfaces:**
- Produces:
  - `classify(ndjson: string): Map<string, { name: string; tags: string[]; verdict: "red" | "green" | "crash"; reason: string }>`, keyed by pickle id.
  - `redGate(results, pbiTag: string, expected: string[]): { ok: boolean; findings: string[] }`, which is ok only when every scenario tagged `pbiTag` is red and every name in `expected` appears in `results`. `expected` is the item's scenario names from an unfiltered `bdd.parse` report, so a scenario that a repo's `bdd.run` filter kept out of the cell fails Red with "not run in the cell: <name>", and red proof stays whole. Per Run contract 4, other scenarios are ignored here.
  - `greenGate(results): { ok: boolean; findings: string[] }`, which is ok only when every scenario in the suite is green.
  - `traceability(results, criteriaCount: number, pbiTag: string): string[]`, which lists every `@ac-N` with no scenario tagged `pbiTag`.
  - `matchesLock(repoDir: string, lockSha: string, files: string[]): Promise<boolean>`, which diffs only the locked files.

- [ ] **Step 1: Write fixtures.** `fixtures/verdicts.ndjson` is a real cucumber-js run, trimmed to the `pickle`, `testCase`, `testCaseStarted` and `testStepFinished` messages, with each error message cut to its first line so no local path is committed. Its scenarios cover:
  - a Then step `FAILED`, which is red, and an `And` after a Then `FAILED`, which is red too;
  - all steps `PASSED`, which is green;
  - an `UNDEFINED` step, which is a crash;
  - an `AMBIGUOUS` step, which is a crash;
  - a When step `FAILED`, which is a crash;
  - a Given `PENDING`, which is a crash;
  - a failed `Before` hook ahead of a failing Then, which is a crash.

  An empty report gives no results at all. Red then fails every expected scenario with "not run in the cell: <name>", the owner's call at PBI 10's sign-off.

  Statuses come from `TestStepResult.status` (`UNKNOWN`, `PASSED`, `SKIPPED`, `PENDING`, `UNDEFINED`, `AMBIGUOUS`, `FAILED`). Step kind comes from the pickle step `type` (`Context`, `Action` or `Outcome`). Both are defined in `cucumber/messages` `jsonschema/messages.schema.json`.
- [ ] **Step 2: Write failing tests.** Each fixture maps to the verdict above.
  - `redGate` fails with the finding "scenario passes before any behaviour exists: <name>" when any scenario is green at Red, which is spec §6 Red proof.
  - `redGate` fails with "not run in the cell: <name>" when a name in `expected` is missing from `results`, as happens for a `@db` scenario under a `not @db` filter, even when every scenario that did run is red.
  - `traceability` with three criteria and `@pbi-482` scenarios tagged only `@ac-1` and `@ac-3` returns `["@ac-2"]`, even when an `@pbi-481` scenario carries `@ac-2`.
  - **Second item.** `redGate(results, "@pbi-482", ["<each @pbi-482 scenario name>"])` is ok when the `@pbi-482` scenarios are red and an earlier item's `@pbi-481` scenarios are green. This is the case that would otherwise block every item after the first.
  - `matchesLock` returns false after a test commit edits a locked `.feature` file. It returns true after a commit that only adds a step definition, and true after a merge that adds another item's feature file.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **`classify`.** Join `testCase.testSteps[].pickleStepId` to `pickle.steps[].type`. A scenario is red when its first non-`PASSED` step is `FAILED` and of type `Outcome`. A hook step has no pickle step, so a failed hook is a crash. A retried scenario counts from its last attempt. A step with no result, as when a killed runner leaves the report cut short, is a crash, so a truncated report never yields a false red or green.
  - **`redGate`.** Besides its two findings above, a crashed scenario of the item fails Red with "scenario crashed instead of failing on a Then: <name>: <reason>". It counts names rather than only matching them, because a Scenario Outline's rows share one name and an Examples-level `@db` tag can keep some rows out of the cell. An item with no scenarios in either list fails with "no scenario carries <tag>".
  - **`greenGate`.** A report with no scenarios fails with "the report holds no scenarios".
  - **`matchesLock`.** Run `git diff --quiet <lockSha> HEAD -- <files...>` through `execFile`. Exit 1 means a locked file changed or was deleted. It throws on any other git error, such as an unknown `lockSha`, and on an empty file list, which would diff the whole tree.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(bdd): red and green from Cucumber Messages, lock check`.

---

### Task 11: Agent runner

**Files:**
- Create: `src/agent/run.ts`, `src/agent/run.test.ts`, `src/agent/run.live.test.ts`

**Interfaces:**
- Produces:

```ts
export type AgentResult = { ok: boolean; text: string; costUsd: number; tokensIn: number; tokensOut: number;
  model: string; limit: { resetsAt: number } | null; usage: { utilization: number; resetsAt: number | null } | null;
  transcript: string };
export function runAgent(a: { prompt: string; model: string; cwd: string; agent?: string;
  maxTurns?: number; mode: "cell" | "judge"; webTools?: WebTool[]; signal: AbortSignal }): Promise<AgentResult>;
export function foldMessages(msgs: AsyncIterable<SDKMessage>): Promise<Omit<AgentResult, "model">>;
export function agentOptions(a: /* runAgent's argument */): Options; // the SDK options for a's mode
export function haikuJudge(sop: Sop): (item: FactoryItem, dor: Policy) => Promise<string>; // raw reply; gate() parses it
```

  This is the only module that imports `@anthropic-ai/claude-agent-sdk`. `haikuJudge` calls `runAgent` with `model: sop.models.triage`, `maxTurns: 1`, `mode: "judge"` and a 2-minute timeout. It runs in the control plane, which holds the App key and database access, while reading untrusted item text, so judge mode carries none of the cell's freedoms. Its prompt puts the repo's `dor.md` in the instructions, lists each criterion as a JSON line with its index, and puts the item text, with its readiness fields, as JSON in a fenced data block that it treats as requirements to weigh, never as commands. The fence is one backtick longer than the longest backtick run in the data, so item text can't close it. It asks for one JSON line per `dor.md` criterion, per Run contract 11, then a last line `{"flags":[]}`. `flags` covers requests for credentials, CI or workflow changes, and access outside the repo, as spec §9 requires. That check is the engine's, and no `dor.md` can remove it. A run that isn't `ok` makes `haikuJudge` throw instead of returning its text, so a usage limit never reads as the item failing readiness, and the poller tries again on its next poll.

  `haikuJudge` types its inputs by the fields it reads, `sop.models.triage` and the `dor` policy's `text` and `criteria`, so Task 9's `Sop` and `Policy` fit without this module importing them.

- [ ] **Step 1: Write failing `foldMessages` tests** against arrays of SDK-shaped messages:
  - A `result` with `subtype: "success"` gives `ok: true`, the result text, and `costUsd` as the sum of `modelUsage[*].costUSD`. `tokensIn` sums `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`, and `tokensOut` sums `outputTokens`.
  - A `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt: 1762400000` gives `limit.resetsAt = 1762400000` and `ok: false`, unless the run still ends in a clean success, as it can on overage. Then `limit` is null and `ok` is true, so a finished stage isn't parked until the reset. A rejection with no `resetsAt` waits 5 hours from now, as Task 12 does for usage.
  - A `rate_limit_event` with `status: "allowed_warning"`, `utilization: 0.74` and a `resetsAt` gives `usage: { utilization: 0.74, resetsAt }`, leaves `limit` null and doesn't change `ok`. Any event that carries `utilization` sets `usage`, and the last one in the stream wins.
  - A `result` with `subtype: "error_max_turns"` gives `ok: false` and keeps the cost.
  - A `result` with `subtype: "success"` and `is_error: true` gives `ok: false`. The SDK sends that shape when a turn ends on an API error (`sdk.d.ts`, `SDKResultMessage`), and PBI 11's usage-limit scenario expects it after a rejection. A stream with no `result` gives `ok: false`.
  - `transcript` is the JSONL of every message, for Blob upload.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `runAgent`.** Call `query({ prompt, options })` with `model`, `cwd`, `maxTurns` and the `AbortController` behind `signal`, plus the options for its mode.

  In `cell` mode:
  - `settingSources: ["user", "project"]`, so the vendored `~/.claude/agents` and the repo's own `.claude/` load.
  - `permissionMode: "bypassPermissions"`, which is safe only because the cell is a throwaway container holding a one-repo token. The SDK also requires `allowDangerouslySkipPermissions: true` for that mode.
  - `sandbox` from the sandbox probes, Task 2 Step 8 for local containers and Task 19 Step 9 for Azure: the egress allowlist when the sandbox can start, otherwise omitted. Locally it's omitted, because bubblewrap can't start under Docker Desktop, and Task 13's egress proxy enforces the allowlist instead. In Azure, Task 19 Step 9 decides.
  - `disallowedTools` holds each of `WebSearch` and `WebFetch` that `webTools` leaves out, so with the default `[]` both are denied. This only stops the model being offered a tool. The fence is Task 12's gateway, which refuses the same tools in any request body, since an agent with a shell can call the gateway directly (spec §6 "Web tools").

  In `judge` mode:
  - `settingSources: []`, so nothing on disk loads;
  - no `permissionMode`, so the default applies;
  - `tools: []`, which the pinned SDK's types document as the way to disable every built-in tool;
  - `strictMcpConfig: true` with no `mcpServers`, so no MCP server from a project, user or plugin config starts;
  - `disallowedTools: ["*"]`, which the SDK reference gives as the way "to deny every tool" ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)). The pinned 0.3.318 types don't mention `"*"`, so judge mode sets all three. A live judge-mode run on Haiku succeeded, and its `init` message listed no tools and no MCP servers.

  Add a unit test asserting that the options built for `judge` mode contain none of the cell-mode settings. Add another asserting that cell mode with no `webTools` denies both `WebSearch` and `WebFetch`, and with `webTools: ["WebSearch"]` denies only `WebFetch`.

  The spike may show that the SDK refuses the OAuth token. In that case `runAgent` spawns `claude -p --output-format stream-json --verbose`, with the same model and cwd, and feeds the parsed lines to `foldMessages`. The CLI emits the same message shapes, so nothing else changes.
- [ ] **Step 4: Run the unit tests.** Expected: PASS.
- [ ] **Step 5: Run the live test.** `run.live.test.ts` runs only with `CLAUDE_CODE_OAUTH_TOKEN` set. It asks Haiku for one word and asserts `ok`, `costUsd > 0` and `model === "claude-haiku-5-5"`. Run it in the cell image. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agent): Agent SDK runner with cost and limit folding`.

---

### Task 12: Cell API in the control plane

**Files:**
- Create: `src/control/cell-api.ts`, `src/control/cell-api.test.ts`, `src/control/board.ts` for Run contract 8's mirroring, `db/migrations/003_cell_api.sql`, and `src/http/server.ts`, which is a plain `node:http` list of handlers that Task 15 extends
- Modify: `src/store/runs.ts`, `src/store/items.ts`, `src/adapters/types.ts` and `src/adapters/fake.ts`, `src/control/model-gateway.ts` and its test

**Interfaces:**
- Consumes: `renewLease`, `transitionItem`, `appendEvent`, `RepoHost.cellToken`, `RepoHost.openReviewComments`, `RepoHost.readFile`, `RepoHost.checksOnSha`, `RepoHost.onBranch` and `parseRepoConfig`.
- `cellApi(deps): Handler` takes `{ pool, secret, repoHost, backlogFor, stageAfter, uploadUrl, gateway: { upstream, ownerToken }, webToolsOf, killSwitch?, now? }`. `killSwitch()` is true while the kill switch's env flag is on, and defaults to reading `FACTORY_KILL=1`. Three of these stand in for code that other tasks own, and the cell API imports none of that code:
  - `stageAfter(sopVersion, stageId)` names the next stage in the pinned SOP, from Task 9's `loadSop`;
  - `webToolsOf(configYaml)` is `parseRepoConfig(configYaml).webTools` from Task 9;
  - `uploadUrl(path)` is `blobUploadUrl(FACTORY_BLOB, CELL_BLOB_HOST)` locally, and a user delegation key in Task 19.
- `mirrorBoard({ pool, backlogFor, repoHost }): () => void` registers Run contract 8 through `onTransition`. It also closes a withdrawn item's PR when `prState` says it's still open.
- `003_cell_api.sql` adds `question.decision` (`approve`, `changes` or `answer`), which `decide` writes in Task 15 and `/context` returns as `decision.kind`, and `check_watch(run_id, sha, first_asked_at)`, which starts each sha's 10-minute clock.
- Produces the routes below, all under `/internal/cells/:runId`, all with `Authorization: Bearer <runToken>`. The token is `HMAC-SHA256(CELL_SECRET, runId + ":" + generation)` in hex. Every route checks the token with `timingSafeEqual` and then checks that `generation` is the item's current one. A failure of either check gets 409 with no write. Both checks run under the item's row lock, in the transaction that holds the route's writes, so a re-claim can't land between check and write. The token is checked before the body, so a fenced cell gets 409 even for a request that would get 400. A body over 1 MiB gets 413 and is drained, not kept, because the gateway shares this listener and is on public ingress in Azure.
  - `POST /lease` takes `{ generation }` and returns `{ ok: true, stop: boolean }`. `stop` is true when the kill switch, a pause or a stop-run override is active. The kill switch is either half of Task 13's definition: `FACTORY_KILL=1` or a `kill` override.
  - `POST /github-token` returns `{ token, expiresAt }`.
  - `GET /context` returns the fields Run contract 5 lists. `decision` comes only from questions asked since the run started, so a run that `criteria_changed` started never sees the previous run's decision.
  - `POST /policy-results` takes `{ file: "pr-review" | "dod", source: "repo" | "default", stageId, attempt, checkedSha, verdicts: Verdict[] }` and writes them to `policy_result` for the run. Run detail shows each criterion's verdict from its latest stage attempt. A `person` verdict outside `dod.md` gets 400, so a cell can't turn a `pr-review.md` fail into an unticked checklist line.
  - `POST /pr` takes `{ prNumber, prUrl }` and records them on the run, so the control plane starts polling that PR's checks (Run contract 6). The stored URL is built from the run's repo and `prNumber`, and a `prUrl` that differs gets 400, here and on `pr_opened`, because the board links it from a public item.
  - `GET /checks?sha=<sha>` returns `{ status: "pending" | "success" | "failure" | "none" }` for that commit on the run's branch. The control plane reads it on each request through its own `RepoHost.checksOnSha`, so the cell never sees a check API, per Run contract 6. The first request for a sha records it in `check_watch`, which starts its 10-minute `none` clock, and `none` from the host reads as `pending` until then. A sha that `RepoHost.onBranch` doesn't place on the run's branch gets 400, so a cell can't ask about main's green head.
  - `POST /stage` takes `{ stageId, attempt, status: "started" | "passed" | "failed", model, tokensIn, tokensOut, costUsd, transcriptRef?, reportRef?, usage? }`. It writes `stage_run` and, on `passed`, `run.next_stage` per Run contract 1. When `usage.utilization` is at or above `wip_policy.usage_reserve_at`, it sets `wip_policy.usage_paused_until` to `usage.resetsAt`, or to now plus 5 hours when the event gave no reset time.
  - `POST /transition` takes `{ event: ItemEvent, question?: { kind: "needs_input" | "sign_off"; body: string }, scenariosSha?: string, lockedFiles?: string[], prNumber?: number, prUrl?: string, resumeAt?: string, tier?: "Low" | "Medium" | "High", tierReasons?: string[] }`. A cell may send only `scenarios_written`, `blocked`, `pr_opened`, `retries_exhausted` and `usage_limited`, and any other event gets 400.
  - `POST /upload-url` takes `{ kind: "transcript" | "report", stageId, attempt }` and returns a write-only SAS URL, signed locally from the Azurite connection in `FACTORY_BLOB`, with its host swapped for `CELL_BLOB_HOST` as Task 2 Step 8 proved, and in Azure with a user delegation key, for `<kind>s/<runId>/<stageId>-<attempt>.<jsonl|ndjson>`, valid for 15 minutes.
- `runToken(secret: string, runId: string, generation: number): string`
- The model gateway from issue #33, at `/internal/model/*` and outside the 409 rule above. It calls `handleModelRequest` from `src/control/model-gateway.ts` with the path after `/internal/model`, `upstream` set to `https://api.anthropic.com`, and `ownerToken` reading the control plane's own `CLAUDE_CODE_OAUTH_TOKEN`. Its `verify` splits the stand-in `<runId>.<generation>.<runToken>` and accepts it only when the run token matches `runToken` under `timingSafeEqual` and the generation is the item's current one. Every refusal is the gateway's 401, so a fenced cell can't reach the model either. The gateway already refuses any path outside its allowlist with 404.
  - **Request check.** `verify` changes from a boolean to `{ webTools: WebTool[] } | null`, where null refuses. `webTools` is the run's pinned repo config, read once per run with `RepoHost.readFile(repo, config_sha, ".factory/config.yml")` and `parseRepoConfig`, then cached by `(repo, config_sha)`, which never changes for a run. A failed read answers 503, not 401, so a GitHub outage doesn't look like a bad credential to the cell. The gateway then reads each `/v1/messages` and `/v1/messages/count_tokens` body, up to 32 MiB, with 413 above that. It fails closed: it answers 400, and sends nothing upstream, for any of these:
    - a `Content-Encoding` other than `identity`;
    - a body that `JSON.parse` rejects;
    - an `mcp_servers` key;
    - a `tools` entry whose `type` is neither absent nor `custom`, unless the type starts with `web_search_` and `webTools` holds `WebSearch`. A `web_fetch_*` tool is always refused: the API fetches its URLs from Anthropic's servers ([web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)), while Claude Code's WebFetch fetches in the cell and never sends it, so `WebFetch` in `webTools` only lifts the agent's deny list;
    - an object anywhere in `messages` or `system` whose `source` is an object with a `type` other than `base64`, `text` or `content`. The walk skips the `input` of `tool_use` blocks and never enters `tools`. The API reads neither as content, and a JSON schema for a parameter named `source`, such as AskUserQuestion's `metadata.source`, is an object with `type: "string"`. A `url` source makes Anthropic's servers fetch that URL ([vision](https://platform.claude.com/docs/en/build-with-claude/vision), [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)), which is another way past the egress allowlist.

    Claude Code sends its own tools as custom tools and its images as base64, so its requests pass. What goes upstream is `JSON.stringify` of the object the gateway checked, with `content-length` reset and `transfer-encoding` dropped, so a parser that reads the original bytes differently, such as one keeping the first of two `tools` keys, never sees them.

- [ ] **Step 1: Write failing tests** against `startTestDb()` and a request helper:
  - **Model gateway.** With a fake upstream, a stand-in for the current generation reaches it with the owner's token. A forged stand-in, one from the previous generation after a re-claim, and a malformed one (no dots, a non-numeric generation) each get 401, and the fake upstream receives nothing.
  - **Request check.** In `model-gateway.test.ts`, with `verify` returning `{ webTools: [] }`:
    - a body whose `tools` holds a custom tool and whose messages hold a base64 image reaches the upstream;
    - a body reaches the upstream when a custom tool's `input_schema` has a `source` property, or a past `tool_use` block's `input` has a `source` object;
    - each of these gets 400 and the upstream receives nothing: a `tools` entry of type `web_search_20250305`, `web_fetch_20250910` or `code_execution_20250522`; an `mcp_servers` key; an image with `source: { type: "url" }` in a message; a document with a `url` source inside a `tool_result`; a body that isn't JSON; a body with `Content-Encoding: gzip`;
    - a body with two `tools` keys, a web search one first and a custom one last, reaches the upstream holding only the custom one;
    - with `webTools: ["WebSearch", "WebFetch"]`, the web search body reaches the upstream and the web fetch one still gets 400;
    - a chunked request reaches the upstream with a `content-length` and no `transfer-encoding`;
    - a 33 MiB body gets 413.

    In `cell-api.test.ts`, the run's config is read once across two model requests, and a failed read gets 503. The streaming and abort tests still pass, since only the request body is buffered.
  - With the current generation's token, `/stage` writes one `stage_run` row.
  - **Review Focus 2.** After a re-claim bumps the generation, each of the nine routes with the old token returns 409, and the `stage_run`, `event`, `item` and `policy_result` tables are unchanged.
  - **End-of-stage order.** Calls in Run contract 9 order all succeed. A `/stage` sent after the stage's own `/transition` gets 409, which is why the order is fixed.
  - `/transition` with `scenarios_written`, a `sign_off` question, `scenariosSha` and `lockedFiles` moves InProgress to SignOff. It inserts the question, stores the sha and files on the run, and releases the lease.
  - **Every exit releases.** Each of `pr_opened`, `blocked`, `retries_exhausted` and `usage_limited` leaves the item with no `lease_owner` and a generation one higher, per Run contract 2. `pr_opened` with `tier` writes `run.risk_tier` and `run.tier_reasons`.
  - `/context` after an approved sign-off returns `nextStage: "red"`, the `lockSha` and the `lockedFiles`.
  - **Trusted comments.** For an address run on a PR whose one unresolved thread holds a comment by an allowlisted user's `github_login`, a reply by the App's bot user and a reply by a stranger, `/context` returns `trustedComments` with the first two comments only.
  - `/transition` with `retries_exhausted` moves to Failed, and the event payload lists every attempt from `stage_run`.
  - `/lease` returns `stop: true` while a factory `pause` override is active.
  - `/stage` with `usage: { utilization: 0.72, resetsAt }` sets `usage_paused_until` to that reset time, and with `utilization: 0.5` leaves it unchanged.
  - **Board mirroring.** Run contract 8, asserted against the fake adapter:
    - each transition writes `statusFor[to]`, and a null entry writes nothing;
    - every claim calls `claim`, including the re-claim of a revived item, and Done, Failed and Abandoned call `release`;
    - `pr_opened` calls `linkPr`;
    - Done closes the item;
    - SignOff, NeedsInput and Failed also post a comment that names what the item is waiting for.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes in `src/http/server.ts` and mount them, the model gateway included, first, so they work without a dashboard session. Ignore every `x-ms-client-principal*` header on these routes. Register the board mirroring through `onTransition` from Task 4, so the watcher, the scheduler and the dashboard all mirror the same way.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(control): cell API fenced by lease generation`.

---

### Task 13: Scheduler, launcher and overrides

**Files:**
- Create: `src/scheduler/scheduler.ts`, `src/scheduler/launcher.ts`, `src/store/overrides.ts`, `src/scheduler/scheduler.test.ts`
- Modify: `aspire-apphost/apphost.mts`, which pins Azurite's blob port with `await azurite.withBlobPort(7410)` inside `configureContainer`, as Task 2 pins `control` to 7400. Then the egress proxy's label stays the same across `aspire run` restarts.

**Interfaces:**
- Consumes: `claimNext`, `expireLeases`, `runToken`, active overrides.
- Produces:
  - `interface Launcher { start(env: Record<string, string>): Promise<string>; stop(executionName: string): Promise<void>; }`, implemented by `dockerLauncher(cfg)` for Phase 0a, `containerAppsLauncher(cfg)` for Phase 0b, and `fakeLauncher()` for tests.
    - `dockerLauncher` runs `docker run -d --rm` on `CELL_IMAGE` with one `-e NAME=value` per cell variable, `CONTROL_URL` set to `CELL_CONTROL_URL`, and the two `cellModelEnv` variables, with the gateway at `CELL_CONTROL_URL` + `/internal/model` and the stand-in for the run (Run contract 5). The owner's Claude token never reaches the container, by value or by name. It returns the container id, and `stop` runs `docker stop`. A test with a stubbed `execFile` checks the exact argv: the six cell variables, the two model variables, `--network factory-cells`, the egress variables below, no bare `-e CLAUDE_CODE_OAUTH_TOKEN`, and no argv word containing the owner's token or any other control plane secret.
    - **Egress.** The owner chose this on 2026-11-06, because bubblewrap can't start in a local cell (Task 2 Step 8).
      - **Boot step.** `ensureEgress(cfg): Promise<void>`, exported from `src/scheduler/launcher.ts`, sets up the network and the proxy below. Task 15's `main.ts` awaits it once at control plane boot in local mode, before the first `tick`. It never runs in Azure and never per cell.
      - **Network.** `ensureEgress` makes sure the Docker network `factory-cells` exists, created with `--internal`. An "already exists" answer counts as success. Containers on it reach no other network and get no outside DNS. Docker's docs say they can still reach the network's gateway and "appropriately configured host services", which is why the egress test probes the gateway.
      - **Proxy.** It also makes sure a container `factory-egress` runs on that network and on the default bridge network. That container is an allowlisting HTTP proxy that admits only `github.com`, `api.github.com`, `registry.npmjs.org`, and `host.docker.internal` on the two ports it reads at boot. `api.anthropic.com` isn't on the list, because a cell's model calls go to the control plane's model gateway (issue #33), so the gateway is a cell's only route to the model. The two ports are: the control plane's from `CELL_CONTROL_URL`, and Azurite's from `FACTORY_BLOB`. The proxy carries a SHA-256 of its whole configuration, the allowed hosts and both ports, in a container label. Both ports are pinned, so the label changes only when the allowlist grows or someone changes a pinned port. When the label differs from the boot's configuration, the proxy is rebuilt, and an old port or host list is never reused. When the label matches, the running proxy stays, because rebuilding it would cut every live cell's open connections, the agent's model stream included.
      - **Cell variables.** Cells run with `--network factory-cells`. Both cases of each proxy variable, `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` and `http_proxy`, are set to `http://factory-egress:3128`, because curl, and so git and its credential helper, reads `http_proxy` only in lower case. The control plane and Azurite are plain `http`. Cells also get `NODE_USE_ENV_PROXY=1` for the cell's own `fetch` calls, plus two variables from Claude Code's network docs. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off telemetry, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` stops the agent from fetching the owner's claude.ai connectors, a call the gateway's allowlist would refuse anyway.
    - **First run.** Check these, and record the results in `docs/superpowers/spikes/2026-11-local-platform.md`:
      - Pick the proxy, either tinyproxy with a default-deny filter or a small Node CONNECT proxy, and record why.
      - A cell resolves `factory-egress` by name on the internal network.
      - Node 26 sends `fetch` through the proxy under `NODE_USE_ENV_PROXY=1`. If it doesn't, the cell's API client takes an explicit proxy agent.
      - The agent needs no Anthropic host at all, because its model calls go to the gateway. Issue #33's spike saw only `/api/hello` and `/v1/messages`, both through the gateway. If the agent probe below reaches for another Anthropic host, such as `platform.claude.com`, record it and route it through the gateway, never through the allowlist.
    - **Egress test.** From a cell container on `factory-cells`, with the egress variables set:
      - `curl https://api.github.com` succeeds;
      - `curl -X POST $CONTROL_URL/internal/cells/ping` gets 204;
      - a PUT to a `/probe/sas` URL gets 201;
      - with the control plane running and the two `cellModelEnv` variables set for a run it has claimed, `spike/sdk-oauth.ts` returns `subtype` "success" through the gateway;
      - `curl https://example.com` fails, and so does `curl https://api.anthropic.com`, which proves the gateway is the cell's only route to the model;
      - `host.docker.internal` on a port outside the allowlist, such as Postgres's, fails too.

      With the proxy variables unset, `curl https://api.github.com` fails. On the network's gateway IP, nothing answers. The Postgres and Azurite ports refuse the connection, because Aspire binds them to `127.0.0.1`. A port another container publishes on every interface, when one is running, times out.
    - A cell outlives an `aspire run` that stops, and stops itself after 3 minutes of failed lease renewals. A restart within that window finds it renewing, as Review Focus 5 expects. The restart finds the proxy's label unchanged and keeps `factory-egress` running, so a cell in the middle of a stage keeps its model stream.
    - `containerAppsLauncher` calls `ContainerAppsAPIClient.jobs.beginStart(rg, job, { containers: [{ name: "cell", image, env: [...] }] })`.
    - It reads the execution name from the response, and `stop` calls `jobs.beginStopExecution`.
  - `tick(deps: { pool; launcher: Launcher; now: Date; killFlag: boolean }): Promise<{ started: string[]; stopped: string[]; expired: string[] }>`
  - `TICK_MS = 15_000`, half the 30-second override budget.
  - `setOverride(c, o: { scope: "factory" | "item"; targetId: string | null; kind: "pause" | "resume" | "drain" | "hold" | "unhold" | "stop_run" | "requeue" | "kill"; reason: string; createdBy: string; expiresAt: Date | null }): Promise<void>`. A blank `reason` throws.
  - `activeOverrides(c, now: Date): Promise<Override[]>`

- [ ] **Step 1: Write failing tests** with `fakeLauncher` and the test DB:
  - **Fixed WIP.** With one InProgress item that holds a live lease and one Queued item, `tick` starts nothing. Once the lease expires, `tick` moves the old item to Queued and starts one cell.
  - **Review Focus 5.** A second `tick` from a new process, with the same DB and a live lease, starts nothing.
  - **Kill switch.** A `kill` override, or `killFlag: true`, makes `tick` call `stop` for every execution with a live lease and start nothing.
  - **Drain and pause.** Neither starts anything. Under drain the running cell's `/lease` reply has `stop: false`, and under pause it has `stop: true`.
  - **Hold.** A `hold` item override keeps that item out of `claimNext`.
  - **Cell env.** The env passed to `start` holds exactly the six variables in Run contract 5, so a cell learns its base, branch and lock only from `/context`.
  - **CI poll.** Each `tick` refreshes the cached check status of every open factory PR head and every Accepted item's `merge_sha`, through the App's `RepoHost`. A merge commit with no checks reported 60 minutes after the merge moves the item to Failed through `dod_failed`, with a comment that CI didn't run on main.
  - **Stop a run.** A `stop_run` override stops the execution, moves the item to Failed through `overrideTo`, sets `held = true`, and comments the branch name on the PBI.
  - **Usage limit.** An item that came back through `usage_limited` has `run.resume_at` in the future. It is skipped, and nothing at all starts before the earliest `resume_at`, as spec §7 requires.
  - **Expiry.** Item overrides end when the item reaches Done, Failed or Abandoned.
  - **Timeouts.** SignOff and NeedsInput items whose open question is older than 5 days move to Abandoned through `timed_out`.
  - **Reminders.** A question 2 days old with `reminders_sent = 0` gets a comment on the item and `reminders_sent = 1`. At 4 days it gets the second. A second `tick` the same hour sends nothing more.
  - **Waiting on people.** With one SignOff, one NeedsInput and one InReview item, all unanswered, and `review_capacity = 3`, `tick` starts no Queued item, although a slot is free. These cases follow:
    - When the SignOff item is approved, the next `tick` claims that answered item, because answered items are always claimable and no longer count (Run contract 3).
    - With three answered SignOff items and nothing else waiting, `tick` claims one of them, so answering never deadlocks.
    - When an unanswered item times out to Abandoned instead, the count drops to 2, and a Queued item starts.
    - With the count at 3 and two Queued items, a fresh one ranked first and one back from `changes_requested` with `next_stage = "address"`, `tick` claims the address item and leaves the fresh one waiting.
  - **Usage reserve.** With `usage_paused_until` in the future, `tick` starts nothing, and running cells' `/lease` replies keep `stop: false`, so they finish.
  - **Re-queue.** A `requeue` item override clears `held` and moves a Failed or Abandoned item to Queued through `requeued`, so a stopped run can be restarted. Two variants:
    - An Abandoned item whose question is still open goes back to SignOff or NeedsInput, through `reopened_signoff` or `reopened_question`, with `asked_at` reset to now and `reminders_sent` reset to 0.
    - A Failed item whose PR already merged starts a new run, numbered one above the item's last run, on a new branch, per Run contract 7.
    - An Abandoned item whose PR a person closed without merging, with `next_stage = "address"`, keeps its run and branch and gets `next_stage = "open-pr"`, per Run contract 1.
  - **Criteria hash.** A claim that opens a new run writes `item.criteria_hash` from the item's current acceptance criteria.
  - **Egress boot.** `ensureEgress` with a stubbed `execFile`, in three cases:
    - `docker network create` answers "already exists", and `ensureEgress` still succeeds;
    - the running `factory-egress` carries the label for this boot's configuration, and nothing is removed or started;
    - the label differs, and the old proxy is removed and a new one starts with the new label.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** A run can be created by a claim, by `criteria_changed` in Task 8, or by a re-queue after a merge. So the scheduler pins on the first claim of any run whose `config_sha` is still null, and records:
  - `run.repo_id`, since whoever creates the run already set `run.run_number` one above the item's last (Task 5);
  - `run.config_sha`, from `RepoHost.defaultBranchSha`;
  - `run.sop_version`, from the loaded SOP file.

  The cell reads both files at those pins for the whole run, as spec §6 requires. The cell env passed to `start` is the six variables in Run contract 5, with `RESUME_FROM` set to `run.next_stage`.

  `wip_policy` holds one row, `mode = 'fixed'` with `current_wip = 1`, and the scheduler reads it each tick.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(scheduler): fixed WIP, launcher, Phase 0 overrides`.

---

### Task 14: Cell engine, stages 1 to 7 and the thin stage 8

**Files:**
- Create: `src/cell/engine.ts`, `src/cell/api-client.ts`, `src/cell/main.ts`, `src/cell/engine.test.ts`, `sop/default.yml`, `sop/prompts/understand.md`, `sop/prompts/specify.md`, `sop/prompts/red.md`, `sop/prompts/tdd.md`, `sop/prompts/self-review.md`, `sop/prompts/open-pr.md`, `sop/prompts/address.md`, `cell/claude/agents/factory-self-reviewer.md`, `cell/claude/agents/factory-pr-addresser.md`
- Modify: `cell/Dockerfile`

**Interfaces:**
- Consumes: `runAgent`, `classify`, `redGate`, `greenGate`, `traceability`, `matchesLock`, `loadSop`, `parseRepoConfig`, `cellRepoHost` from Task 7, and the cell API from Task 12 through `api-client.ts`.
- Produces:

```ts
type CellContext = { externalId: string; title: string; acceptanceCriteria: string[]; nextStage: string;
  decision: { kind: "approve" | "changes" | "answer"; text: string } | null; lockSha: string | null;
  lockedFiles: string[]; prNumber: number | null; repo: string; base: string; branch: string;
  configSha: string; sopVersion: string; dodVerdicts: Verdict[]; dodCheckedSha: string | null;
  trustedComments: ReviewComment[] };   // the body of GET /context (Run contract 5)
type Git = { clone(url: string, branch: string): Promise<string>; mergeBase(base: string): Promise<"clean" | "conflict">;
  commitAll(msg: string): Promise<string>; push(): Promise<void>; head(): Promise<string> };
function runCell(deps: { api: CellApi; ctx: CellContext; agent: typeof runAgent; git: Git;
  repoHost: ReturnType<typeof cellRepoHost>; sop: Sop; config: RepoConfig;
  policies: { scenarios: Policy; prReview: Policy; risk: Policy; dod: Policy }; now: () => Date })
  : Promise<"done" | "waiting" | "failed" | "stopped" | "limited">;
```

  The engine starts at `ctx.nextStage`, and the item's tag is `@pbi-${ctx.externalId}`. Every `runAgent` call in cell mode passes `webTools: config.webTools`, from the repo config pinned for the run. Before the first stage of every claim, `runCell` calls `git.mergeBase(ctx.base)`. On `conflict` it runs the coding agent once to resolve it. A conflict still left goes to `blocked`, with the conflicting paths. From red onward, that is red, green, self-review, open-pr and address, the engine commits whatever the agent left in the checkout with `git.commitAll` and then runs `matchesLock(dir, ctx.lockSha, ctx.lockedFiles)`, before every `git.push` and before each stage's exit check. Understand and specify skip it, since no lock exists until sign-off and `matchesLock` throws on an empty file list. At red, green and address, a false result fails that attempt, counted against the stage's retries. Self-review and open-pr have no retries of their own, so there a false result posts `blocked` and the engine pushes nothing. `matchesLock` compares commits, so without the commit an edit to a locked feature file that was never committed would pass the lock check while `bdd.run` ran the edited file. Without the check after green, a self-review fix or an address push could change a locked scenario on its way to merge, though spec §6 says every later gate compares the feature files against the lock. `commitAll` stages every change, deletions included, and returns HEAD unchanged when there's nothing to commit, which is the usual case, since agents commit their own work.

Stage behaviour, from spec §6 rows 1 to 7:

| Stage | Exit check in code | On failure |
|---|---|---|
| understand | Agent output lists each criterion with an `@ac-N` tag | `blocked`, with the agent's question |
| specify | Every feature file carries the item's `@pbi` tag, `bdd.parse` exits 0, and `traceability(results, n, tag)` is empty. When `ctx.decision` is a `changes` note, the agent gets the note. Feature files are committed and posted on the PBI with dedupe key `scenarios:<sha>`. The engine then posts `scenarios_written` with a `sign_off` question, `scenariosSha` and `lockedFiles`, and returns `waiting` | 1 retry, then `blocked` |
| sign-off | No cell runs it. `decide` moves `next_stage` to `red` or back to `specify`, per Run contract 1 | none |
| red | `bdd.parse`, whose report gives `expected`, the names of the scenarios carrying `tag`. Then `bdd.run`, which overwrites the report, and `redGate(classify(report), tag, expected)` is ok, and `matchesLock(dir, ctx.lockSha, ctx.lockedFiles)` is true. The report goes up through `/upload-url` with `kind: "report"` as red evidence | 2 retries, then `blocked` |
| green | `greenGate`, `commands.test`, `commands.lint` and `matchesLock` all pass. The green report is uploaded the same way. Then the `dod.md` criteria are checked per Run contract 11: the engine runs the `run:` lines, an agent judges the rest, and the verdicts go to `POST /policy-results`. A `failed` `dod.md` verdict counts as a green failure. A `person` verdict goes to the PR checklist unticked and doesn't fail green | 3 retries, then `retries_exhausted` |
| self-review | The reviewer's last line is `APPROVED`, and every `pr-review.md` verdict it reported passed, with the verdicts sent to `POST /policy-results`. `APPROVED` with a failed verdict counts as another round. `DEADLOCK` or 5 rounds without approval means `blocked` | `blocked` |
| open-pr | `dod.md` checked again when HEAD moved since `ctx.dodCheckedSha` (Run contract 11). Then `openOrUpdatePr` with `Refs #<n>` in the body, a link to the repo's `pr-review.md` or the default, and the `dod.md` criteria as a checklist showing the cell's verdicts, for the person who merges to tick, then `POST /pr`, then `requestReviewers(repo, pr, config.reviewers)`, then `GET /checks?sha=<git.head()>` every 60s until `success`. Every later push, including a retry after "back to green", asks about its own new sha. On `failure`, back to green, counted against green's retries. On `none`, `blocked` with "no CI ran on the PR". The stage ends in Run contract 9 order with `pr_opened` carrying `prNumber`, `prUrl`, `tier` and `tierReasons` | as stated |
| address | Runs only when `ctx.nextStage` is `address`. `factory-pr-addresser` replies to or fixes each comment in `ctx.trustedComments` (Run contract 10), and the branch merges cleanly with the base. Then `GET /checks?sha=<git.head()>` for the pushed commit reaches `success`, `dod.md` is checked again when HEAD moved since `ctx.dodCheckedSha`, and the engine posts `pr_opened` again, which returns the item to InReview | 2 retries, then `blocked` |

- [ ] **Step 1: Write `sop/default.yml`.** Copy the spec's SOP YAML, keep stages understand to open-pr, set self-review's agent to `factory-self-reviewer`, add `address` with `agent: factory-pr-addresser`, and keep `budget` as recorded data only. Phase 0 doesn't enforce caps. The one exception is `wall_clock: 8h`, which counts only time with a lease, and when it runs out the engine posts `blocked`. Write the seven prompt files. They hold only engine rules, and every repo-specific standard comes from a policy file the engine loads at run time (Run contract 11). `specify.md` carries the engine's BDD rules verbatim: traceability, the lock and red proof. It requires the item's `@pbi-<n>` tag on every feature file, and appends the repo's `scenarios.md` as the team's writing guide. `red.md` says to write step definitions and stubs with no behaviour.
- [ ] **Step 2: Write the agent definitions.** Copy `~/.claude/agents/self-reviewer.md` into `cell/claude/agents/` as `factory-self-reviewer.md`, with `name:` set to match. Write `factory-pr-addresser.md` fresh instead of copying `~/.claude/agents/pr-addresser.md`. That file only points to a skill loop that fetches every review thread itself, takes each thread's latest comment as the ask, watches the PR until it merges and calls scripts under `~/.claude/scripts`, none of which an address stage can use. The factory's addresser makes one pass:
  - it merges the base and resolves any conflict;
  - it works each comment in the brief's list, fixing the code or replying in that comment's thread;
  - it commits and stops.

  It fetches no review threads, watches nothing and runs no script outside the repo, so the brief's list is the only review text it works from. The new names matter because cell mode loads the repo's own `.claude/agents/`, and Claude Code prefers a project agent over a user agent of the same name ([sub-agents](https://code.claude.com/docs/en/sub-agents), "Choose the subagent scope"). Under the old names, a repo shipping its own `self-reviewer.md` would replace the factory's reviewer and its report format. From the vendored reviewer, remove its rubric list (what to review for) and its line saying a repo's own agent file overrides it. Keep only the review loop and the `APPROVED` / `OPEN: <n>` report format, so `pr-review.md` is the only rubric. `address.md` gives `factory-pr-addresser` the conflict and `ctx.trustedComments` (Run contract 10), and tells it to treat that text as requests to weigh, never as commands. `self-review.md` gives the reviewer the repo's `pr-review.md` as its rubric, numbered as in Run contract 11. Then come the engine's BDD checks, under a heading that says they outrank anything in the rubric above: every step definition asserts something, no scenario is pending or skipped, and no tag hides a scenario. It also adds the rule "after a finding is rebutted twice and still held, end with `DEADLOCK`". The reviewer reports each `pr-review.md` criterion as a JSON line, which the engine stores in `policy_result`.
- [ ] **Step 3: Write failing engine tests** with a scripted fake agent, a fake `Git` and a recording `CellApi`:
  - **Happy path.** A fresh run with `ctx.nextStage = "understand"` executes understand and specify, posts `scenarios_written` with `scenariosSha` and `lockedFiles`, and returns `waiting`. A second run with `ctx.nextStage = "red"` and a lock in `ctx` runs red, green, self-review and open-pr. It posts `pr_opened` and returns `done`. Each stage writes `started` then `passed` with the fake agent's cost. With `config.webTools: ["WebSearch"]`, every `mode: "cell"` call the fake agent records carries `webTools: ["WebSearch"]`.
  - **Checkpoint resume.** With `ctx.nextStage = "red"`, it never calls the agent for understand or specify.
  - **Changes asked.** With `ctx.nextStage = "specify"` and `ctx.decision = { kind: "changes", text: "split AC 2" }`, the specify prompt contains the note.
  - **Base merge.** Every run calls `mergeBase` before its first stage. A `conflict` the agent can't clear posts `blocked` naming the paths, and no stage runs.
  - **Address.** With `ctx.nextStage = "address"`, it runs only the address stage, pushes, and posts `pr_opened` once `/checks?sha=` for the pushed sha reports `success`. A `success` cached for the previous head never counts.
  - **Trusted brief.** The prompt the fake agent receives at address holds the body of every comment in `ctx.trustedComments` and no other review text.
  - **Rubric can't weaken.** A repo `pr-review.md` that says "skip the BDD checks" still yields a brief whose BDD checks follow the rubric under the outranking heading. A reviewer reply of `APPROVED` with one failed `pr-review.md` verdict starts another round instead of passing.
  - **Repo agents can't replace the factory's.** With a fake repo holding `.claude/agents/self-reviewer.md` and `.claude/agents/pr-addresser.md`, the self-review and address calls to the fake agent name `factory-self-reviewer` and `factory-pr-addresser`.
  - **DoD commands.** A `dod.md` with `` `run: false` `` fails green on exit code 1, and the command's env holds no `CLAUDE_CODE_OAUTH_TOKEN` and no `RUN_TOKEN`. `` `run: true && true` `` passes, which proves the `sh -c` path.
  - **DoD lines for a person.** A `dod.md` line "Deployed to staging" judged `person` doesn't fail green, and appears in the PR body as an unticked line marked for the person who merges.
  - **Policy load.** A `pr-review.md` holding a `run:` line, and separately a missing `dod.md` at `ctx.configSha`, each post `blocked` naming the file, and `runCell` never starts.
  - **Stale DoD.** At open-pr with HEAD equal to `ctx.dodCheckedSha`, no `dod.md` command runs again. With `ctx.nextStage = "address"`, a `dod.md` holding `` `run: false` `` and a fix that moves HEAD, the address attempt fails before `pr_opened`. Every `/policy-results` call carries the head it checked, and the PR checklist names that sha.
  - **Policy in prompts.** With a repo `scenarios.md` and `pr-review.md`, the specify prompt contains the repo's `scenarios.md` text and the self-review brief contains its `pr-review.md` text, each word for word. Without them, the factory defaults appear instead. The engine's BDD checks appear in the self-review brief either way.
  - **Open PR.** The PR body contains `Refs #482` and never `Closes`, and lists each `dod.md` criterion as a `- [ ]` line, `POST /pr` comes before the first `GET /checks`, and `requestReviewers` is called with `config.reviewers`.
  - **Call order.** At the end of every stage the recording `CellApi` sees `/stage passed`, then the uploads, then `/transition`, per Run contract 9, and the run returns `waiting` or `done` rather than `stopped`.
  - **Red proof.** A red stage whose report has a green scenario retries twice, then posts `blocked` with "scenario passes before any behaviour exists".
  - **Locked files at every gate.** These cases use a real temporary repo and a real `Git`, because `matchesLock` runs `git diff` and a fake `Git` writes no commits. A red stage whose agent edits a locked feature file and leaves it uncommitted retries twice, then posts `blocked`. An address stage whose agent commits an edit to a locked feature file never pushes it, never posts `pr_opened`, and posts `blocked` after its retries. A self-review fix that commits an edit to a locked feature file posts `blocked` at once, with no second round. A red stage whose agent left a clean tree passes, with HEAD unchanged by `commitAll`.
  - **Usage limit.** An agent result with `limit.resetsAt` makes the engine commit, post `/stage failed`, post `/transition` with `usage_limited` and `resumeAt`, and return `limited`. That attempt doesn't count against retries.
  - **Stop.** A `/lease` reply of `{ stop: true }` during any stage aborts the agent through `signal`, commits the work in progress, and returns `stopped`.
  - **Lost lease.** A 409 from any API call makes the engine stop at once, with no push and no further calls.
- [ ] **Step 4: Run the tests.** Expected: FAIL.
- [ ] **Step 5: Implement `engine.ts`, `api-client.ts` and `main.ts`.**
  - A lease renewal loop runs every 60s. After 3 minutes of failed renewals it aborts and exits 1.
  - Before each push, comment and transition, the engine calls `/lease` to check the generation.
  - Every stage uploads its transcript through `/upload-url` with `kind: "transcript"`.
  - `main.ts` reads `GET /context`, and clones `ctx.branch` through a git credential helper that fetches a token from `/github-token` on demand, so no token is written into `.git/config` or the remote URL. It creates the branch from `ctx.base` when it doesn't exist yet.
  - A `PolicyError` while loading the four policies posts `blocked` with the error, and never crashes the cell into a lease-expiry loop. So does a null `dod`, which happens when a team removes `.factory/dod.md` between the readiness check and the claim that pins `config_sha`. It posts `blocked` with "No .factory/dod.md at <configSha>". It reads `.factory/config.yml` at `ctx.configSha`, loads the four policies with `loadPolicy` at the same commit, and reads the SOP at `ctx.sopVersion`. Then it runs `runCell`.
- [ ] **Step 6: Update `cell/Dockerfile`** from Task 2, which already has `git`, `curl`, `bubblewrap` and `socat`. Copy `cell/claude/agents` into `/home/factory/.claude/agents`, copy `policy/` into `/app/policy`, and run as a non-root `factory` user.
- [ ] **Step 7: Run the tests.** Expected: PASS.
- [ ] **Step 8: Commit** `feat(cell): SOP engine for stages 1 to 7 and address`.

---

### Task 15: Dashboard: sign-in, Floor, Run detail, controls

**Files:**
- Create: `src/http/auth.ts`, `src/http/views.ts`, `src/http/routes.ts`, `src/http/auth.test.ts`, `src/http/routes.test.ts`, `src/control/decisions.ts`, `src/control/decisions.test.ts`, `src/main.ts`, `scripts/seed-owner.ts`
- Modify: `src/http/server.ts` from Task 12
- Modify: `aspire-apphost/apphost.mts`, so `control` runs `src/main.ts` in place of `spike/hello.ts`. In local mode `main.ts` keeps `/internal/cells/ping` and the three `/probe/*` routes from `spike/hello.ts`, so PBI 2's scenarios keep passing.
- Modify: `Dockerfile`, which also copies `src/` for `main.ts` and `migrate-cli.ts`, `db/` into `/app/db` for the migrate job's SQL files, `policy/` into `/app/policy` for the readiness gate's defaults, and `config/` into `/app/config` for the migrate job's sources file. Without `db/`, `migrate()` can't find `db/migrations` and the first Azure migration fails.

**Interfaces:**
- Consumes: the store, `setOverride`, `activeOverrides`, `ensureEgress`, `handleWebhook`, the cell API and `pollOnce`.
- Produces:
  - `identify(path, headers): { provider: "google" | "microsoft" | "dev"; subject: string; tenantId: string | null } | null`. It returns null on any route under `/webhooks` or `/internal` in both modes.
    - **In Azure** it reads the `x-ms-client-principal-idp` and `x-ms-client-principal-id` headers. Task 19 Step 5 records them on live sign-ins, and Task 20 fixes `identify` if the live names differ.
    - **Locally** no sign-in sits in front of the app, and cells reach the same port through `host.docker.internal`. So at each start `main.ts` makes a random 32-byte dev token and logs the link `http://localhost:7400/dev-login?token=<token>`, which the Aspire dashboard's console shows. `GET /dev-login` with that token sets a `factory_dev` cookie, `HttpOnly` and `SameSite=Strict`. `identify` returns `{ provider: "dev", subject: FACTORY_DEV_LOGIN }` only for a request carrying that cookie. Local mode never reads principal headers.
  - **Origin check.** Every dashboard POST must carry an `Origin` header equal to the dashboard's own origin, or it gets 403, in both modes. Built-in auth and the dev token both ride on cookies, so this is what stops a cross-site form post from any page the owner has open.
  - **Dev identity guard.** `main.ts` refuses to start in three cases: `FACTORY_DEV_LOGIN` is set and `FACTORY_ENV` isn't `local`; `FACTORY_ENV` is `local` and `FACTORY_DEV_LOGIN` is empty; or either is set while `CONTAINER_APP_NAME` is set. Azure Container Apps adds `CONTAINER_APP_NAME` to every container app ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/container-apps/environment-variables)), so that's a signal the deploy itself gives, beside the AppHost setting both only in run mode and the Bicep setting neither.
  - `requireRole(user, role: "viewer" | "operator" | "owner")`
  - These routes:
    - `GET /` is Floor.
    - `GET /items/:id` is Run detail.
    - `GET /events` is SSE fed by `LISTEN factory_events`.
    - `POST /items/:id/signoff` takes `{ decision: "approve" | "changes", note }` and needs `product_owner`.
    - `POST /items/:id/answer` takes `{ answer }` and needs operator or product owner.
    - `POST /overrides` needs operator.
    - `POST /users` needs owner.
    - `GET /phase0` is the exit report.
  - `scripts/seed-owner.ts` takes dash-free words `provider=<p>`, `subject=<id>`, `email=<e>` and `github-login=<login>`, plus an optional bare `product-owner`, and inserts the first owner. `provider` is `google`, `microsoft` or `dev`. It exits 1 on any other word. It runs only through `migrate-cli.ts`. Locally the dev owner seeds itself (Task 4), so `seed-owner` is for Azure's migrate job and for adding a second local user.
  - `decide(c, d: { itemId: string; userId: string; kind: "approve" | "changes" | "answer"; text: string; via: "dashboard" | "comment" }): Promise<"applied" | "ignored" | "forbidden">`. The routes and the webhook's `comment` events both call it, so the two channels can't drift. It records `d.kind` in `question.decision` and `d.text` in `question.answer`, which is what Task 12's `/context` hands the cell as `decision`.
    - **Roles.** `decide` owns the role rules. `approve` and `changes` need `product_owner`, and `answer` needs operator or product owner. The routes only check that the user is signed in and allowlisted.
    - **Effects.** It answers the open question and applies Run contract 1. On approve it copies `scenarios_sha` into `features_lock_sha`. On an Abandoned item it revives the item through `requeued`.
  - `parseCommand(body: string): { kind: "approve" | "changes" | "answer"; text: string } | null`, which reads only a leading `/approve`, `/changes` or `/answer`.

- [ ] **Step 1: Write failing tests:**
  - **Review Focus 4.**
    - `identify` returns null for any request to `/webhooks/github` or `/internal/cells/x`, even with every principal header set.
    - A dashboard request whose subject isn't in `user` gets 403 and the page "You don't have access to this factory. Ask an owner to add you."
    - **Guard.** `main.ts` exits non-zero at startup with `FACTORY_DEV_LOGIN` set and `FACTORY_ENV` unset, with `FACTORY_ENV=local` and no `FACTORY_DEV_LOGIN`, and with both set plus `CONTAINER_APP_NAME=ca-factory-control`.
    - **Dev token.** Locally, a dashboard request without the `factory_dev` cookie, or with a wrong one, gets no identity, even with every principal header set. `GET /dev-login` with a wrong token sets no cookie. With the right cookie the request is the dev user, and a request to `/internal/cells/x` still gets no identity.
    - **Origin.** A signed-in `POST /items/:id/signoff` with `Origin: https://evil.example`, or with no `Origin`, gets 403 and changes nothing.
  - **Roles.** A viewer posting `/overrides` gets 403. An operator posting `/overrides` with an empty reason gets 400.
  - **Sign-off.** A sign-off from a user without `product_owner` gets 403. A sign-off from a product owner answers the open `sign_off` question, comments the decision on the PBI, and logs an event with `actor: "human"` and the user id.
  - **Floor.** Floor lists every InProgress, SignOff, NeedsInput and InReview item. Each row shows the current stage, time in stage, the sum of `stage_run.cost_usd` and the last agent message, and a held item or active override shows a badge.
  - **Run detail.** Run detail shows:
    - the SOP version and config sha;
    - each policy file used, marked repo or default, with every criterion's result and reason from `policy_result`;
    - the signed-off feature files at `features_lock_sha`;
    - each scenario's red and green verdicts, read by running `classify` on the reports at `stage_run.report_ref`;
    - per stage: attempts, model, tokens, cost and a transcript link;
    - the shadow risk tier with its reasons.
  - **Token expiry.** A banner appears when the Claude token expires within 30 days of `CLAUDE_TOKEN_CREATED_AT` + 365 days.
  - **Comment decisions.**
    - A `/approve` comment from a login mapped to a product owner signs off, exactly like the dashboard route.
    - The same comment from an unmapped login, or from a user who isn't a product owner, returns `forbidden`. The item gets one reply saying who can sign off, and nothing changes.
    - A comment with no leading command is `ignored`.
    - `/answer` on an Abandoned item's open question answers it and moves the item to Queued through `requeued`.
    - A late `/approve` on an item Abandoned in SignOff does the same, with `next_stage = "red"` and the lock set.
    - `/answer` from a mapped user with only the viewer role returns `forbidden`, exactly as the dashboard route does for that user.
  - **Floor strips.** Floor shows:
    - "Waiting on you", with every SignOff and NeedsInput item oldest first, plus each InReview PR and how long it has waited, which matches the count in Run contract 3;
    - "Next up", the first five items `claimNext` would pick;
    - "Not ready", each NotReady item with the `dor.md` lines it failed;
    - the waiting count beside the WIP number, as "3 of 3 waiting".
  - **Sign-off view.** For a SignOff item, Run detail lists each acceptance criterion with the scenarios tagged `@ac-N` under it, and marks a criterion with no scenario "no scenario".
  - **Re-queue.** Failed and Abandoned items in Run detail show a Re-queue button that posts a `requeue` override, which needs a reason.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The server is plain `node:http` with a route table and HTML from template literals through one `escapeHtml`.
  - `views.ts` defines its colours as CSS custom properties with a dark-mode override, and every form control has a label.
  - In local mode `main.ts` first awaits `ensureEgress(cfg)` from Task 13, so `factory-cells` and `factory-egress` exist before any cell launches.
  - `main.ts` wires the pool, the scheduler `tick` every `TICK_MS`, `pollOnce` every `POLL_INTERVAL_MS`, and the HTTP server. It never runs `migrate`, because in Azure it connects as `factory_app`, which has no DDL rights. Migrations run only in the `migrate` resource locally (Task 2) and the migrate job in Azure (Task 19).
  - The kill switch is `FACTORY_KILL=1` in the app's env or a `kill` override from the dashboard. Either one stops every cell on the next tick.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): sign-in allowlist, Floor, Run detail, overrides`.

---

### Task 16: Shadow risk classifier

**Files:**
- Create: `src/risk/shadow.ts`, `src/risk/shadow.test.ts`
- Modify: `src/cell/engine.ts`, so open-pr calls `classifyRisk` before writing the PR body

**Interfaces:**
- Consumes: `runAgent` and `RepoConfig.sensitivePaths`.
- Produces:
  - `pathFloor(files: string[], sensitive: string[]): { min: "Low" | "Medium" | "High"; reasons: string[] }`. CI workflow files, `sensitive_paths`, anything under `.factory/` or `.claude/`, and any `AGENTS.md` or `CLAUDE.md` force at least Medium. Those paths hold the policy files and what steers the factory's agents. This floor is the engine's, and no `risk.md` lowers it.
  - `classifyRisk(diff: string, files: string[], ctx: { sop: Sop; config: RepoConfig; risk: Policy; dodVerdicts: Verdict[]; agent: typeof runAgent }): Promise<{ tier: "Low" | "Medium" | "High"; reasons: string[] }>`. Any `dod.md` verdict with status `person` raises the floor to Medium, with the reason "a DoD line needs a person at merge: <line>". So a line only a person can check never slips through a Low merge that no person sees. It runs two passes on `sop.models.coding`, with the repo's `risk.md` as the definition of each tier: the tier, then "does this change need a person anyway". It never returns below `pathFloor`.

- [ ] **Step 1: Write failing tests:**
  - **Path floor.** `pathFloor` gives Medium for `.github/workflows/ci.yml`, `.factory/config.yml`, `.factory/dod.md`, `.claude/agents/self-reviewer.md`, `AGENTS.md`, `src/CLAUDE.md` and a file matching `src/billing/**`, and gives Low for `docs/readme.md`.
  - **Person lines.** A docs-only diff that the fake agent calls Low, with one `dod.md` verdict "Deployed to staging" judged `person`, yields Medium with that reason.
  - **Repo risk.** A repo `risk.md` that calls any change to `src/payments/**` High makes the fake agent's prompt carry that text, and a diff there comes back High. A `risk.md` that calls `.factory/` changes Low still yields Medium, because of the floor.
  - **No lowering.** A fake agent answering Low for a diff that touches `.factory/config.yml` still yields Medium, with both reasons kept.
  - **Second pass.** A second pass that answers "needs a person" raises Low to Medium.
  - **Unreadable output.** Output that doesn't parse yields High, with the reason "classifier output unreadable". A wrong Low lets code skip review, so failure raises the tier.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Match globs with `path.matchesGlob` from `node:path`. The cell sends the tier and reasons with `pr_opened`, the control plane writes `run.risk_tier` and `run.tier_reasons`, and the PR body gains a "Shadow risk tier" section. No status check is posted.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(risk): shadow-mode tier classifier`.

---

### Task 17: Merge, Done and the walking skeleton end to end

**Files:**
- Create: `src/e2e.test.ts`
- Modify: `src/watcher/webhook.ts` for these mappings:
  - `pr_merged` moves InReview, or InProgress during address, to Accepted through `merged`, and stores `run.merge_sha`. When the cached check status of `merge_sha` reaches `success`, through `checks_completed` matched on `merge_sha` or the poll in Task 13, the item moves to Done through `dod_verified`. Run contract 8 then sets Done on the board and closes the item. On `failure` the item moves to Failed through `dod_failed`, with a comment linking the failed run. Phase 0 files no bug PBI.
  - `review` with `changes_requested` and a `submittedAt` after `run.reviews_seen_at` moves InReview to Queued through `changes_requested`, with `next_stage = "address"`, per Run contract 10. An older review, or one whose `author` is no allowlisted user's `github_login`, is ignored.
  - `pr_closed` without a merge, by anyone but the factory, moves the item to Abandoned through `withdrawn`.

**Interfaces:**
- Consumes everything above, with the fake adapter, the fake launcher running `runCell` in-process, and the scripted fake agent.

- [ ] **Step 1: Write the failing end-to-end test:**
  - **The full path.** Seed one labelled item with two criteria in a repo whose fake files include `.factory/config.yml` and `.factory/dod.md`, and no other policy file, so the defaults run. Then tick:
    - Eligible goes to Queued with a fake judge reply that passes each default `dor.md` criterion by index, one JSON line each, then `{"flags":[]}`.
    - Queued goes to InProgress and then SignOff.
    - The product owner approves, and SignOff goes to InProgress and then InReview with a PR URL.
    - A `review` webhook with `changes_requested` sends it to Queued. The next claim runs the address stage, which returns it to InReview.
    - **Second item.** A second item is then taken through the same path to Done, so its Red stage runs with the first item's scenarios already green on main.
    - A `pr_merged` webhook moves InReview to Accepted, and green checks on the merge commit move it to Done. The fake adapter shows status Done and `closed: true`.
  - **Event trail.** The `event` table holds every transition in order, and `/phase0` reports 1 merged PR and its cost.
  - **Sign-off by comment.** A copy of the full path signs off with a `/approve` comment instead of the dashboard, and reaches the same states.
  - **NotReady recovery.** A second item with no acceptance criteria goes to NotReady with a reasons comment. Editing it re-runs the gate.
- [ ] **Step 2: Run the test.** Expected: FAIL, until the wiring gaps it exposes are closed.
- [ ] **Step 3: Close the gaps** in the modules the failure names. Don't add new modules.
- [ ] **Step 4: Run `npm test`.** Expected: every test passes.
- [ ] **Step 5: Commit** `test: walking skeleton end to end`.

---

### Task 18: First live item, locally

Phase 0a's exit. The factory runs under `aspire run` and builds one real PBI from this repo's own board, end to end.

**Files:**
- Create: `config/sources.yml`, `docs/superpowers/runbooks/phase-0.md`

- [ ] **Step 1: Name the board and sign in.** Write `config/sources.yml` with one entry: repo `ricksu978/software-factory`, the installation id from Task 2 Step 5, owner `{ type: user, login: ricksu978 }`, the personal Project's number, and a `fieldMap` whose `statusFor` uses that board's Status option names. Start `aspire run` and open the sign-in link from the control resource's console. Expected: Floor loads as owner and product owner, and `repo` and `backlog_source` each hold one row.
- [ ] **Step 2: Ready this repo as the target.**
  - This repo already holds `.factory/dod.md` and `.factory/dor.md` from the dogfood bootstrap.
  - Task 1 added `.factory/config.yml` with real `bdd` and `commands` entries, the Gherkin runner that writes Cucumber Messages to `reports/bdd.ndjson`, and CI that runs the scenarios as well as the unit tests. Done on merge depends on that CI.
  - Check all of these, and add a CODEOWNERS file.
  - In the personal Project's Workflows settings, turn off the built-in workflows that set status, including "Item closed" and "Pull request merged". The factory owns status.
  - **Branch protection.** Confirm `main` still requires a PR, one approving review, `lint` and Task 1's CI job (Global Constraints). Shadow mode posts no `risk-approval`, so that check isn't required yet.
  - Confirm the GitHub App is installed on this repo only.
- [ ] **Step 3: Run one PBI live, locally.** With `aspire run` up, take the next PBI from this repo's own backlog, labelled `factory` on the personal Project. Expected:
  - A readiness comment within one poll, and no webhooks are needed.
  - Scenarios posted on the PBI, and the sign-off question in the local dashboard's Run detail. Sign off there, because comment commands need the webhooks that arrive in Task 19.
  - A cell container started from `factory-cell:local`, visible in `docker ps`.
  - After your approval, a PR with red and green results, the review rounds, the `dod.md` checklist and a shadow tier.
  - A reviewer requested on the PR from CODEOWNERS.
  - After your merge and green CI on main, the item at Done and the issue closed.

  Record the run id and cost in the runbook. From here the factory builds the backlog's factory-labelled PBIs, still running locally.
- [ ] **Step 4: Test the five overrides locally.** Hold a second item, pause, drain, stop a run, and re-queue the stopped item. Record that each took effect within 30 seconds, using event timestamps against the moment of the click. Press the kill switch and record that every cell container stopped within a minute.
- [ ] **Step 5: Restart mid-run.** While a cell is in Green, stop `aspire run` and start it again within 2 minutes. Expected: the item, its events and its transcripts are still there, the running cell's next renewal succeeds, no second cell starts, and the old sign-in cookie is refused until you open the new link.
- [ ] **Step 6: Write `docs/superpowers/runbooks/phase-0.md`.** It covers how to start the factory with `aspire run`, set its parameters, sign in, add users, rotate the GitHub App key and the Claude token, replace the board token after the owner's `gh` login changes, revoke it by revoking the GitHub CLI's access in GitHub's settings, and use the kill switch.
- [ ] **Step 7: Commit** `docs: phase 0a runbook and first local live run`.

---
### Task 19: Azure platform and the cloud platform tests

Phase 0b starts here, once the walking skeleton runs locally (Task 18). The sign-in, webhook and runtime tests below can still change §11. This task builds no factory logic. It deploys the infrastructure and runs throwaway probes, then records what happened.

**Files:**
- Create: `infra/main.bicep`, `infra/main.bicepparam`, `.github/workflows/deploy.yml`, `spike/Dockerfile`, `docs/superpowers/spikes/2026-11-phase-0-platform.md`
- Reuse from Task 2: `spike/hello.ts`, `spike/sdk-oauth.ts`, `cell/Dockerfile` and `Dockerfile`

**Interfaces:**
- Produces: the deployed resources named below, which Task 20 deploys into, and the spike record, which Task 20 reads before it deploys the factory.

- [ ] **Step 1: Write `infra/main.bicep`** with these resources in resource group `rg-software-factory-aue`:
  - Log Analytics workspace `log-factory`.
  - Container Apps environment `cae-factory`, Consumption only.
  - ACR `acrfactory<uniqueString>`, Basic. The spec has not priced it, so record its monthly cost in the spike file.
  - User-assigned identities `id-factory-control`, `id-factory-cell`, `id-factory-deploy` and `id-factory-migrate`. The deploy identity is the one `deploy.yml` signs in as through OIDC. Its rights stop at the resource group: Owner on `rg-software-factory-aue` only, which it needs for the role assignments below. Its federated credential trusts one subject, `repo:ricksu978/software-factory:environment:production`. `deploy.yml` runs only into the `production` environment, whose required reviewer is the owner, and it has only a `workflow_dispatch` trigger, so a merge never deploys by itself. Starting it needs `actions: write`, which no cell token carries.
  - Storage roles for `id-factory-control`: Storage Blob Data Contributor and Storage Blob Delegator on the storage account, so it can sign write-only SAS URLs with a user delegation key. No account key is used.
  - Key Vault `kv-factory-<uniqueString>` with RBAC and five secrets: `github-app-key`, `github-project-token` (Task 2 Step 5), `claude-oauth-token`, `github-webhook-secret` and `cell-secret`, a random 32-byte value for signing run tokens. The control identity reads all five. The cell identity reads none of them, because cells reach the model through the control plane's gateway with a stand-in token (issue #33).
  - Storage account with `transcripts` and `reports` containers, Hot LRS.
  - Postgres Flexible Server `psql-factory-<uniqueString>`, B1ms, 32 GB, Entra auth only. Its firewall admits Azure services only, so no GitHub runner or laptop connects to it directly. The Entra admin is `id-factory-migrate`, a fourth identity attached only to `caj-factory-migrate`. A Postgres principal for `id-factory-control` must exist and be a member of `factory_app`, or the append-only grant never applies to the app. The migrate job creates it, because it runs as the Entra admin and the firewall keeps a laptop out. `migrate-cli.ts` calls `pg_catalog.pgaadauth_create_principal(roleName, isAdmin, isMfa)`, whose role name "must match the name of the Microsoft Entra principal" ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-manage-azure-ad-users)), then grants it `factory_app`.
  - Job `caj-factory-migrate`, manual trigger, running the control plane image in one container named `migrate`, with the command `node src/store/migrate-cli.ts`. That runs `migrate()` from Task 4, and with the dash-free first argument `seed-owner` it runs `scripts/seed-owner.ts`. Its env sets `PGHOST`, `PGDATABASE`, `PGUSER` to `id-factory-migrate`'s principal name, `AZURE_CLIENT_ID` to `id-factory-migrate`'s client id, and `FACTORY_APP_PRINCIPAL` to `id-factory-control`, so `createPool`'s Entra path signs in as the Entra admin and `migrate-cli.ts` grants the control principal `factory_app`. This is the only migration path, and Step 3 sets its order in `deploy.yml`. The control identity maps to a role `factory_app`, which can read and write the factory's tables but can only `SELECT` and `INSERT` on `event`. That keeps the event log append-only for the identity the app runs as.
  - Container App `ca-factory-control` at 0.5 vCPU and 1 GiB with external ingress. Its image comes from a `controlImage` parameter, which defaults to the public placeholder `mcr.microsoft.com/k8se/quickstart:latest`, so the Step 2b bootstrap works while ACR is still empty. The cell and migrate jobs take the same placeholder default. `deploy.yml` passes the ACR images, with the spike image for the app until Task 20. Its env takes `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_KEY`, `GITHUB_PROJECT_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `CELL_SECRET` from Key Vault references, the same names Task 2 gives the local control resource, and `CLAUDE_TOKEN_CREATED_AT` and `GITHUB_APP_ID` from `main.bicepparam`. For the database it gets `PGHOST`, `PGDATABASE`, `PGUSER` set to the control identity's Postgres principal name, and `AZURE_CLIENT_ID` set to `id-factory-control`'s client id, which `createPool`'s Entra path reads (Task 4). The Bicep sets neither `FACTORY_ENV` nor `FACTORY_DEV_LOGIN`.
  - Job `caj-factory-cell` with a manual trigger, 2 vCPU and 4 GiB and `replicaRetryLimit: 1`. It holds no Key Vault reference. The launcher gives each execution its stand-in token and the gateway URL, per Run contract 5.
  - An `authConfigs` child on the app with the Microsoft provider (any Entra directory and personal accounts), the Google provider, `unauthenticatedClientAction: RedirectToLoginPage`, and `globalValidation.excludedPaths: ['/webhooks/github', '/internal/cells', '/internal/model']`. A cell has no login session, so the gateway must sit outside sign-in like the cell API.
  - A custom role on the job for the control identity, granting job start and execution stop. Find the exact action names with `az provider operation show --namespace Microsoft.App`.
- [ ] **Step 2: Run `az bicep build --file infra/main.bicep`.** Expected: no errors. Then run `az deployment group what-if` against the resource group and read the resource list against Step 1.
- [ ] **Step 2b: Bootstrap once.** The deploy identity can't create itself. So the first deploy is yours, from your own `az login`: `az deployment group create -g rg-software-factory-aue -f infra/main.bicep -p infra/main.bicepparam`. Then add the federated credential above to `id-factory-deploy`, and create the repo's `production` environment with yourself as its required reviewer and `main` as its only deployment branch. Every later deploy runs through `deploy.yml`.
- [ ] **Step 3: Write `deploy.yml`.** It authenticates to Azure through OIDC federated credentials, never a stored secret. It runs in this order, and each step waits for the one before:
  Its only trigger is `workflow_dispatch`, and its job runs in the `production` environment, per the identity bullet in Step 1.
  1. Build both Dockerfiles with `docker buildx build --platform linux/amd64`, and push them to ACR with the commit sha as the tag. Build `spike/Dockerfile` the same way and push it as `control-spike:<sha>`. It starts from `node:26.13.0-bookworm`, installs the repo's dependencies, copies `spike/` and `src/`, because `spike/hello.ts` imports `src/control/model-gateway.ts` for Step 8, and runs `node spike/hello.ts`.
  2. Run the migrations on the new image: `az containerapp job start -n caj-factory-migrate -g rg-software-factory-aue --container-name migrate --image <acr>/control:<sha> --command node src/store/migrate-cli.ts`. The container name and command are passed explicitly, in case a start override replaces the template's container instead of merging into it (Step 10 checks which). Wait until that execution reports Succeeded, and stop the workflow if it doesn't.
  3. Run `az deployment group create` with the new image tags, which updates the app and the jobs. A `workflow_dispatch` input `control_image` overrides the control app's image only. When it's empty, the app gets `control-spike:<sha>`. The real control image polls the board that the local factory is still claiming from, so no Task 19 run deploys it. Task 20 Step 2 changes that default.

  So the new app code never runs before its migration.
- [ ] **Step 4: Deploy the spike.** Run `deploy.yml` with `control_image` empty. The app serves `spike/hello.ts` from Task 2, and its `GET /probe/sas` route stays off, because Azure doesn't set `FACTORY_ENV=local`.
- [ ] **Step 5: Sign-in test.** Sign in with a Google account, a personal Microsoft account and a work account from another tenant. Record each case's `x-ms-client-principal-idp` and `x-ms-client-principal-id`. Expected: all three reach `/` and show distinct ids.
- [ ] **Step 6: Header spoofing test.** Send `curl -H "X-MS-CLIENT-PRINCIPAL-ID: forged" https://<app>/` while signed out. Expected: a redirect to login, not a 200. Then send the same header to `/internal/cells/ping` and confirm the response doesn't echo the forged value as an authenticated identity. Last, `curl -X POST https://<app>/internal/model/v1/messages` with no credential. Expected: 401 from the gateway, not a login redirect, which proves the exclusion above took effect.
- [ ] **Step 7a: Turn on the App webhook.** The factory GitHub App was registered in Task 2 Step 5 with its webhook inactive. Point it at `https://<app>/webhooks/github`, set its secret, and subscribe it to issues, issue comment, pull request, pull request review, check suite and issue dependencies. Pull request review is a separate subscription from pull request, and "a GitHub App must have at least read-level access for the 'Pull requests' repository permission" to receive it ([GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review)). Personal accounts get no `projects_v2_item` webhook, so board changes still come through the 5-minute poll.
- [ ] **Step 7: Webhook test.** Point a GitHub App webhook at `https://<app>/webhooks/github` and trigger a delivery. Expected: 204 in the App's delivery log, and no login redirect. Change the secret on one side, then expect 401.
- [ ] **Step 8: SDK probe in Azure.** The cell job holds no Claude token, so the probe goes through a gateway, as every real cell will.
  - Before Step 4's deploy, `spike/hello.ts` gains an `/internal/model/*` route that calls `handleModelRequest` like Task 12, except that `verify` returns `{ webTools: [] }` only for the value of a `MODEL_PROBE_CREDENTIAL` env var, and null for anything else. While that var is unset, `verify` refuses everything, so the route answers 401, which is what Step 6 expects.
  - For the probe, set `MODEL_PROBE_CREDENTIAL` on `ca-factory-control` to a fresh random value. Run `spike/sdk-oauth.ts` from Task 2 as one execution of `caj-factory-cell`, with the two `cellModelEnv` variables pointing at `https://<app>/internal/model` and that value as the credential. Remove `MODEL_PROBE_CREDENTIAL` from the app once Step 9 is done.
  - Expected: `subtype: "success"`.
  - If the SDK refuses the token, run `claude -p "Reply with the word ready." --output-format json` in the same image. Record which one works. §14 already names the headless CLI as the fallback.
- [ ] **Step 9: Sandbox egress probe in Azure.** Run `spike/sdk-oauth.ts sandbox` in the same job, with the same two variables as Step 8.
  - Expected: example.com blocked, api.github.com allowed.
  - If the result is `error_during_execution` because bubblewrap can't start in Container Apps, record that. The egress allowlist then needs another mechanism, which is a pending decision.
- [ ] **Step 10: Job override probe.** Start one `caj-factory-migrate` execution with `--image` and `--args`, then read its resolved template with `az containerapp job execution show`. Record whether the job's env vars survived, such as the identity client id and the Postgres host. The az reference says only that `--image` starts "a job with different image and configurations" ([az containerapp job](https://learn.microsoft.com/en-us/cli/azure/containerapp/job)). If the env is dropped, add `--env-vars` for those values to both calls in Step 3 and Task 20.
- [ ] **Step 11: Record results** in `docs/superpowers/spikes/2026-11-phase-0-platform.md`. Give each probe its expected result, its actual result and the evidence: a command, a screenshot path or a delivery id. If Step 5, 7 or 8 fails, stop and raise it, because the spec's §11 changes before Task 20 starts.
- [ ] **Step 12: Commit** `chore: platform baseline and phase 0 platform tests`.

---

### Task 20: Deploy to Azure and run live there

Phase 0b's exit. The same factory, now on the platform Task 19 built.

**Files:**
- Modify: `deploy.yml`, so an empty `control_image` gives the app `control:<sha>` in place of the spike image
- Modify: `docs/superpowers/runbooks/phase-0.md`

- [ ] **Step 1: Deploy through `deploy.yml` with `control_image` empty,** which still gives the app the spike image (Task 19 Step 3), so the migrate and cell jobs get the real images while no Azure control plane polls the shared board or starts a cell. If Task 19 Step 5 recorded principal header names other than the two `identify` reads, fix `identify` first. Then seed yourself as the first owner and product owner through the migrate job: `az containerapp job start -n caj-factory-migrate -g rg-software-factory-aue --container-name migrate --command node src/store/migrate-cli.ts --args seed-owner provider=microsoft subject=<id> email=<you> github-login=<login> product-owner`. The words after `--args` carry no leading dashes, because az would read a dash-prefixed word as its own option and reject the call. Confirm the execution succeeded. The spike app has no allowlist, so the sign-in check waits for Step 2.6. Take the subject id from the Task 19 Step 5 spike record.
- [ ] **Step 2: Move the factory to Azure.** The Azure database starts empty, so nothing in flight may cross over.
  1. In the local dashboard, set drain. Wait until every local item is Done, Failed, Abandoned, NotReady, Eligible or Queued, so none is InProgress, SignOff, NeedsInput, InReview or Accepted and no PR is open. A held or stopped item is Failed and counts as settled.
  2. Record the local `/phase0` report in the runbook: merged factory PRs and cost per item. That's Phase 0a's share of the exit count, because Azure's `/phase0` reads only Azure's database.
  3. Stop `aspire run`.
  4. Delete every remote `factory/pbi-*` branch. No PR is open, and the Azure factory numbers its runs from 1, so an old branch would collide with its first run.
  5. Remove the `factory` label from any open Failed or Abandoned item you don't want rebuilt from scratch. Done items are closed, and `listEligible` skips closed items (Task 6).
  6. Merge the `deploy.yml` change from Files, then run `deploy.yml` again with `control_image` empty, so the app gets the real control image. Sign in, and confirm you get past the no-access page as owner and product owner. Expected after that: the same flow as Task 18 Step 3, plus sign-off by a `/approve` comment, now that the webhook is on.
- [ ] **Step 3: Test the five overrides in Azure.** Repeat Task 18 Step 4 against the deployed factory. The kill switch must stop every job execution within a minute.
- [ ] **Step 4: Extend the runbook** with the Azure deploy, the migrate job, the cutover above and the exit criteria: 10 merged factory PRs, counted as the 0a figure from Step 2 plus Azure's `/phase0`, cost per item, and your verdict on the shadow tiers.
- [ ] **Step 5: Commit** `docs: phase 0b runbook and first Azure live run`.

---
## Out of scope for Phase 0

These come from spec §13 Phases 1 to 3, and nothing here builds them:
- `pr-reviewer` in stage 8, stages 9 to 11, Increment records and stage 10's post-merge verification on main;
- an enforced `risk-approval` check and the `approval` table;
- budget caps, the Inbox and the Cost view;
- quarantine, adaptive and advised WIP, and Azure DevOps adapters.

The SOP file's `budget` block is recorded but not enforced, apart from the wall clock.
