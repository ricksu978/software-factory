# Software Factory Phase 0 Implementation Plan

> **For agentic workers.** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Build the Phase 0 walking skeleton from spec §13. One GitHub repo and project, fixed WIP of 1, and SOP stages 1 to 7. A person merges, the risk classifier runs in shadow mode, and the dashboard has Floor, Run detail and four overrides: pause, drain, stop a run and hold an item.

**Architecture.** One TypeScript codebase with two entry points. The control plane runs as a single always-on Container App with the watcher, scheduler, dashboard and cell API. A cell runs as one Container Apps job execution per PBI and drives the Claude Agent SDK through the SOP stages. Cells never touch Postgres. They talk to the control plane's cell API with a per-run token fenced by the lease generation. Postgres is the only state store, and every state change appends to the `event` table.

**Tech Stack.** Node 26.13.0 LTS running `.ts` files directly through type stripping, `node:test`, TypeScript 7.0.2 for type checks only, `pg` 8.23.1, `yaml` 2.9.1, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@octokit/app` 16.1.4, `@azure/identity` 4.14.1, `@azure/arm-appcontainers` 4.0.0, `@azure/storage-blob` 12.34.0, `@testcontainers/postgresql` 12.2.1, Bicep for infrastructure.

**Spec.** `docs/superpowers/specs/2026-11-05-software-factory-design.html`, as merged in cca3e23. §13's Phase 0 row is the scope. §14 lists the settled decisions this plan does not reopen.

## Global Constraints

- Region australiaeast. Control plane is one Container App at 0.5 vCPU and 1 GiB with external ingress. Cells are a Container Apps job, manual trigger, 2 vCPU and 4 GiB per replica, retry limit at least 1.
- Images are `linux/amd64` and build in CI. Never build them natively on the ARM64 dev machine.
- Postgres Flexible Server, Burstable B1ms, Microsoft Entra authentication with managed identities and no stored password.
- Transcripts go to Blob Storage, Hot LRS, and `stage_run.transcript_ref` points at them. Container logs go to Log Analytics.
- Key Vault holds the GitHub App private key and the Claude OAuth token. Cells get the token as `CLAUDE_CODE_OAUTH_TOKEN` and never run with `--bare`.
- Model IDs live in the SOP file only: `coding: claude-opus-5-5`, `triage: claude-haiku-5-5`.
- The Phase 0 backlog is a Project owned by a GitHub organization, and the target repo lives in that organization. A GitHub App can reach only organization-owned Projects. This was decided 2026-11-05.
- Eligibility label `factory`. Definition of Done path defaults to `DoD.md`. A repo with no DoD file fails readiness for every item.
- Poll every 5 minutes on top of webhooks. Leases renew every 60 seconds and expire after 5 missed renewals. A cell stops itself after 3 minutes of failed renewals.
- Each claim increments `lease_generation`. A cell checks its generation before every push, comment and state write.
- NeedsInput and SignOff items move to Abandoned after 5 days with no answer.
- An override takes effect within 30 seconds. The kill switch stops every cell within a minute.
- Cell GitHub tokens are minted with explicit `permissions`: write on `contents`, `pull_requests` and `issues`, and nothing on `statuses` or `checks`.
- Phase 0 runs WIP fixed at 1, SOP stages 1 to 7, and the risk classifier in shadow mode. Shadow mode records a tier on every PR and posts no `risk-approval` check.
- A merged item stops at Accepted. Stages 10 and 11, budget caps, Inbox, Cost view and quarantine belong to Phase 1.
- Sign-in via Container Apps built-in auth with Microsoft (any Entra directory and personal accounts) and Google. The app's own `user` table decides access, and roles are viewer, operator and owner.

## Review Focus

1. **Planted instructions in PBI text.** An item body that asks for secrets, CI changes or access outside the repo is flagged NotReady by the gate, and no cell token can post a status or check. Tests in Task 9 and Task 7.
2. **Zombie cell after lease expiry.** An old cell whose lease was re-claimed gets 409 on every cell API write, so it can't push, comment or move state. Test in Task 12.
3. **Duplicate or replayed webhook deliveries.** The same `X-GitHub-Delivery` id processed twice yields one event. A bad or missing signature yields 401 and no event. Tests in Task 7.
4. **Spoofed identity headers.** A request that carries `X-MS-CLIENT-PRINCIPAL` on an auth-excluded path never authenticates a dashboard action, and an unknown signed-in subject gets the no-access page. Tests in Task 15, plus a live check in Task 2.
5. **Control plane restart mid-run.** A fresh scheduler process sees the running cell's live lease and starts no second cell for that item. Test in Task 13.

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
src/bdd/messages.ts, lock.ts
src/risk/shadow.ts
src/agent/run.ts                   the only file that imports the Agent SDK
src/cell/engine.ts, api-client.ts, main.ts
src/control/cell-api.ts            /internal/cells/* routes
src/scheduler/scheduler.ts, launcher.ts
src/http/server.ts, auth.ts, views.ts, routes.ts
src/main.ts                        control plane entry
sop/default.yml, sop/prompts/*.md
cell/Dockerfile, cell/claude/agents/self-reviewer.md
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
  - User-assigned identities `id-factory-control` and `id-factory-cell`.
  - Key Vault `kv-factory-<uniqueString>` with RBAC. The control identity reads both secrets. The cell identity reads only `claude-oauth-token`.
  - Storage account with a `transcripts` container, Hot LRS.
  - Postgres Flexible Server `psql-factory-<uniqueString>`, B1ms, 32 GB, Entra auth only, with `id-factory-control` as the Entra admin.
  - Container App `ca-factory-control` at 0.5 vCPU and 1 GiB with external ingress, running the spike image first.
  - Job `caj-factory-cell` with a manual trigger, 2 vCPU and 4 GiB, `replicaRetryLimit: 1`, and `CLAUDE_CODE_OAUTH_TOKEN` from a Key Vault secret reference.
  - An `authConfigs` child on the app with the Microsoft provider (any Entra directory and personal accounts), the Google provider, `unauthenticatedClientAction: RedirectToLoginPage`, and `globalValidation.excludedPaths: ['/webhooks/github', '/internal/cells']`.
  - A custom role on the job for the control identity, granting job start and execution stop. Find the exact action names with `az provider operation show --namespace Microsoft.App`.
- [ ] **Step 2: Run `az bicep build --file infra/main.bicep`.** Expected: no errors. Then run `az deployment group what-if` against the resource group and read the resource list against Step 1.
- [ ] **Step 3: Write `spike/hello.ts`**, a `node:http` server with three routes:
  - `GET /`, which returns every request header that starts with `x-ms-client-principal`.
  - `POST /webhooks/github`, which verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` and returns 204 or 401.
  - `POST /internal/cells/ping`, which returns 204.
- [ ] **Step 4: Write `deploy.yml`.** It builds both Dockerfiles with `docker buildx build --platform linux/amd64`, pushes them to ACR, and runs `az deployment group create`. It authenticates to Azure through OIDC federated credentials, never a stored secret.
- [ ] **Step 5: Sign-in test.** Sign in with a Google account, a personal Microsoft account and a work account from another tenant. Record each case's `x-ms-client-principal-idp` and `x-ms-client-principal-id`. Expected: all three reach `/` and show distinct ids.
- [ ] **Step 6: Header spoofing test.** Send `curl -H "X-MS-CLIENT-PRINCIPAL-ID: forged" https://<app>/` while signed out. Expected: a redirect to login, not a 200. Then send the same header to `/internal/cells/ping` and confirm the response doesn't echo the forged value as an authenticated identity.
- [ ] **Step 7a: Organization and App.** Create a free GitHub organization for Phase 0. Creating it is your step, because the API can't create organizations for a personal account. Then register the factory GitHub App with this setup:
  - Repository permissions: write on contents, pull requests, issues and commit statuses, read on checks and metadata.
  - Organization permissions: write on organization projects.
  - App webhook events: issues, issue comment, pull request, check suite and issue dependencies.

  GitHub doesn't offer `projects_v2_item` to App webhooks, so also add an organization webhook for that event. It goes to the same `/webhooks/github` URL with the same secret. Install the App on the organization, scoped to the selected repos only. Store its private key in Key Vault as `github-app-key`.
- [ ] **Step 7: Webhook test.** Point a GitHub App webhook at `https://<app>/webhooks/github` and trigger a delivery. Expected: 204 in the App's delivery log, and no login redirect. Change the secret on one side, then expect 401.
- [ ] **Step 8: Write `spike/sdk-oauth.ts`.** It calls `query({ prompt: "Reply with the word ready.", options: { model: "claude-haiku-5-5", maxTurns: 1, settingSources: [] } })` and prints each message's `type`. It also prints the result's `subtype`, `is_error`, `total_cost_usd` and `modelUsage`. Run it as one execution of `caj-factory-cell`.
  - Expected: `subtype: "success"`.
  - If the SDK refuses the token, run `claude -p "Reply with the word ready." --output-format json` in the same image. Record which one works. §14 already names the headless CLI as the fallback.
- [ ] **Step 9: Sandbox egress probe.** In the same job, run `query()` with `sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains: ["api.github.com", "github.com", "registry.npmjs.org"], strictAllowlist: true } }`. Ask it to run `curl -sI https://example.com` and then `curl -sI https://api.github.com`.
  - Expected: example.com blocked, api.github.com allowed.
  - If the result is `error_during_execution` because bubblewrap can't start in Container Apps, record that. The egress allowlist then needs another mechanism, which is a pending decision.
- [ ] **Step 10: Bot assignment probe.** Try to assign the GitHub App's bot user to an issue. Use `gh api repos/<o>/<r>/issues/<n>/assignees -f assignees[]=<app-slug>[bot]` with an installation token. Record whether GitHub accepts it.
- [ ] **Step 11: Record results** in `docs/superpowers/spikes/2026-11-phase-0-platform.md`. Give each probe its expected result, its actual result and the evidence: a command, a screenshot path or a delivery id. If Step 5, 7 or 8 fails, stop and raise it, because the spec's §11 changes before Task 3 starts.
- [ ] **Step 12: Commit** `chore: platform baseline and phase 0 platform tests`.

---

### Task 3: State machine

**Files:**
- Create: `src/core/states.ts`, `src/core/states.test.ts`

**Interfaces:**
- Produces:
  - `type ItemState = "Eligible" | "NotReady" | "Queued" | "InProgress" | "SignOff" | "NeedsInput" | "InReview" | "Accepted" | "Done" | "Failed" | "Abandoned"`
  - `type ItemEvent = "readiness_failed" | "item_edited" | "ready" | "claimed" | "scenarios_written" | "blocked" | "pr_opened" | "changes_requested" | "approvals_met" | "dod_verified" | "dod_failed" | "retries_exhausted" | "timed_out" | "lease_expired" | "requeued"`
  - `function next(from: ItemState, event: ItemEvent): ItemState | null`, which returns null for an edge the diagram doesn't draw.
  - `function overrideTo(from: ItemState, to: ItemState): ItemState`, which always succeeds. The caller logs it as an override event.

- [ ] **Step 1: Write the failing table test.** It asserts every edge in the spec §5 diagram, as amended by the merged spec:

```ts
const edges: [ItemState, ItemEvent, ItemState][] = [
  ["Eligible", "readiness_failed", "NotReady"], ["NotReady", "item_edited", "Eligible"],
  ["Eligible", "ready", "Queued"], ["Queued", "claimed", "InProgress"],
  ["SignOff", "claimed", "InProgress"], ["NeedsInput", "claimed", "InProgress"],
  ["InProgress", "scenarios_written", "SignOff"], ["InProgress", "blocked", "NeedsInput"],
  ["InProgress", "pr_opened", "InReview"], ["InReview", "changes_requested", "InProgress"],
  ["InReview", "approvals_met", "Accepted"], ["Accepted", "dod_verified", "Done"],
  ["Accepted", "dod_failed", "Failed"], ["InProgress", "retries_exhausted", "Failed"],
  ["NeedsInput", "timed_out", "Abandoned"], ["SignOff", "timed_out", "Abandoned"],
  ["InProgress", "lease_expired", "Queued"], ["Failed", "requeued", "Queued"],
];
for (const [from, ev, to] of edges) test(`${from} --${ev}--> ${to}`, () => assert.equal(next(from, ev), to));
test("undrawn edge is null", () => assert.equal(next("Done", "claimed"), null));
test("answer alone does not move state", () => assert.equal(next("NeedsInput", "ready"), null));
```

  The spec draws "SignOff to InProgress" and "NeedsInput to InProgress" directly. Here both go through `claimed`, because a waiting item gave up its WIP slot and has to take one again. The answer itself is recorded on the `question` row.
- [ ] **Step 2: Run `node --test src/core/states.test.ts`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `next` and `overrideTo`** in `src/core/states.ts` as a lookup table keyed `` `${from}:${event}` ``.
- [ ] **Step 4: Run the test.** Expected: every case passes.
- [ ] **Step 5: Commit** `feat(core): PBI state machine`.

---

### Task 4: Schema and store basics

**Files:**
- Create: `db/migrations/001_init.sql`, `src/store/db.ts`, `src/store/items.ts`, `src/store/events.ts`, `src/store/runs.ts`, `src/store/test-db.ts`, `src/store/items.test.ts`

**Interfaces:**
- Consumes: `next`, `ItemState`, `ItemEvent` from Task 3.
- Produces:
  - `createPool(url?: string): pg.Pool`. Without a URL it connects as the managed identity, using an Entra token from `@azure/identity` `DefaultAzureCredential` with scope `https://ossrdbms-aad.database.windows.net/.default`.
  - `migrate(pool): Promise<void>`, which applies `db/migrations/*.sql` in name order and tracks them in `schema_migrations`.
  - `withTx<T>(pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>`
  - `appendEvent(c, e: { actor: "agent" | "human" | "system"; actorId: string; itemId: string | null; kind: string; payload: unknown }): Promise<void>`. It also runs `NOTIFY factory_events`.
  - `transitionItem(c, itemId: string, event: ItemEvent, actor: Actor): Promise<ItemState>`. It throws `IllegalTransition` when `next` returns null. It writes `item.state` and the event row in one transaction.
  - `upsertItem(c, item: FactoryItem): Promise<string>`, keyed on `(source_id, external_id)`.
  - `startTestDb(): Promise<{ pool: pg.Pool; stop(): Promise<void> }>`, which uses `@testcontainers/postgresql` with image `postgres:17` and runs `migrate`.

- [ ] **Step 1: Write `001_init.sql`** with the §12 tables Phase 0 uses: `backlog_source`, `repo`, `user`, `item`, `run`, `stage_run`, `event`, `question`, `override` and `wip_policy`. Use the merged spec's columns, plus these Phase 0 columns:
  - `item.held boolean default false`, for the hold override.
  - `item.priority int default 0`, for factory queue order.
  - `user.product_owner boolean default false`. Only product owners sign off scenarios.
  - `run.last_stage text`, the checkpoint.
  - `run.resume_at timestamptz`, for usage-limit stalls.
  - `run.execution_name text`, the Container Apps execution.
  - `webhook_delivery(id text primary key, received_at timestamptz)`, for dedupe.

  Skip `increment` and `approval`, which belong to Phase 1. Make `event` append-only by revoking UPDATE and DELETE on it from the app role.
- [ ] **Step 2: Write failing tests** in `items.test.ts` against `startTestDb()`:
  - `transitionItem` moves Eligible to Queued on `ready` and writes exactly one event with `kind = "transition"` and `payload = { from: "Eligible", to: "Queued", event: "ready" }`.
  - `transitionItem` on `Done` with `claimed` throws `IllegalTransition`, and both the item and the event table are unchanged.
  - `upsertItem` called twice with the same `(source_id, external_id)` returns the same id.
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
  - **Claim order.** `claimNext` picks a SignOff or NeedsInput item whose open `question` has an answer before any Queued item. Among Queued items it picks highest `priority`, then lowest `backlog_rank`. It skips `held` items and items with an open dependency. It moves the claimed item to InProgress through `transitionItem(..., "claimed")`.
  - **Generations.** Each claim sets `lease_generation` to the previous value plus 1, and `lease_expires = now + 300s`.
  - **Renewal.** `renewLease` with the current generation returns `"ok"` and pushes `lease_expires` out. With an older generation it returns `"lost"` and changes nothing.
  - **Expiry.** `expireLeases(now + 301s)` returns the item, moves it to Queued through `lease_expired`, and leaves `run.last_stage` unchanged, so a new cell resumes there.
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
  repo: string | null; size: number | null; updatedAt: string };
export type FactoryWebhookEvent =
  | { kind: "item_changed"; externalId: string } | { kind: "pr_merged"; prNumber: number; repo: string }
  | { kind: "pr_closed"; prNumber: number; repo: string } | { kind: "checks_completed"; sha: string; repo: string }
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
  parseWebhook(headers: Record<string, string>, body: unknown): FactoryWebhookEvent;
}
export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
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
  - `githubRepoHost(app: App, installationId: number): RepoHost`
  - `verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean`
  - `handleWebhook(deps, req: { headers; rawBody: Buffer }): Promise<{ status: 204 | 401 | 200 }>`
- `FieldMap` mirrors the spec: `{ acceptanceCriteriaHeading: string; statusField: string; statusQueued: string; statusDone: string; optInLabel: string; sprintField: string | null; sizeField: string | null; maxSize: number | null }`

- [ ] **Step 1: Write failing tests:**
  - `verifySignature` returns true for `sha256=` plus the HMAC-SHA256 hex digest of the body. It returns false for a one-character change, a missing header and a `sha1=` header.
  - Calling `handleWebhook` twice with the same `X-GitHub-Delivery` stores one `webhook_delivery` row and one event. The second call returns 200 with no event.
  - `handleWebhook` with a bad signature returns 401 and writes nothing.
  - `cellToken` sends `permissions: { contents: "write", pull_requests: "write", issues: "write" }` and `repositories: [repo]`, and the body has no `statuses` or `checks` key. Assert this against a stubbed `app.octokit.request`.
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
- Consumes: `BacklogAdapter`, `upsertItem`, `transitionItem`.
- Produces: `pollOnce(deps: { pool; adapter: BacklogAdapter; sourceId: string }): Promise<{ seen: number; cursor: string }>` and `POLL_INTERVAL_MS = 300_000`.

- [ ] **Step 1: Write failing tests** with the fake adapter:
  - A new labelled item becomes an `item` row in Eligible.
  - An edit to a NotReady item moves it to Eligible through `item_edited`.
  - A Done item that loses its label is left alone.
  - The cursor persists in `backlog_source.cursor`, so a second `pollOnce` with no changes upserts nothing.
  - A paused `backlog_source` is skipped.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `pollOnce`.** The control plane calls it every 5 minutes and also on each `item_changed` webhook event.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(watcher): polling with cursor`.

---

### Task 9: Repo config, SOP loader and readiness gate

**Files:**
- Create: `src/config/repo-config.ts`, `src/config/sop.ts`, `src/gate/readiness.ts`, and a `*.test.ts` next to each.

**Interfaces:**
- Produces:
  - `parseRepoConfig(yamlText: string | null): RepoConfig`, where `RepoConfig = { definitionOfDone: string; sensitivePaths: string[]; bdd: { parse: string; run: string; report: string }; commands: { test: string; lint: string } }`. Defaults: `definitionOfDone: "DoD.md"` and `sensitivePaths: []`. A missing `bdd` or `commands` key throws `ConfigError` naming the key.
  - `loadSop(yamlText: string): Sop`, which validates stage ids, `models.coding` and `models.triage`. A stage `model` must name a key in `models`.
  - `gate(item: FactoryItem, ctx: { dodExists: boolean; repoKnown: boolean; openDeps: string[]; maxSize: number | null; judge: (item: FactoryItem) => Promise<string> }): Promise<{ ready: boolean; reasons: string[] }>`
  - Tests pass a fake `judge`. The real one, `haikuJudge`, comes in Task 11.

- [ ] **Step 1: Write failing tests:**
  - `parseRepoConfig(null)` throws `ConfigError("bdd")`. A repo with no config can't run BDD, so it can't be ready.
  - `gate` rule checks run first, and the judge isn't called when any rule fails. Rules:
    - The DoD file is missing: "No DoD.md in this repo".
    - There are zero acceptance criteria.
    - The size is over `maxSize`.
    - There is an open dependency, and the reason names it.
    - The repo is unknown.
  - A judge result with `flags: ["asks for credentials"]` makes the item not ready, whatever `ready` says. The reason includes the flag. This is Review Focus 1.
  - A judge reply that doesn't parse becomes `{ ready: false, reasons: ["readiness check output unreadable"] }`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The gate parses the judge's reply as one JSON object on the last line: `{"ready":bool,"reasons":[],"flags":[]}`.
  - The gate comments its reasons on the item through `adapter.comment` with `dedupeKey = "readiness:" + item.updatedAt`, and never edits the item.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gate): repo config, SOP loader, readiness gate`.

---

### Task 10: BDD evidence: red, green and the lock

**Files:**
- Create: `src/bdd/messages.ts`, `src/bdd/lock.ts`, `src/bdd/messages.test.ts`, `src/bdd/lock.test.ts`, `src/bdd/fixtures/*.ndjson`

**Interfaces:**
- Produces:
  - `classify(ndjson: string): Map<string, { name: string; tags: string[]; verdict: "red" | "green" | "crash"; reason: string }>`, keyed by pickle id.
  - `redGate(results): { ok: boolean; findings: string[] }`, which is ok only when every scenario is red.
  - `greenGate(results): { ok: boolean; findings: string[] }`, which is ok only when every scenario is green.
  - `traceability(results, criteriaCount: number): string[]`, which lists every `@ac-N` with no scenario.
  - `matchesLock(repoDir: string, lockSha: string, glob: string): Promise<boolean>`

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
  - `traceability` with three criteria and scenarios tagged only `@ac-1` and `@ac-3` returns `["@ac-2"]`.
  - `matchesLock` returns false after a test commit edits a locked `.feature` file. It returns true after a commit that only adds a step definition.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **`classify`.** Join `testCase.testSteps[].pickleStepId` to `pickle.steps[].type`. A scenario is red when its first non-`PASSED` step is `FAILED` and of type `Outcome`.
  - **`matchesLock`.** Run `git diff --quiet <lockSha> HEAD -- <glob>` through `execFile`.
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
  model: string; limit: { resetsAt: number } | null; transcript: string };
export function runAgent(a: { prompt: string; model: string; cwd: string; agent?: string;
  maxTurns?: number; tools: boolean; signal: AbortSignal }): Promise<AgentResult>;
export function foldMessages(msgs: AsyncIterable<SDKMessage>): Promise<Omit<AgentResult, "model">>;
export function haikuJudge(sop: Sop): (item: FactoryItem) => Promise<string>; // raw reply; gate() parses it
```

  This is the only module that imports `@anthropic-ai/claude-agent-sdk`. `haikuJudge` calls `runAgent` with `model: sop.models.triage`, `maxTurns: 1` and `tools: false`. Its prompt treats the item text as requirements to weigh and never as commands. It asks for `{"ready":bool,"reasons":[],"flags":[]}` on the last line, where `flags` covers requests for credentials, CI or workflow changes, and access outside the repo, as spec §9 requires.

- [ ] **Step 1: Write failing `foldMessages` tests** against arrays of SDK-shaped messages:
  - A `result` with `subtype: "success"` gives `ok: true`, the result text, and `costUsd` as the sum of `modelUsage[*].costUSD`. `tokensIn` sums `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`, and `tokensOut` sums `outputTokens`.
  - A `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt: 1762400000` gives `limit.resetsAt = 1762400000` and `ok: false`.
  - A `result` with `subtype: "error_max_turns"` gives `ok: false` and keeps the cost.
  - `transcript` is the JSONL of every message, for Blob upload.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `runAgent`.** Call `query({ prompt, options })` with these options:
  - `model`, `cwd`, `maxTurns` and the `AbortController` behind `signal`.
  - `settingSources: ["user", "project"]`, so the vendored `~/.claude/agents` and the repo's own `.claude/` load.
  - `permissionMode: "bypassPermissions"`, which is safe only because the cell is a throwaway container holding a one-repo token.
  - `sandbox` from the Task 2 Step 9 result: the egress allowlist when the sandbox can start, otherwise omitted, with the pending decision recorded.
  - When `tools` is false, `disallowedTools: ["*"]`.

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
  - `POST /stage` takes `{ stageId, attempt, status: "started" | "passed" | "failed", model, tokensIn, tokensOut, costUsd, transcriptRef? }`. It writes `stage_run` and, on `passed`, `run.last_stage`.
  - `POST /transition` takes `{ event: ItemEvent, question?: { kind: "needs_input" | "sign_off"; body: string }, prUrl?: string, resumeAt?: string, lockSha?: string }`.
  - `POST /transcript-url` takes `{ stageId, attempt }` and returns a write-only SAS URL for `transcripts/<runId>/<stageId>-<attempt>.jsonl`, valid for 15 minutes.
- `runToken(secret: string, runId: string, generation: number): string`

- [ ] **Step 1: Write failing tests** against `startTestDb()` and a request helper:
  - With the current generation's token, `/stage` writes one `stage_run` row.
  - **Review Focus 2.** After a re-claim bumps the generation, each of the five routes with the old token returns 409, and the `stage_run`, `event` and `item` tables are unchanged.
  - `/transition` with `scenarios_written` and a `sign_off` question moves InProgress to SignOff, inserts the question, releases the lease, and so frees the WIP slot.
  - `/transition` with `retries_exhausted` moves to Failed, and the event payload lists every attempt from `stage_run`.
  - `/lease` returns `stop: true` while a factory `pause` override is active.
  - **Status mirroring.** Every transition mirrors to the PBI through `adapter.setStatus`, using the source's field map, as spec §5 requires. SignOff, NeedsInput and Failed also post a comment that names what the item is waiting for. Assert this against the fake adapter.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes in `src/http/server.ts` and mount them first, so they work without a dashboard session. Ignore every `x-ms-client-principal*` header on these routes. Put the status mirroring in one `onTransition(itemId, from, to)` hook that the store calls after commit, so the watcher and the dashboard mirror the same way.
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
  - `setOverride(c, o: { scope: "factory" | "item"; targetId: string | null; kind: "pause" | "resume" | "drain" | "hold" | "unhold" | "stop_run" | "kill"; reason: string; createdBy: string; expiresAt: Date | null }): Promise<void>`. A blank `reason` throws.
  - `activeOverrides(c, now: Date): Promise<Override[]>`

- [ ] **Step 1: Write failing tests** with `fakeLauncher` and the test DB:
  - **Fixed WIP.** With one InProgress item that holds a live lease and one Queued item, `tick` starts nothing. Once the lease expires, `tick` moves the old item to Queued and starts one cell.
  - **Review Focus 5.** A second `tick` from a new process, with the same DB and a live lease, starts nothing.
  - **Kill switch.** A `kill` override, or `killFlag: true`, makes `tick` call `stop` for every execution with a live lease and start nothing.
  - **Drain and pause.** Neither starts anything. Under drain the running cell's `/lease` reply has `stop: false`, and under pause it has `stop: true`.
  - **Hold.** A `hold` item override keeps that item out of `claimNext`.
  - **Stop a run.** A `stop_run` override stops the execution, moves the item to Failed through `overrideTo`, sets `held = true`, and comments the branch name on the PBI.
  - **Usage limit.** An item with `run.resume_at` in the future is skipped, and nothing at all starts before the earliest `resume_at`, as spec §7 requires.
  - **Expiry.** Item overrides end when the item reaches Done, Failed or Abandoned.
  - **Timeouts.** SignOff and NeedsInput items whose open question is older than 5 days move to Abandoned through `timed_out`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Right after a claim that opens a new run, the scheduler records:
  - `run.repo_id`;
  - `run.config_sha`, from `RepoHost.defaultBranchSha`;
  - `run.sop_version`, from the loaded SOP file.

  The cell reads both files at those pins for the whole run, as spec §6 requires. The cell env passed to `start` is:
  - `RUN_ID`, `ITEM_ID`, `GENERATION`, `RUN_TOKEN`, `CONTROL_URL` and `REPO`;
  - `BRANCH=factory/pbi-<externalId>`;
  - `RESUME_FROM`, set to `run.last_stage`.

  `wip_policy` holds one row, `mode = 'fixed'` with `current_wip = 1`, and the scheduler reads it each tick.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(scheduler): fixed WIP, launcher, Phase 0 overrides`.

---

### Task 14: Cell engine, stages 1 to 7

**Files:**
- Create: `src/cell/engine.ts`, `src/cell/api-client.ts`, `src/cell/main.ts`, `src/cell/engine.test.ts`, `sop/default.yml`, `sop/prompts/understand.md`, `sop/prompts/specify.md`, `sop/prompts/red.md`, `sop/prompts/tdd.md`, `sop/prompts/self-review.md`, `sop/prompts/open-pr.md`, `cell/claude/agents/self-reviewer.md`
- Modify: `cell/Dockerfile`

**Interfaces:**
- Consumes: `runAgent`, `classify`, `redGate`, `greenGate`, `traceability`, `matchesLock`, `loadSop`, `parseRepoConfig`, and the cell API from Task 12 through `api-client.ts`.
- Produces: `runCell(deps: { api: CellApi; agent: typeof runAgent; git: Git; sop: Sop; config: RepoConfig; resumeFrom: string | null; now: () => Date }): Promise<"done" | "waiting" | "failed" | "stopped" | "limited">`

  Also `type Git = { clone(url: string, branch: string): Promise<string>; commitAll(msg: string): Promise<string>; push(): Promise<void>; head(): Promise<string> }`.

Stage behaviour, from spec §6 rows 1 to 7:

| Stage | Exit check in code | On failure |
|---|---|---|
| understand | Agent output lists each criterion with an `@ac-N` tag | `blocked`, with the agent's question |
| specify | `bdd.parse` exits 0, and `traceability()` is empty. Feature files are committed and posted on the PBI with dedupe key `scenarios:<sha>` | 1 retry, then `blocked` |
| sign-off | The engine posts `scenarios_written` with a `sign_off` question and returns `waiting`. On resume, an approval sets `lockSha`, and "changes asked" goes back to specify | none |
| red | `bdd.run` and then `redGate(classify(report))` is ok, and `matchesLock` is true. The report is uploaded as red evidence | 2 retries, then `blocked` |
| green | `greenGate`, `commands.test`, `commands.lint` and `matchesLock` all pass | 3 retries, then `retries_exhausted` |
| self-review | The reviewer's last line is `APPROVED`. `DEADLOCK` or 5 rounds without approval means `blocked` | `blocked` |
| open-pr | `openOrUpdatePr`, then `checksOnHead` polled every 60s until `success`. On `failure`, back to green, counted against green's retries | as stated |

- [ ] **Step 1: Write `sop/default.yml`.** Copy the spec's SOP YAML, keep stages understand to open-pr, and keep `budget` as recorded data only. Phase 0 doesn't enforce caps. The one exception is `wall_clock: 8h`, which counts only time with a lease, and when it runs out the engine posts `blocked`. Write the six prompt files. `specify.md` carries the spec's BDD rules verbatim: traceability, business language, the lock and red proof. `red.md` says to write step definitions and stubs with no behaviour.
- [ ] **Step 2: Vendor the agent definition.** Copy `~/.claude/agents/self-reviewer.md` into `cell/claude/agents/`. In `self-review.md`, add the spec's BDD checks: every step definition asserts something, no scenario is pending or skipped, and no tag hides a scenario. Also add the rule "after a finding is rebutted twice and still held, end with `DEADLOCK`".
- [ ] **Step 3: Write failing engine tests** with a scripted fake agent, a fake `Git` and a recording `CellApi`:
  - **Happy path.** A fresh run executes understand and specify, posts `scenarios_written`, and returns `waiting`. Resumed with `resumeFrom: "sign-off"` and an approved question, it runs red, green, self-review and open-pr. It posts `pr_opened` and returns `done`. Each stage writes `started` then `passed` with the fake agent's cost.
  - **Checkpoint resume.** Resumed with `resumeFrom: "red"`, it never calls the agent for understand or specify.
  - **Red proof.** A red stage whose report has a green scenario retries twice, then posts `blocked` with "scenario passes before any behaviour exists".
  - **Usage limit.** An agent result with `limit.resetsAt` makes the engine commit, post `/stage failed` and `/transition` with `resumeAt`, and return `limited`. That attempt doesn't count against retries.
  - **Stop.** A `/lease` reply of `{ stop: true }` during any stage aborts the agent through `signal`, commits the work in progress, and returns `stopped`.
  - **Lost lease.** A 409 from any API call makes the engine stop at once, with no push and no further calls.
- [ ] **Step 4: Run the tests.** Expected: FAIL.
- [ ] **Step 5: Implement `engine.ts`, `api-client.ts` and `main.ts`.**
  - A lease renewal loop runs every 60s. After 3 minutes of failed renewals it aborts and exits 1.
  - Before each push, comment and transition, the engine calls `/lease` to check the generation.
  - Every stage uploads its transcript through `/transcript-url`.
  - `main.ts` clones with a token from `/github-token`, refreshing it 5 minutes before `expiresAt`. It reads `.factory/config.yml` at the pinned `config_sha` and the SOP at the pinned version, then runs `runCell`.
- [ ] **Step 6: Update `cell/Dockerfile`.** Use `node:26.13.0-bookworm`, plus `git`, `bubblewrap` and `socat` for the sandbox. Copy `cell/claude/agents` into `/home/factory/.claude/agents` and run as a non-root `factory` user.
- [ ] **Step 7: Run the tests.** Expected: PASS.
- [ ] **Step 8: Commit** `feat(cell): SOP engine for stages 1 to 7`.

---

### Task 15: Dashboard: sign-in, Floor, Run detail, controls

**Files:**
- Create: `src/http/server.ts`, `src/http/auth.ts`, `src/http/views.ts`, `src/http/routes.ts`, `src/http/auth.test.ts`, `src/http/routes.test.ts`, `src/main.ts`, `scripts/seed-owner.ts`
- Modify: `Dockerfile`

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
    - `POST /items/:id/answer` takes `{ answer }` and needs operator.
    - `POST /overrides` needs operator.
    - `POST /users` needs owner.
    - `GET /phase0` is the exit report.
  - `scripts/seed-owner.ts` takes `--provider`, `--subject` and `--email`, and inserts the first owner.

- [ ] **Step 1: Write failing tests:**
  - **Review Focus 4.**
    - `identify` returns null for any request to `/webhooks/github` or `/internal/cells/x`, even with every principal header set.
    - A dashboard request whose subject isn't in `user` gets 403 and the page "You don't have access to this factory. Ask an owner to add you."
  - **Roles.** A viewer posting `/overrides` gets 403. An operator posting `/overrides` with an empty reason gets 400.
  - **Sign-off.** A sign-off from a user without `product_owner` gets 403. A sign-off from a product owner answers the open `sign_off` question, comments the decision on the PBI, and logs an event with `actor: "human"` and the user id.
  - **Floor.** Floor lists every InProgress, SignOff, NeedsInput and InReview item. Each row shows the current stage, time in stage, the sum of `stage_run.cost_usd` and the last agent message, and a held item or active override shows a badge.
  - **Run detail.** Run detail shows:
    - the SOP version and config sha;
    - the signed-off feature files at `features_lock_sha`;
    - each scenario's red and green verdicts;
    - per stage: attempts, model, tokens, cost and a transcript link;
    - the shadow risk tier with its reasons.
  - **Token expiry.** A banner appears when the Claude token expires within 30 days of `CLAUDE_TOKEN_CREATED_AT` + 365 days.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The server is plain `node:http` with a route table and HTML from template literals through one `escapeHtml`.
  - `views.ts` defines its colours as CSS custom properties with a dark-mode override, and every form control has a label.
  - `main.ts` wires the pool, `migrate`, the scheduler `tick` every `TICK_MS`, `pollOnce` every `POLL_INTERVAL_MS`, and the HTTP server.
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
  - `pathFloor(files: string[], sensitive: string[], dodPath: string): { min: "Low" | "Medium" | "High"; reasons: string[] }`. CI workflow files, `sensitive_paths`, anything under `.factory/` and the DoD file force at least Medium.
  - `classifyRisk(diff: string, files: string[], ctx: { sop: Sop; config: RepoConfig; agent: typeof runAgent }): Promise<{ tier: "Low" | "Medium" | "High"; reasons: string[] }>`. It runs two passes on `sop.models.coding`: the tier, then "does this change need a person anyway". It never returns below `pathFloor`.

- [ ] **Step 1: Write failing tests:**
  - **Path floor.** `pathFloor` gives Medium for `.github/workflows/ci.yml`, `.factory/config.yml`, `DoD.md` and a file matching `src/billing/**`, and gives Low for `docs/readme.md`.
  - **No lowering.** A fake agent answering Low for a diff that touches `.factory/config.yml` still yields Medium, with both reasons kept.
  - **Second pass.** A second pass that answers "needs a person" raises Low to Medium.
  - **Unreadable output.** Output that doesn't parse yields High, with the reason "classifier output unreadable". A wrong Low lets code skip review, so failure raises the tier.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Match globs with `path.matchesGlob` from `node:path`. The cell sends the tier and reasons with `pr_opened`, the control plane writes `run.risk_tier` and `run.tier_reasons`, and the PR body gains a "Shadow risk tier" section. No status check is posted.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(risk): shadow-mode tier classifier`.

---

### Task 17: Merge detection and the walking skeleton end to end

**Files:**
- Create: `src/e2e.test.ts`
- Modify: `src/watcher/webhook.ts`, so `pr_merged` moves InReview to Accepted and `pr_closed` without a merge moves InReview to InProgress through `changes_requested`

**Interfaces:**
- Consumes everything above, with the fake adapter, the fake launcher running `runCell` in-process, and the scripted fake agent.

- [ ] **Step 1: Write the failing end-to-end test:**
  - **The full path.** Seed one labelled item with two criteria in a repo whose fake files include `DoD.md` and `.factory/config.yml`. Then tick:
    - Eligible goes to Queued with a fake judge reply of `ready`.
    - Queued goes to InProgress and then SignOff.
    - The product owner approves, and SignOff goes to InProgress and then InReview with a PR URL.
    - A `pr_merged` webhook moves InReview to Accepted.
  - **Event trail.** The `event` table holds every transition in order, and `/phase0` reports 1 merged PR and its cost.
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

- [ ] **Step 1: Deploy through `deploy.yml`.** Then run `scripts/seed-owner.ts` once against the deployed database with your Microsoft identity, and mark yourself `product_owner`.
- [ ] **Step 2: Create the Phase 0 target repo.**
  - Add `DoD.md`, `.factory/config.yml` with real `bdd` and `commands` entries, a Gherkin runner that writes Cucumber Messages to `bdd.report`, and CI.
  - In branch protection, require one human review and CI. Shadow mode posts no `risk-approval`, so that check isn't required yet.
  - Install the GitHub App on that repo only.
- [ ] **Step 3: Run one PBI live.** Add one small PBI with the `factory` label to the org project. Expected:
  - A readiness comment.
  - Scenarios posted on the PBI, and the sign-off question on Run detail.
  - After your approval, a PR with red and green results, the review rounds and a shadow tier.
  - After your merge, the item at Accepted.

  Record the run id and cost in the runbook.
- [ ] **Step 4: Test the four overrides live.** Hold a second item, pause, drain and stop a run. Record that each took effect within 30 seconds, using event timestamps against the moment of the click. Press the kill switch and record that every execution stopped within a minute.
- [ ] **Step 5: Write `docs/superpowers/runbooks/phase-0.md`.** It covers how to seed users, rotate the GitHub App key and the Claude token, read `/phase0` toward the exit criteria (10 merged PRs, cost per item, your verdict on the shadow tiers), and use the kill switch.
- [ ] **Step 6: Commit** `docs: phase 0 runbook and first live run`.

---

## Out of scope for Phase 0

These come from spec §13 Phases 1 to 3, and nothing here builds them:
- stages 8 to 11, Increment records and DoD verification on main;
- an enforced `risk-approval` check and the `approval` table;
- budget caps, the Inbox and the Cost view;
- quarantine, adaptive and advised WIP, and Azure DevOps adapters.

The SOP file's `budget` block is recorded but not enforced, apart from the wall clock.
