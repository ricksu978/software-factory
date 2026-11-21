@pbi-378
Feature: Bug-labelled items come first within a priority in the final-stage group, and first among priority 1 items
  Today the scheduler claims Start now items first, then the final-stage group, then every other item, by priority
  within each group, and within one priority answered items first, then the factory queue's order. An item with the
  "bug" label waits behind any other item at its priority that is higher on the board.
  With this item, the factory reads on every poll whether each item carries the "bug" label, as it reads the
  board's Priority, and keeps it with the item. In the final-stage group, within each priority, the bug items come
  before the rest. Outside that group, among the items at claim priority 1, the bug items come before the rest.
  Priorities 2 to 5 outside the group are ordered as today. After the bug items, the order is as today: answered
  items, then the factory queue's order. Only an item's own label counts: an item that takes a priority or the
  final-stage group from an item that depends on it doesn't take that item's label. Floor's "Next up" shows the new
  order, and Floor and Run detail mark a bug item.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub and the cells are fakes. The factory has one free WIP slot and a review capacity of 3 unless a scenario
  says otherwise. An item has no dependencies and no labels other than the factory's own unless a scenario gives it
  some.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in

  Rule: The factory reads each item's "bug" label on every poll and keeps it with the item

    @ac-1
    Scenario: An item carrying the "bug" label on the board is held as a bug item, and one with another label isn't
      Given item "A" is Queued and carries the "bug" label on the board
      And item "B" is Queued and carries the "enhancement" label on the board
      When the poller reads the board
      Then the factory holds item "A" as a bug item
      And the factory doesn't hold item "B" as a bug item

    @ac-1
    Scenario: A "bug" label added on the board is picked up on the next poll
      Given item "A" is Queued with no "bug" label on the board
      And the poller has read the board
      When someone adds the "bug" label to item "A" on the board
      And the poller reads the board
      Then the factory holds item "A" as a bug item

    @ac-1
    Scenario: A "bug" label removed on the board is dropped on the next poll
      Given items "A" and "B" are Queued and carry the "bug" label on the board
      And the poller has read the board
      When someone removes the "bug" label from item "A" on the board
      And the poller reads the board
      Then the factory doesn't hold item "A" as a bug item
      And the factory holds item "B" as a bug item

    @ac-1
    Scenario Outline: The "bug" label is read for an item that is <stage>
      Given item "A" is <stage>
      When someone adds the "bug" label to item "A" on the board
      And the poller reads the board
      Then the factory holds item "A" as a bug item

      Examples:
        | stage                                    |
        | Queued                                   |
        | InProgress in Green, with no PR yet      |
        | in NeedsInput with its question answered |
        | InReview with an open PR                 |

    @ac-1
    Scenario: The priority and the "bug" label are read on the same poll
      Given item "A" is Queued with the Priority 2 on the board and carries the "bug" label
      When the poller reads the board
      Then item "A" has priority 2
      And the factory holds item "A" as a bug item

  Rule: In the final-stage group, items are claimed by priority, and within one priority the bug items come first

    @ac-2
    Scenario Outline: Within priority <p> in the final-stage group, a bug item is claimed ahead of a higher board place
      Given item "A" has an open PR, is Queued to address requested changes, and has priority <p>
      And item "B" has an open PR, is Queued to address requested changes, has priority <p>, and carries the "bug" label
      And the board orders the items "A", "B"
      When the poller reads the board
      And the scheduler ticks once
      Then item "B" is "InProgress"
      And item "A" is "Queued"

      Examples:
        | p |
        | 1 |
        | 2 |
        | 3 |
        | 4 |
        | 5 |

    @ac-2
    Scenario: In the final-stage group, a higher priority still comes before a bug item
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 1
      And item "C" has an open PR, is Queued to address requested changes, and has priority 2
      And item "B" has an open PR, is Queued to address requested changes, has priority 2, and carries the "bug" label
      And the board orders the items "A", "C", "B"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "A", "B", "C", in that order

    @ac-2
    Scenario: Among the bug items of one priority in the final-stage group, the board order decides
      Given item "N" has an open PR, is Queued to address requested changes, and has priority 3
      And items "B1" and "B2" each have an open PR, are Queued to address requested changes, have priority 3, and carry the "bug" label
      And the board orders the items "N", "B2", "B1"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "B2", "B1", "N", in that order

    @ac-2
    Scenario: In the final-stage group, a bug item comes before an answered item, and answered bug items come first of all
      Given item "A" has an open PR and is InReview, with priority 2
      And item "A" depends on items "D" and "E" on the board
      And item "D" is in NeedsInput with its question answered
      And item "E" is in NeedsInput with its question answered and carries the "bug" label
      And item "B" has an open PR, is Queued to address requested changes, has priority 2, and carries the "bug" label
      And the board orders the items "D", "E", "B"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "E", "B", "D", in that order

  Rule: Outside the final-stage group, among the items at claim priority 1, the bug items come first; priorities 2 to 5 are ordered as today

    @ac-3
    Scenario: Among priority-1 items outside the final-stage group, a bug item is claimed ahead of a higher board place
      Given items "A" and "B" are Queued, in that board order, with priority 1
      And item "B" carries the "bug" label
      When the poller reads the board
      And the scheduler ticks once
      Then item "B" is "InProgress"
      And item "A" is "Queued"

    @ac-3
    Scenario: At priority 1, a Queued bug item is claimed ahead of an answered item without the label
      Given item "N" is in NeedsInput with its question answered and has priority 1
      And item "B" is Queued, has priority 1, and carries the "bug" label
      When the poller reads the board
      And the scheduler ticks once
      Then item "B" is "InProgress"
      And item "N" is still in NeedsInput with its question answered

    @ac-3
    Scenario: At priority 1, after the bug items come first, answered items and then the queue order decide as today
      Given item "N" is in NeedsInput with its question answered, has priority 1, and carries the "bug" label
      And item "M" is in SignOff with its sign-off answered and has priority 1
      And items "C" and "B" are Queued, with priority 1, and carry the "bug" label
      And item "A" is Queued and has priority 1
      And the board orders the items "A", "M", "C", "B", "N"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "N", "C", "B", "M", "A", in that order

    @ac-3
    Scenario: A bug item at claim priority 1 from an item that depends on it comes before the other priority-1 items
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And item "X" is Queued and has priority 1
      And item "D" is Queued, has priority 4, and carries the "bug" label
      And the board orders the items "X", "D", "H"
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"

    @ac-3
    Scenario: A bug item outside the final-stage group still comes after the final-stage group
      Given item "F" has an open PR, is Queued to address requested changes, and has priority 5
      And item "Y" is Queued and has priority 1
      And item "X" is Queued, has priority 1, and carries the "bug" label
      And the board orders the items "Y", "X", "F"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "F", "X", "Y", in that order

    @ac-3
    Scenario: Move up doesn't take a priority-1 item past a bug item
      Given items "B" and "C" are Queued, in that board order, with priority 1
      And item "B" carries the "bug" label
      And the poller has read the board
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      Then Floor's "Next up" lists "B", "C", in that order

    @ac-3 @regression
    Scenario Outline: At priority <p> outside the final-stage group, a bug item keeps its place in the order as today
      Given items "A" and "B" are Queued, in that board order, with priority <p>
      And item "B" carries the "bug" label
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "A", "B", in that order
      When the scheduler ticks once
      Then item "A" is "InProgress"
      And item "B" is "Queued"

      Examples:
        | p |
        | 2 |
        | 3 |
        | 4 |
        | 5 |

    @ac-3 @regression
    Scenario: Outside the final-stage group, a priority-1 item still comes before a priority-2 bug item
      Given items "B" and "X" are Queued, in that board order, with priorities 2 and 1
      And item "B" carries the "bug" label
      When the poller reads the board
      And the scheduler ticks once
      Then item "X" is "InProgress"
      And item "B" is "Queued"

  Rule: Only an item's own "bug" label counts, never one from an item that depends on it

    @ac-4
    Scenario: An item that joins the final-stage group from a bug item doesn't come first as a bug item
      Given item "A" has an open PR and is InReview, with priority 2, and carries the "bug" label
      And item "A" depends on item "D" on the board
      And item "D" is Queued and has priority 5
      And item "B" has an open PR, is Queued to address requested changes, and has priority 2
      And item "C" has an open PR, is Queued to address requested changes, has priority 2, and carries the "bug" label
      And the board orders the items "B", "D", "C", "A"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "C", "B", "D", in that order

    @ac-4
    Scenario: An item at priority 1 from a bug item doesn't come first as a bug item
      Given item "H" is Queued, has priority 1, and carries the "bug" label
      And item "H" depends on item "D" on the board
      And item "D" is Queued and has priority 4
      And item "X" is Queued and has priority 1
      And item "Y" is Queued, has priority 1, and carries the "bug" label
      And the board orders the items "D", "X", "Y", "H"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "Y", "D", "X", in that order

    @ac-4
    Scenario: An item's own "bug" label counts when it joins the final-stage group from an item without it
      Given item "A" has an open PR and is InReview, with priority 2
      And item "A" depends on item "D" on the board
      And item "D" is Queued, has priority 5, and carries the "bug" label
      And item "X" has an open PR, is Queued to address requested changes, and has priority 2
      And the board orders the items "X", "D", "A"
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"

    @ac-4 @ac-5
    Scenario: Floor and Run detail mark the bug item but not the item that depends on it
      Given item "A" has an open PR and is InReview, with priority 1, and carries the "bug" label
      And item "A" depends on item "D" on the board
      And item "D" is Queued and has priority 5
      When the poller reads the board
      And the operator opens Floor
      Then Floor marks item "A" as a bug item
      And Floor doesn't mark item "D" as a bug item
      When the operator opens item "D"'s Run detail
      Then Run detail doesn't mark item "D" as a bug item

  Rule: Floor's "Next up" shows the claim order with bug items first, and Floor and Run detail mark a bug item

    @ac-5
    Scenario: Floor's "Next up" shows bug items first where the claim puts them, and the scheduler claims by it
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 3
      And item "B" has an open PR, is Queued to address requested changes, has priority 3, and carries the "bug" label
      And item "C" is Queued and has priority 1
      And item "D" is Queued, has priority 1, and carries the "bug" label
      And item "E" is Queued, has priority 2, and carries the "bug" label
      And the board orders the items "A", "B", "C", "D", "E"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "B", "A", "D", "C", "E", in that order
      When the scheduler ticks once
      Then item "B" is "InProgress"

    @ac-5
    Scenario: Floor marks a bug item in "Next up" and not an item without the label
      Given items "A" and "B" are Queued, in that board order, with priority 3
      And item "B" carries the "bug" label
      When the poller reads the board
      And the operator opens Floor
      Then Floor marks item "B" as a bug item
      And Floor doesn't mark item "A" as a bug item

    @ac-5
    Scenario Outline: Floor marks a bug item that is <stage>
      Given item "A" is <stage> and carries the "bug" label
      When the poller reads the board
      And the operator opens Floor
      Then Floor marks item "A" as a bug item

      Examples:
        | stage                                    |
        | InProgress in Green, with no PR yet      |
        | InReview with an open PR                 |
        | in NeedsInput with its question answered |

    @ac-5
    Scenario: Run detail marks a bug item, and not an item without the label
      Given item "A" is Queued and carries the "bug" label
      And item "B" is Queued
      When the poller reads the board
      And the operator opens item "A"'s Run detail
      Then Run detail marks item "A" as a bug item
      When the operator opens item "B"'s Run detail
      Then Run detail doesn't mark item "B" as a bug item

    @ac-5
    Scenario: Once the "bug" label is removed, Floor and Run detail stop marking the item
      Given items "A" and "B" are Queued and carry the "bug" label on the board
      And the poller has read the board
      When someone removes the "bug" label from item "A" on the board
      And the poller reads the board
      And the operator opens Floor
      Then Floor marks item "B" as a bug item
      And Floor doesn't mark item "A" as a bug item
      When the operator opens item "A"'s Run detail
      Then Run detail doesn't mark item "A" as a bug item
