@pbi-234
Feature: A cell stops waiting on CI that stays pending for 60 minutes and asks a person about it
  After a cell pushes a commit to its PR, it waits for CI to pass or fail on that commit. Open-pr waits
  this way, and so does address, and so does the PR review after the PR addresser pushes a fix. Today
  the cell waits with no limit. A check that never starts or never ends keeps the cell, its lease and a
  WIP slot busy for good, and nobody is told.
  With this item, a cell waits at most 60 minutes for CI on any one commit. When CI is still pending at
  that point, the cell stops waiting and the item moves to NeedsInput. Its question names the commit and
  every check still pending on it, so a person knows what to look at. The 60 minutes start again for
  each new commit the cell waits on.
  Every scenario runs the engine against a fake control plane, agent and repo, with a clock the
  scenario moves, so cells run them all.

  Rule: CI still pending 60 minutes after the cell began waiting on a commit sends the item to NeedsInput

    @ac-1
    Scenario: Open-pr stops waiting after 60 minutes of pending CI and asks about it
      Given an approved run for item 482 that resumes at open-pr
      And CI on the PR's head commit reports the checks "build" and "e2e" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      Then the cell stops waiting on CI
      And the item moves to NeedsInput
      And the item doesn't move to InReview

    @ac-1
    Scenario: Address stops waiting after 60 minutes of pending CI on its fix and asks about it
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And CI on the address fix's commit reports the check "build" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      Then the cell stops waiting on CI
      And the item moves to NeedsInput
      And no reply is posted on PR 57

    @ac-1
    Scenario: The PR review stops waiting after 60 minutes of pending CI on the PR addresser's fix
      Given an approved run for item 482 that resumes at pr-review
      And the PR review has a finding that the PR addresser fixes in a new commit
      And CI on that fix's commit reports the check "build" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      Then the cell stops waiting on CI
      And the item moves to NeedsInput
      And the item doesn't move to InReview

    @ac-1
    Scenario: After it asks, the cell no longer asks CI about the commit
      Given an approved run for item 482 that resumes at open-pr
      And CI on the PR's head commit reports the check "build" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      And 30 more minutes pass
      Then the cell has ended
      And the cell asked CI nothing about the head commit after the 60 minutes were up

  Rule: The question names the commit and every check still pending on it

    @ac-1
    Scenario: The question names each pending check and the commit it is pending on
      Given an approved run for item 482 that resumes at open-pr
      And CI on the PR's head commit reports the checks "build" and "e2e" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      Then the item waits on an open question
      And the question names the check "build"
      And the question names the check "e2e"
      And the question names the PR's head commit
      And the question says CI stayed pending for 60 minutes

    @ac-1
    Scenario: The question leaves out checks that already finished on the commit
      Given an approved run for item 482 that resumes at open-pr
      And CI on the PR's head commit reports the check "lint" as passed
      And CI on the PR's head commit reports the check "e2e" as pending and never finishes
      When the cell runs and 60 minutes pass while it waits on CI
      Then the item waits on an open question
      And the question names the check "e2e"
      And the question doesn't name the check "lint"

  Rule: The 60 minutes count from when the cell began waiting on that commit, not on an earlier one

    @ac-1
    Scenario: A new commit after a failed one gets its own 60 minutes
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And CI on the address stage's first fix stays pending for 50 minutes and then fails
      And CI on the address stage's second fix reports the check "build" as pending and never finishes
      When the cell runs until the item moves to NeedsInput
      Then the cell waited 60 minutes on the second fix's commit before it stopped waiting
      And the question names the second fix's commit
      And the question doesn't name the first fix's commit
