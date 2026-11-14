@pbi-234
Feature: CI left pending for 60 minutes on a commit sends the item to NeedsInput
  Today a cell that waits for CI on a commit it pushed waits for as long as CI stays pending, so a
  check that never reports holds the cell forever. With this item, the cell waits at most 60 minutes
  for CI on any one commit. When CI is still pending after 60 minutes, the cell stops waiting and the
  item moves to NeedsInput with a question that names each check still pending, so a person knows
  which check to look at. A check that already passed or failed isn't named.
  The cap holds wherever the cell waits for CI: on the PR's head when the PR opens, on the PR
  addresser's fix during the PR review, and on the fix pushed in address. Each commit gets its own
  60 minutes. CI that is still pending isn't CI that failed, so a timeout never sends the item back
  to Green and uses up none of its retries.
  Every scenario runs the engine against a fake control plane, a fake agent, a fake repo host and a
  fake clock, so cells run them all and no scenario waits an hour.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise

  Rule: CI still pending 60 minutes after the PR opens sends the item to NeedsInput, naming the pending checks

    @ac-1
    Scenario: The PR's head stays pending for 60 minutes and the item moves to NeedsInput
      Given the check "ci" stays pending on the PR's head
      When the cell runs
      Then the cell stopped waiting for CI 60 minutes after it began waiting on the PR's head
      And the item moves to NeedsInput, with a question that names the check "ci"
      And the item never moved to InReview

    @ac-1
    Scenario: The question names every check still pending, and none that already finished
      Given these checks report on the PR's head:
        | check | status  |
        | lint  | passed  |
        | ci    | pending |
        | e2e   | pending |
      And the checks "ci" and "e2e" stay pending on the PR's head
      When the cell runs
      Then the item moves to NeedsInput, with a question that names the checks "ci" and "e2e"
      And the question doesn't name the check "lint"

    @ac-1
    Scenario: A timeout isn't a CI failure, so the item doesn't go back to Green
      Given the check "ci" stays pending on the PR's head
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
      And the item moves to NeedsInput, with a question that names the check "ci"
      And no reviewers were asked to look at the PR

    @ac-1
    Scenario: CI that finishes just inside the 60 minutes lets the cell carry on
      Given the check "ci" stays pending on the PR's head for 59 minutes and then passes
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the item moves to InReview
      And the item never moved to NeedsInput

    @ac-1
    Scenario: CI that fails after a long wait inside the 60 minutes still goes back to Green
      Given the check "ci" stays pending on the PR's head for 59 minutes and then fails
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the item moves to InReview

  Rule: Each commit gets its own 60 minutes

    @ac-1
    Scenario: Time spent waiting on an earlier commit doesn't count against the next one
      Given the check "ci" stays pending on the PR's head for 50 minutes and then fails
      And the check "ci" stays pending on Green's fix for 50 minutes and then passes
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the item moves to InReview
      And the item never moved to NeedsInput

  Rule: The cap also holds while the cell waits for CI on a fix during the PR review and in address

    @ac-1
    Scenario: CI pending for 60 minutes on the PR addresser's fix moves the item to NeedsInput
      Given the PR reviewer finds "Rename this variable." on its first review
      And the check "ci" stays pending on the PR addresser's fix
      When the cell runs
      Then the cell stopped waiting for CI 60 minutes after it began waiting on the PR addresser's fix
      And the item moves to NeedsInput, with a question that names the check "ci"
      And the PR reviewer never reviewed the PR addresser's fix
      And the item never moved to InReview

    @ac-1
    Scenario: CI pending for 60 minutes on a fix pushed in address moves the item to NeedsInput
      Given an item 482 in review whose run resumes at address
      And a trusted reviewer commented "rename foo to bar" on the PR
      And the check "ci" stays pending on the fix
      When the cell runs
      Then the cell ran these stages, in order:
        | stage   |
        | address |
      And address ran 1 time
      And the cell stopped waiting for CI 60 minutes after it began waiting on the fix
      And the item moves to NeedsInput, with a question that names the check "ci"
      And the item never moved to InReview
