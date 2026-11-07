@pbi-17 @db
Feature: Scheduler, launcher and overrides
  Every 15 seconds the scheduler decides which PBI starts next. It starts a cell only when a slot under the
  WIP limit is free, holds new work back while too many items wait on a person, and never lets an answer
  wait behind that brake. Operators steer it with overrides: the kill switch stops every running cell, and
  stopping a run holds its item until someone re-queues it.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given a fresh factory database with WIP 1 and a review capacity of 3

  @ac-1
  Scenario: While one item runs under WIP 1, nothing new starts
    Given item "A" is running in cell "cell-a" with a live lease
    And item "B" is queued
    When the scheduler ticks
    Then no cell starts
    And item "B" is "Queued"

  @ac-1
  Scenario: When the running item's lease runs out, the next tick starts one cell
    Given item "A" is running in cell "cell-a" with a lease that ran out
    And item "B" is queued
    When the scheduler ticks
    Then item "A" has left "InProgress"
    And exactly one cell starts

  @ac-1
  Scenario: A restarted scheduler starts no second cell for an item still running
    Given item "A" is running in cell "cell-a" with a live lease
    When a newly started scheduler process ticks
    Then no cell starts

  @ac-2
  Scenario: With three items waiting on a person, no queued item starts
    Given item "S" waits for an unanswered sign-off
    And item "N" waits for an unanswered question
    And item "R" is in review
    And item "B" is queued
    When the scheduler ticks
    Then no cell starts

  @ac-2
  Scenario: An answered item still starts while the brake is on
    Given item "S" waits for a sign-off that has been answered
    And item "N" waits for an unanswered question
    And item "R" is in review
    And item "X" waits for an unanswered sign-off
    And item "B" is queued
    When the scheduler ticks
    Then a cell starts for item "S"
    And item "B" is "Queued"

  @ac-2
  Scenario: An item back from requested changes starts ahead of new work while the brake is on
    Given item "S" waits for an unanswered sign-off
    And item "N" waits for an unanswered question
    And item "R" is in review
    And item "B" is queued and ranked first
    And item "C" is queued to address requested changes
    When the scheduler ticks
    Then a cell starts for item "C"
    And item "B" is "Queued"

  @ac-2
  Scenario: When a waiting item times out, the count drops and a queued item starts
    Given item "S" waits for an unanswered sign-off asked 6 days ago
    And item "N" waits for an unanswered question
    And item "R" is in review
    And item "B" is queued
    When the scheduler ticks
    Then item "S" is "Abandoned"
    And a cell starts for item "B"

  @ac-3
  Scenario Outline: The kill switch stops every running cell and starts nothing
    Given item "A" is running in cell "cell-a" with a live lease
    And item "D" is running in cell "cell-d" with a live lease
    And item "B" is queued
    When <switch> and the scheduler ticks
    Then cells "cell-a" and "cell-d" are stopped
    And no cell starts

    Examples:
      | switch                                          |
      | an operator turns on the kill switch            |
      | the control plane starts with its kill flag set |

  @ac-4
  Scenario: Stopping a run holds the item, and re-queueing it clears the hold
    Given item "A" is running in cell "cell-a" with a live lease
    When an operator stops item "A"'s run and the scheduler ticks
    Then cell "cell-a" is stopped
    And item "A" is "Failed" and held
    When an operator re-queues item "A" and the scheduler ticks
    Then item "A" is no longer held
    And a cell starts for item "A"

  @ac-4
  Scenario: A held item never starts
    Given item "B" is queued
    And an operator holds item "B"
    When the scheduler ticks
    Then no cell starts
