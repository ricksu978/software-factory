# Phases, stages and states implementation plan

> **For whoever executes this.** The factory builds this plan, one PBI per task.
> File each task as an issue with the `factory` label once the tasks it depends on are Done.
> The factory's own stages do the test-first work, so a task here gives the PBI's title, its acceptance criteria, the rules it changes and the names later tasks rely on.

**Goal.** An item's position reads as a phase, a stage and a state with a reason, and the factory never closes a PBI by itself.

**Architecture.** First a pure function works out the new position from what the factory stores today, and the pages and the board show it. Then each behaviour changes in a PBI of its own. Last, the item row stores the new model and the old state names are deleted.

**Tech stack.** TypeScript on Node, Postgres, the Hono API in `src/api`, the React SPA in `web/src`, cucumber-js scenarios in `features`.

**Spec.** `docs/superpowers/specs/2026-11-26-phases-stages-states-design.md`

## Global constraints

- Stage names, exactly: Readiness, Split, Rule Change, Understand, Specify, Sign Off, Red, Green, Self Review, Submit, Human Review, Address, Merge, Verify.
- Final stage names, exactly: Done, Not Done, Partially Done.
- State names, exactly: Queued, In Progress, Needs Human, Waiting.
- Needs Human reasons, exactly: Item not ready, Split blocked, Rule change approval, Scenario sign-off, Question from the agent, Feature change decision, CI broken, Human review, PR closed, Stage failed, Verify failed on `main`.
- Waiting reasons, exactly: "Waiting for split children to complete" and "Waits on #N", with every open dependency named.
- No task converts an in-flight item by hand. An item in any of today's states keeps moving after each task ships.
- Tasks 4 to 10 change §5 or §6 of `docs/superpowers/specs/2026-11-05-software-factory-design.html`. Each of their PBIs carries a `## Changes the factory's rules` section whose Before text is copied from `git show origin/main:<file>` on the day it is filed, and each waits for the owner's approval.
- Every PBI names this plan's task as the plan task it implements, and fits one Sprint.
- Each PR updates the main spec and the Phase 0 plan for the behaviour it changes, as the Definition of Done asks.

## Review focus

Five conditions the spec implies and no task's criteria would otherwise test, most likely first.
Each has a criterion in the task that owns it.

1. **A stored state and a run that disagree.** An `InProgress` item with no run, or a run whose stage id an older SOP version used, still gets a position and Floor still renders. Task 1.
2. **Needs Human items that never time out.** After weeks, review capacity fills and nothing new starts. Floor says that review capacity is why. Task 4.
3. **A reopened PBI with a branch and a PR from its first run.** The new run takes a new branch and doesn't push to the old one. Task 6.
4. **A split child that no longer exists on GitHub.** The parent's Waiting reason names the missing child. The parent never waits in silence. Task 7.
5. **An item that is mid-stage when its stage goes away.** An item in `pr-review` when Task 8 ships carries on at Human Review or Address. Task 8.

---

## Task 0: Before anything

Not a PBI. These are done by the owner or by PBIs already filed.

- [ ] #414 is Done, so a rule-change PBI reaches its approval.
- [ ] #281, #282 and #283 are Done, so the dashboard is the SPA behind the BFF and pages are built once.
- [ ] #366 loses its criterion that abandons a feature change request after 5 days. It is in flight, so the owner makes the edit, and a change to its acceptance criteria re-queues it.
- [ ] #413 loses its criteria about the PR review stage's findings, before Task 8.
- [ ] This plan and its spec are on `main`.

## Task 1: Work out the position

**PBI title.** An item's phase, stage, state and reason are worked out from what the factory stores today

**Depends on.** Task 0.

**Changes rules.** none. It adds a function and changes no behaviour.

**Files:**
- Create: `src/core/position.ts`, `src/core/position.test.ts`
- Read only: `src/core/states.ts`, `src/config/sop.ts`

**Interfaces:**
- Produces:

```ts
export type Phase = "Triage" | "Plan" | "Build" | "Deliver" | "Final";
export type Stage =
  | "Readiness" | "Split" | "Rule Change"
  | "Understand" | "Specify" | "Sign Off"
  | "Red" | "Green" | "Self Review"
  | "Submit" | "PR Review" | "Human Review" | "Address" | "Merge" | "Verify"
  | "Done" | "Not Done" | "Partially Done";
export type State = "Queued" | "In Progress" | "Needs Human" | "Waiting";
export type Position = { phase: Phase; stage: Stage; state: State | null; reason: string | null; since: Date | null };

export type PositionInput = {
  state: ItemState;
  /** The stage the run is in or resumes at, or null when the item has no run. */
  runStage: StageId | null;
  /** True when the item's last readiness check left it waiting for the owner's rule approval. */
  waitsForRuleApproval: boolean;
  /** True when the open question names only CI failures. */
  questionIsCi: boolean;
  /** The external ids of the open items this one waits on. */
  blockedBy: string[];
  /** True when a `Failed` item failed after its PR merged. */
  failedAfterMerge: boolean;
  /** When the item entered its stored state. */
  stateSince: Date;
};
export function phaseOf(stage: Stage): Phase;
export function position(i: PositionInput): Position;
```

`"PR Review"` is in `Stage` only until Task 8 removes it.

**Acceptance criteria:**
- [ ] Each row of the spec's table "How today's states read in the model" gives the stage, state and reason that row names.
- [ ] `phaseOf` puts every stage in the phase the spec's stage table gives it, and the three final stages in Final.
- [ ] A Closed position has a null state, a null reason and a null since.
- [ ] A Needs Human or Waiting position always has a reason and a since. Queued and In Progress have a null reason.
- [ ] An item waiting on two open dependencies reads "Waits on #283 and #280".
- [ ] An `InProgress` item with no run reads Understand, In Progress. A run stage the function doesn't know reads as Understand too, and the function never throws. (Review focus 1.)

## Task 2: Show the position

**PBI title.** Floor and Run detail show each item's phase, stage, state and reason, and Waiting on You lists what needs a person, oldest first

**Depends on.** Task 1.

**Changes rules.** none. §8 only.

**Files:**
- Modify: `src/api/items.ts`, `src/api/main.ts`, `web/src/pages/Floor.tsx`, `web/src/pages/RunDetail.tsx`, `web/src/pages/parts.tsx`

**Interfaces:**
- Consumes: `position`, `Position` from Task 1.
- Produces: each item in the API's Floor and item answers carries `position: { phase, stage, state, reason, since }`, with `since` as an ISO time or null.

**Acceptance criteria:**
- [ ] Every item on Floor shows its phase, stage and state, and its reason when it has one.
- [ ] Waiting on You lists every item whose state is Needs Human, with its reason and how long it has waited.
- [ ] Waiting on You is ordered by `since`, oldest first, and two items with the same time keep a stable order.
- [ ] An item in Waiting shows what it waits on and is absent from Waiting on You.
- [ ] Run detail's heading shows the item's phase, stage, state and reason in place of today's state name.
- [ ] Floor still renders when one item's position can't be worked out, and shows that item with its stored state. (Review focus 1.)

## Task 3: The board shows the phase

**PBI title.** The GitHub board's Status shows an item's phase while it is open and its final stage once it is Closed

**Depends on.** Task 1. The owner first adds the Status options Triage, Plan, Build, Deliver, Done, Not Done and Partially Done to the project.

**Changes rules.** none.

**Files:**
- Modify: `src/control/board.ts`, `src/adapters/github/backlog.ts`

**Interfaces:**
- Consumes: `position` from Task 1.
- Produces: the source's field map gains `statusForPhase: Record<Phase | "Done" | "Not Done" | "Partially Done", string | null>`, and `statusFor` is read only when `statusForPhase` is absent.

**Acceptance criteria:**
- [ ] A source with `statusForPhase` gets each item's Status set from its phase, and from its final stage once Closed.
- [ ] A source without it keeps today's Status values.
- [ ] A phase mapped to null leaves the Status as it is.
- [ ] A Status option the project doesn't have fails that one update with a message naming the option, and the poll carries on.

## Task 4: No timeouts

**PBI title.** A sign-off or a question nobody answers waits for as long as it takes, and the item is never abandoned for it

**Depends on.** Task 2.

**Changes rules.** §5. The two moves "NeedsInput --> Abandoned: no answer in 5 days" and "SignOff --> Abandoned: no answer in 5 days", and the sentence "and after 5 days with no answer the item is Abandoned."

**Files:**
- Modify: `src/core/states.ts`, `src/scheduler/scheduler.ts` (`chaseQuestions`), `web/src/pages/Floor.tsx`

**Acceptance criteria:**
- [ ] An item whose sign-off has had no answer for 30 days is still at Sign Off in Needs Human.
- [ ] An item whose question has had no answer for 30 days is still in Needs Human at the stage that asked.
- [ ] Reminder comments are still posted on the schedule they have today.
- [ ] The state machine has no `timed_out` move.
- [ ] An item that timed out to `Abandoned` before this ships stays as it is and can be re-queued as today.
- [ ] When the count of waiting items has reached review capacity, Floor says no new item starts until one of them is answered. (Review focus 2.)

## Task 5: Failure becomes Needs Human

**PBI title.** A stage that gives up, or a merge that breaks main, leaves the item where it failed with Needs Human, and no item ends as Failed

**Depends on.** Task 2.

**Changes rules.** §5, every move into and out of `Failed`. §6 stage 10, "Item moves to Failed, the factory files a bug PBI and the dashboard flags it."

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/scheduler/scheduler.ts` (`recheckFailed`, `pollMergedCi`), `src/cell/engine.ts`, `src/api/main.ts`

**Interfaces:**
- Consumes: `position` from Task 1.
- Produces: `PositionInput` loses `failedAfterMerge` once no item is stored as `Failed`.

**Acceptance criteria:**
- [ ] Green out of retries leaves the item at Green in Needs Human with "Stage failed".
- [ ] A merge that turns `main` red leaves the item at Verify in Needs Human with "Verify failed on `main`", and the factory files its bug PBI as today.
- [ ] `main` going green again moves that item to Done without a person, as the re-check does today.
- [ ] A person can re-queue an item in either reason, and it runs again at that stage.
- [ ] A person can close an item in either reason. Until Task 6 it is withdrawn as today.
- [ ] A stage that gives up by asking a question still asks it, with "Question from the agent" or "CI broken".
- [ ] An item stored as `Failed` when this ships reads with the right reason and can be re-queued, with no edit to its row by hand.

## Task 6: Not Done, reopening and a closed PR

**PBI title.** The Product Owner closes a PBI as Not Done, a reopened one starts over at Readiness, and a closed PR asks why

**Depends on.** Tasks 4 and 5.

**Changes rules.** §5, every move into and out of `Abandoned`, and "FeatureChangeRequest --> Abandoned: label removed, item closed, or PR closed unmerged".

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/watcher/poller.ts`, `src/scheduler/scheduler.ts`, `src/api/main.ts`, `web/src/pages/RunDetail.tsx`

**Acceptance criteria:**
- [ ] Closing the issue on GitHub, or removing the factory's label, closes the PBI as Not Done from any stage.
- [ ] Reopening the issue, putting the label back, or the Reopen control on Run detail starts a Not Done PBI again at Readiness as a new run.
- [ ] The new run takes a new branch and pushes nothing to the first run's branch. Its PR, if one is still open, is closed with a note naming the reopen. (Review focus 3.)
- [ ] A PR a person closes without merging leaves the item at Human Review in Needs Human with "PR closed", and the factory asks why it was closed.
- [ ] Answering "new PR" queues the item at the stage that opens the PR, which opens a new PR from the same branch.
- [ ] Answering "re-spec" starts a new run at Specify from `main`, with the scenario lock lifted.
- [ ] Answering "not done" closes the PBI as Not Done.
- [ ] The factory closes no PBI by itself. No move ends at Not Done without a person's action.
- [ ] An item stored as `Abandoned` when this ships reads as Not Done and reopens the same way.

## Task 7: Split

**PBI title.** A split parent waits for its children and closes as Done, Not Done or Partially Done by how they closed

**Depends on.** Task 6.

**Changes rules.** §5. "NotReady --> Split: split filed, last child filed and label off" and "Split --> Done: every filed child Done".

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/watcher/poller.ts` (closing split parents), `src/gate/readiness.ts`, `src/gate/file-split.ts`

**Acceptance criteria:**
- [ ] A parent whose children are filed sits at Split in Waiting with "Waiting for split children to complete".
- [ ] It closes as Done when every child closed as Done.
- [ ] It closes as Not Done when every child closed as Not Done.
- [ ] It closes as Partially Done when its children closed as a mix, and a Partially Done child counts as a mix.
- [ ] It stays in Waiting while any child is open.
- [ ] A split that can't be filed leaves the item at Split in Needs Human with "Split blocked", naming the child and the lines it failed.
- [ ] A child reopened after its parent closed reopens the parent to Split in Waiting, and the parent closes again by the same rules.
- [ ] A child whose issue no longer exists is named in the parent's Waiting reason. (Review focus 4.)
- [ ] A parent stored as `Split` with a `Failed` or `Abandoned` child when this ships, as #172 is, closes by these rules with no edit by hand.

## Task 8: One review

**PBI title.** The factory reviews its work once, in Self Review, and a change request goes through Address, Self Review and the PR's update before a person sees it again

**Depends on.** Task 2, and #413 trimmed.

**Changes rules.** §6. The stage 8 row "PR review", and the decision "The PR reviewer only comments."

**Files:**
- Modify: `sop/default.yml`, `src/config/sop.ts`, `src/cell/engine.ts`, `src/core/position.ts`, `src/watcher/poller.ts`
- Delete: `sop/prompts/pr-review.md`, `cell/claude/agents/factory-pr-reviewer.md`

**Interfaces:**
- Produces: `STAGE_IDS` without `"pr-review"`, and `Stage` without `"PR Review"`.

**Acceptance criteria:**
- [ ] A new run goes from Self Review to the PR's opening to Human Review, with no review stage between.
- [ ] A person's change request runs Address, then Self Review, then the PR's update and its CI, then Human Review.
- [ ] Red CI on the PR sends the item back to Green, as today.
- [ ] The factory posts no review of its own on the PR.
- [ ] The PR body states the Self Review rounds and no PR review rounds.
- [ ] Review threads the factory opened on a PR before this ships are resolved with a note saying the factory's PR review is retired.
- [ ] An item that is in `pr-review` when this ships carries on at Human Review when it has no open thread, and at Address when it has one. (Review focus 5.)
- [ ] Stage attempts recorded as `pr-review` still show on Run detail, named "PR Review".

## Task 9: Submit

**PBI title.** The stage that opens the PR is named Submit everywhere a stage is stored or shown

**Depends on.** Task 8.

**Changes rules.** §6. The stage 7 row "Open PR".

**Files:**
- Modify: `sop/default.yml`, `src/config/sop.ts`, `src/cell/engine.ts`, `src/control/cell-api.ts`, `src/core/position.ts`
- Rename: `sop/prompts/open-pr.md` to `sop/prompts/submit.md`
- Create: a migration that renames `open-pr` in stored stage ids

**Interfaces:**
- Produces: `STAGE_IDS` with `"submit"` in place of `"open-pr"`.

**Acceptance criteria:**
- [ ] The SOP names the stage `submit`, and a new run records its attempts under that id.
- [ ] A run that is waiting to resume at `open-pr` when this ships resumes at `submit`.
- [ ] Stage attempts recorded as `open-pr` read as Submit on Run detail.
- [ ] A cell built from an older image, still reporting `open-pr`, has its report accepted and stored as `submit`.

## Task 10: Store the model

**PBI title.** The item row holds its stage, state, reason and since, and today's state names are gone

**Depends on.** Tasks 3 to 9.

**Changes rules.** §5 whole, rewritten around stages and states. §6, the stage table, with Readiness, Split, Rule Change, Human Review, Merge and Verify as stages.

This task is bigger than one Sprint. File it as one item and let the readiness gate split it, in this order: write the new columns beside the old one, switch every reader, then delete the old column, `ItemState` and `position`'s mapping.

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/store/items.ts`, `src/scheduler/scheduler.ts`, `src/watcher/poller.ts`, `src/api/items.ts`, `src/control/board.ts`, `src/adapters/github/backlog.ts`
- Create: migrations for the new columns and their backfill

**Interfaces:**
- Produces: `item.stage`, `item.state`, `item.reason`, `item.since` as stored columns, and moves between stages in place of `transitionItem`'s state events.

**Acceptance criteria:**
- [ ] Every item row holds a stage, and a state unless it is Closed.
- [ ] The backfill gives each existing row the position Task 1's function gives it.
- [ ] An approved, clean PR reads as Merge, In Progress until the merge lands.
- [ ] WIP slots and review capacity count as the spec's Slots table says.
- [ ] The claim order is what it is today for the same set of items.
- [ ] No code, scenario or page names one of today's fourteen states.
- [ ] §5 and §6 of the main spec read as the design spec does.
