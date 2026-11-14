@pbi-181 @db
Feature: The factory merges a PR once GitHub allows it and every DoD line left for a person is ticked
  Today a person merges every factory PR by hand, and the poller notices the merge. With this item, the
  poller merges an InReview item's PR itself, with a squash merge, once GitHub reports the PR as `clean`,
  the PR has an approval, and every Definition of Done line the PR body leaves for the person who merges
  is ticked. The merge then moves the item to Accepted through the existing `merged` path.
  The factory leaves a PR alone while anything still stands in the way: no approval, a required check
  pending or failing, a trusted review asking for changes the factory hasn't addressed, an item still
  InProgress, or an operator's Hold. A merge GitHub refuses leaves the item in InReview, logs why, and
  the next poll tries again. Each merge the factory makes is logged as a system event.
  GitHub and the board are fakes here. Every scenario needs Postgres, which each test starts for
  itself, so cells and CI both run them.

  Background:
    Given "octo" and "kim" are allowlisted users
    And the factory holds an item in state "InReview" whose open run has PR 57 in "acme/widgets"
    And "octo" has approved PR 57
    And every required check on PR 57 has passed
    And PR 57's Definition of Done leaves no line for the person who merges
    And GitHub would merge PR 57 as commit "abc123"

  Rule: A clean PR merges on the next poll, as a squash merge, and the item moves to Accepted

    @ac-1
    Scenario: An InReview item whose PR reads clean is merged and moves to Accepted
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1
    Scenario: The factory's merge moves the item through the same "merged" path as a person's merge
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the item's history shows exactly one move to "Accepted", by the "merged" event

    @ac-1
    Scenario: A second poll after the merge doesn't merge again or move the item again
      Given GitHub reports PR 57 as "clean"
      When the poller runs twice
      Then the factory asked GitHub to merge PR 57 exactly once
      And the item's history shows exactly one move to "Accepted", by the "merged" event

    @ac-1
    Scenario Outline: A PR GitHub reports as "<merge state>" waits until it reads clean
      Given GitHub reports PR 57 as "<merge state>"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      When GitHub reports PR 57 as "clean"
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

      Examples:
        | merge state |
        | blocked     |
        | behind      |
        | unstable    |
        | unknown     |

  Rule: Every Definition of Done line left for the person who merges must be ticked first

    @ac-2
    Scenario: An unticked line for the person who merges holds the merge until a person ticks it
      Given PR 57's Definition of Done leaves the line "No secret appears in the diff" unticked for the person who merges
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      When a person ticks "No secret appears in the diff" in PR 57's body
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-2
    Scenario: One line still unticked holds the merge even when the others are ticked
      Given PR 57's Definition of Done leaves these lines unticked for the person who merges:
        | line                                       |
        | No secret appears in the diff              |
        | The PR body names the plan task it builds  |
      And GitHub reports PR 57 as "clean"
      When a person ticks "No secret appears in the diff" in PR 57's body
      And the poller runs once
      Then the factory hasn't merged PR 57
      When a person ticks "The PR body names the plan task it builds" in PR 57's body
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-2
    Scenario: Lines the factory ticked itself never hold the merge
      Given PR 57's Definition of Done has the factory's ticked line "Typecheck, unit tests and scenarios pass"
      And PR 57's Definition of Done leaves no line for the person who merges
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge

    @ac-2
    Scenario: An unticked box outside the Definition of Done doesn't hold the merge
      Given PR 57's body has an unticked box "Try it on staging" outside its Definition of Done
      And PR 57's Definition of Done leaves no line for the person who merges
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge

  Rule: The factory leaves a PR alone without an approval, with a required check not passed, or with a trusted review unaddressed

    @ac-3
    Scenario: A PR with no approval waits, even when GitHub reads it clean, until someone approves it
      Given nobody has approved PR 57
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      When "octo" approves PR 57
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-3
    Scenario Outline: A required check that is <status> holds the merge until it passes
      Given the required check "ci" on PR 57 is <status>
      And GitHub reports PR 57 as "blocked"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      When the required check "ci" on PR 57 passes
      And GitHub reports PR 57 as "clean"
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge

      Examples:
        | status  |
        | pending |
        | failing |

    @ac-3
    Scenario: A trusted review asking for changes sends the item to address instead of merging it, and the PR merges once that's addressed
      Given GitHub reports PR 57 as "clean"
      And "kim", an allowlisted user, requests changes on PR 57
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "Queued"
      And the item's run resumes from "address"
      When the factory addresses kim's review and the item returns to "InReview"
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-3
    Scenario: A review asking for changes from someone outside the allowlist doesn't hold the merge
      Given GitHub reports PR 57 as "clean"
      And "stranger", who maps to no allowlisted user, requests changes on PR 57
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

  Rule: A merge GitHub refuses leaves the item in InReview, logs why, and the next poll tries again

    @ac-4
    Scenario: GitHub refuses the merge because the head moved, and the next poll merges
      Given GitHub reports PR 57 as "clean"
      And GitHub refuses the next merge of PR 57 with "Head branch was modified. Review and try the merge again."
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      And a system event names PR 57 and the reason "Head branch was modified. Review and try the merge again."
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-4
    Scenario: A refused merge of one PR doesn't stop the poll merging another
      Given GitHub reports PR 57 as "clean"
      And GitHub refuses the next merge of PR 57 with "Base branch was modified."
      And the factory holds a second item in state "InReview" whose open run has PR 58 in "acme/widgets", approved by "octo"
      And GitHub reports PR 58 as "clean"
      When the poller runs once
      Then the factory has merged PR 58 with a squash merge
      And the second item is in state "Accepted"
      And the factory holds the first item in state "InReview"
      And a system event names PR 57 and the reason "Base branch was modified."

  Rule: Each merge the factory makes is logged as a system event naming the PR, the merge commit and the approvers

    @ac-5
    Scenario: The merge event names the PR, the merge commit and the approving reviewer
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then a system event records the factory's merge of PR 57
      And that event names the merge commit "abc123"
      And that event names "octo" as an approving reviewer

    @ac-5
    Scenario: The merge event names every approving reviewer, and only them
      Given "kim" has also approved PR 57
      And "lee" has commented on PR 57 without approving it
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then a system event records the factory's merge of PR 57
      And that event names "octo" and "kim" as the approving reviewers
      And that event doesn't name "lee"

    @ac-5
    Scenario: A refused merge logs no merge event
      Given GitHub reports PR 57 as "clean"
      And GitHub refuses the next merge of PR 57 with "Base branch was modified."
      When the poller runs once
      Then no system event records a merge of PR 57
      When the poller runs once
      Then exactly one system event records the factory's merge of PR 57

  Rule: An InProgress item is never merged, so a run still in PR review or address finishes first

    @ac-6
    Scenario Outline: An InProgress item whose PR reads clean waits until its run in <stage> finishes
      Given the factory holds the item in state "InProgress", with its run in "<stage>"
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InProgress"
      When the run finishes and the item moves to "InReview"
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

      Examples:
        | stage     |
        | pr-review |
        | address   |

  Rule: A held item is never merged, so an operator stops one merge with the dashboard's Hold

    @ac-7
    Scenario: A held InReview item whose PR reads clean waits until the operator lifts the hold
      Given an operator has held the item from the dashboard
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
      When the operator lifts the hold
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-7
    Scenario: Holding one item doesn't stop the merge of another
      Given an operator has held the item from the dashboard
      And GitHub reports PR 57 as "clean"
      And the factory holds a second item in state "InReview" whose open run has PR 58 in "acme/widgets", approved by "octo"
      And GitHub reports PR 58 as "clean"
      When the poller runs once
      Then the factory has merged PR 58 with a squash merge
      And the factory hasn't merged PR 57
