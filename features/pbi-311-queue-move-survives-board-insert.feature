@pbi-311
Feature: A queue move stays in place when a new issue lands on the board between the moved item and the one it passed
  PBI 265 gave the dashboard Move up and Move down, which change an item's place in the factory queue without
  touching the board. PR #306 keeps a move in place when a board change shifts the moved item and the items around
  it alike, such as a new issue at the top of the board. But a new issue that lands on the board between the moved
  item and the item it passed shifts one of the two and not the other, and today the move is lost: the moved item
  drops back behind the item it passed, or ahead of the item it moved down past.
  With this item, a move holds its item ahead of, or behind, the item it passed for as long as the board keeps
  those two in the order they had when the move was made, whatever else changes on the board. When a person puts
  the two in the other order on the board itself, the board wins: the move ends, the queue follows the board, and
  the item's page says the board change ended it.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub and the cells are fakes. Every item a scenario names is Queued unless it says otherwise.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in

  Rule: An item moved up stays ahead of the item it passed while the board keeps those two in their order

    @ac-1
    Scenario: A new issue that lands between the moved item and the one it passed leaves the move in place
      Given items "A", "B" and "C" are Queued, in that board order
      And the operator pressed "Move up" on item "C" with the reason "smaller, so it goes first"
      When a new issue "X" lands on the board, which then orders the items "A", "B", "X", "C"
      And the poller reads the board
      And the readiness gate passes item "X"
      Then Floor's "Next up" lists "A", "C", "B", "X", in that order
      And item "C" has an active "Move up" override

    @ac-1
    Scenario: Two new issues that land between the moved item and the one it passed leave the move in place
      Given items "A", "B" and "C" are Queued, in that board order
      And the operator pressed "Move up" on item "C" with the reason "smaller, so it goes first"
      When new issues "X" and "Y" land on the board, which then orders the items "A", "B", "X", "Y", "C"
      And the poller reads the board
      And the readiness gate passes items "X" and "Y"
      Then Floor's "Next up" lists "A", "C", "B", "X", "Y", in that order
      And item "C" has an active "Move up" override

    @ac-1
    Scenario: The move still holds at the next board poll after the new issue landed
      Given items "A", "B" and "C" are Queued, in that board order
      And the operator pressed "Move up" on item "C" with the reason "smaller, so it goes first"
      When a new issue "X" lands on the board, which then orders the items "A", "B", "X", "C"
      And the poller reads the board
      And the readiness gate passes item "X"
      And the poller reads the board, still ordered "A", "B", "X", "C"
      Then Floor's "Next up" lists "A", "C", "B", "X", in that order

    @ac-1
    Scenario: A person moving another item on the board to between the two leaves the move in place
      Given items "A", "B", "C", "D" and "E" are Queued, in that board order
      And the operator pressed "Move up" on item "E" with the reason "smaller, so it goes first"
      When a person reorders the board to "B", "C", "D", "A", "E"
      And the poller reads the board
      Then Floor's "Next up" lists "E" ahead of "D"
      And item "E" has an active "Move up" override
      And the board still orders the items "B", "C", "D", "A", "E"

  Rule: An item moved down stays behind the item it passed while the board keeps those two in their order

    @ac-2
    Scenario: A new issue that lands between the moved item and the one it passed leaves the move in place
      Given items "A", "B" and "C" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      When a new issue "X" lands on the board, which then orders the items "A", "X", "B", "C"
      And the poller reads the board
      And the readiness gate passes item "X"
      Then Floor's "Next up" lists "X", "B", "A", "C", in that order
      And item "A" has an active "Move down" override

    @ac-2
    Scenario: Two new issues that land between the moved item and the one it passed leave the move in place
      Given items "A", "B" and "C" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      When new issues "X" and "Y" land on the board, which then orders the items "A", "X", "Y", "B", "C"
      And the poller reads the board
      And the readiness gate passes items "X" and "Y"
      Then Floor's "Next up" lists "X", "Y", "B", "A", "C", in that order
      And item "A" has an active "Move down" override

    @ac-2
    Scenario: A person moving another item on the board to between the two leaves the move in place
      Given items "A", "B", "C", "D" and "E" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      When a person reorders the board to "A", "E", "B", "C", "D"
      And the poller reads the board
      Then Floor's "Next up" lists "A" behind "B"
      And item "A" has an active "Move down" override
      And the board still orders the items "A", "E", "B", "C", "D"

  Rule: A new issue at the top of the board, or one taken off it, still leaves every move in place

    @ac-3 @regression
    Scenario: A new issue at the top of the board leaves a move up and a move down in place
      Given items "A", "B", "C", "D" and "E" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      And the operator pressed "Move up" on item "E" with the reason "smaller, so it goes first"
      When a new issue "X" lands on the board, which then orders the items "X", "A", "B", "C", "D", "E"
      And the poller reads the board
      And the readiness gate passes item "X"
      Then Floor's "Next up" lists "X", "B", "A", "C", "E", "D", in that order
      And item "A" has an active "Move down" override
      And item "E" has an active "Move up" override

    @ac-3 @regression
    Scenario Outline: An issue taken off the board <where> leaves a <control> in place
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "<control>" on item "<moved>" with the reason "<reason>"
      When a person takes issue "<gone>" off the board
      And the poller reads the board
      Then Floor's "Next up" lists <order>, in that order
      And item "<moved>" has an active "<control>" override

      Examples:
        | where             | control   | moved | reason                     | gone | order         |
        | above the two     | Move up   | D     | smaller, so it goes first  | A    | "B", "D", "C" |
        | above the two     | Move down | B     | waiting on a design review | A    | "C", "B", "D" |
        | below the two     | Move up   | C     | smaller, so it goes first  | D    | "A", "C", "B" |
        | below the two     | Move down | B     | waiting on a design review | D    | "A", "C", "B" |

  Rule: When a person puts the two items in the other order on the board itself, the board wins and the move ends

    @ac-4
    Scenario: A person drags the moved-up item above the one it passed, and the board's order wins
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "Move up" on item "D" with the reason "smaller, so it goes first"
      When a person reorders the board to "A", "D", "B", "C"
      And the poller reads the board
      Then Floor's "Next up" lists "A", "D", "B", "C", in that order
      And item "D" has no active "Move up" override
      And the override records when it ended
      And item "D"'s page says its "Move up" was ended by a change to the board's order
      And the factory asked the board to reorder nothing

    @ac-4
    Scenario: A person drags the passed item below the moved-up item, and the board's order wins
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "Move up" on item "D" with the reason "smaller, so it goes first"
      When a person reorders the board to "A", "B", "D", "C"
      And the poller reads the board
      Then Floor's "Next up" lists "A", "B", "D", "C", in that order
      And item "D" has no active "Move up" override
      And item "D"'s page says its "Move up" was ended by a change to the board's order

    @ac-4
    Scenario: A person drags the moved-down item below the one it passed, and the board's order wins
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      When a person reorders the board to "B", "C", "A", "D"
      And the poller reads the board
      Then Floor's "Next up" lists "B", "C", "A", "D", in that order
      And item "A" has no active "Move down" override
      And the override records when it ended
      And item "A"'s page says its "Move down" was ended by a change to the board's order
      And the factory asked the board to reorder nothing

    @ac-4
    Scenario: A person drags the passed item above the moved-down item, and the board's order wins
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "Move down" on item "A" with the reason "waiting on a design review"
      When a person reorders the board to "B", "A", "C", "D"
      And the poller reads the board
      Then Floor's "Next up" lists "B", "A", "C", "D", in that order
      And item "A" has no active "Move down" override
      And item "A"'s page says its "Move down" was ended by a change to the board's order

    @ac-4
    Scenario: Once the board has ended a move, the item follows the board from then on
      Given items "A", "B", "C" and "D" are Queued, in that board order
      And the operator pressed "Move up" on item "D" with the reason "smaller, so it goes first"
      When a person reorders the board to "A", "D", "B", "C"
      And the poller reads the board
      And a person reorders the board to "A", "B", "C", "D"
      And the poller reads the board
      Then Floor's "Next up" lists "A", "B", "C", "D", in that order
      And item "D" has no active "Move up" override
