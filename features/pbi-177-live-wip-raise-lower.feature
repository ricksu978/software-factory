@pbi-177 @db
Feature: The scheduler honours a live raise or lower of current WIP
  An operator can change current WIP while the factory runs, with no restart. When WIP goes up, the scheduler
  fills the new slots quickly: raising WIP from 1 to 3 with three items queued and nobody's review holding work
  back starts all three within two scheduler turns, and never more than the new limit. When WIP goes down below
  the number of items already running, the scheduler starts nothing new, and it never stops a running cell to
  get under the limit. Running items finish, and new work starts only once there is room (spec §7, Damping).
  Today the scheduler already starts nothing while the running count is at or over the limit, and it never stops
  a cell for it. So the scenarios for lowering WIP are tagged @regression and pass before the build. They guard
  that behaviour while the scheduler learns to fill more than one slot at a time.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given a fresh factory database with WIP minimum 1, WIP maximum 3, current WIP 1 and a review capacity of 3

  Rule: Raising current WIP starts queued work up to the new limit within two scheduler turns

    @ac-1
    Scenario: Raising WIP from 1 to 3 starts all three queued items within two turns
      Given item "A" is queued
      And item "B" is queued
      And item "C" is queued
      And no item waits on a person
      When an operator changes current WIP from 1 to 3 while the scheduler keeps running
      And the scheduler ticks
      And the scheduler ticks again
      Then items "A", "B" and "C" are "InProgress"
      And exactly three cells have started, one for each of "A", "B" and "C"

    @ac-1
    Scenario: Raising WIP from 1 to 3 with four items queued starts three and leaves the last one queued
      Given item "A" is queued
      And item "B" is queued
      And item "C" is queued
      And item "D" is queued behind them
      And no item waits on a person
      When an operator changes current WIP from 1 to 3 while the scheduler keeps running
      And the scheduler ticks
      And the scheduler ticks again
      Then items "A", "B" and "C" are "InProgress"
      And exactly three cells have started, one for each of "A", "B" and "C"
      And item "D" is "Queued"

  Rule: Lowering current WIP below the running count stops new starts and never stops a running cell

    @ac-2 @regression
    Scenario: Lowering WIP from 3 to 1 with three items running starts nothing and stops nothing
      Given current WIP is 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is running in cell "cell-b" with a live lease
      And item "C" is running in cell "cell-c" with a live lease
      And item "D" is queued
      When an operator changes current WIP from 3 to 1 while the scheduler keeps running
      And the scheduler ticks
      And the scheduler ticks again
      Then no cell starts
      And no cell is stopped
      And items "A", "B" and "C" are "InProgress"
      And item "D" is "Queued"

    @ac-2 @regression
    Scenario: After WIP is lowered, one running item leaving doesn't free a slot while the rest are still over the limit
      Given current WIP is 3
      And item "A" is running in cell "cell-a" with a lease that ran out
      And item "B" is running in cell "cell-b" with a live lease
      And item "C" is running in cell "cell-c" with a live lease
      And item "D" is queued
      When an operator changes current WIP from 3 to 1 while the scheduler keeps running
      And the scheduler ticks
      Then item "A" has left "InProgress"
      And no cell starts
      And cells "cell-b" and "cell-c" are not stopped
      And items "B" and "C" are "InProgress"
      And item "D" is "Queued"
