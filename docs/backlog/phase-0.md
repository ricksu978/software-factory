# Phase 0 backlog

The software factory builds itself, locally first. PBIs 1 to 20 are the Phase 0 plan's 20 tasks, in backlog order. PBIs 1 to 18 are Phase 0a, run on the owner's machine under Aspire, and PBIs 19 and 20 are Phase 0b, in Azure. PBI 21 is the first work the factory builds for itself, and the owner builds PBI 22 by hand. The owner approved them on 2026-11-06, and PBI n is issue #(n + 4) on the personal Project, so PBI 1 is #5 and PBI 22 is #26.

Until the factory can run, PBIs 1 to 18 go through their SOP by hand. Claude does Understand, Specify, Red, Green, self-review and the PR, and the owner signs off the scenarios and merges. "Takes over" says which manual step that PBI hands to the factory once it merges.

Which PBIs carry the `factory` label:
- **PBI 21.** It's for the factory to build, so it carries the label. It names its plan task, has criteria a test can check, and fits one Sprint, per `.factory/dor.md`.
- **PBIs 1 to 18.** They're closed before the factory runs, so the label changes nothing.
- **PBIs 19 and 20.** They never carry it. They need the owner's Azure Owner rights, three real-account sign-ins and a cutover, which no cell can do and no test can check, so the owner runs them by hand.
- **PBI 22.** It never carries it either. Its criteria need a real database, so its scenarios are `@db`, and Red fails any item with an `@db` scenario until PBI 22 itself merges (plan Task 4). The owner builds it through the SOP by hand, as for PBIs 1 to 18.

The Phase 0b exit asks for 10 merged factory PRs. PBI 21 is the first, and the owner adds the rest to the board as they come up.

## PBI 1. Project skeleton with a BDD runner

Implements plan Task 1, plus the Gherkin runner every later PBI needs.

- [ ] `npm run typecheck` exits 0 on a clean checkout.
- [ ] `npm test` runs every `src/**/*.test.ts` with `node:test`.
- [ ] `npm run bdd` runs every feature file and writes a Cucumber Messages report to `reports/bdd.ndjson`.
- [ ] CI runs typecheck, tests and scenarios on every push and PR, beside the prose check.
- [ ] `.factory/config.yml` names the `bdd` parse, run and report commands and the `test` and `lint` commands, in the shape plan Task 9 reads.

Takes over: nothing yet. It makes the first line of `.factory/dod.md` checkable.

## PBI 2. Local platform on Aspire

Implements plan Task 2.

- [ ] `aspire run` brings up Postgres and the Azurite storage emulator, both with data volumes, a `migrate` resource that exits 0, and the control resource on port 7400.
- [ ] After a stop and a second `aspire run`, `migrate` connects to the same database.
- [ ] The control resource receives the database and blob connections and the four secret parameters as environment variables, and the spike record names them.
- [ ] From inside a `factory-cell:local` container, a ping to the control plane gets 204, and a PUT to a local upload URL gets 201.
- [ ] A cell container runs the Agent SDK on the subscription token, or the spike record shows the CLI fallback working.
- [ ] The spike record states whether bubblewrap starts in a local cell container, and whether GitHub lets the App's bot be assigned.

Takes over: nothing. It gives every later PBI a place to run.

## PBI 3. PBI state machine

Implements plan Task 3.

- [ ] Every edge in the plan's Task 3 table moves to its listed state.
- [ ] An edge the table doesn't list returns null.
- [ ] `overrideTo` accepts any pair of states.

Takes over: nothing yet.

## PBI 4. Schema, transitions and event log

Implements plan Task 4.

- [ ] A legal transition writes the new state and exactly one event row in one transaction.
- [ ] An illegal transition throws and leaves the item and the event table unchanged.
- [ ] Leaving InProgress raises the lease generation by 1 and clears the lease.
- [ ] Connected as `factory_app`, an `UPDATE` on `event` fails.
- [ ] With `FACTORY_DB_TESTS=skip`, a test file that uses `dbTest` is skipped, and without it the file runs.

Takes over: nothing yet.

## PBI 5. Leases with generation fencing

Implements plan Task 5.

- [ ] Each claim raises the generation by 1 and sets the lease to expire in 300 seconds.
- [ ] A renewal with an old generation returns "lost" and changes nothing.
- [ ] Two concurrent claims on one Queued item return one claim and one null.
- [ ] An expired lease sends an InProgress item back to Queued with its resume pointer unchanged.

Takes over: nothing yet.

## PBI 6. Adapter interfaces, fake adapter and contract suite

Implements plan Task 6.

- [ ] The fake adapter passes every case in the shared contract suite.
- [ ] Commenting twice with the same dedupe key leaves one comment.
- [ ] Claiming an item shows the factory's marker, and releasing it clears the marker.

Takes over: nothing yet.

## PBI 7. GitHub adapters and webhook intake

Implements plan Task 7.

- [ ] A delivery with a valid `X-Hub-Signature-256` is accepted, and one with a changed byte, no header or a `sha1=` header is refused.
- [ ] The same delivery id processed twice produces one event.
- [ ] A cell token request carries write on contents, pull requests and issues, and nothing on statuses or checks.
- [ ] Against a sandbox personal Project, the GitHub backlog adapter passes the contract suite.

Takes over: nothing yet.

## PBI 8. Poller

Implements plan Task 8.

- [ ] A newly labelled item on the board becomes an Eligible item within one poll.
- [ ] An item whose label is removed or that is closed during a run moves to Abandoned, and its PR closes.
- [ ] Changing any readiness input re-gates every NotReady item.
- [ ] An InReview item whose PR a person closed without merging moves to Abandoned within one poll.
Takes over: watching the board, which the owner does by hand until then.

## PBI 9. Repo config, policy files and readiness gate

Implements plan Task 9.

- [ ] An item that fails a `.factory/dor.md` line gets a comment naming that line, word for word.
- [ ] A repo without `.factory/dor.md` is checked against the factory's default.
- [ ] A `run:` line in any file other than `dod.md` makes that file invalid, with the reason shown.
- [ ] Item text that asks for credentials is flagged, whatever `dor.md` says.

Takes over: checking this repo's own backlog against `.factory/dor.md`.

## PBI 10. BDD evidence: red, green and the lock

Implements plan Task 10.

- [ ] A scenario whose first non-passing step is a failed Then counts as red, and every other failure counts as a crash.
- [ ] Red passes for a second item while an earlier item's scenarios are already green.
- [ ] Editing a locked feature file fails the lock check, and adding a step definition doesn't.

Takes over: judging Red and Green from the Cucumber report.

## PBI 11. Agent runner

Implements plan Task 11.

- [ ] A run's cost is the sum of `costUSD` across the models used.
- [ ] A rejected usage-limit event stops the run with its reset time.
- [ ] Judge mode loads no settings and allows no tools.

Takes over: nothing yet.

## PBI 12. Cell API

Implements plan Task 12.

- [ ] Every route rejects a token from an older lease generation with 409 and writes nothing.
- [ ] A cell may send only its five allowed events, and any other gets 400.
- [ ] Every transition updates the board's status through the field map.

Takes over: nothing yet.

## PBI 13. Scheduler, launcher and overrides

Implements plan Task 13.

- [ ] With one item running and WIP 1, nothing new starts.
- [ ] With 3 items waiting on a person and `review_capacity` 3, no Queued item starts, and an answered item still can.
- [ ] The kill switch stops every running cell.
- [ ] Re-queueing a stopped item clears its hold.

Takes over: deciding which PBI starts next.

## PBI 14. Cell engine, stages 1 to 7 and address

Implements plan Task 14.

- [ ] A fresh run stops after Specify and asks for sign-off.
- [ ] After approval, a run goes through Red, Green, self-review and open-pr, and opens a PR with `Refs #<n>`.
- [ ] A failed `dod.md` line fails Green, and a line only a person can check goes to the PR checklist unticked.
- [ ] A changes-requested review sends the item back through address to InReview.

Takes over: Claude running the SOP by hand. From here, cells run PBIs.

## PBI 15. Dashboard

Implements plan Task 15.

- [ ] A signed-in user who isn't on the allowlist sees the no-access page.
- [ ] Locally, a request without the cookie from this start's sign-in link gets no identity, and a dashboard POST from another origin gets 403.
- [ ] Floor shows what waits on the owner, the next five items and the not-ready items with their failed lines.
- [ ] A `/approve` comment from a product owner signs off scenarios, exactly as the dashboard button does.

Takes over: sign-off and answers by hand in chat.

## PBI 16. Shadow risk classifier

Implements plan Task 16.

- [ ] A change to `.factory/`, `.claude/`, `AGENTS.md` or `CLAUDE.md` is at least Medium, whatever `risk.md` says.
- [ ] A `dod.md` line left for a person raises the PR to at least Medium.
- [ ] The PR body shows the tier and its reasons.

Takes over: nothing. Shadow tiers are recorded, and a person still approves every PR.

## PBI 17. Walking skeleton end to end

Implements plan Task 17.

- [ ] On the fake adapter, one item goes from Eligible to Done, through sign-off, a changes-requested round and a merge.
- [ ] A second item reaches Done after the first, with the first item's scenarios already on main.

Takes over: nothing. It proves the parts fit.

## PBI 18. First live item, locally

Implements plan Task 18. This is Phase 0a's exit.

- [ ] Under `aspire run`, the factory takes PBI 21 from this repo's own board, opens its PR from a local cell container, and moves it to Done after the owner merges and CI on main is green.
- [ ] Sign-off in the local dashboard moves the item on, and the dev identity works only with `FACTORY_ENV=local`.
- [ ] Each of the five Phase 0 overrides takes effect within 30 seconds, and the kill switch stops every cell container within a minute.
- [ ] A restart of `aspire run` while a cell is in Green loses no item, event or transcript, and starts no second cell.

Takes over: building. From here the local factory builds every factory-labelled PBI, starting with PBI 21. The owner still runs PBIs 19, 20 and 22.

## PBI 19. Azure platform and the cloud platform tests

Implements plan Task 19. This is where Phase 0b starts. No `factory` label: the owner runs it.

- [ ] `az bicep build` on `infra/main.bicep` exits 0, and the bootstrap deploy creates every resource Step 1 names.
- [ ] The spike record shows a Google account, a personal Microsoft account and a work account from another tenant each signed in, with distinct ids.
- [ ] A forged `X-MS-CLIENT-PRINCIPAL-ID` header on a signed-out request gets a login redirect, never a 200.
- [ ] A signed GitHub webhook delivery gets 204 without a login redirect, and a wrongly signed one gets 401.
- [ ] The spike record states whether the Agent SDK runs on the subscription token in Azure, whether the sandbox blocks `example.com`, whether the bot can be assigned, and whether a job start override keeps env vars.

Takes over: nothing. It settles the cloud facts PBI 20 depends on.

## PBI 20. Deploy to Azure and run live there

Implements plan Task 20. This is Phase 0b's exit. No `factory` label: the owner runs it.

- [ ] The Azure control plane neither polls the board nor starts a cell until the local factory has drained, recorded its merged-PR count and stopped.
- [ ] The deployed factory then takes the next factory-labelled PBI from the board, with no `factory/pbi-*` branch left over from the local run.
- [ ] A `/approve` comment from a product owner signs off scenarios, now that webhooks reach the factory.
- [ ] Each of the five overrides takes effect within 30 seconds in Azure, and the kill switch stops every job execution within a minute.

Takes over: the owner's machine. The factory now runs in the cloud.

## PBI 21. Length-prefixed readiness hash

Implements plan Run contract 11 and Task 9. The factory builds it.

- [ ] Two sets of readiness texts that join to the same string, such as `dor` = "ab" with `scenarios` = "c" and `dor` = "a" with `scenarios` = "bc", give different `readinessSha` values.
- [ ] A null file and a file whose text is the word `absent` give different values.
- [ ] Every existing `readinessSha` test still passes.

## PBI 22. A database for cells

Implements plan Global Constraints and Task 4. No `factory` label: the owner builds it by hand.

- [ ] A cell can run the database suites and the `@db` scenarios, so `.factory/dod.md` and `.factory/config.yml` drop `FACTORY_DB_TESTS=skip` and the `not @db` filter.
- [ ] Two cells running the suites at once don't see each other's rows.
- [ ] A cell can reach only its test database, never the factory's own.
