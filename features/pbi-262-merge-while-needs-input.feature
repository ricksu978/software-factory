@pbi-262 @db
Feature: The factory merges an approved, clean PR whose item waits in NeedsInput
  A run can stop and ask a person a question after it has opened its PR, so the item waits in NeedsInput
  while its PR is still open. A person may then approve the PR and tick its Definition of Done without
  answering. Today the poller merges only an InReview item's PR, so this PR waits for a person to merge it
  by hand, and the question stays open after that question has stopped mattering.
  With this item, the poller's merge step treats a NeedsInput item the way it treats an InReview one. GitHub
  must read the PR `clean`, a trusted person must have approved it, and every Definition of Done line left
  for the person who merges must be ticked. When the factory merges, the item moves to Accepted through the
  existing `merged` path. Its open question closes with a note naming the merge, and the merge event says
  the item was waiting in NeedsInput and names its question. A held item, an InProgress item, and an item
  whose criteria changed since its run started still aren't merged.
  GitHub and the board are fakes here. Every scenario needs Postgres, which each test starts for itself, so
  cells and CI both run them.

  Background:
    Given "octo" and "kim" are allowlisted users
    And the factory holds an item in state "NeedsInput" whose open run has PR 57 in "acme/widgets"
    And the item waits on an open question "Address failed: CI failed on the PR"
    And "octo" has approved PR 57
    And every required check on PR 57 has passed
    And PR 57's Definition of Done leaves no line for the person who merges
    And GitHub would merge PR 57 as commit "abc123"

  Rule: A NeedsInput item's PR merges once GitHub reads it clean, as an InReview item's does

    @ac-1
    Scenario: A NeedsInput item whose PR reads clean and is approved is merged on the next poll
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1
    Scenario Outline: A NeedsInput item's PR that GitHub reports as "<merge state>" waits until it reads clean
      Given GitHub reports PR 57 as "<merge state>"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      And the question "Address failed: CI failed on the PR" is still open
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

    @ac-1
    Scenario: A second poll after the merge doesn't merge again or move the item again
      Given GitHub reports PR 57 as "clean"
      When the poller runs twice
      Then the factory asked GitHub to merge PR 57 exactly once
      And the item's history shows exactly one move to "Accepted", by the "merged" event

  Rule: A NeedsInput item's PR needs a trusted person's approval before the factory merges it

    @ac-1
    Scenario: A NeedsInput item's PR with no approval waits until a trusted person approves it
      Given nobody has approved PR 57
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      When "kim" approves PR 57
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-1
    Scenario: An approval from someone outside the allowlist doesn't merge a NeedsInput item's PR
      Given nobody has approved PR 57
      And "stranger", who maps to no allowlisted user, approves PR 57
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      When "octo" approves PR 57
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge

  Rule: Every Definition of Done line left for the person who merges must be ticked before a NeedsInput item's PR merges

    @ac-1
    Scenario: An unticked line for the person who merges holds the merge until a person ticks it
      Given PR 57's Definition of Done leaves the line "No secret appears in the diff" unticked for the person who merges
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      When a person ticks "No secret appears in the diff" in PR 57's body
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-1
    Scenario: One line still unticked holds the merge even when the others are ticked
      Given PR 57's Definition of Done leaves these lines unticked for the person who merges:
        | line                                  |
        | No secret appears in the diff         |
        | The new page reads well on a phone    |
      And GitHub reports PR 57 as "clean"
      When a person ticks "No secret appears in the diff" in PR 57's body
      And the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      When a person ticks "The new page reads well on a phone" in PR 57's body
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge

  Rule: The factory's merge of a NeedsInput item closes its question with a note naming the merge, and accepts the item through the merged path

    @ac-2
    Scenario: The question the item waited on closes with a note naming the factory's merge
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the item has no open question
      And the question "Address failed: CI failed on the PR" is closed without an answer
      And the question "Address failed: CI failed on the PR" carries a note that the factory merged PR 57 as commit "abc123"

    @ac-2
    Scenario: The factory's merge moves the NeedsInput item to Accepted through the "merged" path
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item's history shows exactly one move to "Accepted", by the "merged" event
      And that move to "Accepted" is from "NeedsInput"

    @ac-2
    Scenario: The dashboard stops asking for an answer once the factory has merged the item's PR
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then "Waiting on you" on the dashboard doesn't list the item
      And the item's page asks for no answer

    @ac-2
    Scenario: A NeedsInput item whose PR isn't merged keeps its question open, with no merge note
      Given GitHub reports PR 57 as "blocked"
      When the poller runs once
      Then the question "Address failed: CI failed on the PR" is still open
      And the question "Address failed: CI failed on the PR" carries no note about a merge
      When GitHub reports PR 57 as "clean"
      And the poller runs once
      Then the question "Address failed: CI failed on the PR" carries a note that the factory merged PR 57 as commit "abc123"

  Rule: A held item, an InProgress item, or an item whose criteria changed since its run started is never merged

    @ac-3
    Scenario: A held NeedsInput item whose PR reads clean waits until the operator lifts the hold
      Given an operator has held the item from the dashboard
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "NeedsInput"
      And the question "Address failed: CI failed on the PR" is still open
      When the operator lifts the hold
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-3
    Scenario: An InProgress item whose PR reads clean waits until its run stops to ask a question
      Given the factory holds the item in state "InProgress", with its run in "address"
      And the item has no open question
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InProgress"
      When the run stops to ask "Address failed: CI failed on the PR" and the item moves to "NeedsInput"
      And the poller runs once
      Then the factory has merged PR 57 with a squash merge
      And the factory holds the item in state "Accepted"

    @ac-3 @regression
    Scenario: A NeedsInput item whose acceptance criteria changed since its run started isn't merged, and starts a new run
      Given GitHub reports PR 57 as "clean"
      And the item's acceptance criteria on the board changed since its run started
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "Queued"
      And the item's run that opened PR 57 has ended
      And the factory has closed PR 57 without merging it

    @ac-3 @regression
    Scenario: An InReview item whose acceptance criteria changed since its run started isn't merged
      Given the factory holds a second item in state "InReview" whose open run has PR 58 in "acme/widgets", approved by "octo"
      And GitHub reports PR 58 as "clean"
      And the second item's acceptance criteria on the board changed since its run started
      When the poller runs once
      Then the factory hasn't merged PR 58
      And the second item is in state "Queued"

    @ac-3 @regression
    Scenario: A held InReview item whose PR reads clean still isn't merged
      Given the factory holds a second item in state "InReview" whose open run has PR 58 in "acme/widgets", approved by "octo"
      And an operator has held the second item from the dashboard
      And GitHub reports PR 58 as "clean"
      When the poller runs once
      Then the factory hasn't merged PR 58
      And the second item is in state "InReview"

  Rule: The merge event of a NeedsInput item says the item was waiting in NeedsInput and names its question

    @ac-4
    Scenario: The merge event says the item was waiting in NeedsInput and names its question
      Given GitHub reports PR 57 as "clean"
      When the poller runs once
      Then a system event records the factory's merge of PR 57
      And that event names the merge commit "abc123"
      And that event names "octo" as an approving reviewer
      And that event says the item was waiting in "NeedsInput"
      And that event names the question "Address failed: CI failed on the PR"

    @ac-4
    Scenario: The merge event of an InReview item names no waiting state or question
      Given the factory holds a second item in state "InReview" whose open run has PR 58 in "acme/widgets", approved by "octo"
      And GitHub reports PR 58 as "clean"
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then a system event records the factory's merge of PR 57
      And that event says the item was waiting in "NeedsInput"
      And a system event records the factory's merge of PR 58
      And that event doesn't say the item was waiting in "NeedsInput"
      And that event names no question
