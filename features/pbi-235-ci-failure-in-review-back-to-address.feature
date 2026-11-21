@pbi-235 @db
Feature: A CI failure on the head of an InReview item's PR sends the item back to address with the failure detail
  Once an item's PR is open and the item waits in InReview, nothing watches CI on the PR's head. A person who
  pushes to the PR, or CI that goes red on a re-run, leaves the item sitting in InReview with a red PR until a
  person notices. A review or a conflict already sends the item back to address, but a red head doesn't.
  With this item, the poller reads CI on the head of each InReview item's PR. When CI has failed there, it moves
  the item to Queued, and its run resumes at address. The findings address gets are the failure detail: the
  commit CI failed on, each failed check with its URL, and the failing tests. The "changes_requested" event names
  that CI failure as its cause. A check that passed isn't named. CI still running on the head, or passed there,
  leaves the item in InReview. When webhooks are on, GitHub's delivery that a check suite completed does the
  same, without waiting for the next poll.
  Only the PR's head counts. A failure on an older commit of the PR, or on any commit that isn't the head when
  the factory reads it, is ignored, so a late delivery about a commit the PR has since moved past never sends
  the item back.
  In every scenario, item 482's open run has PR 57 in "acme/widgets". Nothing else sends the item back: its PR
  merges cleanly with its base and no review asks for changes. GitHub, the board, the repo
  host and the webhook deliveries are fakes. Every scenario needs Postgres, which each test starts for itself, so
  cells and CI both run them. Deliveries are signed with the factory's webhook secret, each with its own
  delivery id.

  Background:
    Given the factory holds item 482 in state "InReview" with PR 57 in "acme/widgets"
    And the head of PR 57 is "c0ffee1"
    And PR 57 merges cleanly with its base
    And nobody has asked for changes on PR 57

  Rule: When the poller reads CI as failed on the head of an InReview item's PR, the item goes back to address with the failure detail as its findings

    @ac-1
    Scenario: A failed check on the PR's head sends the item back to address, naming the commit, the check, its URL and the failing test
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"
      And the item's findings say CI failed on "c0ffee1"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"
      And the item's findings name the test "totals include VAT"
      And the item's "changes_requested" event names CI failing on "c0ffee1" as its cause

    @ac-1
    Scenario: Every failed check on the head is named with its own URL, and a check that passed isn't
      Given these checks report on "c0ffee1":
        | check | status | url                                               | failing tests      |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7300 |                    |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7301 | totals include VAT |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7302 | signs in           |
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"
      And the item's findings name the check "e2e" and "https://github.com/acme/widgets/actions/runs/7302"
      And the item's findings name the tests "totals include VAT" and "signs in"
      And the item's findings don't name the check "lint"

    @ac-1
    Scenario: A failed check that names no failing test still sends the item back, with its name and URL
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", naming no failing test
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"

    @ac-1
    Scenario: CI still running on the head leaves the item in review, and once it fails the item goes back
      Given CI is still running on "c0ffee1"
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      When CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      And the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"

    @ac-1
    Scenario: CI that passed on the head leaves the item in review, and a new head that fails sends it back
      Given CI passed on "c0ffee1"
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview
      When the head of PR 57 becomes "c0ffee2"
      And CI reports the check "ci" failed on "c0ffee2" at "https://github.com/acme/widgets/actions/runs/7311", failing the test "rounds to the cent"
      And the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's findings say CI failed on "c0ffee2"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7311"

    @ac-1
    Scenario: Two polls of the same failed head send the item back once
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      When the poller runs once
      And the poller runs once
      Then the factory holds item 482 in state "Queued"
      And item 482 has exactly 1 "changes_requested" event since it came to InReview

    @ac-1
    Scenario: Only the InReview item is sent back, and an item whose run is still in progress is left to its stage
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      And the factory holds item 483 in state "InProgress" with PR 58 in "acme/widgets", whose head is "beef001"
      And CI reports the check "ci" failed on "beef001" at "https://github.com/acme/widgets/actions/runs/7401", failing the test "reads the board"
      When the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the factory holds item 483 in state "InProgress"
      And item 483 has no "changes_requested" event

  Rule: When webhooks are on, GitHub's delivery that checks completed on the head of an InReview item's PR does the same as the poller

    @ac-1
    Scenario: A delivery that checks completed on the failed head sends the item back to address, with no poll
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      When GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's run resumes from "address"
      And the item's findings say CI failed on "c0ffee1"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"
      And the item's findings name the test "totals include VAT"
      And the item's "changes_requested" event names CI failing on "c0ffee1" as its cause

    @ac-1
    Scenario: A delivery that names every failed check, and no check that passed
      Given these checks report on "c0ffee1":
        | check | status | url                                               | failing tests      |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7300 |                    |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7301 | totals include VAT |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7302 | signs in           |
      When GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7301"
      And the item's findings name the check "e2e" and "https://github.com/acme/widgets/actions/runs/7302"
      And the item's findings don't name the check "lint"

    @ac-1
    Scenario: A delivery for a head whose CI passed leaves the item in review, and a later one after a failed re-run sends it back
      Given CI passed on "c0ffee1"
      When GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "InReview"
      When CI on "c0ffee1" is re-run and reports the check "ci" failed at "https://github.com/acme/widgets/actions/runs/7305", failing the test "totals include VAT"
      And GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's findings name the check "ci" and "https://github.com/acme/widgets/actions/runs/7305"

    @ac-1
    Scenario: A delivery followed by a poll of the same failed head sends the item back once
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      When GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      And the poller runs once
      Then the factory holds item 482 in state "Queued"
      And item 482 has exactly 1 "changes_requested" event since it came to InReview

  Rule: A CI failure on a commit that isn't the PR's head is ignored

    @ac-2
    Scenario: The poller ignores a failure on an older commit of the PR, and sends the item back only once the head fails
      Given the PR's earlier commit "0ldc0de" had the check "ci" fail at "https://github.com/acme/widgets/actions/runs/7201", failing the test "parses the config"
      And CI is still running on "c0ffee1"
      When the poller runs once
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview
      When CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      And the poller runs once
      Then the factory holds item 482 in state "Queued"
      And the item's findings say CI failed on "c0ffee1"
      And the item's findings don't name "0ldc0de"
      And the item's findings don't name "https://github.com/acme/widgets/actions/runs/7201"

    @ac-2
    Scenario: A delivery about an older commit of the PR is ignored, and one about the failed head isn't
      Given the PR's earlier commit "0ldc0de" had the check "ci" fail at "https://github.com/acme/widgets/actions/runs/7201", failing the test "parses the config"
      And CI passed on "c0ffee1"
      When GitHub delivers that a check suite completed on "0ldc0de" in "acme/widgets"
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview
      When CI on "c0ffee1" is re-run and reports the check "ci" failed at "https://github.com/acme/widgets/actions/runs/7305", failing the test "totals include VAT"
      And GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's findings say CI failed on "c0ffee1"
      And the item's findings don't name "0ldc0de"

    @ac-2
    Scenario: A late delivery about the commit the PR has since moved past is ignored
      Given CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "totals include VAT"
      And the head of PR 57 has since become "c0ffee2", whose CI is still running
      When GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview
      When CI reports the check "ci" failed on "c0ffee2" at "https://github.com/acme/widgets/actions/runs/7311", failing the test "rounds to the cent"
      And GitHub delivers that a check suite completed on "c0ffee2" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's findings say CI failed on "c0ffee2"
      And the item's findings don't name "c0ffee1"

    @ac-2
    Scenario: A delivery about a commit that isn't on the PR at all is ignored
      Given CI reports the check "ci" failed on "ma1n001", a commit on "main" that isn't on PR 57, at "https://github.com/acme/widgets/actions/runs/7501"
      And CI passed on "c0ffee1"
      When GitHub delivers that a check suite completed on "ma1n001" in "acme/widgets"
      Then the factory holds item 482 in state "InReview"
      And item 482 has no "changes_requested" event since it came to InReview
      When CI on "c0ffee1" is re-run and reports the check "ci" failed at "https://github.com/acme/widgets/actions/runs/7305", failing the test "totals include VAT"
      And GitHub delivers that a check suite completed on "c0ffee1" in "acme/widgets"
      Then the factory holds item 482 in state "Queued"
      And the item's findings don't name "ma1n001"
