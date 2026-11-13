@pbi-168
Feature: An Eligible or NotReady item that leaves the backlog is withdrawn
  The poller withdraws an item that loses its "factory" label or closes, but only once the item is
  Queued or further along. An Eligible or NotReady item that leaves the backlog stays held: it sits on
  the dashboard's "Not ready" list for good, as #118 does today. With this item, the poller withdraws
  it too, to Abandoned, and logs the move as a system event, as it does for the other withdrawals.
  An item withdrawn this way that gets its label back comes back as Eligible and meets the readiness
  gate again, so it never reaches Queued without passing it.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.
  The board, the repo and the readiness judge are fakes.

  Rule: A NotReady item that loses its label is withdrawn and leaves the "Not ready" list

    @ac-1 @db
    Scenario: A NotReady item whose label a person removes moves to Abandoned on the next poll
      Given the factory holds an item in state "NotReady"
      And the dashboard's "Not ready" list shows the item
      When a person removes the item's "factory" label on the board
      And the poller runs once
      Then the factory holds the item in state "Abandoned"
      And the dashboard's "Not ready" list doesn't show the item

    @ac-1 @db
    Scenario: A second poll after the withdrawal leaves the item where the first one put it
      Given the factory holds an item in state "NotReady"
      When a person removes the item's "factory" label on the board
      And the poller runs twice
      Then the factory holds the item in state "Abandoned"
      And the item's history shows exactly one move to "Abandoned"

  Rule: An Eligible item that loses its label is withdrawn before the readiness gate sees it

    @ac-2 @db
    Scenario: An Eligible item whose label a person removes moves to Abandoned on the next poll
      Given the factory holds an item in state "Eligible"
      And the readiness judge passes every line
      When a person removes the item's "factory" label on the board
      And the poller runs once
      Then the factory holds the item in state "Abandoned"
      And the readiness judge was not asked about the item

  Rule: A NotReady or Eligible item whose issue closes is withdrawn

    @ac-3 @db
    Scenario Outline: A <state> item whose issue a person closes moves to Abandoned on the next poll
      Given the factory holds an item in state "<state>"
      And the item still carries its "factory" label on the board
      When a person closes the item on the board
      And the poller runs once
      Then the factory holds the item in state "Abandoned"

      Examples:
        | state    |
        | NotReady |
        | Eligible |

  Rule: An item already held as NotReady without its label is withdrawn on the first poll after this ships

    @ac-4 @db
    Scenario: A NotReady item like #118, whose label was removed before this change, moves to Abandoned on the first poll
      Given the factory holds item 118 in state "NotReady"
      And item 118's "factory" label was removed on the board while earlier polls left it NotReady
      When the poller runs once
      Then the factory holds item 118 in state "Abandoned"
      And the dashboard's "Not ready" list doesn't show item 118

  Rule: A withdrawn item that gets its label back returns to Eligible and meets the readiness gate again

    @ac-5 @db
    Scenario Outline: An item withdrawn from <state> that gets its label back is Eligible after one poll
      Given the factory held an item in state "<state>" and withdrew it to "Abandoned" when its label was removed
      And the readiness judge is unavailable
      When a person adds the "factory" label back to the item on the board
      And the poller runs once
      Then the factory holds the item in state "Eligible"

      Examples:
        | state    |
        | NotReady |
        | Eligible |

    @ac-5 @db
    Scenario: A returning item that fails the readiness gate goes to NotReady, not Queued
      Given the factory held an item in state "Eligible" and withdrew it to "Abandoned" when its label was removed
      And the readiness judge fails one line of the item's Definition of Ready
      When a person adds the "factory" label back to the item on the board
      And the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item has a new readiness check recorded

    @ac-5 @db
    Scenario: A returning item that passes the readiness gate reaches Queued only through Eligible
      Given the factory held an item in state "NotReady" and withdrew it to "Abandoned" when its label was removed
      And the readiness judge passes every line
      When a person adds the "factory" label back to the item on the board
      And the poller runs once
      Then the item's history shows a move from "Abandoned" to "Eligible"
      And the item's history shows a move from "Eligible" to "Queued" after it
      And the item's history shows no move from "Abandoned" to "Queued"
      And the item has a new readiness check recorded

  Rule: The factory logs each of these moves as a system event

    @ac-6 @db
    Scenario Outline: The withdrawal of a <state> item is logged as a system event
      Given the factory holds an item in state "<state>"
      When a person <change> on the board
      And the poller runs once
      Then the item's history shows one withdrawal from "<state>" to "Abandoned", made by the system

      Examples:
        | state    | change                             |
        | NotReady | removes the item's "factory" label |
        | NotReady | closes the item                    |
        | Eligible | removes the item's "factory" label |
        | Eligible | closes the item                    |

    @ac-6 @db
    Scenario: A withdrawn item's return to Eligible is logged as a system event
      Given the factory held an item in state "NotReady" and withdrew it to "Abandoned" when its label was removed
      And the readiness judge is unavailable
      When a person adds the "factory" label back to the item on the board
      And the poller runs once
      Then the item's history shows one move from "Abandoned" to "Eligible", made by the system
