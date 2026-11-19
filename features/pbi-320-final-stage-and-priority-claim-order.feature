@pbi-320
Feature: Final-stage items and the items they depend on are claimed first, then by a priority from 1 to 5
  Today the scheduler claims in board order, with Start now first and answered items ahead of new work. An item
  that is nearly done, with its PR open and in the review loop, waits behind new work like any other, and so does
  an item it depends on. On 2026-11-15 the waiting brake held #305 and #317 back even though they mattered most.
  With this item, every item has a priority from 1 to 5, read from the board's Priority field on each poll, where
  1 is the highest and an item with no valid value gets 3. Items whose PR is open and that are in the review loop
  (InReview, in address, or in the PR review after address) are final-stage and form one group. The scheduler
  claims Start now items first, then the final-stage group, then every other item, and by priority within each
  group, keeping today's order within one priority. An item that a final-stage item depends on joins the
  final-stage group with that item's priority. Outside that group, an item that a higher-priority item depends on
  takes the higher priority. Either way the item goes back to its own group and priority once the dependency is
  gone. A priority-1 item takes the next free slot even when the waiting brake is on. Floor and the item page show
  each item's priority, whether it's final-stage, and which item it inherits that from.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub and the cells are fakes. The factory has one free WIP slot and a review capacity of 3 unless a scenario
  says otherwise, and an item has no dependencies unless a scenario gives it some.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in

  Rule: Each item's priority comes from the board's Priority field on each poll, and is 3 when the value is missing or not from 1 to 5

    @ac-1
    Scenario Outline: An item whose Priority on the board is <value> has priority <value>
      Given item "A" is Queued with the Priority <value> on the board
      When the poller reads the board
      Then item "A" has priority <value>

      Examples:
        | value |
        | 1     |
        | 2     |
        | 3     |
        | 4     |
        | 5     |

    @ac-1
    Scenario Outline: An item whose Priority on the board is <value> gets priority 3
      Given item "A" is Queued with the Priority <value> on the board
      When the poller reads the board
      Then item "A" has priority 3

      Examples:
        | value   |
        | empty   |
        | 0       |
        | 6       |
        | -1      |
        | 2.5     |
        | "high"  |

    @ac-1
    Scenario: A priority changed on the board is picked up on the next poll
      Given item "A" is Queued with the Priority 4 on the board
      And the poller has read the board
      When someone sets item "A"'s Priority to 1 on the board
      And the poller reads the board
      Then item "A" has priority 1

    @ac-1
    Scenario: A priority cleared on the board goes back to 3 on the next poll
      Given item "A" is Queued with the Priority 1 on the board
      And the poller has read the board
      When someone clears item "A"'s Priority on the board
      And the poller reads the board
      Then item "A" has priority 3

  Rule: An item is final-stage while its PR is open and it's in the review loop, and all such items form one group

    @ac-2
    Scenario Outline: An item <stage> is final-stage
      Given item "A" has an open PR and is <stage>
      When the operator opens Floor
      Then Floor shows item "A" as final-stage
      And item "A"'s page shows it as final-stage

      Examples:
        | stage                                       |
        | InReview                                    |
        | Queued to address requested changes         |
        | in address                                  |
        | in the PR review that follows address       |

    @ac-2
    Scenario Outline: An item <stage> isn't final-stage
      Given item "A" is <stage>
      And item "B" has an open PR and is InReview
      When the operator opens Floor
      Then Floor shows item "B" as final-stage
      And Floor doesn't show item "A" as final-stage
      And item "A"'s page doesn't show it as final-stage

      Examples:
        | stage                                       |
        | Queued and never started                    |
        | InProgress in Green, with no PR yet         |
        | in NeedsInput with its question answered    |
        | in SignOff with its sign-off answered       |
        | Accepted, with its PR merged                |

    @ac-2
    Scenario: Final-stage items in different review-loop stages are ordered together by priority alone
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 3
      And item "B" has an open PR, is Queued to address requested changes, and has priority 1
      And item "C" is Queued, has priority 1, and is first on the board
      And the board orders the items "C", "A", "B"
      When the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "B", "A", "C", in that order

  Rule: The scheduler claims Start now first, then the final-stage group, then every other item, by priority within each group

    @ac-3
    Scenario: A final-stage item is claimed ahead of other work with a higher priority and a higher board place
      Given item "B" is Queued, has priority 1, and is first on the board
      And item "A" has an open PR, is Queued to address requested changes, and has priority 5
      When the scheduler ticks once
      Then item "A" is "InProgress"
      And item "B" is "Queued"

    @ac-3
    Scenario: A Start now item is claimed ahead of the final-stage group, and the final-stage group next
      Given item "C" is Queued, has priority 1, and is first on the board
      And item "A" has an open PR, is Queued to address requested changes, and has priority 1
      And item "B" is Queued and has priority 5
      And the factory has two free WIP slots
      When the operator presses "Start now" on item "B" with the reason "customer demo on Friday"
      And the scheduler ticks once
      Then items "B" and "A" are "InProgress"
      And item "C" is "Queued"

    @ac-3
    Scenario: Within the final-stage group, the higher priority is claimed first
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 3
      And item "B" has an open PR, is Queued to address requested changes, and has priority 2
      And the board orders the items "A", "B"
      When the scheduler ticks once
      Then item "B" is "InProgress"
      And item "A" is "Queued"

    @ac-3
    Scenario: Outside the final-stage group, the higher priority is claimed first, whatever the board order
      Given items "A", "B" and "C" are Queued, in that board order
      And items "A", "B" and "C" have priorities 4, 5 and 2
      When the scheduler ticks once
      Then item "C" is "InProgress"
      And items "A" and "B" are "Queued"

    @ac-3
    Scenario: Within one priority, the board order still decides
      Given items "A", "B" and "C" are Queued, in that board order
      And items "A", "B" and "C" have priorities 3, 3 and 1
      And the factory has two free WIP slots
      When the scheduler ticks once
      Then items "C" and "A" are "InProgress"
      And item "B" is "Queued"

    @ac-3
    Scenario: A higher priority comes before an answered item, and within one priority the answered item still comes first
      Given item "N" is in NeedsInput with its question answered and has priority 2
      And item "M" is in SignOff with its sign-off answered and has priority 3
      And items "A" and "B" are Queued, in that board order, with priorities 2 and 1
      When the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "B", "N", "A", "M", in that order

    @ac-3
    Scenario: Move up orders items within one priority, and a higher priority still comes first
      Given items "A", "B" and "C" are Queued, in that board order
      And items "A", "B" and "C" have priorities 2, 1 and 1
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      Then Floor's "Next up" lists "C", "B", "A", in that order

    @ac-3
    Scenario: Floor's Next up shows the claim order, and the scheduler claims by it
      Given items "A", "B" and "C" are Queued, in that board order
      And items "A", "B" and "C" have priorities 5, 3 and 3
      And item "D" has an open PR, is Queued to address requested changes, and has priority 4
      When the operator opens Floor before the scheduler ticks
      Then Floor's "Next up" lists "D", "B", "C", "A", in that order
      When the scheduler ticks once
      Then item "D" is "InProgress"

  Rule: An item that a final-stage item depends on joins the final-stage group with that item's priority while the dependency stands

    @ac-4
    Scenario: The item a final-stage item depends on is claimed ahead of other work
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 2
      And item "A" depends on item "D" on the board
      And item "X" is Queued and has priority 1
      And item "D" is Queued and has priority 5
      And the board orders the items "X", "D", "A"
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"

    @ac-4
    Scenario: An item that a final-stage item depends on through another item joins the group too
      Given item "A" has an open PR and is InReview, with priority 2
      And item "A" depends on item "E" on the board
      And item "E" depends on item "D" on the board
      And item "X" is Queued and has priority 1
      And items "X", "E" and "D" are Queued, in that board order
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And items "X" and "E" are "Queued"

    @ac-4
    Scenario: The joining item takes the final-stage item's priority within the group
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 1
      And item "A" depends on item "D" on the board
      And item "B" has an open PR, is Queued to address requested changes, and has priority 3
      And item "D" is Queued and has priority 5
      And the board orders the items "B", "D", "A"
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "B" is "Queued"

    @ac-4
    Scenario: An item that two final-stage items depend on takes the higher of their priorities
      Given item "A" has an open PR and is InReview, with priority 4
      And item "B" has an open PR and is InReview, with priority 1
      And items "A" and "B" each depend on item "D" on the board
      And item "C" has an open PR, is Queued to address requested changes, and has priority 2
      And item "D" is Queued and has priority 5
      And the board orders the items "C", "D"
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "C" is "Queued"

    @ac-4
    Scenario Outline: An item that a final-stage item depends on joins the group while it's <stage>
      Given item "A" has an open PR and is InReview, with priority 1
      And item "A" depends on item "D" on the board
      And item "D" is <stage>
      When the poller reads the board
      And the operator opens Floor
      Then Floor shows item "D" as final-stage
      And item "D"'s page shows it as final-stage

      Examples:
        | stage                                    |
        | Eligible                                 |
        | Queued                                   |
        | InProgress in Green, with no PR yet      |
        | in NeedsInput with its question answered |
        | in SignOff with its sign-off answered    |

    @ac-4
    Scenario: An answered item that a final-stage item depends on is claimed ahead of other work
      Given item "A" has an open PR and is InReview, with priority 3
      And item "A" depends on item "D" on the board
      And item "D" is in NeedsInput with its question answered and has priority 5
      And item "X" is in SignOff with its sign-off answered, has priority 1, and is first on the board
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is still in SignOff with its sign-off answered

  Rule: Outside the final-stage group, an item that a higher-priority item depends on takes that priority while the dependency stands

    @ac-5
    Scenario: The item a higher-priority item depends on is claimed at that priority
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And items "X" and "D" are Queued, in that board order, with priorities 2 and 4
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"

    @ac-5
    Scenario: An item that a higher-priority item depends on through another item takes that priority too
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "E" on the board
      And item "E" depends on item "D" on the board
      And items "X", "E" and "D" are Queued, in that board order, with priorities 2, 5 and 5
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And items "X" and "E" are "Queued"

    @ac-5
    Scenario: A lower-priority item that depends on another doesn't lower that item's priority
      Given item "L" is Queued and has priority 5
      And item "L" depends on item "D" on the board
      And items "X" and "D" are Queued, in that board order, with priorities 3 and 2
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"
      And item "D"'s page shows priority 2, its own

    @ac-5
    Scenario: An item that two items depend on takes the higher of their priorities
      Given item "H" is Queued and has priority 1
      And item "M" is Queued and has priority 3
      And items "H" and "M" each depend on item "D" on the board
      And items "X" and "D" are Queued, in that board order, with priorities 2 and 5
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"

  Rule: Once a dependency is gone, an item goes back to its own group and priority

    @ac-6
    Scenario: An item leaves the final-stage group when the final-stage item no longer depends on it
      Given item "A" has an open PR and is InReview, with priority 1
      And item "A" depends on item "D" on the board
      And items "D" and "X" are Queued, in that board order, with priorities 5 and 3
      And the poller has read the board
      When someone removes item "A"'s dependency on item "D" on the board
      And the poller reads the board
      And the scheduler ticks once
      Then item "X" is "InProgress"
      And item "D" is "Queued"
      And Floor doesn't show item "D" as final-stage
      And item "D"'s page shows priority 5

    @ac-6
    Scenario: An item goes back to its own priority when the higher-priority item no longer depends on it
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And items "D" and "X" are Queued, in that board order, with priorities 4 and 2
      And the poller has read the board
      When someone removes item "H"'s dependency on item "D" on the board
      And the poller reads the board
      And the scheduler ticks once
      Then item "X" is "InProgress"
      And item "D" is "Queued"
      And item "D"'s page shows priority 4

    @ac-6
    Scenario: An item goes back to its own group when the item that depended on it is Done
      Given item "A" has an open PR and is InReview, with priority 1
      And item "A" depends on item "D" on the board
      And items "D" and "X" are Queued, in that board order, with priorities 5 and 3
      And the poller has read the board
      When item "A" reaches Done
      And the poller reads the board
      And the scheduler ticks once
      Then item "X" is "InProgress"
      And item "D" is "Queued"
      And Floor doesn't show item "D" as final-stage

    @ac-6
    Scenario: An item that still has one final-stage dependent stays in the group when another drops it
      Given item "A" has an open PR and is InReview, with priority 1
      And item "B" has an open PR and is InReview, with priority 2
      And items "A" and "B" each depend on item "D" on the board
      And items "X" and "D" are Queued, in that board order, with priorities 1 and 5
      And the poller has read the board
      When someone removes item "A"'s dependency on item "D" on the board
      And the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "X" is "Queued"
      And item "D"'s page shows priority 2, from item "B"

  Rule: A priority-1 item takes the next free slot, and the waiting brake doesn't hold it back

    @ac-7
    Scenario: A priority-1 item starts while the waiting brake holds back other new work
      Given item "S" waits for an unanswered sign-off
      And item "N" waits for an unanswered question
      And item "R" is in review
      And items "B" and "P" are Queued, in that board order, with priorities 2 and 1
      When the scheduler ticks once
      Then item "P" is "InProgress"
      And item "B" is "Queued"

    @ac-7
    Scenario: A priority-1 item takes the next slot that frees up
      Given the factory has no free WIP slot
      And items "B" and "P" are Queued, in that board order, with priorities 3 and 1
      When the scheduler ticks once
      Then items "B" and "P" are "Queued"
      When a WIP slot frees up
      And the scheduler ticks once
      Then item "P" is "InProgress"
      And item "B" is "Queued"

    @ac-7
    Scenario: An item that a priority-1 item depends on starts while the waiting brake is on
      Given item "S" waits for an unanswered sign-off
      And item "N" waits for an unanswered question
      And item "R" is in review
      And item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And items "B" and "D" are Queued, in that board order, with priorities 2 and 4
      When the poller reads the board
      And the scheduler ticks once
      Then item "D" is "InProgress"
      And item "B" is "Queued"

    @ac-7
    Scenario: The brake is the only thing a priority-1 item gets past, not a hold
      Given item "S" waits for an unanswered sign-off
      And item "N" waits for an unanswered question
      And item "R" is in review
      And items "A" and "P" are Queued, in that board order, with priority 1
      And item "A" is on Hold
      When the scheduler ticks once
      Then item "P" is "InProgress"
      And item "A" is "Queued" and still on Hold

  Rule: Floor and the item page show each item's priority and whether it's final-stage, and name the item either comes from

    @ac-8
    Scenario: An item's page shows its priority and that it's final-stage
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 2
      When the operator opens item "A"'s page
      Then the page shows priority 2
      And the page shows item "A" is final-stage

    @ac-8
    Scenario: Floor shows each item's priority and which items are final-stage
      Given item "A" has an open PR and is InReview, with priority 2
      And items "B" and "C" are Queued, with priorities 4 and 3
      When the operator opens Floor
      Then Floor shows these items:
        | item | priority | final-stage |
        | A    | 2        | yes         |
        | B    | 4        | no          |
        | C    | 3        | no          |

    @ac-8
    Scenario: An item with no priority on the board shows priority 3
      Given item "A" is Queued with the Priority empty on the board
      When the poller reads the board
      And the operator opens item "A"'s page
      Then the page shows priority 3

    @ac-8
    Scenario: An item in the final-stage group because of a dependent says so and names it
      Given item "A" has an open PR and is InReview, with priority 1
      And item "A" depends on item "D" on the board
      And item "D" is Queued and has priority 5
      When the poller reads the board
      And the operator opens item "D"'s page
      Then the page shows item "D" is final-stage because item "A" depends on it
      And the page shows priority 1, from item "A"
      When the operator opens Floor
      Then Floor shows item "D" as final-stage because of item "A"
      And Floor shows item "D"'s priority as 1, from item "A"

    @ac-8
    Scenario: An item with a priority from a dependent says so and names it
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And item "D" is Queued and has priority 4
      When the poller reads the board
      And the operator opens item "D"'s page
      Then the page shows priority 1, from item "H"
      And the page doesn't show item "D" as final-stage
      When the operator opens Floor
      Then Floor shows item "D"'s priority as 1, from item "H"

    @ac-8
    Scenario: Once the dependency is gone, the page and Floor stop naming the dependent
      Given item "A" has an open PR and is InReview, with priority 1
      And item "A" depends on item "D" on the board
      And item "D" is Queued and has priority 5
      And the poller has read the board
      And item "D"'s page shows priority 1, from item "A"
      When someone removes item "A"'s dependency on item "D" on the board
      And the poller reads the board
      And the operator opens item "D"'s page
      Then the page shows priority 5
      And the page doesn't name item "A"
      When the operator opens Floor
      Then Floor shows item "D"'s priority as 5
      And Floor doesn't show item "D" as final-stage
