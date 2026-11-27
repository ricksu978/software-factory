@pbi-265
Feature: The dashboard can start an item next, or move it up or down the factory queue, without touching the board
  Spec §8 lists three selection overrides for an item that the dashboard doesn't offer yet: Start now, which
  takes the next free slot ahead of backlog order, and Move up and Move down, which change an item's place in
  the factory queue without changing the board's own order. With this item, an operator finds all three among
  the Controls on an item's page in Run detail. Each one needs a reason, and each is logged as an item override
  with the person who set it, as Hold is.
  Start now goes ahead of every other item, including one whose question has been answered, which today always
  comes first. None of the three gets past the readiness gate, a hold or an open blocker. A Start now item that
  isn't ready waits until it passes readiness, and is claimed first from then on. Floor's "Production Line" uses the
  claim order, so it shows a change as soon as the operator makes it. Like every item override, each one ends
  when the item reaches Done, Failed, Abandoned or Split (spec §8, Expiry).
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub and the cells are fakes, and the factory has one free WIP slot unless a scenario says otherwise.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in

  Rule: An item that can still be picked up has a Start now control, and the next free slot claims it ahead of every other item

    @ac-1
    Scenario Outline: A <state> item's page offers Start now
      Given item "A" is <state>
      When the operator opens item "A"'s page
      Then the page's Controls offer "Start now", with a box for the reason

      Examples:
        | state                                    |
        | Eligible                                 |
        | NotReady                                 |
        | Queued                                   |
        | in NeedsInput with its question answered |
        | in SignOff with its sign-off answered    |

    @ac-1
    Scenario Outline: A <state> item's page offers no Start now
      Given item "A" is <state>
      And item "B" is Queued
      When the operator opens item "A"'s page
      And the operator opens item "B"'s page
      Then item "B"'s page offers "Start now"
      And item "A"'s page doesn't offer "Start now"

      Examples:
        | state                                       |
        | InProgress                                  |
        | InReview                                    |
        | in NeedsInput with its question unanswered  |
        | Done                                        |
        | Failed                                      |

    @ac-1
    Scenario: A Queued item started now is claimed ahead of the items above it on the board
      Given items "B", "C" and "A" are Queued, in that board order
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And items "B" and "C" are "Queued"

    @ac-1
    Scenario: An item started now is claimed ahead of an item whose question was answered
      Given item "B" is in NeedsInput with its question answered
      And item "A" is Queued
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "B" is still in NeedsInput with its question answered

    @ac-1
    Scenario: An answered item started now is claimed ahead of another answered item that was answered first
      Given item "B" is in NeedsInput with its question answered 2 hours ago
      And item "A" is in SignOff with its sign-off answered 1 minute ago
      And item "C" is Queued
      And the board orders the items "B", "C", "A"
      When the operator presses "Start now" on item "A" with the reason "unblocks the release"
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "B" is still in NeedsInput with its question answered
      And item "C" is "Queued"

    @ac-1
    Scenario: An Eligible item started now is claimed first once the readiness gate passes it
      Given item "B" is Queued
      And item "A" is Eligible, below item "B" on the board
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the readiness gate passes item "A"
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "B" is "Queued"

  Rule: Move up and Move down change an item's place in the factory queue and leave the board's order as it is

    @ac-2
    Scenario: Move up puts an item one place earlier in the factory queue
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      Then Floor's "Production Line" lists "A", "C", "B" to claim, in that order
      And the board still orders the items "A", "B", "C"
      And the factory asked the board to reorder nothing

    @ac-2
    Scenario: Move down puts an item one place later in the factory queue
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move down" on item "A" with the reason "waiting on a design review"
      Then Floor's "Production Line" lists "B", "A", "C" to claim, in that order
      And the board still orders the items "A", "B", "C"
      And the factory asked the board to reorder nothing

    @ac-2
    Scenario: Two moves up take an item two places earlier
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      And the operator presses "Move up" on item "C" with the reason "really, first"
      Then Floor's "Production Line" lists "C", "A", "B" to claim, in that order
      And the board still orders the items "A", "B", "C"

    @ac-2
    Scenario: The next free slot claims by the moved order
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move up" on item "B" with the reason "smaller, so it goes first"
      And the scheduler ticks once
      Then item "B" is "InProgress"
      And items "A" and "C" are "Queued"

    @ac-2
    Scenario: A board poll that finds the board unchanged keeps the moved order
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      And the poller reads the board, still ordered "A", "B", "C"
      Then Floor's "Production Line" lists "A", "C", "B" to claim, in that order

    @ac-2
    Scenario: An item's page offers Move up and Move down
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator opens item "B"'s page
      Then the page's Controls offer "Move up" and "Move down", each with a box for the reason

  Rule: Each of these controls is logged as an item override, with the person and the reason, like Hold

    @ac-3
    Scenario Outline: <control> is logged as an item override with who set it and why
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "<control>" on item "B" with the reason "<reason>"
      Then item "B" has an active "<control>" override
      And the override records "octo" as the person who set it
      And the override records the reason "<reason>"

      Examples:
        | control   | reason                     |
        | Start now | customer demo on Friday    |
        | Move up   | smaller, so it goes first  |
        | Move down | waiting on a design review |

    @ac-3
    Scenario Outline: <control> with no reason is turned down, and with a reason it goes through
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "<control>" on item "B" with the reason "   "
      Then the dashboard answers 400
      And item "B" has no "<control>" override
      And Floor's "Production Line" lists "A", "B", "C" to claim, in that order
      When the operator presses "<control>" on item "B" with the reason "<reason>"
      Then item "B" has an active "<control>" override
      And Floor's "Production Line" lists <order> to claim, in that order

      Examples:
        | control   | reason                     | order           |
        | Start now | customer demo on Friday    | "B", "A", "C"   |
        | Move up   | smaller, so it goes first  | "B", "A", "C"   |
        | Move down | waiting on a design review | "A", "C", "B"   |

    @ac-3
    Scenario: A viewer sees an item's Start now override but can't set one
      Given items "A" and "B" are Queued, in that board order
      And the operator pressed "Start now" on item "B" with the reason "customer demo on Friday"
      When "vera", a viewer, opens item "B"'s page
      Then the page shows item "B" is marked "Start now"
      And the page offers no "Start now", "Move up" or "Move down" control

  Rule: Floor's "Production Line" shows the new order as soon as the operator changes it

    @ac-4
    Scenario: Production Line puts an item started now first, before the scheduler ticks
      Given items "A", "B", "C" and "D" are Queued, in that board order
      When the operator presses "Start now" on item "D" with the reason "customer demo on Friday"
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Production Line" lists "D", "A", "B", "C" to claim, in that order

    @ac-4
    Scenario: Production Line puts an item started now ahead of an answered item
      Given item "B" is in NeedsInput with its question answered
      And item "A" is Queued
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Production Line" lists "A", "B" to claim, in that order

    @ac-4
    Scenario: Production Line shows a move down before the scheduler ticks
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Move down" on item "A" with the reason "waiting on a design review"
      And the operator opens Floor before the scheduler ticks
      Then Floor's "Production Line" lists "B", "A", "C" to claim, in that order

  Rule: Start now, Move up and Move down never get an item past the readiness gate, a hold or an open blocker

    @ac-5
    Scenario: A NotReady item started now stays out of the queue until it passes readiness, then goes first
      Given items "B" and "C" are Queued, and item "A" is NotReady, in the board order "B", "C", "A"
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the readiness gate turns item "A" away again
      And the scheduler ticks once
      Then item "A" is "NotReady"
      And item "B" is "InProgress"
      When the item's author fixes item "A" and the readiness gate passes it
      And a WIP slot frees up
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "C" is "Queued"

    @ac-5
    Scenario: A held item started now isn't claimed until its hold is released, and then goes first
      Given items "B", "C" and "A" are Queued, in that board order
      And item "A" is on Hold
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the scheduler ticks once
      Then item "A" is "Queued" and still on Hold
      And item "B" is "InProgress"
      And Floor's "Production Line" doesn't list "A" to claim
      When the operator releases the hold on item "A"
      And a WIP slot frees up
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "C" is "Queued"

    @ac-5
    Scenario: An item started now with an open blocker isn't claimed until the blocker closes, and then goes first
      Given items "B", "C" and "A" are Queued, in that board order
      And item "A" is blocked by an open issue
      When the operator presses "Start now" on item "A" with the reason "customer demo on Friday"
      And the scheduler ticks once
      Then item "A" is "Queued"
      And item "B" is "InProgress"
      And Floor's "Production Line" doesn't list "A" to claim
      When the issue blocking item "A" closes and the poller reads it
      And a WIP slot frees up
      And the scheduler ticks once
      Then item "A" is "InProgress"
      And item "C" is "Queued"

    @ac-5
    Scenario: A held item moved up stays out of the items to claim until its hold is released, then takes its new place
      Given items "A", "B" and "C" are Queued, in that board order
      And item "C" is on Hold
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      Then Floor's "Production Line" lists "A", "B" to claim, in that order
      When the operator releases the hold on item "C"
      And the scheduler ticks once with no free WIP slot
      Then Floor's "Production Line" lists "A", "C", "B" to claim, in that order

  Rule: Each of these overrides ends when the item reaches Done, Failed, Abandoned or Split

    @ac-6
    Scenario Outline: An item's Start now ends when it reaches <state>
      Given items "A" and "B" are Queued, in that board order
      When the operator presses "Start now" on item "B" with the reason "customer demo on Friday"
      Then item "B"'s page shows it is marked "Start now"
      When item "B" reaches <state>
      And the scheduler ticks once
      Then item "B" has no active "Start now" override
      And the override records when it ended
      And item "B"'s page no longer shows it is marked "Start now"

      Examples:
        | state     |
        | Done      |
        | Failed    |
        | Abandoned |
        | Split     |

    @ac-6
    Scenario Outline: An item's <control> ends when it reaches Failed
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "<control>" on item "B" with the reason "<reason>"
      Then item "B" has an active "<control>" override
      When item "B" reaches Failed
      And the scheduler ticks once
      Then item "B" has no active "<control>" override
      And the override records when it ended

      Examples:
        | control   | reason                     |
        | Move up   | smaller, so it goes first  |
        | Move down | waiting on a design review |

    @ac-6
    Scenario: A Failed item that was started now goes back to its board place when it's re-queued
      Given items "A", "B" and "C" are Queued, in that board order
      When the operator presses "Start now" on item "C" with the reason "customer demo on Friday"
      Then Floor's "Production Line" lists "C", "A", "B" to claim, in that order
      When item "C" reaches Failed
      And the scheduler ticks once
      And the operator re-queues item "C" with the reason "try again"
      And the scheduler ticks once with no free WIP slot
      Then Floor's "Production Line" lists "A", "B", "C" to claim, in that order
