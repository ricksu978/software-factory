@pbi-300 @db
Feature: Prepare restart starts no cell and stops none, and a control plane or worker restart clears it
  While a restart is being prepared, the factory starts nothing and stops nothing. Each live cell is still
  told to stop at its next lease renewal, as before, but the factory never stops a cell itself, however long
  it runs. FACTORY_RESTART_WAIT_MINUTES no longer ends a wrap-up by stopping the cells still running.
  No cell starts while the restart is being prepared. That holds after an operator raises current WIP on
  the Configuration page, and for an answered item, which would otherwise start even under the waiting
  brake. Restarting the control plane or the worker clears the restart, as it does today, and the factory
  starts cells again up to current WIP.
  The scheduler already starts nothing while a restart is being prepared, and a starting control plane or
  worker already clears the restart. So the scenarios for those criteria are tagged @regression and pass
  before the build. They make sure taking away the stop doesn't let work start.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: While a restart is being prepared, the factory never stops a cell, however long it runs

    @ac-1
    Scenario Outline: The cells keep running after FACTORY_RESTART_WAIT_MINUTES has passed
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And FACTORY_RESTART_WAIT_MINUTES is <setting>
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And an operator prepared a restart <ago> minutes ago
      When the scheduler ticks
      Then no cell is stopped
      And items "A" and "D" are "InProgress"

      Examples:
        | setting | ago |
        | unset   | 15  |
        | unset   | 16  |
        | 5       | 5   |
        | 0       | 1   |

    @ac-1
    Scenario: A cell still running hours after the restart was prepared isn't stopped, and its attempt stays open
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator prepared a restart 3 hours ago
      When the scheduler ticks
      Then no cell is stopped
      And item "A" is "InProgress"
      And item "A"'s green attempt is still open, not recorded as stopped

    @ac-1
    Scenario: Tick after tick through the old wrap-up and past it, the scheduler stops no cell
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And FACTORY_RESTART_WAIT_MINUTES is unset
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 1 minute ago
      When the scheduler ticks every minute until 60 minutes have passed since the restart was prepared, while cell "cell-a" keeps renewing its lease
      Then the launcher was never asked to stop a cell
      And item "A" is "InProgress"

  Rule: While a restart is being prepared, no cell starts

    @ac-2 @regression
    Scenario: A queued item doesn't start while a restart is being prepared, long after the old wrap-up ended
      Given a fresh factory database with WIP 3 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And an operator prepared a restart 2 hours ago
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-2 @regression
    Scenario: Raising current WIP on the Configuration page starts nothing while a restart is being prepared
      Given a fresh factory database with WIP minimum 1, WIP maximum 3, current WIP 1 and a review capacity of 3
      And "octo" is an operator
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And item "C" is queued
      And an operator prepared a restart 1 minute ago
      When "octo" changes current WIP to "3" on the Configuration page, giving the reason "Let the queued items start."
      And the scheduler ticks
      And the scheduler ticks again
      Then the factory's WIP policy has current WIP set to 3
      And no cell starts
      And items "B" and "C" are "Queued"

    @ac-2 @regression
    Scenario: An answered item that would start under the waiting brake doesn't start while a restart is being prepared
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "S" waits for a sign-off that has been answered
      And item "N" waits for an unanswered question
      And item "R" is in review
      And item "X" waits for an unanswered sign-off
      And an operator prepared a restart 1 minute ago
      When the scheduler ticks
      Then no cell starts
      And no cell starts for item "S"

  Rule: Restarting the control plane or the worker clears the restart, and cells start again up to current WIP

    @ac-3 @regression
    Scenario Outline: A restarted <process> clears the restart and starts queued items up to current WIP
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator prepared a restart 20 minutes ago, and no cell is running
      And item "B" is queued
      And item "C" is queued
      And item "D" is queued behind them
      When the <process> starts
      And the scheduler ticks
      Then the restart override left from before is cleared
      And cells start for items "B" and "C"
      And item "D" is "Queued"

      Examples:
        | process       |
        | control plane |
        | worker        |

    @ac-3 @regression
    Scenario: A cell still running from before the restart counts against current WIP once the worker restarts
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 5 minutes ago
      And item "B" is queued
      And item "C" is queued behind it
      When the worker starts
      And the scheduler ticks
      Then the restart override left from before is cleared
      And exactly one cell starts, for item "B"
      And cell "cell-a" is not stopped
      And item "C" is "Queued"

    @ac-3 @regression
    Scenario: A restarted worker clears the restart but keeps a pause set before it
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator paused the factory with the reason "looking"
      And an operator prepared a restart 20 minutes ago, and no cell is running
      And item "B" is queued
      When the worker starts
      And the scheduler ticks
      Then the restart override left from before is cleared
      And the pause is still active
      And no cell starts
