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
- State names, exactly: Queued, In Progress, Needs Human, Waiting, Parked.
- Parked has one reason, exactly: Factory label removed.
- The factory removes its opt-in label from no item.
- Needs Human reasons, exactly: Item not ready, Split blocked, Rule change approval, Scenario sign-off, Question from the agent, Feature change decision, CI broken, Human review, PR closed, Stopped by an operator, Stage failed, Verify failed on `main`.
- Waiting reasons, exactly: "Waiting for split children to complete" and "Waits on #N", with every open dependency named.
- No task converts an in-flight item by hand. An item in any of today's states keeps moving after each task ships.
- Tasks 4 to 9 and Task 12 change §5 or §6 of `docs/superpowers/specs/2026-11-05-software-factory-design.html`. Each of their PBIs carries a `## Changes the factory's rules` section whose Before text is copied from `git show origin/main:<file>` on the day it is filed, and each waits for the owner's approval.
- A task that reverses a §14 row or §10's failure text, as the spec's "What this reverses in the main spec" lists, updates that text in the same PR.
- Every PBI names this plan's task as the plan task it implements, and fits one Sprint.
- Each PR updates the main spec and the Phase 0 plan for the behaviour it changes, as the Definition of Done asks.

## Review focus

Five conditions the spec implies and no task's criteria would otherwise test, most likely first.
Each has a criterion in the task that owns it.

1. **A stored state and a run that disagree.** An `InProgress` item with no run, or a run whose stage id an older SOP version used, still gets a position and Floor still renders. Task 1.
2. **Needs Human items that never time out.** After weeks, review capacity fills and nothing new starts. Floor says that review capacity is why. Task 4.
3. **A reopened PBI with a branch and a PR from its first run.** The new run takes a new branch and doesn't push to the old one. Task 6.
4. **A split child that no longer exists on GitHub.** It counts as Not Done, so the parent never waits on it. Task 7.
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
  /** True when a `SignOff` or `NeedsInput` item's question is answered and no newer one is open. */
  questionAnswered: boolean;
  /** The external ids of the open items this one waits on. */
  blockedBy: string[];
  /** True when a `Failed` item failed after its PR merged. */
  failedAfterMerge: boolean;
  /** True when a `Failed` item was stopped by an operator. */
  stoppedByOperator: boolean;
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
- [ ] A queued item with an open dependency reads Waiting at the stage it would start: Understand with no run, and the run's next stage otherwise.
- [ ] A `SignOff` or `NeedsInput` item whose question is answered reads Queued, so it is absent from the Needs Human list.
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
- Modify: `src/control/board.ts`, `src/adapters/github/backlog.ts`, `src/control/cell-api.ts`

**Interfaces:**
- Consumes: `position` and `phaseOf` from Task 1.
- Produces: the source's field map gains `statusForPhase: Record<Exclude<Phase, "Final"> | "Done" | "Not Done" | "Partially Done", string | null>`. `statusFor` stays, and filing a split child or a bug item still reads its board status from it.

**Acceptance criteria:**
- [ ] A source with `statusForPhase` gets each item's Status set from its phase, and from its final stage once Closed.
- [ ] The Status changes when a run moves to a stage in another phase, as from Specify to Red, though the stored state stays `InProgress`.
- [ ] A source without `statusForPhase` keeps today's Status values.
- [ ] A child or a bug item the factory files gets the board status `statusFor` gives it, as today.
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
- [ ] Reminder comments are still posted on the schedule they have today, and none says the item will be abandoned.
- [ ] The state machine has no `timed_out` move.
- [ ] An item that timed out to `Abandoned` before this ships stays as it is and can be re-queued as today.
- [ ] When the count of waiting items has reached review capacity, Floor says no new item starts until one of them is answered. (Review focus 2.)

## Task 5: Failure becomes Needs Human

**PBI title.** A stage that gives up, or a merge that breaks main, leaves the item where it failed with Needs Human, and no item ends as Failed

**Depends on.** Task 2.

**Changes rules.** §5, every move into and out of `Failed`. §6 stage 10, "Item moves to Failed, the factory files a bug PBI and the dashboard flags it." It also updates §10's failure text and the §14 rows "Red main" and "Re-checking Failed items".

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/scheduler/scheduler.ts` (`stopRun`, `recheckFailed`, `pollMergedCi`), `src/cell/engine.ts`, `src/api/main.ts`

**Interfaces:**
- Consumes: `position` from Task 1. `failedAfterMerge` and `stoppedByOperator` stay in `PositionInput` until Task 12, since rows stored as `Failed` before this ships still need them.

**Acceptance criteria:**
- [ ] Green out of retries leaves the item at Green in Needs Human with "Stage failed".
- [ ] A merge that turns `main` red leaves the item at Verify in Needs Human with "Verify failed on `main`", and the factory files its bug PBI as today.
- [ ] The re-check of that item's merge runs on the schedule it has today. When its rules no longer say the merge broke `main`, the item goes back to Verify in In Progress and on to Done without a person. Otherwise it stays as it is and nothing is commented.
- [ ] An operator's stop leaves the item held at the stage it was stopped at, in Needs Human with "Stopped by an operator", and a re-queue carries on from the kept branch as today.
- [ ] A person can re-queue an item in any of the three reasons, "Stage failed", "Verify failed on `main`" and "Stopped by an operator", and it runs again at that stage.
- [ ] A person can close an item in any of the three. Until Task 6 it is withdrawn as today.
- [ ] A stage that gives up by asking a question still asks it, with "Question from the agent" or "CI broken".
- [ ] An item stored as `Failed` when this ships reads with the right reason and can be re-queued, with no edit to its row by hand.

## Task 6: Not Done, reopening and a closed PR

**PBI title.** A closed issue closes a PBI as Not Done, a removed label parks it, a reopened one starts over at Readiness, and a closed PR asks why

**Depends on.** Tasks 4 and 5.

**Changes rules.** §5, every move into and out of `Abandoned`, and "FeatureChangeRequest --> Abandoned: label removed, item closed, or PR closed unmerged".

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/store/items.ts`, `src/watcher/poller.ts`, `src/watcher/webhook.ts`, `src/control/board.ts`, `src/scheduler/scheduler.ts`, `src/gate/file-split.ts`, `src/api/main.ts`, `web/src/pages/RunDetail.tsx`
- Create: a migration for `item.parked_since`

**Interfaces:**
- Produces: `State` gains `"Parked"`. The item row gains `parked_since`, a time or null, set when the label is removed and cleared when it comes back. `PositionInput` gains `parkedSince: Date | null`, and `position` gives Parked with "Factory label removed" at the stage it would otherwise give whenever it is set. `ItemState` gains nothing, so what was stored before the park is untouched. For an `Abandoned` row, `position` gives Readiness underneath when `parkedSince` is set and Not Done when it is null, so no other field is needed for the rows the factory withdrew for a missing label. The poller sets `parked_since` on those rows on its first reading after this ships: each `Abandoned` row that `withdrawnBeforeQueue` in `src/store/items.ts` names and whose issue it reads as open, with the time of that withdrawal.

**Acceptance criteria:**
- [ ] Closing the issue on GitHub closes the PBI as Not Done from any stage before its PR merges.
- [ ] Closing the issue of an item whose PR has merged changes nothing, and the item goes on through Verify to Done.
- [ ] However an item closes as Not Done, a Parked one included, the factory closes its open PR with a note.
- [ ] Removing the factory's label parks the item: it keeps its stage, its state is Parked with "Factory label removed", and a cell running for it is stopped.
- [ ] A Parked item is listed in Waiting on You, and holds no WIP slot and no review capacity.
- [ ] While an item is Parked the factory claims nothing for it, runs no readiness check on it, merges nothing for it and sends it no reminder.
- [ ] A Parked item's PR stays open. A person who merges it clears `parked_since`, and the item reads Verify in In Progress and goes on to Done.
- [ ] Putting the label back on an item parked while Queued or In Progress queues it at that stage, on the same run and branch.
- [ ] Putting it back on an item parked in Needs Human or Waiting returns it to that state with the reason it had, as "Scenario sign-off", "Human review" or "Stopped by an operator" with its hold.
- [ ] Putting it back on an item parked at Readiness or Rule Change sends it through Readiness again.
- [ ] Closing the issue of a Parked item closes it as Not Done.
- [ ] A Parked split parent doesn't close while it is Parked, and closes by its children once its label is back.
- [ ] The comment the factory leaves on a split parent says removing the label from a child parks that child.
- [ ] A split parent the factory took the label from before Task 7 ships is not parked, and neither is an item whose PR has merged.
- [ ] The issue going from closed to open, or the Reopen control on Run detail, starts a Not Done PBI again at Readiness as a new run.
- [ ] A Not Done item whose issue is open stays Not Done from poll to poll, and reopens only through the Reopen control.
- [ ] The new run takes a new branch and pushes nothing to the first run's branch. Its PR, if one is still open, is closed with a note naming the reopen. (Review focus 3.)
- [ ] A PR a person closes without merging moves the item to Human Review in Needs Human with "PR closed", from whatever stage it was at, and the factory asks why it was closed.
- [ ] A cell still running for that item is stopped and its claim ends.
- [ ] Any PR the factory closes itself asks nothing, whether the poller or the webhook sees the close first. That covers changed acceptance criteria, a changed rules section, a reopen and a close as Not Done.
- [ ] Answering "new PR" queues the item at the stage that opens the PR, which opens a new PR from the same branch.
- [ ] Answering "re-spec" starts a new run at Specify from `main`, with the scenario lock lifted.
- [ ] Answering "not done" closes the PBI as Not Done.
- [ ] The factory closes no PBI by itself. No move ends at Not Done without a person's action.
- [ ] An item stored as `Abandoned` when this ships reads as Not Done, reopens the same way, and doesn't restart by itself on the first poll after this ships.
- [ ] One stored as `Abandoned` that was withdrawn before it was queued, and whose issue the poller reads as open, gets `parked_since` set on the first poll after this ships and reads as Parked at Readiness. Putting its label back sends it through Readiness, as `returned` does today.
- [ ] One stored as `Abandoned` whose issue is closed, or that was withdrawn after it was queued, gets no mark and reads as Not Done.

## Task 7: Split

**PBI title.** A split parent waits for its children and closes as Done, Not Done or Partially Done by how they closed

**Depends on.** Task 6.

**Changes rules.** §5. "NotReady --> Split: split filed, last child filed and label off" and "Split --> Done: every filed child Done".

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/watcher/poller.ts` (closing split parents), `src/gate/readiness.ts`, `src/gate/file-split.ts`

**Acceptance criteria:**
- [ ] Filing a split leaves the parent's opt-in label on, and no code path removes that label from any item.
- [ ] A parent whose children are filed sits at Split in Waiting with "Waiting for split children to complete".
- [ ] It closes as Done when every child closed as Done.
- [ ] It closes as Not Done when every child closed as Not Done.
- [ ] It closes as Partially Done when its children closed as a mix, and a Partially Done child counts as a mix.
- [ ] It stays in Waiting while any child is open.
- [ ] A split that can't be filed leaves the item at Split in Needs Human with "Split blocked", naming the child and the lines it failed.
- [ ] A child reopened after its parent closed reopens the parent to Split in Waiting. The factory reopens the parent's issue, and the parent closes again by the same rules.
- [ ] A child that isn't Done in the factory counts by its issue, whether the factory holds it in another state or not at all: closed as completed counts as Done, and closed as not planned or as a duplicate counts as Not Done. #426 builds the Done half before this task.
- [ ] A child whose issue no longer exists counts as Not Done, so the parent never waits on it. (Review focus 4.)
- [ ] The factory's own reopen of a parent's issue is never read as a person's reopen, so the parent goes to Split and never to Readiness.
- [ ] A parent that is itself a filed child, whose own children got no label, sits at Split in Needs Human with "Split blocked", naming the children that wait for a label.
- [ ] Once the owner labels those children, that parent goes to Waiting, and it closes by the same rules.
- [ ] A parent stored as `Split` with a `Failed` or `Abandoned` child when this ships, as #172 is, closes by these rules with no edit by hand.

## Task 8: One review

**PBI title.** The factory reviews its work once, in Self Review, and a change request goes through Address, Self Review and the PR's update before a person sees it again

**Depends on.** Task 2, and #413 trimmed.

**Changes rules.** §6. The stage 8 row "PR review", and the decision "The PR reviewer only comments." It also updates the §14 row "PR review in Phase 0".

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
- Modify: `sop/default.yml`, `src/config/sop.ts`, `src/cell/engine.ts`, `src/cell/pr-body.ts`, `src/control/cell-api.ts`, `src/control/decisions.ts`, `src/scheduler/scheduler.ts`, `src/watcher/merge.ts`, `src/core/position.ts`, and any other file `grep -rn "open-pr" src` names
- Rename: `sop/prompts/open-pr.md` to `sop/prompts/submit.md`
- Create: a migration that renames `open-pr` in stored stage ids

**Interfaces:**
- Produces: `STAGE_IDS` with `"submit"` in place of `"open-pr"`.

**Acceptance criteria:**
- [ ] The SOP names the stage `submit`, and a new run records its attempts under that id.
- [ ] A run that is waiting to resume at `open-pr` when this ships resumes at `submit`.
- [ ] Stage attempts recorded as `open-pr` read as Submit on Run detail.
- [ ] A cell built from an older image, still reporting `open-pr`, has its report accepted and stored as `submit`.

## Task 10: Store the position beside the state

**PBI title.** Every item row also holds its stage, state, reason and since, kept in step with today's state

**Depends on.** Tasks 3 to 9.

**Changes rules.** none. It adds columns and changes no behaviour.

**Files:**
- Modify: `src/store/items.ts`, `src/control/cell-api.ts`, `src/control/decisions.ts`, `src/watcher/poller.ts`, `src/scheduler/scheduler.ts`, `src/core/position.ts`
- Create: a migration for the new columns and their backfill

**Interfaces:**
- Produces: the columns `item.position_stage`, `item.position_state`, `item.position_reason` and `item.position_since`. Every write that changes any field of `PositionInput` also writes them, in the same transaction. They hold the position underneath a park, which is what `position` gives with `parkedSince` null. `item.parked_since` stays its own column, and a reader applies Parked on top when it is set.

**Acceptance criteria:**
- [ ] Every item row holds a stage, and a state unless it is Closed.
- [ ] The backfill gives each existing row the position Task 1's function gives it with `parkedSince` null, and leaves `parked_since` as it is. A legacy `Abandoned` row that Task 6 marked is stored as Readiness underneath, with its mark still set.
- [ ] A Parked item's stored state and reason are the ones it had before the park, and it comes back to them when its label returns after this ships.
- [ ] After any move of an item, or of its run to another stage, the stored position equals what Task 1's function gives for the row with `parkedSince` null.
- [ ] The same holds after a write that moves neither: a question answered, the item's dependencies refreshed, a rule approval asked for or given, and an operator's stop.
- [ ] A write that fails rolls the stored position back with it.

## Task 11: Read the stored position

**PBI title.** The scheduler, the poller, the API and the board read an item's stored stage and state

**Depends on.** Task 10.

**Changes rules.** none. Every reader gives the answer it gives today.

**Files:**
- Modify: `src/store/items.ts`, `src/scheduler/scheduler.ts`, `src/watcher/poller.ts`, `src/api/items.ts`, `src/api/main.ts`, `src/control/board.ts`

**Interfaces:**
- Consumes: the `position_*` columns from Task 10.

**Acceptance criteria:**
- [ ] WIP slots and review capacity count as the spec's Slots table says, with the same numbers as before for the same items.
- [ ] The claim order is what it was for the same set of items.
- [ ] Floor, Run detail and the board show the same position for each item as before this ships.
- [ ] No reader outside `src/core` and `src/store` names one of today's thirteen states.

## Task 12: Delete today's states

**PBI title.** Today's thirteen states are gone, and §5 and §6 of the spec describe stages and states

**Depends on.** Task 11.

**Changes rules.** §5 whole, rewritten around stages and states. §6, the stage table, with Readiness, Split, Rule Change, Human Review, Merge and Verify as stages.

**Files:**
- Modify: `src/core/states.ts`, `src/core/position.ts`, `src/store/items.ts`, `src/watcher/poller.ts` (`mergeIfReady`), `src/scheduler/scheduler.ts`, `src/adapters/github/backlog.ts`, and every scenario that names a state
- Create: a migration that drops `item.state`

**Interfaces:**
- Produces: moves between stages in place of `transitionItem`'s state events. `ItemState`, `PositionInput` and `position`'s mapping are deleted, and `Position` stays as the stored shape.

**Acceptance criteria:**
- [ ] The item table has no `state` column, and every move is a move between stages or states of the model.
- [ ] An approved, clean PR moves from Human Review to Merge in In Progress, and to Verify once the merge lands. A merge GitHub refuses leaves it at Merge, and the next poll tries again.
- [ ] An item at Merge counts toward neither a WIP slot nor review capacity. This is the one count that differs from today, as the spec's Slots rule says.
- [ ] No code, scenario or page names one of today's thirteen states.
- [ ] `item.parked_since` stays. An item parked before this ships comes back to the state and reason it had when its label returns after it.
- [ ] The events an item logged under the old names still show on Activity and Run detail.
- [ ] §5 and §6 of the main spec read as the design spec does.
