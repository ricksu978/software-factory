@pbi-7
Feature: PBI state machine
  An item moves between states only along the edges plan Task 3 lists. Anything else is refused,
  unless an operator overrides it, which can move an item from any state to any state.

  @ac-1
  Scenario Outline: An edge moves the item to its listed state
    Given an item in state "<from>"
    When the event "<event>" happens
    Then the item is in state "<to>"

    Examples:
      | from       | event             | to         |
      | Eligible   | readiness_failed  | NotReady   |
      | NotReady   | item_edited       | Eligible   |
      | NotReady   | policy_changed    | Eligible   |
      | Eligible   | ready             | Queued     |
      | Queued     | claimed           | InProgress |
      | SignOff    | claimed           | InProgress |
      | NeedsInput | claimed           | InProgress |
      | InProgress | scenarios_written | SignOff    |
      | InProgress | blocked           | NeedsInput |
      | InProgress | pr_opened         | InReview   |
      | InReview   | changes_requested | Queued     |
      | InReview   | merged            | Accepted   |
      | InProgress | merged            | Accepted   |
      | InReview   | approvals_met     | Accepted   |
      | Accepted   | dod_verified      | Done       |
      | Accepted   | dod_failed        | Failed     |
      | InProgress | retries_exhausted | Failed     |
      | NeedsInput | timed_out         | Abandoned  |
      | SignOff    | timed_out         | Abandoned  |
      | InProgress | lease_expired     | Queued     |
      | InProgress | usage_limited     | Queued     |
      | Failed     | requeued          | Queued     |
      | Abandoned  | requeued          | Queued     |
      | Abandoned  | reopened_signoff  | SignOff    |
      | Abandoned  | reopened_question | NeedsInput |
      | Queued     | withdrawn         | Abandoned  |
      | InProgress | withdrawn         | Abandoned  |
      | SignOff    | withdrawn         | Abandoned  |
      | NeedsInput | withdrawn         | Abandoned  |
      | InReview   | withdrawn         | Abandoned  |
      | Queued     | criteria_changed  | Queued     |
      | InProgress | criteria_changed  | Queued     |
      | SignOff    | criteria_changed  | Queued     |
      | NeedsInput | criteria_changed  | Queued     |
      | InReview   | criteria_changed  | Queued     |
      | Eligible   | withdrawn         | Abandoned  |
      | NotReady   | withdrawn         | Abandoned  |
      | Abandoned  | returned          | Eligible   |

  @ac-2
  Scenario: Every move the table doesn't list is refused
    When I try every event from every state that the table above doesn't list
    Then every one of those moves is refused
    And at least one move is tried

  @ac-3
  Scenario: An override can move an item between any two states
    When I override every state to every state
    Then every override lands on its target state
