@pbi-423
Feature: A cancelled CI run is read as neither failed nor passed, so CI can cancel a superseded run
  GitHub cancels a push's CI run when a newer push to the same branch starts, if the workflow sets
  `concurrency: cancel-in-progress`. A cancelled run proves nothing about the commit: it neither failed
  nor passed. Today the factory reads a cancelled check as failed everywhere except the merge-commit
  check of PBI 369. A stage that waits on CI for its own commit charges an attempt and goes back to Green
  when a later push cancels that commit's run. An InReview item goes back to address for it. The factory
  re-runs the cancelled check as if it had failed, and Green is asked to fix a failure that never happened.
  So no repo can turn on cancel-in-progress.
  With this item, no read of a PR's or a branch's checks takes a cancelled check as failed, and none takes
  it as passed. A commit whose only unpassed check was cancelled isn't green. A stage waiting on CI for its
  own commit ends the wait when a later push to the branch cancelled that commit's run. The attempt isn't
  charged, the item goes back to Queued at the same stage, and its next claim starts from the branch's
  newest commit. A check that failed beside a cancelled one is still a failure, and is the only one named.
  With no cancelled check on a commit, every read answers as it does today.
  This item replaces the `cancelled` example of PBI 232's "A check that timed out, was cancelled or needs
  action counts as failed and is named": a cancelled check no longer counts as failed. Timed out and
  action required still do.
  An attempt "charged" is one that counts against its stage's retries. Scenarios tagged @db need
  Postgres, which each test starts for itself, so cells and CI both run them. The rest run the cell
  engine against a fake control plane, a fake agent and a fake repo host, so cells run them all.

  Rule: The cell API never answers that CI failed because of a cancelled check, nor that it passed

    @ac-1
    Scenario: A commit whose only unpassed check was cancelled isn't answered as failed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result    | url                                  | log lines |
        | build | success   | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | cancelled | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API doesn't answer that CI failed
      And the answer lists no failed check

    @ac-2
    Scenario: A commit whose only unpassed check was cancelled isn't answered as passed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result    | url                                  | log lines |
        | build | success   | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | cancelled | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI neither failed nor passed

    @ac-1 @ac-2
    Scenario: A commit whose every check was cancelled is answered as neither failed nor passed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result    | url                                  | log lines |
        | build | cancelled | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | cancelled | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI neither failed nor passed
      And the answer lists no failed check

    @ac-1
    Scenario: A failed check beside a cancelled one is answered as failed, and only the failed check is named
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result    | url                                  | log lines |
        | build | success   | https://ci.example/runs/4/jobs/build | 10        |
        | unit  | failure   | https://ci.example/runs/4/jobs/unit  | 40        |
        | e2e   | cancelled | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer lists exactly the failed check "unit"
      And the answer doesn't name the check "e2e"

    @ac-1
    Scenario: The cell API's list of a commit's checks doesn't give a cancelled check as failed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result    | url                                  | log lines |
        | build | success   | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | cancelled | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API for the checks on that commit by name
      Then the checks name "e2e" as neither failed nor passed
      And the checks name "build" as passed

  Rule: A stage waiting on CI for its own commit, whose run a later push to the branch cancelled, goes back to Queued at the same stage without charging the attempt

    Background:
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise

    @ac-3 @ac-1
    Scenario: open-pr whose head's run a later push cancelled ends its wait, and the item goes back to Queued at open-pr
      Given open-pr pushes the PR's first head "c0ffee1"
      And while the factory waits on CI for "c0ffee1", a person pushes the commit "c0ffee2" to the item's branch
      And CI reports the check "ci" was cancelled on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201"
      When the cell runs
      Then the item moves to Queued
      And the item's run resumes from "open-pr"
      And the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
      And no attempt in the run says CI failed on "c0ffee1"

    @ac-3
    Scenario: The open-pr attempt whose run a later push cancelled isn't charged
      Given open-pr pushes the PR's first head "c0ffee1"
      And while the factory waits on CI for "c0ffee1", a person pushes the commit "c0ffee2" to the item's branch
      And CI reports the check "ci" was cancelled on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201"
      When the cell runs
      Then the open-pr attempt doesn't count against the stage's retries
      And the open-pr attempt doesn't end as failed
      And the item doesn't move to Failed

    @ac-3
    Scenario: A cancelled run ends the wait without asking the owner, however long the pending CI cap is
      Given open-pr pushes the PR's first head "c0ffee1"
      And while the factory waits on CI for "c0ffee1", a person pushes the commit "c0ffee2" to the item's branch
      And CI reports the check "ci" was cancelled on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201"
      When the cell runs
      Then the owner is asked no question
      And the item doesn't move to NeedsInput
      And the item moves to Queued

    @ac-3
    Scenario: The next claim starts from the branch's newest commit, and reads CI on it
      Given open-pr pushes the PR's first head "c0ffee1"
      And while the factory waits on CI for "c0ffee1", a person pushes the commit "c0ffee2" to the item's branch
      And CI reports the check "ci" was cancelled on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201"
      And the PR reviewer finds nothing on its first review
      When the cell runs
      And the next claim's cell runs from open-pr
      Then the next claim started on the commit "c0ffee2"
      And in the next claim the factory read CI on "c0ffee2"
      And in the next claim the factory read CI on "c0ffee1" 0 times
      And the item moves to InReview

    @ac-3 @ac-1
    Scenario: A cancelled check beside one that passed still ends the wait without going back to Green
      Given open-pr pushes the PR's first head "c0ffee1"
      And while the factory waits on CI for "c0ffee1", a person pushes the commit "c0ffee2" to the item's branch
      And these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests |
        | lint  | passed    | https://github.com/acme/widgets/actions/runs/7200 |               |
        | ci    | cancelled | https://github.com/acme/widgets/actions/runs/7201 |               |
      When the cell runs
      Then Green ran 1 time
      And the item moves to Queued
      And the item's run resumes from "open-pr"
      And no attempt in the run says CI failed on "c0ffee1"

    @ac-3 @ac-1
    Scenario: address whose pushed commit's run a later push cancelled goes back to Queued at address
      Given a run for item 482 whose PR is in review
      And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
      And the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And while the factory waits on CI for "m3rge01", a person pushes the commit "m3rge02" to the item's branch
      And CI reports the check "ci" was cancelled on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101"
      When the cell runs
      Then the item moves to Queued
      And the item's run resumes from "address"
      And Green ran 0 times
      And no attempt in the run says CI failed on "m3rge01"
      And the address attempt doesn't count against the stage's retries

    @ac-3
    Scenario: address's next claim starts from the branch's newest commit
      Given a run for item 482 whose PR is in review
      And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
      And the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And while the factory waits on CI for "m3rge01", a person pushes the commit "m3rge02" to the item's branch
      And CI reports the check "ci" was cancelled on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101"
      When the cell runs
      And the next claim's cell runs from address
      Then the next claim started on the commit "m3rge02"
      And in the next claim the factory read CI on "m3rge01" 0 times

  Rule: A cancelled check is never re-run as a failed one, and never goes to Green as a failure

    Background:
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise

    @ac-1
    Scenario: The cell re-runs the check that failed on its head, and not the one that was cancelled
      Given these checks report on the PR's first head "c0ffee1":
        | check | status    | url                                               | failing tests      |
        | ci    | failed    | https://github.com/acme/widgets/actions/runs/7201 | totals include VAT |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7202 |                    |
      And the check "ci" fails again when it is re-run on "c0ffee1"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And the factory re-ran the check "e2e" on "c0ffee1" 0 times

    @ac-1
    Scenario: Green's findings name the check that failed beside a cancelled one, and not the cancelled check
      Given these checks report on the PR's first head "c0ffee1":
        | check | status    | url                                               | failing tests      |
        | ci    | failed    | https://github.com/acme/widgets/actions/runs/7201 | totals include VAT |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7202 |                    |
      And the check "ci" fails again when it is re-run on "c0ffee1"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then Green's second brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And Green's second brief doesn't name the check "e2e"

  Rule: A Definition of Done line that names a cancelled CI check is neither failed nor passed by it

    Background:
      Given a run for item 482 whose scenarios were signed off
      And the Definition of Done has the line "CI's e2e check passes", naming the CI check "e2e"

    @ac-1 @ac-2
    Scenario: A cancelled check gives its Definition of Done line neither a failed nor a passed verdict
      Given these checks report on the PR's first head "c0ffee1":
        | check | status    | url                                               | failing tests |
        | ci    | passed    | https://github.com/acme/widgets/actions/runs/7201 |               |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7202 |               |
      When the Definition of Done is verified on "c0ffee1"
      Then the line "CI's e2e check passes" isn't failed by the check "e2e"
      And the line "CI's e2e check passes" isn't passed by the check "e2e"

    @ac-1
    Scenario: A cancelled run beside a failed run of the same check still fails the line
      Given these checks report on the PR's first head "c0ffee1":
        | check | status    | url                                               | failing tests |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7202 |               |
        | e2e   | failed    | https://github.com/acme/widgets/actions/runs/7203 | signs in      |
      When the Definition of Done is verified on "c0ffee1"
      Then the line "CI's e2e check passes" is failed by the check "e2e" at "https://github.com/acme/widgets/actions/runs/7203"

  Rule: An InReview item whose PR head has a cancelled check and no failed one stays in review

    Background:
      Given the factory holds item 482 in state "InReview" with PR 57 in "acme/widgets"
      And the head of PR 57 is "c0ffee1"
      And PR 57 merges cleanly with its base
      And nobody has asked for changes on PR 57

    @ac-4 @ac-1 @db
    Scenario: A cancelled check on the PR's head, beside one that passed, doesn't send the item back to address
      Given these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests |
        | lint  | passed    | https://github.com/acme/widgets/actions/runs/7300 |               |
        | ci    | cancelled | https://github.com/acme/widgets/actions/runs/7301 |               |
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview

    @ac-4 @ac-1 @db
    Scenario: A head whose every check was cancelled doesn't send the item back to address
      Given these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests |
        | ci    | cancelled | https://github.com/acme/widgets/actions/runs/7301 |               |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7302 |               |
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview

    @ac-4 @ac-1 @db
    Scenario: The poller doesn't re-run a cancelled check on the PR's head
      Given these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests |
        | lint  | passed    | https://github.com/acme/widgets/actions/runs/7300 |               |
        | ci    | cancelled | https://github.com/acme/widgets/actions/runs/7301 |               |
      When the poller runs once
      Then the factory re-ran no check on "c0ffee1"

    @ac-4 @ac-1 @db
    Scenario: A webhook delivery that a check suite completed with a cancelled check doesn't send the item back
      Given webhooks are on
      And these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests |
        | lint  | passed    | https://github.com/acme/widgets/actions/runs/7300 |               |
        | ci    | cancelled | https://github.com/acme/widgets/actions/runs/7301 |               |
      When GitHub delivers that a check suite completed on "c0ffee1"
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview

    @ac-4 @ac-1 @db
    Scenario: A failed check beside a cancelled one sends the item back, naming only the failed check
      Given these checks report on "c0ffee1":
        | check | status    | url                                               | failing tests      |
        | ci    | failed    | https://github.com/acme/widgets/actions/runs/7301 | totals include VAT |
        | e2e   | cancelled | https://github.com/acme/widgets/actions/runs/7302 |                    |
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"
      And the item's findings don't name the check "e2e"

  Rule: A base commit whose only unpassed check was cancelled gives no verdict, so an older base commit decides

    @ac-1 @ac-2 @db
    Scenario: An item stopped by a red base is re-queued by a passing base commit behind a newer cancelled one, which isn't named
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      And CI's only unpassed check on commit "b4se003" of "main" was cancelled, and "b4se003" is the newest commit of "main"
      When the poller runs once
      Then item 482's question is answered
      And the answer names the commit "b4se002"
      And the answer doesn't name the commit "b4se003"

  Rule: With no cancelled check on the commit, every read answers as it does today

    @ac-5 @regression
    Scenario: The cell API answers a failed check beside passing ones as failed, naming only the failed check
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result  | url                                  | log lines |
        | build | success | https://ci.example/runs/4/jobs/build | 10        |
        | unit  | failure | https://ci.example/runs/4/jobs/unit  | 40        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer lists exactly the failed check "unit"

    @ac-5 @regression
    Scenario Outline: A check that timed out or needs action still counts as failed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result   | url                                  | log lines |
        | build | success  | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | <result> | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer lists exactly the failed check "e2e"

      Examples:
        | result          |
        | timed_out       |
        | action_required |

    @ac-5 @regression
    Scenario Outline: A commit whose checks all passed, were skipped or ended neutral is answered as passed
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result   | url                                  | log lines |
        | build | success  | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | <result> | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI passed

      Examples:
        | result  |
        | success |
        | skipped |
        | neutral |

    @ac-5 @regression
    Scenario: A failed check on open-pr's head is re-run once and, failing again, goes back to Green
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise
      And CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And the check "ci" fails again when it is re-run on "c0ffee1"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And exactly 1 attempt in the run says CI failed on "c0ffee1"
      And Green's second brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And the item moves to InReview

    @ac-5 @regression
    Scenario: CI passing on open-pr's head goes on to PR review
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the item moves to InReview

    @ac-5 @regression @db
    Scenario: A failed check on an InReview PR's head still sends the item back to address
      Given the factory holds item 482 in state "InReview" with PR 57 in "acme/widgets"
      And the head of PR 57 is "c0ffee1"
      And PR 57 merges cleanly with its base
      And nobody has asked for changes on PR 57
      And CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"

    @ac-5 @regression @db
    Scenario: CI that passed on an InReview PR's head leaves the item in review
      Given the factory holds item 482 in state "InReview" with PR 57 in "acme/widgets"
      And the head of PR 57 is "c0ffee1"
      And PR 57 merges cleanly with its base
      And nobody has asked for changes on PR 57
      And CI passed on "c0ffee1"
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview

    @ac-5 @regression
    Scenario: A Definition of Done line whose CI check failed is failed, and one whose check passed is passed
      Given a run for item 482 whose scenarios were signed off
      And the Definition of Done has the line "CI's e2e check passes", naming the CI check "e2e"
      And the Definition of Done has the line "CI's lint check passes", naming the CI check "lint"
      And these checks report on the PR's first head "c0ffee1":
        | check | status | url                                               | failing tests |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7200 |               |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7202 | signs in      |
      When the Definition of Done is verified on "c0ffee1"
      Then the line "CI's e2e check passes" is failed by the check "e2e" at "https://github.com/acme/widgets/actions/runs/7202"
      And the line "CI's lint check passes" is passed by the check "lint" at "https://github.com/acme/widgets/actions/runs/7200"

    @ac-5 @regression @db
    Scenario: A newest base commit CI failed on keeps the red-base question open
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      And CI failed the check "ci" on commit "b4se003" of "main", and "b4se003" is the newest commit of "main"
      When the poller runs once
      Then item 482's question is still open
