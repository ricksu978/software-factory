@pbi-12 @db
Feature: Poller
  Every five minutes the poller reads the board and the PRs the factory opened. It brings new items
  in, notices items a person withdrew, re-checks readiness when a team changes its rules, and moves
  items whose PR changed. The board, the repo and the readiness judge are fakes here. Every scenario
  needs Postgres, so cells skip them and CI runs them.

  @ac-1
  Scenario: A newly labelled item is Eligible after one poll
    Given a board item labelled "factory" that the factory has never seen
    And the readiness judge is unavailable
    When the poller runs once
    Then the factory holds the item in state "Eligible"
    And the board item has no comment

  @ac-1
  Scenario: An item without the label stays out of the factory
    Given a board item with no "factory" label
    When the poller runs once
    Then the factory doesn't hold the item

  @ac-2
  Scenario Outline: An item withdrawn during a run moves to Abandoned, and its PR closes
    Given the factory holds an item in state "<state>" with an open PR
    When a person <change> on the board
    And the poller runs once
    Then the factory holds the item in state "Abandoned"
    And the item's PR is closed

    Examples:
      | state      | change                             |
      | InProgress | removes the item's "factory" label |
      | InProgress | closes the item                    |
      | InReview   | removes the item's "factory" label |
      | InReview   | closes the item                    |

  @ac-3
  Scenario Outline: Changing any readiness input re-gates every NotReady item
    Given the factory holds two items in state "NotReady", checked against the repo's current readiness files
    And the readiness judge now passes every line
    When "<file>" changes on the repo's default branch
    And the poller runs once
    Then both items are in state "Queued"

    Examples:
      | file                   |
      | .factory/dor.md        |
      | .factory/scenarios.md  |
      | .factory/pr-review.md  |
      | .factory/risk.md       |
      | .factory/dod.md        |
      | .factory/config.yml    |

  @ac-3
  Scenario: With no readiness input changed, NotReady items stay as they are
    Given the factory holds two items in state "NotReady", checked against the repo's current readiness files
    And the readiness judge now passes every line
    When the poller runs once
    Then both items are in state "NotReady"

  @ac-4
  Scenario: An InReview item whose PR a person closed without merging moves to Abandoned
    Given the factory holds an item in state "InReview" with an open PR
    When a person closes the item's PR without merging it
    And the poller runs once
    Then the factory holds the item in state "Abandoned"

  @ac-4
  Scenario: An InReview item whose PR merged moves to Accepted
    Given the factory holds an item in state "InReview" with an open PR
    When a person merges the item's PR
    And the poller runs once
    Then the factory holds the item in state "Accepted"

  @ac-5
  Scenario: A changes-requested review from a stranger leaves the item in InReview
    Given the factory holds an item in state "InReview" with an open PR
    When "stranger", who maps to no allowlisted user, requests changes on the item's PR
    And the poller runs once
    Then the factory holds the item in state "InReview"

  @ac-5
  Scenario: The same review from an allowlisted user sends the item back to address
    Given the factory holds an item in state "InReview" with an open PR
    When "octo", an allowlisted user, requests changes on the item's PR
    And the poller runs once
    Then the factory holds the item in state "Queued"
    And the item's run resumes from "address"
