@pbi-440 @db
Feature: Re-queueing a Failed item whose PR merged sends it back to wait on main, and it reaches Done once main passes with its merge
  A person re-queues a Failed item to carry on with it. Today the factory sends it back to Queued. An item whose
  PR didn't merge resumes at the stage that failed, on the same run and branch, with that stage's retries
  available again. An item whose PR merged gets a new run on a new branch that starts again at understand, though
  its work is already on main. That is what happened to #212.
  With this item, re-queueing a Failed item whose PR merged moves it to Accepted, on the same run, and starts no
  new run. That holds whether the factory recorded the merge before the item failed or only learns of it from
  GitHub at the re-queue. From Accepted the item waits on main. It moves to Done once CI passes on a main commit
  that contains its merge, as long as every feature file its run added or changed is still on main at that
  commit. A later item may edit one of those files. That's fine, as long as the file is still there. When the
  files are gone, as when the change was reverted, the item stays Accepted, and its item page says its feature
  files are no longer on main. A re-queue of an item whose PR didn't merge works as today. The factory's own
  re-check, every `failed_recheck_hours` hours (8 by default), works as today too. Only a person's re-queue moves a
  merged item to Accepted.
  Unless a scenario says otherwise, the repo is "acme/widgets" and its main branch is "main". Item 482 is Failed.
  Its run is run 1, on the branch "factory/pbi-482-r1", and its PR is PR 57. Its run added the feature file
  "features/pbi-482-orders.feature" and changed the feature file "features/pbi-301-carts.feature". GitHub, CI, the
  board and the clock are fakes. Every scenario needs Postgres, which each test starts for itself, so cells and CI
  both run them.

  Rule: Re-queueing a Failed item whose PR didn't merge resumes it at the stage that failed, on the same run and branch, with that stage's retries available again, as today

    @ac-1 @regression
    Scenario: A Failed item whose PR is still open resumes at the stage that failed, on the same run and branch
      Given item 482 went to Failed with the event "retries_exhausted" after its stage "address" used up its retries
      And item 482's PR 57 is open and not merged
      When an operator re-queues item 482 with the reason "the flaky test is fixed"
      And the scheduler ticks once
      Then the factory holds item 482 in state "Queued"
      And item 482's run 1 resumes at the stage "address"
      And item 482's run 1 is still on the branch "factory/pbi-482-r1"
      And item 482 has no run 2
      And the stage "address" has all of its retries available again

    @ac-1 @regression
    Scenario: A Failed item that never opened a PR resumes at the stage that failed, on the same run and branch
      Given item 482 has no PR
      And item 482 went to Failed with the event "retries_exhausted" after its stage "build" used up its retries
      When an operator re-queues item 482 with the reason "the build tooling is fixed"
      And the scheduler ticks once
      Then the factory holds item 482 in state "Queued"
      And item 482's run 1 resumes at the stage "build"
      And item 482's run 1 is still on the branch "factory/pbi-482-r1"
      And item 482 has no run 2
      And the stage "build" has all of its retries available again

  Rule: Re-queueing a Failed item whose PR merged moves it to Accepted, on the same run, and starts no new run

    @ac-2
    Scenario: A Failed item whose merge the factory recorded goes to Accepted on the same run
      Given item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And item 482 went to Failed with the event "retries_exhausted"
      When an operator re-queues item 482 with the reason "its work is already on main"
      And the scheduler ticks once
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows a move from "Failed" to "Accepted" made by the re-queue
      And item 482's run is still run 1
      And item 482 has no run 2
      And item 482 waits on "main"

    @ac-2
    Scenario: A Failed item whose PR merged on GitHub without the factory recording it goes to Accepted on the same run
      Given item 482 went to Failed with the event "retries_exhausted" while its PR 57 was open
      And then a person merged PR 57 into "main" as commit "m3rg001", and the factory hasn't recorded the merge
      When an operator re-queues item 482 with the reason "someone merged it by hand"
      And the scheduler ticks once
      Then the factory holds item 482 in state "Accepted"
      And item 482's run is still run 1
      And item 482 has no run 2
      And item 482 waits on "main"

    @ac-2
    Scenario: A Failed item that went to Failed with "dod_failed" goes to Accepted on the same run when a person re-queues it
      Given item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And item 482 went to Failed with the event "dod_failed"
      When an operator re-queues item 482 with the reason "main was red before this merged"
      And the scheduler ticks once
      Then the factory holds item 482 in state "Accepted"
      And item 482 has no run 2
      And item 482 waits on "main"

    @ac-2
    Scenario: A re-queued merged item is never claimed by a cell
      Given item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And item 482 went to Failed with the event "retries_exhausted"
      And a WIP slot is free
      When an operator re-queues item 482 with the reason "its work is already on main"
      And the scheduler ticks 3 times
      Then no cell was started for item 482
      And the factory holds item 482 in state "Accepted"
      And item 482 has no run 2

  Rule: Such an item moves to Done once CI passes on main at a commit that contains its merge, with every feature file its run added or changed still on main there

    Background:
      Given item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And item 482 went to Failed with the event "retries_exhausted"
      And an operator re-queued item 482 and the scheduler ticked once

    @ac-3
    Scenario: The item goes to Done when CI passes on a main commit that contains its merge and keeps its feature files
      Given "main" gains commit "l4t3r01", which contains "m3rg001"
      And "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "l4t3r01"
      And CI passed every check on commit "l4t3r01"
      When the poller runs
      Then the factory holds item 482 in state "Done"
      And item 482's history shows the moves "Failed" to "Accepted" to "Done", in that order
      And item 482 has no run 2

    @ac-3
    Scenario: The item goes to Done when CI passes on its merge commit itself
      Given "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "m3rg001"
      And CI passed every check on commit "m3rg001"
      When the poller runs
      Then the factory holds item 482 in state "Done"

    @ac-3
    Scenario: A later item's edit to one of its feature files doesn't hold the item back
      Given "main" gains commit "l4t3r01", which contains "m3rg001"
      And commit "l4t3r01" changes "features/pbi-482-orders.feature" for another item
      And "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "l4t3r01"
      And CI passed every check on commit "l4t3r01"
      When the poller runs
      Then the factory holds item 482 in state "Done"

    @ac-3
    Scenario: CI passing on a main commit that doesn't contain the merge leaves the item Accepted, and a later one that does moves it to Done
      Given commit "m3rg001"'s first parent on "main" is commit "p4r3nt1"
      And CI passed every check on commit "p4r3nt1"
      When the poller runs
      Then the factory holds item 482 in state "Accepted"
      Given "main" gains commit "l4t3r01", which contains "m3rg001"
      And "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "l4t3r01"
      And CI passed every check on commit "l4t3r01"
      When the poller runs
      Then the factory holds item 482 in state "Done"

    @ac-3
    Scenario: CI still running on the main commit leaves the item Accepted until it passes
      Given "main" gains commit "l4t3r01", which contains "m3rg001"
      And "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "l4t3r01"
      And CI is still running on commit "l4t3r01"
      When the poller runs
      Then the factory holds item 482 in state "Accepted"
      Given CI passed every check on commit "l4t3r01"
      When the poller runs
      Then the factory holds item 482 in state "Done"

    @ac-3
    Scenario: An item held back by missing feature files goes to Done once a later main commit brings them back and CI passes on it
      Given "main" gains commit "r3v3rt1", which contains "m3rg001" and deletes "features/pbi-482-orders.feature"
      And CI passed every check on commit "r3v3rt1"
      And the poller ran
      And "main" gains commit "r3st0r1", which contains "r3v3rt1" and brings back "features/pbi-482-orders.feature"
      And "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature" are on "main" at commit "r3st0r1"
      And CI passed every check on commit "r3st0r1"
      When the poller runs
      Then the factory holds item 482 in state "Done"

  Rule: Such an item whose feature files are gone from main stays Accepted, and its item page says its feature files are no longer on main

    Background:
      Given item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And item 482 went to Failed with the event "retries_exhausted"
      And an operator re-queued item 482 and the scheduler ticked once

    @ac-4
    Scenario: A revert that removes a feature file the run added leaves the item Accepted
      Given "main" gains commit "r3v3rt1", which contains "m3rg001" and reverts it, deleting "features/pbi-482-orders.feature"
      And CI passed every check on commit "r3v3rt1"
      When the poller runs
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows no move to "Done"

    @ac-4
    Scenario: A feature file the run changed that's since been deleted from main leaves the item Accepted
      Given "main" gains commit "d3l3t31", which contains "m3rg001" and deletes "features/pbi-301-carts.feature"
      And "features/pbi-482-orders.feature" is on "main" at commit "d3l3t31"
      And CI passed every check on commit "d3l3t31"
      When the poller runs
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows no move to "Done"

    @ac-4
    Scenario: The item stays Accepted however many times the poller runs while its feature files are gone
      Given "main" gains commit "r3v3rt1", which contains "m3rg001" and reverts it, deleting "features/pbi-482-orders.feature"
      And CI passed every check on commit "r3v3rt1"
      When the poller runs every 10 minutes for 2 hours
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows no move to "Done"

    @ac-4
    Scenario: The item page says the item's feature files are no longer on main
      Given "main" gains commit "r3v3rt1", which contains "m3rg001" and reverts it, deleting "features/pbi-482-orders.feature"
      And CI passed every check on commit "r3v3rt1"
      And the poller ran
      And an operator is signed in
      When the operator opens item 482's page
      Then the page says item 482's feature files are no longer on "main"

  Rule: The factory's own re-check of a Failed item every 8 hours works as today, and only a person's re-queue moves a merged item to Accepted

    Background:
      Given the repo's ".factory/config.yml" has no `failed_recheck_hours` key
      And item 482's PR 57 merged into "main" as commit "m3rg001", and the factory recorded the merge
      And commit "m3rg001"'s first parent on "main" is commit "p4r3nt1"

    @ac-5 @regression
    Scenario: The re-check leaves an item Failed while today's rules still say its merge broke main
      Given item 482 went to Failed with the event "dod_failed" at "2026-11-20 08:00" UTC
      And CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then item 482 was last re-checked at "2026-11-20 16:00" UTC
      And the factory holds item 482 in state "Failed"
      And item 482 has no new comment

    @ac-5 @regression
    Scenario: The re-check moves an item to Accepted with the event "rechecked" when its merge no longer counts as breaking main
      Given item 482 went to Failed with the event "dod_failed" at "2026-11-20 08:00" UTC
      And CI failed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows a move from "Failed" to "Accepted" with the event "rechecked"

    @ac-5 @regression
    Scenario: The re-check leaves a merged item that failed for another reason in Failed
      Given item 482 went to Failed with the event "retries_exhausted" at "2026-11-20 08:00" UTC
      When the poller runs every 10 minutes from "2026-11-20 08:10" to "2026-11-21 08:10" UTC
      Then item 482 has never been re-checked
      And the factory holds item 482 in state "Failed"
      And item 482 has no run 2

  Rule: Re-queueing #212 when this ships moves it to Done on the next check, with no new run

    Background:
      Given the repo is "ricksu978/software-factory"
      And the factory holds item 212 in state "Failed"
      And item 212's PR 248 merged into "main" as commit "92c583e"
      And item 212's run added the feature file "features/pbi-212-merged-pr-while-waiting-for-ci.feature"
      And "main" is at commit "ef3ab62", which contains "92c583e"
      And "features/pbi-212-merged-pr-while-waiting-for-ci.feature" is on "main" at commit "ef3ab62"
      And CI passed every check on commit "ef3ab62"

    @ac-6
    Scenario: #212 goes to Done on the next check after a person re-queues it, with no new run
      When an operator re-queues item 212 with the reason "PR 248 merged, so its work is on main"
      And the scheduler ticks once
      And the poller runs
      Then the factory holds item 212 in state "Done"
      And item 212's history shows the moves "Failed" to "Accepted" to "Done", in that order
      And item 212 has no run newer than the one whose PR 248 merged
      And no cell was started for item 212
