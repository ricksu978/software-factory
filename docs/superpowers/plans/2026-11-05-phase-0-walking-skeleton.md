# Software Factory Phase 0 Implementation Plan

> **For agentic workers.** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Build the Phase 0 walking skeleton from spec §13. One GitHub repo and org-owned project, fixed WIP of 1, SOP stages 1 to 7 plus a thin stage 8 that addresses review feedback. A person merges and the item reaches Done once CI on main is green. The risk classifier runs in shadow mode, and the dashboard has Floor with its three strips, Run detail and five overrides: pause, drain, stop a run, hold an item and re-queue one.

**Architecture.** One TypeScript codebase with two entry points. The control plane runs as a single always-on Container App with the watcher, scheduler, dashboard and cell API. A cell runs as one Container Apps job execution per PBI and drives the Claude Agent SDK through the SOP stages. Cells never touch Postgres. They talk to the control plane's cell API with a per-run token fenced by the lease generation. Postgres is the only state store, and every state change appends to the `event` table.

**Tech Stack.** Node 26.13.0 LTS running `.ts` files directly through type stripping, `node:test`, TypeScript 7.0.2 for type checks only, `pg` 8.23.1, `yaml` 2.9.1, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@octokit/app` 16.1.4, `@azure/identity` 4.14.1, `@azure/arm-appcontainers` 4.0.0, `@azure/storage-blob` 12.34.0, `@testcontainers/postgresql` 12.2.1, Bicep for infrastructure.

**Spec.** `docs/superpowers/specs/2026-11-05-software-factory-design.html`, as revised on this plan's branch with the 14 flow-review fixes. §13's Phase 0 row is the scope. §14 lists the settled decisions this plan does not reopen.

## Global Constraints

- Region australiaeast. Control plane is one Container App at 0.5 vCPU and 1 GiB with external ingress. Cells are a Container Apps job, manual trigger, 2 vCPU and 4 GiB per replica, retry limit at least 1.
- Images are `linux/amd64` and build in CI. Never build them natively on the ARM64 dev machine.
- Postgres Flexible Server, Burstable B1ms, Microsoft Entra authentication with managed identities and no stored password.
- Transcripts go to Blob Storage, Hot LRS, and `stage_run.transcript_ref` points at them. Container logs go to Log Analytics.
- Key Vault holds the GitHub App private key and the Claude OAuth token. Cells get the token as `CLAUDE_CODE_OAUTH_TOKEN` and never run with `--bare`.
- Model IDs live in the SOP file only: `coding: claude-opus-5-5`, `triage: claude-haiku-5-5`.
- The Phase 0 backlog is a Project owned by a GitHub organization, and the target repo lives in that organization. A GitHub App can reach only organization-owned Projects. This was decided 2026-11-05.
- Eligibility label `factory`. Quality criteria live in the repo's policy files, per Run contract 11. A repo with no `.factory/dod.md` fails readiness for every item.
- Poll every 5 minutes on top of webhooks. Leases renew every 60 seconds and expire after 5 missed renewals. A cell stops itself after 3 minutes of failed renewals.
- `lease_generation` changes only as Run contract 2 says. A cell checks its generation before every push, comment and state write.
- NeedsInput and SignOff items get reminders at day 2 and day 4, and move to Abandoned after 5 days with no answer. An operator re-queue or a late answer brings an Abandoned item back.
- The scheduler starts nothing new while the waiting count (Run contract 3) reaches `review_capacity`, default 3, or while the last reported usage utilization is at or above `usage_reserve_at`, default 0.7.
- The factory owns board status. The project's built-in status workflows are off, factory PRs reference their item with `Refs #n`, and the factory closes the item at Done.
- Sign-off (`/approve`, `/changes <note>`) and answers (`/answer <text>`) are accepted as item comments from GitHub logins mapped to allowlisted users, and in Run detail.
- An override takes effect within 30 seconds. The kill switch stops every cell within a minute.
- Cell GitHub tokens are minted with explicit `permissions`: write on `contents`, `pull_requests` and `issues`, and nothing on `statuses` or `checks`.
- Phase 0 runs WIP fixed at 1, SOP stages 1 to 7, a thin stage 8, and the risk classifier in shadow mode. The thin stage 8 runs `pr-addresser` on requested changes and merge conflicts. Shadow mode records a tier on every PR and posts no `risk-approval` check.
- A merged item reaches Done once CI on main is green for the merge commit, so the target repo's CI runs its scenarios. `pr-reviewer`, stage 10's post-merge verification, stage 11, budget caps, Inbox, Cost view and quarantine belong to Phase 1.
- Sign-in via Container Apps built-in auth with Microsoft (any Entra directory and personal accounts) and Google. The app's own `user` table decides access, and roles are viewer, operator and owner.

## Review Focus

1. **Planted instructions in PBI text.** An item body that asks for secrets, CI changes or access outside the repo is flagged NotReady by the gate, and no cell token can post a status or check. Tests in Task 9 and Task 7.
2. **Zombie cell after lease expiry.** An old cell whose lease was re-claimed gets 409 on every cell API write, so it can't push, comment or move state. Test in Task 12.
3. **Duplicate or replayed webhook deliveries.** The same `X-GitHub-Delivery` id processed twice yields one event. A bad or missing signature yields 401 and no event. Tests in Task 7.
4. **Spoofed identity headers.** A request that carries `X-MS-CLIENT-PRINCIPAL` on an auth-excluded path never authenticates a dashboard action, and an unknown signed-in subject gets the no-access page. Tests in Task 15, plus a live check in Task 2.
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
5. **Cell context.** The cell's env holds only `RUN_ID`, `ITEM_ID`, `GENERATION`, `RUN_TOKEN`, `CONTROL_URL` and `RESUME_FROM`. Everything else comes from `GET /internal/cells/:runId/context`:
   - the item's external id, title and acceptance criteria;
   - `nextStage`;
   - the latest decision or answer, with its note;
   - `lockSha` and `lockedFiles`;
   - `prNumber`, `repo`, `base` and `branch`;
   - `configSha` and `sopVersion`.
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
11. **Policy files.** The factory hard-codes no quality criteria. Spec §6 "Policy files" defines five files: `dor.md`, `scenarios.md`, `pr-review.md`, `risk.md` and `dod.md`.
    - **Loading.** The factory reads them from the repo's `.factory/` at the run's pinned `config_sha`. Readiness has no run yet, so it reads the default branch head. A read that returns 404 means the file is absent. Any other read error throws, and the step retries on its next turn. A read error never falls back to a default.
    - **Defaults.** An absent file falls back to `$FACTORY_POLICY_DIR/<name>.md`, except `dod.md`, which has no default. A default's `sha` is the SHA-256 of its text, so a changed default counts as a policy change. Both images copy the factory's `policy/` folder to `/app/policy`, which is the default value of `FACTORY_POLICY_DIR`. A repo file replaces its default whole.
    - **Criteria.** Only `dor.md`, `pr-review.md` and `dod.md` have criteria, one per top-level `- [ ]` line, numbered from 1 in file order. The judge answers one JSON line per criterion: `{"index","status","reason"}`, where `status` is `passed`, `failed` or, in `dod.md` only, `person`. `person` means the line can only be met by a person or after merge, such as "deployed to staging". It goes to the PR checklist unticked and never counts as a fail. A missing index fails, and when an index appears twice, a fail wins. `scenarios.md` and `risk.md` are guidance, given whole to the agent that uses them.
    - **Commands.** A criterion holding `` `run: <command>` `` is allowed only in `dod.md`. `loadPolicy` rejects it in any other file with `PolicyError`. The cell runs `dod.md` commands at the end of green, in the checkout, as `execFile("sh", ["-c", command], { cwd, timeout: 900_000, env: { PATH, HOME, CI: "true" } })`. That env carries none of the cell's tokens. It isn't a sandbox, though: the command runs as the cell's own user, as `commands.test` does and as the agent does. So it has no more reach than the agent that wrote the code already has.
    - **Results.** Every result is stored in `policy_result`, with `source` set to `repo` or `default`. The control plane writes readiness rows itself, and the cell sends its rows through `POST /policy-results` (Task 12).
    - **Re-gating.** `item.readiness_policy_sha` records the `dor.md` blob sha, or `default`, that the item's last readiness check used. When that changes, the poller re-runs the gate on the item.
    - **Engine rules.** The rules no policy file can weaken are the list under "What stays in the engine" in spec §6. They live in code and prompts that the factory owns.

---

## File structure

```
package.json, tsconfig.json
.github/workflows/ci.yml           typecheck + tests on every push
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
src/control/decisions.ts           decide(): sign-off and answers from both channels
src/scheduler/scheduler.ts, launcher.ts
src/http/server.ts, auth.ts, views.ts, routes.ts
src/main.ts                        control plane entry
sop/default.yml, sop/prompts/*.md
cell/Dockerfile, cell/claude/agents/self-reviewer.md, cell/claude/agents/pr-addresser.md
Dockerfile                         control plane image
spike/hello.ts, spike/sdk-oauth.ts
docs/superpowers/spikes/2026-11-phase-0-platform.md
```

Tests sit next to their code as `*.test.ts` and run with `node --test "src/**/*.test.ts"`.

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `.gitignore`, `src/core/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs `node --test "src/**/*.test.ts"`. `npm run typecheck` runs `tsc --noEmit`. Imports use explicit `.ts` extensions.

- [ ] **Step 1: Write `package.json`** with `"type": "module"`, `"engines": {"node": ">=26.13.0"}`, the exact versions from the Tech Stack line, and scripts `test`, `typecheck`, `start:control` (`node src/main.ts`) and `start:cell` (`node src/cell/main.ts`).
- [ ] **Step 2: Write `tsconfig.json`** with `strict`, `noEmit`, `module: nodenext`, `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`. Erasable syntax means no `enum`, `namespace` or parameter properties anywhere in the codebase.
- [ ] **Step 3: Write one smoke test** `src/core/smoke.test.ts` that asserts `1 + 1 === 2`, then run `npm test`. Expected: 1 pass.
- [ ] **Step 4: Run `npm run typecheck`.** Expected: exit 0.
- [ ] **Step 5: Write `ci.yml`** to run on push and PR with `actions/setup-node` at `26.13.0`, `npm ci`, `npm run typecheck` and `npm test`. Docker must be available on the runner for Testcontainers, so use `ubuntu-latest`.
- [ ] **Step 6: Commit** `chore: project skeleton`.

---

### Task 2: Platform baseline and the three Phase 0 tests

The spec says these tests come first, because their results can change §11. This task builds no factory logic. It deploys the infrastructure and runs throwaway probes, then records what happened.

**Files:**
- Create: `infra/main.bicep`, `infra/main.bicepparam`, `.github/workflows/deploy.yml`, `spike/hello.ts`, `spike/sdk-oauth.ts`, `cell/Dockerfile`, `Dockerfile`, `docs/superpowers/spikes/2026-11-phase-0-platform.md`

**Interfaces:**
- Produces: deployed resources named below, which every later task deploys into. Produces the spike record, which Tasks 11, 15 and 16 read before they start.

- [ ] **Step 1: Write `infra/main.bicep`** with these resources in resource group `rg-software-factory-aue`:
  - Log Analytics workspace `log-factory`.
  - Container Apps environment `cae-factory`, Consumption only.
  - ACR `acrfactory<uniqueString>`, Basic. The spec has not priced it, so record its monthly cost in the spike file.
  - User-assigned identities `id-factory-control`, `id-factory-cell`, `id-factory-deploy` and `id-factory-migrate`. The deploy identity is the one `deploy.yml` signs in as through OIDC. Its rights stop at the resource group: Owner on `rg-software-factory-aue` only, which it needs for the role assignments below. Its federated credential trusts one subject, `repo:<org>/software-factory:environment:production`. `deploy.yml` runs only from `main` into the `production` environment, which has required reviewers set in GitHub.
  - Storage roles for `id-factory-control`: Storage Blob Data Contributor and Storage Blob Delegator on the storage account, so it can sign write-only SAS URLs with a user delegation key. No account key is used.
  - Key Vault `kv-factory-<uniqueString>` with RBAC and three secrets: `github-app-key`, `claude-oauth-token` and `cell-secret`, a random 32-byte value for signing run tokens. The control identity reads all three. The cell identity reads only `claude-oauth-token`.
  - Storage account with `transcripts` and `reports` containers, Hot LRS.
  - Postgres Flexible Server `psql-factory-<uniqueString>`, B1ms, 32 GB, Entra auth only. Its firewall admits Azure services only, so no GitHub runner or laptop connects to it directly. The Entra admin is `id-factory-migrate`, a fourth identity attached only to `caj-factory-migrate`.
  - Job `caj-factory-migrate`, manual trigger, running the control plane image in one container named `migrate`, with the command `node src/store/migrate-cli.ts`. That runs `migrate()` from Task 4, and with the dash-free first argument `seed-owner` it runs `scripts/seed-owner.ts`. This is the only migration path, and Step 4 sets its order in `deploy.yml`. The control identity maps to a role `factory_app`, which can read and write the factory's tables but can only `SELECT` and `INSERT` on `event`. That keeps the event log append-only for the identity the app runs as.
  - Container App `ca-factory-control` at 0.5 vCPU and 1 GiB with external ingress. Its image comes from a `controlImage` parameter, which defaults to the public placeholder `mcr.microsoft.com/k8se/quickstart:latest`, so the Step 2b bootstrap works while ACR is still empty. The cell and migrate jobs take the same placeholder default. `deploy.yml` passes the real ACR images, the spike image first. Its env takes `CLAUDE_CODE_OAUTH_TOKEN` and `CELL_SECRET` from Key Vault references, and `CLAUDE_TOKEN_CREATED_AT` from `main.bicepparam`, set to the date you ran `claude setup-token`.
  - Job `caj-factory-cell` with a manual trigger, 2 vCPU and 4 GiB, `replicaRetryLimit: 1`, and `CLAUDE_CODE_OAUTH_TOKEN` from a Key Vault secret reference.
  - An `authConfigs` child on the app with the Microsoft provider (any Entra directory and personal accounts), the Google provider, `unauthenticatedClientAction: RedirectToLoginPage`, and `globalValidation.excludedPaths: ['/webhooks/github', '/internal/cells']`.
  - A custom role on the job for the control identity, granting job start and execution stop. Find the exact action names with `az provider operation show --namespace Microsoft.App`.
- [ ] **Step 2: Run `az bicep build --file infra/main.bicep`.** Expected: no errors. Then run `az deployment group what-if` against the resource group and read the resource list against Step 1.
- [ ] **Step 2b: Bootstrap once.** The deploy identity can't create itself. So the first deploy is yours, from your own `az login`: `az deployment group create -g rg-software-factory-aue -f infra/main.bicep -p infra/main.bicepparam`. Then add the federated credential above to `id-factory-deploy`. Every later deploy runs through `deploy.yml`.
- [ ] **Step 3: Write `spike/hello.ts`**, a `node:http` server with three routes:
  - `GET /`, which returns every request header that starts with `x-ms-client-principal`.
  - `POST /webhooks/github`, which verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` and returns 204 or 401.
  - `POST /internal/cells/ping`, which returns 204.
- [ ] **Step 4: Write `deploy.yml`.** It authenticates to Azure through OIDC federated credentials, never a stored secret. It runs in this order, and each step waits for the one before:
  1. Build both Dockerfiles with `docker buildx build --platform linux/amd64`, and push them to ACR with the commit sha as the tag.
  2. Run the migrations on the new image: `az containerapp job start -n caj-factory-migrate -g rg-software-factory-aue --container-name migrate --image <acr>/control:<sha> --command node src/store/migrate-cli.ts`. The container name and command are passed explicitly, in case a start override replaces the template's container instead of merging into it (Step 10b checks which). Wait until that execution reports Succeeded, and stop the workflow if it doesn't.
  3. Run `az deployment group create` with the new image tags, which updates the app and the jobs.

  So the new app code never runs before its migration.
- [ ] **Step 5: Sign-in test.** Sign in with a Google account, a personal Microsoft account and a work account from another tenant. Record each case's `x-ms-client-principal-idp` and `x-ms-client-principal-id`. Expected: all three reach `/` and show distinct ids.
- [ ] **Step 6: Header spoofing test.** Send `curl -H "X-MS-CLIENT-PRINCIPAL-ID: forged" https://<app>/` while signed out. Expected: a redirect to login, not a 200. Then send the same header to `/internal/cells/ping` and confirm the response doesn't echo the forged value as an authenticated identity.
- [ ] **Step 7a: Organization and App.** Create a free GitHub organization for Phase 0. Creating it is your step, because the API can't create organizations for a personal account. Then register the factory GitHub App with this setup:
  - Repository permissions: write on contents, pull requests and issues, read on checks, commit statuses and metadata. Phase 1 raises commit statuses to write, when it starts posting `risk-approval`.
  - Organization permissions: write on organization projects.
  - App webhook events: issues, issue comment, pull request, pull request review, check suite and issue dependencies. Pull request review is a separate subscription from pull request, and "a GitHub App must have at least read-level access for the 'Pull requests' repository permission" to receive it ([GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review)).

  GitHub doesn't offer `projects_v2_item` to App webhooks, so also add an organization webhook for that event. It goes to the same `/webhooks/github` URL with the same secret. Install the App on the organization, scoped to the selected repos only. Store its private key in Key Vault as `github-app-key`.
- [ ] **Step 7: Webhook test.** Point a GitHub App webhook at `https://<app>/webhooks/github` and trigger a delivery. Expected: 204 in the App's delivery log, and no login redirect. Change the secret on one side, then expect 401.
- [ ] **Step 8: Write `spike/sdk-oauth.ts`.** It calls `query({ prompt: "Reply with the word ready.", options: { model: "claude-haiku-5-5", maxTurns: 1, settingSources: [] } })` and prints each message's `type`. It also prints the result's `subtype`, `is_error`, `total_cost_usd` and `modelUsage`. Run it as one execution of `caj-factory-cell`.
  - Expected: `subtype: "success"`.
  - If the SDK refuses the token, run `claude -p "Reply with the word ready." --output-format json` in the same image. Record which one works. §14 already names the headless CLI as the fallback.
- [ ] **Step 9: Sandbox egress probe.** In the same job, run `query()` with `sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains: ["api.github.com", "github.com", "registry.npmjs.org"], strictAllowlist: true } }`. Ask it to run `curl -sI https://example.com` and then `curl -sI https://api.github.com`.
  - Expected: example.com blocked, api.github.com allowed.
  - If the result is `error_during_execution` because bubblewrap can't start in Container Apps, record that. The egress allowlist then needs another mechanism, which is a pending decision.
- [ ] **Step 10: Bot assignment probe.** Try to assign the GitHub App's bot user to an issue. Use `gh api repos/<o>/<r>/issues/<n>/assignees -f assignees[]=<app-slug>[bot]` with an installation token. Record whether GitHub accepts it.
- [ ] **Step 10b: Job override probe.** Start one `caj-factory-migrate` execution with `--image` and `--args`, then read its resolved template with `az containerapp job execution show`. Record whether the job's env vars survived, such as the identity client id and the Postgres host. The az reference says only that `--image` starts "a job with different image and configurations" ([az containerapp job](https://learn.microsoft.com/en-us/cli/azure/containerapp/job)). If the env is dropped, add `--env-vars` for those values to both calls in Step 4 and Task 18.
- [ ] **Step 11: Record results** in `docs/superpowers/spikes/2026-11-phase-0-platform.md`. Give each probe its expected result, its actual result and the evidence: a command, a screenshot path or a delivery id. If Step 5, 7 or 8 fails, stop and raise it, because the spec's §11 changes before Task 3 starts.
- [ ] **Step 12: Commit** `chore: platform baseline and phase 0 platform tests`.

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
- Create: `db/migrations/001_init.sql`, `src/store/db.ts`, `src/store/items.ts`, `src/store/events.ts`, `src/store/runs.ts`, `src/store/migrate-cli.ts`, `src/store/test-db.ts`, `src/store/items.test.ts`. `migrate-cli.ts` is the migrate job's entry point. It runs `migrate()`. When its first argument is the word `seed-owner`, it hands the remaining `key=value` words to `scripts/seed-owner.ts` from Task 15. Arguments carry no leading dashes, because `az containerapp job start --args` reads any dash-prefixed word as one of its own options. It exits 1 on any word it doesn't recognise, so a mistyped seed never passes as a plain migration.

**Interfaces:**
- Consumes: `next`, `ItemState`, `ItemEvent` from Task 3.
- Produces:
  - `createPool(url?: string): pg.Pool`. Without a URL it connects as the managed identity, using an Entra token from `@azure/identity` `DefaultAzureCredential` with scope `https://ossrdbms-aad.database.windows.net/.default`.
  - `migrate(pool): Promise<void>`, which applies `db/migrations/*.sql` in name order and tracks them in `schema_migrations`.
  - `withTx<T>(pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>`
  - `appendEvent(c, e: { actor: "agent" | "human" | "system"; actorId: string; itemId: string | null; kind: string; payload: unknown }): Promise<void>`. It also runs `NOTIFY factory_events`.
  - `transitionItem(c, itemId: string, event: ItemEvent, actor: Actor): Promise<ItemState>`. It throws `IllegalTransition` when `next` returns null. It writes `item.state` and the event row in one transaction, and applies Run contract 2 to the lease columns.
  - `onTransition(hook: (itemId: string, from: ItemState, to: ItemState, event: ItemEvent) => Promise<void>): void` registers the hook that runs after each committed transition. Task 12 registers the board mirroring from Run contract 8.
  - `upsertItem(c, item: FactoryItem): Promise<string>`, keyed on `(source_id, external_id)`.
  - `startTestDb(): Promise<{ pool: pg.Pool; stop(): Promise<void> }>`, which uses `@testcontainers/postgresql` with image `postgres:17` and runs `migrate`.

- [ ] **Step 1: Write `001_init.sql`** with the §12 tables Phase 0 uses: `backlog_source`, `repo`, `user`, `item`, `run`, `stage_run`, `event`, `question`, `override`, `wip_policy` and `policy_result`. Use the merged spec's columns, plus these Phase 0 columns:
  - `item.held boolean default false`, for the hold override.
  - `item.priority int default 0`, for factory queue order.
  - `user.product_owner boolean default false`. Only product owners sign off scenarios.
  - `user.github_login text unique`, which maps item comments to a user.
  - `item.criteria_hash text`, the SHA-256 of the acceptance criteria the run started from.
  - `question.reminders_sent int default 0`.
  - `wip_policy.usage_reserve_at numeric default 0.7` and `wip_policy.usage_paused_until timestamptz`.
  - `run.next_stage text`, the resume pointer from Run contract 1.
  - `run.run_number int`, counting runs per item, for the branch name in Run contract 7.
  - `run.scenarios_sha text` and `run.locked_files text[]`, written when Specify posts scenarios. `decide` copies `scenarios_sha` into `features_lock_sha` on approve.
  - `run.pr_number int`, `run.reviews_seen_at timestamptz` (Run contract 10) and `run.merge_sha text`.
  - `run.resume_at timestamptz`, for usage-limit stalls.
  - `run.execution_name text`, the Container Apps execution.
  - `stage_run.report_ref text`, the BDD report a red or green stage uploaded.
  - `webhook_delivery(id text primary key, received_at timestamptz)`, for dedupe.
  - `item.readiness_policy_sha text`, for the re-gate in Run contract 11.

  Skip `increment` and `approval`, which belong to Phase 1. The migration also creates role `factory_app` with the grants Task 2 names. Its `event` grant is `SELECT, INSERT` only.
- [ ] **Step 2: Write failing tests** in `items.test.ts` against `startTestDb()`:
  - `transitionItem` moves Eligible to Queued on `ready` and writes exactly one event with `kind = "transition"` and `payload = { from: "Eligible", to: "Queued", event: "ready" }`.
  - `transitionItem` on `Done` with `claimed` throws `IllegalTransition`, and both the item and the event table are unchanged.
  - `upsertItem` called twice with the same `(source_id, external_id)` returns the same id.
  - **Generations.** A transition out of InProgress raises `lease_generation` by 1 and clears `lease_owner` and `lease_expires`. A transition between two non-InProgress states leaves all three untouched.
  - **Append-only.** Connected as `factory_app`, an `UPDATE event` fails with a permission error.
- [ ] **Step 3: Run `node --test src/store/items.test.ts`.** Expected: FAIL.
- [ ] **Step 4: Implement** `db.ts`, `events.ts`, the item functions in `items.ts`, and the empty `runs.ts` exports used later.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(store): schema, transitions and event log`.

---

### Task 5: Leases and claiming

**Files:**
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
  - **Claim order.** `claimNext` picks a SignOff or NeedsInput item whose `question` has an answer before any Queued item. Among Queued items it picks highest `priority`, then lowest `backlog_rank`. It skips `held` items and items with an open dependency. It moves the claimed item to InProgress through `transitionItem(..., "claimed")`.
  - **Generations.** Each claim sets `lease_generation` to the previous value plus 1, and `lease_expires = now + 300s`. That is the claim half of Run contract 2.
  - **Renewal.** `renewLease` with the current generation returns `"ok"` and pushes `lease_expires` out. With an older generation it returns `"lost"` and changes nothing.
  - **Expiry.** `expireLeases(now + 301s)` returns the item, moves it to Queued through `lease_expired`, and leaves `run.next_stage` unchanged, so a new cell resumes there. An expired `lease_expires` on an item that isn't InProgress is ignored.
  - **Concurrency.** Two concurrent `claimNext` calls with one Queued item return one claim and one null. Use `SELECT ... FOR UPDATE SKIP LOCKED`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the four functions. A claim of an item with no open run creates a `run` row. The scheduler fills `sop_version`, `config_sha` and `repo_id` right after the claim, in Task 13.
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
  | { kind: "review"; prNumber: number; repo: string; state: "changes_requested" | "approved" | "commented"; submittedAt: string }
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
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure">;
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>; // CODEOWNERS first
  prState(repo: string, prNumber: number): Promise<{ merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; lastChangesRequestedAt: string | null }>;
  closePr(repo: string, prNumber: number, comment: string): Promise<void>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  defaultBranchSha(repo: string): Promise<string>;
}
```

  `contract.ts` exports `backlogContract(name: string, make: () => Promise<{ adapter: BacklogAdapter; seed(item: Partial<FactoryItem>): Promise<string> }>)`. It registers `node:test` cases.

- [ ] **Step 1: Write the contract suite.** Each case runs against the adapter that `make` returns:
  - `listEligible` returns only items carrying the opt-in label.
  - Calling `comment` twice with the same `dedupeKey` leaves one comment, which is the spec §10 idempotency rule.
  - `claim` followed by `getItem` shows the factory's in-progress marker, and `release` clears it.
  - `setStatus("Done")` round-trips through `getItem().status`.
  - `parseWebhook` on an unknown payload returns `{ kind: "ignored" }` and never throws.
  - `close` followed by `getItem` shows `closed: true`.
- [ ] **Step 2: Write `fake.test.ts`**, which calls `backlogContract("fake", ...)`. Run it. Expected: FAIL.
- [ ] **Step 3: Implement `fake.ts`** as an in-memory map. The claim marker is a `factory:in-progress` label. The Task 2 bot assignment probe decides whether the GitHub adapter also assigns the App.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(adapters): interfaces, fake adapter, contract suite`.

---

### Task 7: GitHub adapters and webhook intake

**Files:**
- Create: `src/adapters/github/app.ts`, `src/adapters/github/backlog.ts`, `src/adapters/github/repo-host.ts`, `src/adapters/github/backlog.contract.test.ts`, `src/watcher/webhook.ts`, `src/watcher/webhook.test.ts`, `src/adapters/github/app.test.ts`

**Interfaces:**
- Consumes: `BacklogAdapter`, `RepoHost` and `backlogContract` from Task 6, and `appendEvent` from Task 4.
- Produces:
  - `githubBacklog(cfg: { app: App; installationId: number; projectNodeId: string; fieldMap: FieldMap }): BacklogAdapter`, with `capabilities.webhooks = true`. Issue, PR, check and dependency events come from the App webhook. Project item changes come from the organization's `projects_v2_item` webhook, and `parseWebhook` maps them to `item_changed`. That event is still in public preview, so the 5-minute poll stays the backstop.
  - `githubRepoHost(app: App, installationId: number): RepoHost`, used only in the control plane, which holds the App key.
  - `cellRepoHost(getToken: () => Promise<string>): Pick<RepoHost, "openOrUpdatePr" | "requestReviewers">`, used in the cell with the token from `/github-token`. Checks reach the cell only through the cell API, per Run contract 6.
  - `verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean`
  - `handleWebhook(deps, req: { headers; rawBody: Buffer }): Promise<{ status: 204 | 401 | 200 }>`
- `FieldMap` mirrors the spec: `{ acceptanceCriteriaHeading: string; statusField: string; statusFor: Record<ItemState, string | null>; optInLabel: string; sprintField: string | null; readinessFields: string[] }`. `readinessFields` names board fields, such as Size, that the readiness check passes to the judge, so `dor.md` can refer to them. `statusFor` names the board status for each factory state, and a null entry leaves the board alone. For example, Queued maps to "Todo", InProgress, SignOff and NeedsInput map to "In Progress", InReview maps to "In Review", Done maps to "Done", and Eligible maps to null.

- [ ] **Step 1: Write failing tests:**
  - `verifySignature` returns true for `sha256=` plus the HMAC-SHA256 hex digest of the body. It returns false for a one-character change, a missing header and a `sha1=` header.
  - Calling `handleWebhook` twice with the same `X-GitHub-Delivery` stores one `webhook_delivery` row and one event. The second call returns 200 with no event.
  - `handleWebhook` with a bad signature returns 401 and writes nothing.
  - `cellToken` sends `permissions: { contents: "write", pull_requests: "write", issues: "write" }` and `repositories: [repo]`, and the body has no `statuses` or `checks` key. Assert this against a stubbed `app.octokit.request`.
  - `parseWebhook` maps an `issue_comment` with action `created` to `{ kind: "comment" }`, and a `pull_request_review` with action `submitted` to `{ kind: "review" }` with the review's state lowercased. A comment by the App's own bot user maps to `ignored`, so the factory never reacts to its own posts.
  - `requestReviewers` returns the CODEOWNERS owners of the changed files when the repo has a CODEOWNERS file, and `fallback` otherwise.
  - `prState` reports `lastChangesRequestedAt` as the `submitted_at` of the newest review in state `CHANGES_REQUESTED`, and null when there is none. That is the poller's backstop for a missed review webhook, under Run contract 10.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `verifySignature` uses `crypto.createHmac` and `crypto.timingSafeEqual` after a length check.
  - The backlog adapter reads Project v2 items through GraphQL `node(id:) { ... on ProjectV2 { items } }`.
  - Acceptance criteria come from the list under the `acceptanceCriteriaHeading` heading in the issue body.
  - Dependencies come from `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by`, filtered to open issues.
  - `comment` stores the `dedupeKey` as an HTML comment, `<!-- factory:KEY -->`, and checks for it before posting.
- [ ] **Step 4: Run the unit tests.** Expected: PASS.
- [ ] **Step 5: Run the contract suite against GitHub.** `backlog.contract.test.ts` calls `backlogContract("github", ...)` against a sandbox org project, and only when `FACTORY_GH_CONTRACT=1` is set. Run it with that variable. Expected: every contract case passes.
- [ ] **Step 6: Commit** `feat(github): backlog and repo host adapters, webhook intake`.

---

### Task 8: Poller and watcher loop

**Files:**
- Create: `src/watcher/poller.ts`, `src/watcher/poller.test.ts`

**Interfaces:**
- Consumes: `BacklogAdapter`, `upsertItem`, `transitionItem`, and `gate`, `parseRepoConfig` and `loadPolicy` from Task 9.
- Produces: `pollOnce(deps: { pool; adapter: BacklogAdapter; repoHost: RepoHost; judge: (item: FactoryItem, dor: Policy) => Promise<string>; sourceId: string }): Promise<{ seen: number; cursor: string }>`. It writes the gate's verdicts to `policy_result`, and stores `item.readiness_policy_sha` from `dor.sha`. Also `POLL_INTERVAL_MS = 300_000`.
- Each `pollOnce` does four things:
  - lists new and changed eligible items from the cursor;
  - calls `getItem` for every item the factory holds in Queued, InProgress, SignOff, NeedsInput or InReview, because `listEligible` can't see an item that lost its label or closed;
  - runs `gate` on every Eligible item;
  - reads `prState` for every InReview item.
- The moves below leave InProgress where the item was running, so `transitionItem` fences the old cell per Run contract 2.

- [ ] **Step 1: Write failing tests** with the fake adapter:
  - A new labelled item becomes an `item` row in Eligible.
  - An edit to a NotReady item moves it to Eligible through `item_edited`.
  - A Done item that loses its label is left alone.
  - The cursor persists in `backlog_source.cursor`, so a second `pollOnce` with no changes upserts nothing.
  - A paused `backlog_source` is skipped.
  - **Gate.** An Eligible item that passes `gate` moves to Queued through `ready`. One that fails moves to NotReady through `readiness_failed` with a reasons comment. The gate's `configValid` comes from `parseRepoConfig` on the repo's `.factory/config.yml` at the default branch. Its `dor` comes from `loadPolicy` on the same commit, and `dodExists` is whether `loadPolicy(..., "dod")` returned a file.
  - **Criteria change.** An InReview item whose criteria now hash differently from `item.criteria_hash` moves to Queued through `criteria_changed`. In the same transaction:
    - `item.criteria_hash` takes the new value, so the next poll sees no change and fires nothing more;
    - a new `run` row starts at `understand` on a new branch, per Run contract 7;
    - its PR is closed with a comment, and the open question, if any, closes.

    The item gets a comment saying the scenarios need a new sign-off. The same holds from Queued, InProgress, SignOff and NeedsInput, and a second `pollOnce` after the change fires nothing.
  - **Withdrawal.** An InProgress item returned by `getItem` with the label gone, or with `closed: true`, moves to Abandoned through `withdrawn`, which fences its cell. An InReview item does the same. Either way an open PR is closed by Run contract 8.
  - **Conflict or requested changes.** An InReview item whose PR reports `mergeable: false`, or a `lastChangesRequestedAt` after `run.reviews_seen_at`, moves to Queued through `changes_requested`, with `run.next_stage = "address"`. Two tests cover the edges:
    - **Addressed review.** After address has run, a review older than its claim leaves the item in InReview on the next poll.
    - **Review during address.** A review submitted while address was running requeues the item on the first poll after it returns to InReview.
  - **Policy change.** After the repo's `dor.md` changes on the default branch, so its sha no longer matches `item.readiness_policy_sha`, the next `pollOnce` moves every NotReady item to Eligible through `policy_changed`. The gate then runs as usual, and an item that now passes moves to Queued. A repo on the default file gets the same re-gate when a deploy changes `policy/dor.md`, because the default's sha is the SHA-256 of its text.
  - **Missed merge.** An InReview item whose PR reports `merged: true` moves to Accepted through `merged`, recording `merge_sha`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `pollOnce`.** The control plane calls it every 5 minutes and also on each `item_changed` webhook event.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(watcher): polling with cursor`.

---

### Task 9: Repo config, SOP loader, policy files and readiness gate

**Files:**
- Create: `src/config/repo-config.ts`, `src/config/sop.ts`, `src/gate/readiness.ts`, `src/policy/policy.ts`, and a `*.test.ts` next to each. Also `policy/dor.md`, `policy/scenarios.md`, `policy/pr-review.md` and `policy/risk.md`.

**Interfaces:**
- Produces:
  - `parseRepoConfig(yamlText: string | null): RepoConfig`, where `RepoConfig = { sensitivePaths: string[]; reviewers: string[]; bdd: { parse: string; run: string; report: string }; commands: { test: string; lint: string } }`. Defaults: `sensitivePaths: []` and `reviewers: []`. A missing `bdd` or `commands` key throws `ConfigError` naming the key.
  - `loadSop(yamlText: string): Sop`, which validates stage ids, `models.coding` and `models.triage`. A stage `model` must name a key in `models`.
  - In `src/policy/policy.ts`, per Run contract 11:
    - `type Criterion = { index: number; text: string; run: string | null }` and `type Verdict = { index: number; criterion: string; status: "passed" | "failed" | "person"; reason: string }`. `person` is valid only in `dod.md`, and anywhere else it counts as `failed`.
    - `type Policy = { name: "dor" | "scenarios" | "pr-review" | "risk" | "dod"; source: "repo" | "default"; sha: string; text: string; criteria: Criterion[] }`. `criteria` is empty for `scenarios` and `risk`.
    - `loadPolicy(read: (path: string) => Promise<string | null>, name: Policy["name"]): Promise<Policy | null>`. `read` returns null only on a 404 and throws on any other error. `loadPolicy` returns null only for a missing `dod.md`, and throws `PolicyError` when a file other than `dod.md` holds a `run:` line.
    - `parseCriteria(markdown: string): Criterion[]`
    - `parseJudgement(reply: string, policy: Policy): Verdict[]`, keyed by index per Run contract 11
  - `gate(item: FactoryItem, ctx: { dor: Policy | null; dodExists: boolean; configValid: boolean; repoKnown: boolean; openDeps: string[]; judge: (item: FactoryItem, dor: Policy) => Promise<string> }): Promise<{ ready: boolean; results: Verdict[] }>`. `dor` is null when the repo is unknown, and the engine's rules fail the item before any policy is read.
  - Tests pass a fake `judge`. The real one, `haikuJudge`, comes in Task 11.
  - Write the four default files under `policy/`. `dor.md` holds three criteria: every acceptance criterion can become a Given/When/Then scenario, the scope is clear enough to build without guessing, and the item fits one Sprint. `scenarios.md` holds the spec's business-language rules. `pr-review.md` holds the rubric the vendored reviewer used to carry: correctness and security, what the linked item asks for, and following the repo's `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`. `risk.md` holds the examples column of the spec's Risk tiers table, as guidance.

- [ ] **Step 1: Write failing tests:**
  - `parseRepoConfig(null)` throws `ConfigError("bdd")`. A repo with no config can't run BDD, so it can't be ready.
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
  - **Repo wording.** With a repo `dor.md` whose only line is "Has a Size of 5 or less", and an item whose readiness field Size is 8, the fake judge's failure for that line becomes the item's NotReady comment, word for word.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The gate parses the judge's reply with `parseJudgement`, plus a last line `{"flags":[]}`. The item is ready only when every `dor.md` criterion passed and `flags` is empty. The caller writes every result to `policy_result` with a null `run_id`. The gate comments the failed lines by name through `adapter.comment`, under `dedupeKey = "readiness:" + item.updatedAt + ":" + (dor?.sha ?? "none")`, so a re-gate after a policy change posts a new comment. It never edits the item.
  - **Validate everything at readiness.** The caller also runs `loadPolicy` on `scenarios`, `pr-review` and `risk`. A `PolicyError` from any of the five files fails the item, with the error as a named reason, so a broken file never reaches a cell.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gate): repo config, SOP loader, readiness gate`.

---

### Task 10: BDD evidence: red, green and the lock

**Files:**
- Create: `src/bdd/messages.ts`, `src/bdd/lock.ts`, `src/bdd/messages.test.ts`, `src/bdd/lock.test.ts`, `src/bdd/fixtures/*.ndjson`

**Interfaces:**
- Produces:
  - `classify(ndjson: string): Map<string, { name: string; tags: string[]; verdict: "red" | "green" | "crash"; reason: string }>`, keyed by pickle id.
  - `redGate(results, pbiTag: string): { ok: boolean; findings: string[] }`, which is ok only when every scenario tagged `pbiTag` is red. Per Run contract 4, other scenarios are ignored here.
  - `greenGate(results): { ok: boolean; findings: string[] }`, which is ok only when every scenario in the suite is green.
  - `traceability(results, criteriaCount: number, pbiTag: string): string[]`, which lists every `@ac-N` with no scenario tagged `pbiTag`.
  - `matchesLock(repoDir: string, lockSha: string, files: string[]): Promise<boolean>`, which diffs only the locked files.

- [ ] **Step 1: Write fixtures.** Hand-write small Cucumber Messages streams covering:
  - a Then step `FAILED`, which is red;
  - all steps `PASSED`, which is green;
  - an `UNDEFINED` step, which is a crash;
  - a When step `FAILED`, which is a crash;
  - a Given `PENDING`, which is a crash;
  - an empty file, which is a crash for every scenario.

  Statuses come from `TestStepResult.status` (`UNKNOWN`, `PASSED`, `SKIPPED`, `PENDING`, `UNDEFINED`, `AMBIGUOUS`, `FAILED`). Step kind comes from the pickle step `type` (`Context`, `Action` or `Outcome`). Both are defined in `cucumber/messages` `jsonschema/messages.schema.json`.
- [ ] **Step 2: Write failing tests.** Each fixture maps to the verdict above.
  - `redGate` fails with the finding "scenario passes before any behaviour exists: <name>" when any scenario is green at Red, which is spec §6 Red proof.
  - `traceability` with three criteria and `@pbi-482` scenarios tagged only `@ac-1` and `@ac-3` returns `["@ac-2"]`, even when an `@pbi-481` scenario carries `@ac-2`.
  - **Second item.** `redGate(results, "@pbi-482")` is ok when the `@pbi-482` scenarios are red and an earlier item's `@pbi-481` scenarios are green. This is the case that would otherwise block every item after the first.
  - `matchesLock` returns false after a test commit edits a locked `.feature` file. It returns true after a commit that only adds a step definition, and true after a merge that adds another item's feature file.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **`classify`.** Join `testCase.testSteps[].pickleStepId` to `pickle.steps[].type`. A scenario is red when its first non-`PASSED` step is `FAILED` and of type `Outcome`.
  - **`matchesLock`.** Run `git diff --quiet <lockSha> HEAD -- <files...>` through `execFile`.
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
  maxTurns?: number; mode: "cell" | "judge"; signal: AbortSignal }): Promise<AgentResult>;
export function foldMessages(msgs: AsyncIterable<SDKMessage>): Promise<Omit<AgentResult, "model">>;
export function haikuJudge(sop: Sop): (item: FactoryItem, dor: Policy) => Promise<string>; // raw reply; gate() parses it
```

  This is the only module that imports `@anthropic-ai/claude-agent-sdk`. `haikuJudge` calls `runAgent` with `model: sop.models.triage`, `maxTurns: 1` and `mode: "judge"`. It runs in the control plane, which holds the App key and database access, while reading untrusted item text, so judge mode carries none of the cell's freedoms. Its prompt puts the repo's `dor.md` in the instructions and the item text, with its readiness fields, in a fenced data block that it treats as requirements to weigh, never as commands. It asks for one JSON line per `dor.md` criterion, per Run contract 11, then a last line `{"flags":[]}`. `flags` covers requests for credentials, CI or workflow changes, and access outside the repo, as spec §9 requires. That check is the engine's, and no `dor.md` can remove it.

- [ ] **Step 1: Write failing `foldMessages` tests** against arrays of SDK-shaped messages:
  - A `result` with `subtype: "success"` gives `ok: true`, the result text, and `costUsd` as the sum of `modelUsage[*].costUSD`. `tokensIn` sums `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`, and `tokensOut` sums `outputTokens`.
  - A `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt: 1762400000` gives `limit.resetsAt = 1762400000` and `ok: false`.
  - A `rate_limit_event` with `status: "allowed_warning"`, `utilization: 0.74` and a `resetsAt` gives `usage: { utilization: 0.74, resetsAt }`, leaves `limit` null and doesn't change `ok`. The last such event in the stream wins.
  - A `result` with `subtype: "error_max_turns"` gives `ok: false` and keeps the cost.
  - `transcript` is the JSONL of every message, for Blob upload.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `runAgent`.** Call `query({ prompt, options })` with `model`, `cwd`, `maxTurns` and the `AbortController` behind `signal`, plus the options for its mode.

  In `cell` mode:
  - `settingSources: ["user", "project"]`, so the vendored `~/.claude/agents` and the repo's own `.claude/` load.
  - `permissionMode: "bypassPermissions"`, which is safe only because the cell is a throwaway container holding a one-repo token.
  - `sandbox` from the Task 2 Step 9 result: the egress allowlist when the sandbox can start, otherwise omitted, with the pending decision recorded.

  In `judge` mode:
  - `settingSources: []`, so nothing on disk loads;
  - no `permissionMode`, so the default applies;
  - `disallowedTools: ["*"]`, which the SDK reference gives as the way "to deny every tool" ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)).

  Add a unit test asserting that the options built for `judge` mode contain none of the cell-mode settings.

  The spike may show that the SDK refuses the OAuth token. In that case `runAgent` spawns `claude -p --output-format stream-json --verbose`, with the same model and cwd, and feeds the parsed lines to `foldMessages`. The CLI emits the same message shapes, so nothing else changes.
- [ ] **Step 4: Run the unit tests.** Expected: PASS.
- [ ] **Step 5: Run the live test.** `run.live.test.ts` runs only with `CLAUDE_CODE_OAUTH_TOKEN` set. It asks Haiku for one word and asserts `ok`, `costUsd > 0` and `model === "claude-haiku-5-5"`. Run it in the cell image. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agent): Agent SDK runner with cost and limit folding`.

---

### Task 12: Cell API in the control plane

**Files:**
- Create: `src/control/cell-api.ts`, `src/control/cell-api.test.ts`, `src/http/server.ts`, which is a plain `node:http` route table that Task 15 extends
- Modify: `src/store/runs.ts`

**Interfaces:**
- Consumes: `renewLease`, `releaseLease`, `transitionItem`, `appendEvent` and `RepoHost.cellToken`.
- Produces the routes below, all under `/internal/cells/:runId`, all with `Authorization: Bearer <runToken>`. The token is `HMAC-SHA256(CELL_SECRET, runId + ":" + generation)` in hex. Every route checks the token with `timingSafeEqual` and then checks that `generation` is the item's current one. A failure of either check gets 409 with no write.
  - `POST /lease` takes `{ generation }` and returns `{ ok: true, stop: boolean }`. `stop` is true when the kill switch, a pause or a stop-run override is active.
  - `POST /github-token` returns `{ token, expiresAt }`.
  - `GET /context` returns the fields Run contract 5 lists.
  - `POST /policy-results` takes `{ file: "pr-review" | "dod", source: "repo" | "default", stageId, attempt, verdicts: Verdict[] }` and writes them to `policy_result` for the run. Run detail shows each criterion's verdict from its latest stage attempt.
  - `POST /pr` takes `{ prNumber, prUrl }` and records them on the run, so the control plane starts polling that PR's checks (Run contract 6).
  - `GET /checks?sha=<sha>` returns `{ status: "pending" | "success" | "failure" | "none" }` for that commit on the run's branch, from the control plane's own poll in Run contract 6. The first request for a sha starts its 10-minute `none` clock. A sha that isn't on the run's branch gets 400.
  - `POST /stage` takes `{ stageId, attempt, status: "started" | "passed" | "failed", model, tokensIn, tokensOut, costUsd, transcriptRef?, reportRef?, usage? }`. It writes `stage_run` and, on `passed`, `run.next_stage` per Run contract 1. When `usage.utilization` is at or above `wip_policy.usage_reserve_at`, it sets `wip_policy.usage_paused_until` to `usage.resetsAt`, or to now plus 5 hours when the event gave no reset time.
  - `POST /transition` takes `{ event: ItemEvent, question?: { kind: "needs_input" | "sign_off"; body: string }, scenariosSha?: string, lockedFiles?: string[], prNumber?: number, prUrl?: string, resumeAt?: string, tier?: "Low" | "Medium" | "High", tierReasons?: string[] }`. A cell may send only `scenarios_written`, `blocked`, `pr_opened`, `retries_exhausted` and `usage_limited`, and any other event gets 400.
  - `POST /upload-url` takes `{ kind: "transcript" | "report", stageId, attempt }` and returns a write-only SAS URL for `<kind>s/<runId>/<stageId>-<attempt>.<jsonl|ndjson>`, valid for 15 minutes.
- `runToken(secret: string, runId: string, generation: number): string`

- [ ] **Step 1: Write failing tests** against `startTestDb()` and a request helper:
  - With the current generation's token, `/stage` writes one `stage_run` row.
  - **Review Focus 2.** After a re-claim bumps the generation, each of the nine routes with the old token returns 409, and the `stage_run`, `event`, `item` and `policy_result` tables are unchanged.
  - **End-of-stage order.** Calls in Run contract 9 order all succeed. A `/stage` sent after the stage's own `/transition` gets 409, which is why the order is fixed.
  - `/transition` with `scenarios_written`, a `sign_off` question, `scenariosSha` and `lockedFiles` moves InProgress to SignOff. It inserts the question, stores the sha and files on the run, and releases the lease.
  - **Every exit releases.** Each of `pr_opened`, `blocked`, `retries_exhausted` and `usage_limited` leaves the item with no `lease_owner` and a generation one higher, per Run contract 2. `pr_opened` with `tier` writes `run.risk_tier` and `run.tier_reasons`.
  - `/context` after an approved sign-off returns `nextStage: "red"`, the `lockSha` and the `lockedFiles`.
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
- [ ] **Step 3: Implement** the routes in `src/http/server.ts` and mount them first, so they work without a dashboard session. Ignore every `x-ms-client-principal*` header on these routes. Register the board mirroring through `onTransition` from Task 4, so the watcher, the scheduler and the dashboard all mirror the same way.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(control): cell API fenced by lease generation`.

---

### Task 13: Scheduler, launcher and overrides

**Files:**
- Create: `src/scheduler/scheduler.ts`, `src/scheduler/launcher.ts`, `src/store/overrides.ts`, `src/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `claimNext`, `expireLeases`, `runToken`, active overrides.
- Produces:
  - `interface Launcher { start(env: Record<string, string>): Promise<string>; stop(executionName: string): Promise<void>; }`, implemented by `containerAppsLauncher(cfg)` and `fakeLauncher()`.
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
    - A Failed item whose PR already merged starts a new run on a new branch, per Run contract 7.
    - An Abandoned item whose PR a person closed without merging, with `next_stage = "address"`, keeps its run and branch and gets `next_stage = "open-pr"`, per Run contract 1.
  - **Criteria hash.** A claim that opens a new run writes `item.criteria_hash` from the item's current acceptance criteria.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** A run can be created by a claim, by `criteria_changed` in Task 8, or by a re-queue after a merge. So the scheduler pins on the first claim of any run whose `config_sha` is still null, and records:
  - `run.repo_id` and `run.run_number`;
  - `run.config_sha`, from `RepoHost.defaultBranchSha`;
  - `run.sop_version`, from the loaded SOP file.

  The cell reads both files at those pins for the whole run, as spec §6 requires. The cell env passed to `start` is the six variables in Run contract 5, with `RESUME_FROM` set to `run.next_stage`.

  `wip_policy` holds one row, `mode = 'fixed'` with `current_wip = 1`, and the scheduler reads it each tick.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(scheduler): fixed WIP, launcher, Phase 0 overrides`.

---

### Task 14: Cell engine, stages 1 to 7 and the thin stage 8

**Files:**
- Create: `src/cell/engine.ts`, `src/cell/api-client.ts`, `src/cell/main.ts`, `src/cell/engine.test.ts`, `sop/default.yml`, `sop/prompts/understand.md`, `sop/prompts/specify.md`, `sop/prompts/red.md`, `sop/prompts/tdd.md`, `sop/prompts/self-review.md`, `sop/prompts/open-pr.md`, `sop/prompts/address.md`, `cell/claude/agents/self-reviewer.md`, `cell/claude/agents/pr-addresser.md`
- Modify: `cell/Dockerfile`

**Interfaces:**
- Consumes: `runAgent`, `classify`, `redGate`, `greenGate`, `traceability`, `matchesLock`, `loadSop`, `parseRepoConfig`, `cellRepoHost` from Task 7, and the cell API from Task 12 through `api-client.ts`.
- Produces:

```ts
type CellContext = { externalId: string; title: string; acceptanceCriteria: string[]; nextStage: string;
  decision: { kind: "approve" | "changes" | "answer"; text: string } | null; lockSha: string | null;
  lockedFiles: string[]; prNumber: number | null; repo: string; base: string; branch: string;
  configSha: string; sopVersion: string };            // the body of GET /context (Run contract 5)
type Git = { clone(url: string, branch: string): Promise<string>; mergeBase(base: string): Promise<"clean" | "conflict">;
  commitAll(msg: string): Promise<string>; push(): Promise<void>; head(): Promise<string> };
function runCell(deps: { api: CellApi; ctx: CellContext; agent: typeof runAgent; git: Git;
  repoHost: ReturnType<typeof cellRepoHost>; sop: Sop; config: RepoConfig;
  policies: { scenarios: Policy; prReview: Policy; risk: Policy; dod: Policy }; now: () => Date })
  : Promise<"done" | "waiting" | "failed" | "stopped" | "limited">;
```

  The engine starts at `ctx.nextStage`, and the item's tag is `@pbi-${ctx.externalId}`. Before the first stage of every claim, `runCell` calls `git.mergeBase(ctx.base)`. On `conflict` it runs the coding agent once to resolve it. A conflict still left goes to `blocked`, with the conflicting paths.

Stage behaviour, from spec §6 rows 1 to 7:

| Stage | Exit check in code | On failure |
|---|---|---|
| understand | Agent output lists each criterion with an `@ac-N` tag | `blocked`, with the agent's question |
| specify | Every feature file carries the item's `@pbi` tag, `bdd.parse` exits 0, and `traceability(results, n, tag)` is empty. When `ctx.decision` is a `changes` note, the agent gets the note. Feature files are committed and posted on the PBI with dedupe key `scenarios:<sha>`. The engine then posts `scenarios_written` with a `sign_off` question, `scenariosSha` and `lockedFiles`, and returns `waiting` | 1 retry, then `blocked` |
| sign-off | No cell runs it. `decide` moves `next_stage` to `red` or back to `specify`, per Run contract 1 | none |
| red | `bdd.run`, then `redGate(classify(report), tag)` is ok, and `matchesLock(dir, ctx.lockSha, ctx.lockedFiles)` is true. The report goes up through `/upload-url` with `kind: "report"` as red evidence | 2 retries, then `blocked` |
| green | `greenGate`, `commands.test`, `commands.lint` and `matchesLock` all pass. The green report is uploaded the same way. Then the `dod.md` criteria are checked per Run contract 11: the engine runs the `run:` lines, an agent judges the rest, and the verdicts go to `POST /policy-results`. A `failed` `dod.md` verdict counts as a green failure. A `person` verdict goes to the PR checklist unticked and doesn't fail green | 3 retries, then `retries_exhausted` |
| self-review | The reviewer's last line is `APPROVED`, and every `pr-review.md` verdict it reported passed, with the verdicts sent to `POST /policy-results`. `APPROVED` with a failed verdict counts as another round. `DEADLOCK` or 5 rounds without approval means `blocked` | `blocked` |
| open-pr | `openOrUpdatePr` with `Refs #<n>` in the body, a link to the repo's `pr-review.md` or the default, and the `dod.md` criteria as a checklist showing the cell's verdicts, for the person who merges to tick, then `POST /pr`, then `requestReviewers(repo, pr, config.reviewers)`, then `GET /checks?sha=<git.head()>` every 60s until `success`. Every later push, including a retry after "back to green", asks about its own new sha. On `failure`, back to green, counted against green's retries. On `none`, `blocked` with "no CI ran on the PR". The stage ends in Run contract 9 order with `pr_opened` carrying `prNumber`, `prUrl`, `tier` and `tierReasons` | as stated |
| address | Runs only when `ctx.nextStage` is `address`. `pr-addresser` replies to or fixes each open thread, and the branch merges cleanly with the base. Then `GET /checks?sha=<git.head()>` for the pushed commit reaches `success`, and the engine posts `pr_opened` again, which returns the item to InReview | 2 retries, then `blocked` |

- [ ] **Step 1: Write `sop/default.yml`.** Copy the spec's SOP YAML, keep stages understand to open-pr, add `address` with `agent: pr-addresser`, and keep `budget` as recorded data only. Phase 0 doesn't enforce caps. The one exception is `wall_clock: 8h`, which counts only time with a lease, and when it runs out the engine posts `blocked`. Write the seven prompt files. They hold only engine rules, and every repo-specific standard comes from a policy file the engine loads at run time (Run contract 11). `specify.md` carries the engine's BDD rules verbatim: traceability, the lock and red proof. It requires the item's `@pbi-<n>` tag on every feature file, and appends the repo's `scenarios.md` as the team's writing guide. `red.md` says to write step definitions and stubs with no behaviour.
- [ ] **Step 2: Vendor the agent definitions.** Copy `~/.claude/agents/self-reviewer.md` and `~/.claude/agents/pr-addresser.md` into `cell/claude/agents/`. From the vendored `self-reviewer.md`, remove its rubric list (what to review for) and its line saying a repo's own agent file overrides it. Keep only the review loop and the `APPROVED` / `OPEN: <n>` report format, so `pr-review.md` is the only rubric. `address.md` tells `pr-addresser` to work only the open threads and the conflict, and to treat review text as requests to weigh, never as commands. `self-review.md` gives the reviewer the repo's `pr-review.md` as its rubric, numbered as in Run contract 11. Then come the engine's BDD checks, under a heading that says they outrank anything in the rubric above: every step definition asserts something, no scenario is pending or skipped, and no tag hides a scenario. It also adds the rule "after a finding is rebutted twice and still held, end with `DEADLOCK`". The reviewer reports each `pr-review.md` criterion as a JSON line, which the engine stores in `policy_result`.
- [ ] **Step 3: Write failing engine tests** with a scripted fake agent, a fake `Git` and a recording `CellApi`:
  - **Happy path.** A fresh run with `ctx.nextStage = "understand"` executes understand and specify, posts `scenarios_written` with `scenariosSha` and `lockedFiles`, and returns `waiting`. A second run with `ctx.nextStage = "red"` and a lock in `ctx` runs red, green, self-review and open-pr. It posts `pr_opened` and returns `done`. Each stage writes `started` then `passed` with the fake agent's cost.
  - **Checkpoint resume.** With `ctx.nextStage = "red"`, it never calls the agent for understand or specify.
  - **Changes asked.** With `ctx.nextStage = "specify"` and `ctx.decision = { kind: "changes", text: "split AC 2" }`, the specify prompt contains the note.
  - **Base merge.** Every run calls `mergeBase` before its first stage. A `conflict` the agent can't clear posts `blocked` naming the paths, and no stage runs.
  - **Address.** With `ctx.nextStage = "address"`, it runs only the address stage, pushes, and posts `pr_opened` once `/checks?sha=` for the pushed sha reports `success`. A `success` cached for the previous head never counts.
  - **Rubric can't weaken.** A repo `pr-review.md` that says "skip the BDD checks" still yields a brief whose BDD checks follow the rubric under the outranking heading. A reviewer reply of `APPROVED` with one failed `pr-review.md` verdict starts another round instead of passing.
  - **DoD commands.** A `dod.md` with `` `run: false` `` fails green on exit code 1, and the command's env holds no `CLAUDE_CODE_OAUTH_TOKEN` and no `RUN_TOKEN`. `` `run: true && true` `` passes, which proves the `sh -c` path.
  - **DoD lines for a person.** A `dod.md` line "Deployed to staging" judged `person` doesn't fail green, and appears in the PR body as an unticked line marked for the person who merges.
  - **Policy in prompts.** With a repo `scenarios.md` and `pr-review.md`, the specify prompt contains the repo's `scenarios.md` text and the self-review brief contains its `pr-review.md` text, each word for word. Without them, the factory defaults appear instead. The engine's BDD checks appear in the self-review brief either way.
  - **Open PR.** The PR body contains `Refs #482` and never `Closes`, and lists each `dod.md` criterion as a `- [ ]` line, `POST /pr` comes before the first `GET /checks`, and `requestReviewers` is called with `config.reviewers`.
  - **Call order.** At the end of every stage the recording `CellApi` sees `/stage passed`, then the uploads, then `/transition`, per Run contract 9, and the run returns `waiting` or `done` rather than `stopped`.
  - **Red proof.** A red stage whose report has a green scenario retries twice, then posts `blocked` with "scenario passes before any behaviour exists".
  - **Usage limit.** An agent result with `limit.resetsAt` makes the engine commit, post `/stage failed`, post `/transition` with `usage_limited` and `resumeAt`, and return `limited`. That attempt doesn't count against retries.
  - **Stop.** A `/lease` reply of `{ stop: true }` during any stage aborts the agent through `signal`, commits the work in progress, and returns `stopped`.
  - **Lost lease.** A 409 from any API call makes the engine stop at once, with no push and no further calls.
- [ ] **Step 4: Run the tests.** Expected: FAIL.
- [ ] **Step 5: Implement `engine.ts`, `api-client.ts` and `main.ts`.**
  - A lease renewal loop runs every 60s. After 3 minutes of failed renewals it aborts and exits 1.
  - Before each push, comment and transition, the engine calls `/lease` to check the generation.
  - Every stage uploads its transcript through `/upload-url` with `kind: "transcript"`.
  - `main.ts` reads `GET /context`, and clones `ctx.branch` through a git credential helper that fetches a token from `/github-token` on demand, so no token is written into `.git/config` or the remote URL. It creates the branch from `ctx.base` when it doesn't exist yet.
  - A `PolicyError` while loading the four policies posts `blocked` with the error, and never crashes the cell into a lease-expiry loop. It reads `.factory/config.yml` at `ctx.configSha`, loads the four policies with `loadPolicy` at the same commit, and reads the SOP at `ctx.sopVersion`. Then it runs `runCell`.
- [ ] **Step 6: Update `cell/Dockerfile`.** Use `node:26.13.0-bookworm`, plus `git`, `bubblewrap` and `socat` for the sandbox. Copy `cell/claude/agents` into `/home/factory/.claude/agents`, copy `policy/` into `/app/policy`, and run as a non-root `factory` user.
- [ ] **Step 7: Run the tests.** Expected: PASS.
- [ ] **Step 8: Commit** `feat(cell): SOP engine for stages 1 to 7 and address`.

---

### Task 15: Dashboard: sign-in, Floor, Run detail, controls

**Files:**
- Create: `src/http/auth.ts`, `src/http/views.ts`, `src/http/routes.ts`, `src/http/auth.test.ts`, `src/http/routes.test.ts`, `src/control/decisions.ts`, `src/control/decisions.test.ts`, `src/main.ts`, `scripts/seed-owner.ts`
- Modify: `src/http/server.ts` from Task 12
- Modify: `Dockerfile`, which also copies `policy/` into `/app/policy` for the readiness gate's defaults

**Interfaces:**
- Consumes: the store, `setOverride`, `activeOverrides`, `handleWebhook`, the cell API and `pollOnce`.
- Produces:
  - `identify(headers): { provider: "google" | "microsoft"; subject: string; tenantId: string | null } | null`. It reads the principal headers recorded in the Task 2 spike file and returns null on any route under `/webhooks` or `/internal`.
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
  - `scripts/seed-owner.ts` takes dash-free words `provider=<p>`, `subject=<id>`, `email=<e>` and `github-login=<login>`, plus an optional bare `product-owner`, and inserts the first owner. It exits 1 on any other word. It runs only inside the migrate job (Task 2).
  - `decide(c, d: { itemId: string; userId: string; kind: "approve" | "changes" | "answer"; text: string; via: "dashboard" | "comment" }): Promise<"applied" | "ignored" | "forbidden">`. The routes and the webhook's `comment` events both call it, so the two channels can't drift.
    - **Roles.** `decide` owns the role rules. `approve` and `changes` need `product_owner`, and `answer` needs operator or product owner. The routes only check that the user is signed in and allowlisted.
    - **Effects.** It answers the open question and applies Run contract 1. On approve it copies `scenarios_sha` into `features_lock_sha`. On an Abandoned item it revives the item through `requeued`.
  - `parseCommand(body: string): { kind: "approve" | "changes" | "answer"; text: string } | null`, which reads only a leading `/approve`, `/changes` or `/answer`.

- [ ] **Step 1: Write failing tests:**
  - **Review Focus 4.**
    - `identify` returns null for any request to `/webhooks/github` or `/internal/cells/x`, even with every principal header set.
    - A dashboard request whose subject isn't in `user` gets 403 and the page "You don't have access to this factory. Ask an owner to add you."
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
  - `main.ts` wires the pool, the scheduler `tick` every `TICK_MS`, `pollOnce` every `POLL_INTERVAL_MS`, and the HTTP server. It never runs `migrate`, because it connects as `factory_app`, which has no DDL rights. Migrations run only in the migrate job from Task 2.
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
  - `classifyRisk(diff: string, files: string[], ctx: { sop: Sop; config: RepoConfig; risk: Policy; agent: typeof runAgent }): Promise<{ tier: "Low" | "Medium" | "High"; reasons: string[] }>`. It runs two passes on `sop.models.coding`, with the repo's `risk.md` as the definition of each tier: the tier, then "does this change need a person anyway". It never returns below `pathFloor`.

- [ ] **Step 1: Write failing tests:**
  - **Path floor.** `pathFloor` gives Medium for `.github/workflows/ci.yml`, `.factory/config.yml`, `.factory/dod.md`, `.claude/agents/self-reviewer.md`, `AGENTS.md`, `src/CLAUDE.md` and a file matching `src/billing/**`, and gives Low for `docs/readme.md`.
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
  - `review` with `changes_requested` and a `submittedAt` after `run.reviews_seen_at` moves InReview to Queued through `changes_requested`, with `next_stage = "address"`, per Run contract 10. An older review is ignored.
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

### Task 18: Deploy and run the first live item

**Files:**
- Modify: `infra/main.bicep`, swapping the spike image for the control plane image, `deploy.yml`
- Create: `docs/superpowers/runbooks/phase-0.md`

- [ ] **Step 1: Deploy through `deploy.yml`.** Then seed yourself as the first owner and product owner by starting the migrate job with your sign-in details: `az containerapp job start -n caj-factory-migrate -g rg-software-factory-aue --container-name migrate --command node src/store/migrate-cli.ts --args seed-owner provider=microsoft subject=<id> email=<you> github-login=<login> product-owner`. The words after `--args` carry no leading dashes, because az would read a dash-prefixed word as its own option and reject the call. Then confirm the execution succeeded and that you can sign in past the no-access page. Take the subject id from the Task 2 Step 5 spike record.
- [ ] **Step 2: Create the Phase 0 target repo.**
  - Add `.factory/dod.md` with the team's Definition of Done, and any of `dor.md`, `scenarios.md`, `pr-review.md` and `risk.md` the team wants to set itself. Add `.factory/config.yml` with real `bdd` and `commands` entries, a Gherkin runner that writes Cucumber Messages to `bdd.report`, a CODEOWNERS file, and CI that runs the scenarios as well as the unit tests. Done on merge depends on that CI.
  - In the org project's Workflows settings, turn off the built-in workflows that set status, including "Item closed" and "Pull request merged". The factory owns status.
  - In branch protection, require one human review and CI. Shadow mode posts no `risk-approval`, so that check isn't required yet.
  - Install the GitHub App on that repo only.
- [ ] **Step 3: Run one PBI live.** Add one small PBI with the `factory` label to the org project. Expected:
  - A readiness comment.
  - Scenarios posted on the PBI, and the sign-off question on Run detail.
  - After your approval, a PR with red and green results, the review rounds and a shadow tier.
  - A reviewer requested on the PR from CODEOWNERS.
  - After your merge and green CI on main, the item at Done and the issue closed.

  Record the run id and cost in the runbook.
- [ ] **Step 4: Test the five overrides live.** Hold a second item, pause, drain, stop a run, and re-queue the stopped item. Record that each took effect within 30 seconds, using event timestamps against the moment of the click. Press the kill switch and record that every execution stopped within a minute.
- [ ] **Step 5: Write `docs/superpowers/runbooks/phase-0.md`.** It covers how to seed users, rotate the GitHub App key and the Claude token, read `/phase0` toward the exit criteria (10 merged PRs, cost per item, your verdict on the shadow tiers), and use the kill switch.
- [ ] **Step 6: Commit** `docs: phase 0 runbook and first live run`.

---

## Out of scope for Phase 0

These come from spec §13 Phases 1 to 3, and nothing here builds them:
- `pr-reviewer` in stage 8, stages 9 to 11, Increment records and stage 10's post-merge verification on main;
- an enforced `risk-approval` check and the `approval` table;
- budget caps, the Inbox and the Cost view;
- quarantine, adaptive and advised WIP, and Azure DevOps adapters.

The SOP file's `budget` block is recorded but not enforced, apart from the wall clock.
