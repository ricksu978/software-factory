# Phases, stages and states

A redesign of how the factory says where a PBI is.
It replaces the state machine in §5 and the stage table in §6 of `2026-11-05-software-factory-design.html`, and reverses three rows of its decision log in §14.
The owner decided each point below in conversation on 2026-11-26, except where a line says "My call".

## Intent

Today an item has a state and, while a cell runs it, a stage.
The two lists overlap, and the states mix three different facts.
`InProgress` says where the item is, `NeedsInput` says who holds it, and `Failed` says how it ended.

The owner wants to read an item's position at a glance:

- which of four phases it is in,
- which stage of that phase,
- and whether it is the factory's turn, a person's turn, or waiting on another item.

## Goals

- One list of stages that covers an item's whole life, grouped into four phases.
- One small state beside the stage that says whose turn it is.
- The factory never removes its own label from a PBI.
- A reason on every state that stops the item.
- The factory never closes a PBI by itself.
- One review by the factory before a person looks, in place of two.

## Non-goals

- What each agent stage does inside itself. The prompts, exit checks, retries and timeouts of `sop/default.yml` stay as they are, apart from the PR review stage this design removes.
- WIP limits, review capacity, the usage pause, priority, Hold and Start now.
- Risk tiers and how many approvals a tier needs.
- The policy files and their format.

## Anti-goals

- An item whose position can't be told from its stage and state alone.
- An item the factory closes while a person could still act on it.
- A cut-over that needs any in-flight item converted by hand.

## Today

- **States.** Thirteen, in `src/core/states.ts:3-7`, with their moves at `:17-80`.
- **Stages.** Nine, in `sop/default.yml:11-75`: `understand`, `specify`, `sign-off`, `red`, `green`, `self-review`, `open-pr`, `pr-review`, `address`.
- **Slots.** Only an `InProgress` item holds a WIP slot. An item in `InReview`, or in `SignOff` or `NeedsInput` with an open question, counts toward review capacity (`src/scheduler/scheduler.ts:629-641`).
- **Timeouts.** A sign-off or a question nobody answers moves the item to `Abandoned` (`src/core/states.ts:43-44`, the two `timed_out` moves). #366, still open, would add a third, for a feature change request after 5 days.
- **Failure.** Only Green ends an item as `Failed` when its retries run out (`src/cell/engine.ts:1417`). Every other stage that gives up asks a question and goes to `NeedsInput`.
- **Verify.** An `Accepted` item is `Done` once CI passes on `main` at a commit that contains its merge (`settleMerges` and `settleBranches` in `src/scheduler/scheduler.ts`). The "Record Increment" stage in §6 of the spec isn't built.
- **A closed PR.** A PR a person closes without merging withdraws its item to `Abandoned`, from any state that holds a run (`src/watcher/poller.ts:336-337`, `src/watcher/webhook.ts:112-116`).
- **An operator's stop.** Stopping a run moves its item to `Failed` and holds it, at whatever stage it was in (`src/scheduler/scheduler.ts:170-181`).
- **An answered question.** An item stays in `SignOff` or `NeedsInput` after its question is answered, until a cell claims it (`src/store/items.ts:108-111`).
- **A split parent's label.** The factory takes the opt-in label off a parent when it files the split. Children of a parent that is itself a filed child get no label and wait for the owner (`src/gate/file-split.ts:3-6`).
- **Reviews.** `self-review` runs before the PR opens and `pr-review` after. Both judge the same rubric with the same model and tools (`src/cell/engine.ts:1424-1431`, `sop/default.yml:48-69`).
- **Merge.** The factory squash-merges an approved, clean PR itself (`src/watcher/poller.ts:659-713`, PBI 181).

## The model

An item has a **stage**, and while it is open a **state**.
The **phase** is the group its stage belongs to and is never stored on its own.

### Phases and stages

| # | Phase | Stage | Who works | What happens |
|---|---|---|---|---|
| 1 | Triage | Readiness | Factory | The engine's rules, then the judge on each `dor.md` line. |
| 2 | Triage | Split | Factory | An oversized item gets children filed, then waits for them. |
| 3 | Triage | Rule Change | Owner | Approval of an item that changes the factory's own rules. |
| 4 | Plan | Understand | Agent | Reads the item and the code. Changes no file. |
| 5 | Plan | Specify | Agent | Writes the feature file, a scenario or more per criterion. |
| 6 | Plan | Sign Off | Product Owner | Approves the scenarios, which locks them, or sends them back to Specify. |
| 7 | Build | Red | Agent | Writes step definitions. Every scenario fails on an assertion. |
| 8 | Build | Green | Agent | Builds until scenarios, tests and lint pass, then the Definition of Done check. |
| 9 | Build | Self Review | Agent | The self-reviewer loops with the builder until it approves. |
| 10 | Deliver | Submit | Agent and factory | Writes the PR summary, re-checks the Definition of Done, pushes, sets the risk tier, opens or updates the PR, waits for CI. |
| 11 | Deliver | Human Review | Person | A trusted person approves the PR and ticks any Definition of Done line left for a person. |
| 12 | Deliver | Address | Agent | Answers a change request, a conflict or red CI on the PR. |
| 13 | Deliver | Merge | Factory | Squash-merges once the PR is approved, clean and ticked. |
| 14 | Deliver | Verify | Factory | CI green on `main` at a commit that contains the merge, as today. |

### Final stages

| Final stage | Applies to |
|---|---|
| Done | A PBI whose work merged and verified. A split parent whose children all closed as Done. |
| Not Done | A PBI the Product Owner closed without an implementation or a fix. A split parent whose children all closed as Not Done. |
| Partially Done | A split parent only, when its children closed as a mix of Done and Not Done. |

**Closed** means a PBI reached a final stage.
A Closed item has no state. *My call.*

### States

| State | Meaning | Reason |
|---|---|---|
| Queued | The stage is ready to run and waits for a slot. | none |
| In Progress | The factory is working on the stage. | none |
| Needs Human | The factory has stopped until a person acts. | always |
| Waiting | The factory has stopped until another item moves. | always |
| Parked | The factory has stopped because the item's opt-in label is gone. | always "Factory label removed" |

Each stopped state also holds the time it turned on.

### Needs Human reasons

| Reason | Stage | What the person does |
|---|---|---|
| Item not ready | Readiness | Edits the item so the failed lines pass. |
| Split blocked | Split | Fixes what kept the split from being filed, or labels the children the factory left for the owner. |
| Rule change approval | Rule Change | Approves the rule change on the item page. |
| Scenario sign-off | Sign Off | Approves the scenarios or asks for changes. |
| Question from the agent | Any agent stage | Answers the question. |
| Feature change decision | Red and later | Approves or turns down a change to a locked feature file. |
| CI broken | Submit, Address | Answers what to do about CI the factory couldn't fix. |
| Human review | Human Review | Reviews and approves the PR. |
| PR closed | Human Review | Says why the PR was closed, then picks what happens next. |
| Stopped by an operator | The stage the run was stopped at | Re-queues the run, or closes the item as Not Done. |
| Stage failed | A stage that gives up with no question to ask, which today is Green | Re-queues the stage, or closes the item as Not Done. |
| Verify failed on `main` | Verify | Re-queues the check, or closes the item as Not Done. |

### Waiting reasons

| Reason | Stage |
|---|---|
| Waiting for split children to complete | Split |
| Waits on #N, a dependency that is still open | The stage about to start |

## Rules

**No closing by the factory.**
Every Needs Human reason waits for as long as it takes.
The timeout that moves an unanswered sign-off to `Abandoned` is removed, and a feature change request never gets one.
#366's criterion that abandons a feature change request after 5 days is dropped before it ships.
The timeout on an agent's question is removed too. *My call.*
The reminder comments stay. *My call.*

**Not Done.**
The Product Owner closes a PBI as Not Done.
They do it by closing the issue on GitHub. *My call.*
Once an item's PR has merged, closing its issue changes nothing, and the item goes on through Verify to Done. *My call.*

**Parked.**
Removing the factory's label doesn't close a PBI.
The item stays at the stage it was at, in the state Parked, with the reason "Factory label removed".
Parking is a mark on the item, beside what is stored for it, so the state and reason it had are kept. *My call.*
While it is Parked the factory does nothing for it: no claim, no readiness check, no merge and no reminder.
A cell still running for it is stopped and its claim ends, so underneath it is Queued at that stage. *My call.*
Its PR stays open, and the factory doesn't close it. A person who merges it takes the mark off, so the item reads Verify in In Progress and goes on to Done, as merged work.
The mark stays a mark once the model is stored: the stored stage, state and reason are the ones underneath, and Parked is read on top of them.
Putting the label back takes the mark off, and the item is what it was underneath. *My call.*

- Parked while Queued or In Progress, it is Queued at that stage, on the same run and branch.
- Parked while in Needs Human or Waiting, it is back in that state with the reason it had.
- Parked at Readiness or Rule Change, it goes through Readiness again.

Closing the issue of a Parked item closes it as Not Done.
A split parent that is Parked doesn't close while it is Parked. Its children still count, and it closes by them once its label is back.
The factory never removes the label itself, so a missing label always means a person removed it.
Today it takes the label off a split parent, and that stops.
Two cases are exempt. *My call.*

- **A split parent from before.** A parent the factory already took the label from is never parked for it.
- **Merged work.** Once an item's PR has merged, a missing label changes nothing.

**Reopening.**
A Not Done PBI that is reopened starts over at Readiness as a new run.
It doesn't resume where it stopped, because the code may have changed since.
A reopen is always a person's action, never a state the factory finds. *My call.*
It is one of two: the issue going from closed to open, or the Reopen control on the item page.
A Not Done item whose issue is still open reopens only through the control.
An issue the factory reopens itself, as it does for a split parent, is never read as a person's reopen.
An item that was `Abandoned` before this design ships reads as Not Done and reopens the same way, so none of them restarts by itself.
One kind is the exception: an item withdrawn before it was ever queued, whose issue is still open, lost its label and nothing else.
It reads as Parked at Readiness, so putting the label back sends it through Readiness, as it does today (PBI 168).

**A closed PR.**
A PR that a person closes without merging doesn't close the PBI.
Whatever stage the item was at, it moves to Human Review in Needs Human with "PR closed", and the factory asks why it was closed.
A cell still running for the item is stopped and its claim ends, as a withdrawal does today. *My call.*
Any PR the factory closes itself never asks, whatever its reason for closing it.
The person then picks one of three:

- **A new PR.** The item is Queued at Submit, which opens a new PR from the same branch.
- **Re-spec.** The item goes back to Specify as a new run from `main`, with the scenario lock lifted, and the old branch is left behind. *My call on the new run and the branch.*
- **Not Done.** The PBI closes as Not Done.

**Failure.**
There is no failed ending.
Each stage keeps the `on_fail` it has today.
A stage that gives up by asking a question stays in Needs Human with "Question from the agent" or "CI broken", and the person answers it. *My call.*
A stage that gives up with no question, which today is Green out of retries, leaves the item at that stage in Needs Human with "Stage failed".
A merge that breaks `main` leaves the item at Verify in Needs Human with "Verify failed on `main`".
The factory still files its bug PBI for a red `main`.
It still re-checks the merge on the schedule it has today, and an item the re-check clears goes back to Verify in In Progress and on to Done.
An operator who stops a run leaves the item at the stage it was stopped at, held, in Needs Human with "Stopped by an operator". *My call.*

**Split.**
A split parent keeps its label and sits at Split in Waiting until every child is Closed.
It then closes as Done, Not Done or Partially Done by the table above.
A child that is itself a Partially Done parent counts as a mix. *My call.*
A split that can't be filed turns on Needs Human with "Split blocked".
Each child starts at Readiness like any other item.
The children of a parent that is itself a filed child are the exception, as today: they get no label and wait for the owner.
That parent sits at Split in Needs Human with "Split blocked" until the owner labels its children or closes them. *My call.*
A child the factory doesn't hold counts by its issue. *My call.*
Open keeps the parent waiting, closed as completed counts as Done, and closed as not planned, closed as a duplicate or deleted counts as Not Done.
When a child is reopened after its parent closed, the parent reopens too, and the factory reopens the parent's issue.
It goes back to Split in Waiting and closes again by the same table.

**One review by the factory.**
The PR review stage is removed.
A change request from a person runs Human Review, Address, Self Review, Submit and back to Human Review.
Red CI at Submit sends the item back to Green, as red CI at `open-pr` does today.
The factory's findings no longer appear as review threads on GitHub.

**The merge is the factory's.**
A person's part in Deliver is the approval.

**Waiting on You.**
The list is every item in Needs Human or Parked, with its reason, oldest first.
The order uses the time that state last turned on for the item. *My call.*

**Slots.**
The counts stay as they are today, read through the mapping below, with one change.
Today an approved PR that waits for its merge still counts toward review capacity.
Once the model is stored it sits at Merge, which is the factory's turn, and counts toward neither.

| What | Counts |
|---|---|
| A WIP slot | An item In Progress at a stage a cell runs: Understand, Specify, Red, Green, Self Review, Submit or Address. |
| Review capacity | An item in Needs Human for "Scenario sign-off", "Question from the agent", "CI broken" or "Human review". |
| Neither | In Progress at Readiness, Merge or Verify. Needs Human for any other reason. Queued. Waiting. Parked. |

**Record.**
The owner folded the spec's "Record Increment" stage into Verify.
That stage isn't built, so Verify does what it does today, and building the record is outside this design. *My call.*

## How today's states read in the model

The first rollout step shows the model while the engine still stores today's states, so it needs this mapping.

| Today | Stage | State | Reason |
|---|---|---|---|
| `Eligible` | Readiness | In Progress | |
| `NotReady`, a line failed | Readiness | Needs Human | Item not ready |
| `NotReady`, waiting for approval | Rule Change | Needs Human | Rule change approval |
| `Split` | Split | Waiting | Waiting for split children to complete |
| `Queued`, no run yet | Understand | Queued | |
| `Queued`, a run waiting to resume | The run's next stage | Queued | |
| `InProgress` | The running stage | In Progress | |
| `SignOff`, not answered | Sign Off | Needs Human | Scenario sign-off |
| `SignOff`, answered | The run's next stage | Queued | |
| `NeedsInput`, not answered | The stage that asked | Needs Human | Question from the agent, or CI broken when the question names only CI failures |
| `NeedsInput`, answered | The stage that asked | Queued | |
| `FeatureChangeRequest` | The stage that asked | Needs Human | Feature change decision |
| `InReview` | Human Review | Needs Human | Human review |
| `Accepted` | Verify | In Progress | |
| `Failed`, retries ran out | The stage that failed | Needs Human | Stage failed |
| `Failed`, an operator stopped the run | The stage it was stopped at | Needs Human | Stopped by an operator |
| `Failed`, after the merge | Verify | Needs Human | Verify failed on `main` |
| `Abandoned`, withdrawn before it was queued, issue still open | Readiness | Parked | Factory label removed |
| `Abandoned`, any other | Not Done | none | |
| `Done` | Done | none | |

A row that reads Queued reads Waiting with "Waits on #N" when the item has an open dependency, at the same stage.
No row reads Merge. Until the model is stored, an approved PR reads Human Review up to the moment it merges.
From rollout step 5 on, an item whose label is off reads Parked with "Factory label removed", at the stage its row gives.
Only the poller sees whether an issue is open, so it marks the first kind of `Abandoned` row on its first reading after that step ships.

Stage ids map as `open-pr` to Submit and `sign-off` to Sign Off, and the rest keep their names.
Until the PR review stage is removed, an item running `pr-review` shows as "PR Review" under Deliver.

## What this reverses in the main spec

The project's `CLAUDE.md` says §14 holds the settled decisions.
This design reverses three of its rows, and the PBI that changes each behaviour updates the row.

| §14 row | What changes |
|---|---|
| PR review in Phase 0 | The factory no longer reviews its own PR in a stage of its own. |
| Red main | The bug item and the item that broke `main` no longer move to `Failed`. They wait in Needs Human. |
| Re-checking Failed items | The re-check runs on items at Verify in Needs Human, since no item is `Failed`. |

§10's text on failure, "the item moves to Failed with a summary of every attempt" and the two sentences on a red `main`, changes with them.

## Approaches

I weighed three ways to roll this out.

- **One switch.** Replace the state machine, the stages, the stored values, the pages and the scenarios together. A clean cut, and too big for the factory to build as one item. Every PBI in flight would need converting by hand.
- **New words first, new behaviour after.** Show the model through a mapping, change behaviour one PBI at a time, then store the model and delete the old names. Small PBIs, and the owner sees the structure from the first one. The engine thinks in old states underneath for a while, and the mapping is thrown away at the end.
- **Engine first, pages last.** Change the stored model first behind a reverse mapping for the pages. The real model arrives early, with the riskiest work first and nothing visible to check it against.

The owner picked **new words first, new behaviour after**.

## Rollout

Each step is one PBI or a few, and each fits a Sprint.
Steps 3 to 9 change §5 or §6, so each carries a `## Changes the factory's rules` section and waits for the owner's approval.

1. **Before anything.** #414 ships, so a rule-change PBI can reach its approval. The dashboard cut-over, #281 to #283, ships, so the pages are built once.
2. **Show the model.** A pure function works out stage, state, reason and since from what is stored today. Floor, the item page, the API and the GitHub board show them. Waiting on You becomes the Needs Human list, oldest first.
3. **No timeouts.** Remove the two automatic moves to `Abandoned`. #366 is trimmed first, so it never adds a third.
4. **Failure becomes Needs Human.** Replace `Failed` with "Stage failed" and "Verify failed on `main`".
5. **Not Done, Parked and reopening.** Replace `Abandoned` and its ways back with Not Done for a closed issue, Parked for a removed label, and a fresh start at Readiness for a reopen. A closed PR asks "PR closed" in place of withdrawing the item.
6. **Split.** Close a parent by its children, add Partially Done and "Split blocked", reopen a parent when a child reopens, and stop taking the label off a parent.
7. **One review.** Remove `pr-review`, and route Address through Self Review and Submit. #413 is trimmed first, since its criteria about the PR review's findings no longer apply.
8. **Rename.** `open-pr` becomes `submit` in `sop/default.yml` and everywhere a stage id is stored or shown.
9. **Store the model.** Three PBIs. The item row gains stage, state, reason and since beside today's state. Every reader switches to them. Then the old state names and the mapping from step 2 are deleted, and §5 and §6 of the spec are rewritten around this document.

## Left to the builder

- The names of columns, types and functions.
- How Floor lays out its sections, as long as Waiting on You is the list of Needs Human and Parked items, oldest first.
- How the GitHub board's Status options are renamed. Status shows the phase while the item is open and the final stage once it is Closed. *My call.*
- How stage attempts recorded under `open-pr` and `pr-review` show after the rename and the removal. Old rows keep their ids and show under the new names, with `pr-review` shown as "PR Review". *My call.*
- What happens to review threads the factory opened on a PR that is in flight when step 7 ships. The factory resolves them with a note. *My call.*
- Which existing scenarios each step has to change. Each PBI updates the scenarios its change makes false, in the same PR.
- The wording of each reminder comment, as long as none says the item will be abandoned.
