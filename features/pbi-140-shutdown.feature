@pbi-140
Feature: A dashboard Shutdown lets local cells wrap up for 15 minutes, then stops the rest
  An owner who wants to stop Docker or restart the factory needs the cells to stop cleanly first. Shutdown
  is a factory override on the dashboard's Controls. Once it is on, the scheduler starts nothing, and
  every live cell is told to stop at its next lease renewal, as a pause does. A cell stopped this way
  pushes its work-in-progress commit before it exits, so the next run carries on from it. The control
  plane keeps answering cells and the dashboard while they wrap up. When the wrap-up runs out,
  FACTORY_SHUTDOWN_WAIT_MINUTES (15 by default), the factory stops every cell still running. Once no cell
  runs, Floor says it's safe to stop Docker or restart the factory. Resume clears a shutdown, a restarted
  control plane clears one left from before, and the kill switch still stops every cell at once.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  The rest run the cell engine against a fake control plane, agent and repo.

  Rule: Shutdown is a factory override on the dashboard's Controls, and it needs a reason

    @ac-1 @db
    Scenario: An operator sees Shutdown among the factory's Controls
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator opens Floor
      Then the Controls offer Shutdown beside Pause, Drain, Resume and the kill switch

    @ac-1 @db
    Scenario: A shutdown with a reason is stored and logged as a factory override
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator shuts the factory down with the reason "restarting Docker"
      Then the factory holds an active factory override "shutdown" with the reason "restarting Docker"
      And the override records the operator who set it
      And the log records the factory override "shutdown"

    @ac-1 @db
    Scenario: A shutdown needs a reason, as every override does
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator shuts the factory down with the reason ""
      Then the dashboard answers 400
      And no override is recorded
      When the operator shuts the factory down with the reason "restarting Docker"
      Then the factory holds an active factory override "shutdown" with the reason "restarting Docker"

  Rule: During a shutdown the scheduler starts nothing, and Floor counts down the wrap-up

    @ac-2 @db
    Scenario: A queued item does not start during a shutdown
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "B" is queued
      And an operator shut the factory down 1 minute ago
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-2 @db
    Scenario: An answered item, which starts while the brake is on, does not start during a shutdown
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "S" waits for a sign-off that has been answered
      And an operator shut the factory down 1 minute ago
      When the scheduler ticks
      Then no cell starts

    @ac-2 @db
    Scenario: Floor shows "Shutting down" with the full wrap-up left when the shutdown starts
      Given the control plane is running with a fake board and FACTORY_SHUTDOWN_WAIT_MINUTES unset
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      When the operator shuts the factory down with the reason "restarting Docker"
      And the operator opens Floor
      Then Floor shows "Shutting down" with 15 minutes left in the wrap-up

    @ac-2 @db
    Scenario: The minutes left go down as the wrap-up runs
      Given the control plane is running with a fake board and FACTORY_SHUTDOWN_WAIT_MINUTES unset
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator shut the factory down 6 minutes ago
      When the operator opens Floor
      Then Floor shows "Shutting down" with 9 minutes left in the wrap-up

  Rule: Every live cell is told to stop at its next lease renewal, as a factory pause does

    @ac-3 @db
    Scenario: Every live cell's next renewal tells it to stop
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      When an operator shuts the factory down with the reason "restarting Docker"
      And cell "cell-a" renews its lease
      And cell "cell-d" renews its lease
      Then both renewals are answered and tell the cell to stop

    @ac-3 @db
    Scenario: Before a shutdown the same renewal tells the cell to carry on
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      When an operator shuts the factory down with the reason "restarting Docker"
      And cell "cell-a" renews its lease
      Then the renewal tells the cell to stop

    @ac-3 @db
    Scenario: The scheduler does not stop the cells itself while the wrap-up runs
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator shut the factory down 1 minute ago
      When the scheduler ticks
      Then no cell is stopped
      And cell "cell-a"'s next renewal tells it to stop

  Rule: A cell stopped by a shutdown pushes its work in progress, and a cell that lost its lease pushes nothing

    @ac-4
    Scenario: A cell told to stop by a shutdown commits and pushes its work in progress before it exits
      Given a run for item 482 that is at green with uncommitted changes
      When the cell's lease renewal tells it to stop for a shutdown
      Then the cell commits its changes as work in progress
      And the cell pushes that commit to the run's branch before it exits
      And the cell exits as stopped

    @ac-4
    Scenario: The next run for the item carries on from the pushed work in progress
      Given a run for item 482 that is at green with uncommitted changes
      And the cell's lease renewal told it to stop for a shutdown, and it exited
      When a new cell starts for item 482 and clones the run's branch
      Then the new cell's clone holds the work-in-progress commit the stopped cell pushed

    @ac-4 @regression
    Scenario: During a shutdown, a cell whose lease was lost pushes nothing
      Given a run for item 482 that is at green with uncommitted changes
      And the factory is shutting down
      When the cell's lease renewal says its lease was lost
      Then the cell pushes nothing
      And the cell exits as stopped

    @ac-4 @regression
    Scenario: A cell told to stop that finds its lease lost before it pushes pushes nothing
      Given a run for item 482 that is at green with uncommitted changes
      And the cell's lease renewal tells it to stop for a shutdown
      When the cell checks its lease before pushing and finds it lost
      Then the cell pushes nothing
      And the cell exits as stopped

  Rule: The control plane keeps answering cells and the dashboard during a shutdown

    @ac-5 @db
    Scenario: A cell that is wrapping up can renew, push its branch and report how its stage ended
      Given the control plane is running with a fake board
      And item "A" is running in cell "cell-a" with a live lease
      And an operator shut the factory down 2 minutes ago
      When cell "cell-a" renews its lease
      Then the cell API answers the renewal and tells the cell to stop
      When cell "cell-a" asks for what it needs to push its branch
      Then the cell API answers it
      When cell "cell-a" reports that its stage ended stopped
      Then the cell API accepts the report
      And item "A"'s run records the stage as stopped

    @ac-5 @db
    Scenario: The dashboard keeps answering during a shutdown
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator shut the factory down 2 minutes ago
      When the operator opens Floor
      Then the dashboard answers 200 with "Shutting down"
      When the operator opens item "A"'s Run detail
      Then the dashboard answers 200

  Rule: When the wrap-up runs out, the factory stops every cell still running

    @ac-6 @db
    Scenario Outline: The wrap-up lasts FACTORY_SHUTDOWN_WAIT_MINUTES, 15 by default
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And FACTORY_SHUTDOWN_WAIT_MINUTES is <setting>
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And an operator shut the factory down <before> minutes ago
      When the scheduler ticks
      Then no cell is stopped
      When <wait> minutes have passed since the shutdown and the scheduler ticks
      Then cells "cell-a" and "cell-d" are stopped with the launcher's stop

      Examples:
        | setting | before | wait |
        | unset   | 14     | 15   |
        | 5       | 4      | 5    |

    @ac-6 @db
    Scenario: Only the cells still running are stopped when the wrap-up runs out
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And an operator shut the factory down 15 minutes ago
      And cell "cell-a" wrapped up and exited during the shutdown
      When the scheduler ticks
      Then cell "cell-d" is stopped with the launcher's stop
      And cell "cell-a" is not stopped

    @ac-6 @db
    Scenario: A cell whose stop fails does not keep the others running
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the launcher fails to stop cell "cell-a"
      And an operator shut the factory down 15 minutes ago
      When the scheduler ticks
      Then cell "cell-d" is stopped with the launcher's stop
      And the log records that stopping cell "cell-a" failed

  Rule: Once no cell is running, Floor says it's safe to stop, and the scheduler still starts nothing

    @ac-7 @db
    Scenario: After the wrap-up stops the last cells, Floor says it's safe to stop
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And the operator shut the factory down 15 minutes ago
      When the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Shut down. It's safe to stop Docker or restart the factory."
      And Floor does not show "Shutting down"
      And no cell starts
      And item "B" is "Queued"

    @ac-7 @db
    Scenario: When every cell wraps up early, Floor says so before the wrap-up runs out
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator shut the factory down 3 minutes ago
      And cell "cell-a" wrapped up and exited during the shutdown
      When the operator opens Floor
      Then Floor shows "Shut down. It's safe to stop Docker or restart the factory."

    @ac-7 @db
    Scenario: A shutdown with no cell running is shut down at once
      Given the control plane is running with a fake board
      And an operator is signed in
      And no cell is running
      When the operator shuts the factory down with the reason "restarting Docker"
      And the operator opens Floor
      Then Floor shows "Shut down. It's safe to stop Docker or restart the factory."

    @ac-7 @db
    Scenario: The scheduler starts nothing long after the shutdown completed
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "B" is queued
      And an operator shut the factory down 2 hours ago, and no cell is running
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

  Rule: Resume clears a shutdown, as it clears pause, drain and kill

    @ac-8 @db
    Scenario: Resume during the wrap-up clears the shutdown and work starts again
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "B" is queued
      And the operator shut the factory down 2 minutes ago
      When the operator resumes the factory with the reason "changed my mind"
      And the scheduler ticks
      Then the shutdown is cleared, recording the operator who cleared it
      And Floor does not show "Shutting down"
      And a cell starts for item "B"

    @ac-8 @db
    Scenario: Resume after the factory shut down clears it, and a running cell is no longer told to stop
      Given the control plane is running with a fake board
      And an operator is signed in
      And the operator shut the factory down 20 minutes ago, and no cell is running
      When the operator resumes the factory with the reason "Docker is back"
      Then the shutdown is cleared, recording the operator who cleared it
      And Floor does not show "Shut down. It's safe to stop Docker or restart the factory."
      When item "A" starts in cell "cell-a" and renews its lease
      Then the renewal tells the cell to carry on

    @ac-8 @db
    Scenario: Resume clears a shutdown and a pause together
      Given the control plane is running with a fake board
      And an operator is signed in
      And the operator paused the factory with the reason "looking"
      And the operator shut the factory down 1 minute ago
      When the operator resumes the factory with the reason "all clear"
      Then the factory holds no active pause, drain, kill or shutdown

  Rule: A starting control plane clears a shutdown left from before, so a restarted factory runs

    @ac-9 @db
    Scenario: A restarted control plane clears the old shutdown and starts work
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator shut the factory down 20 minutes ago, and no cell is running
      And item "B" is queued
      When the control plane starts
      And the scheduler ticks
      Then the shutdown left from before is cleared
      And a cell starts for item "B"

    @ac-9 @db
    Scenario: An item the shutdown stopped carries on like any item whose lease ran out
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" was running at green in cell "cell-a" when the shutdown stopped it
      And item "A"'s lease has since run out
      When the control plane starts
      And the scheduler ticks
      Then the shutdown left from before is cleared
      And a cell starts for item "A"
      And item "A"'s run resumes from "green"

    @ac-9 @db
    Scenario: A restart clears a shutdown but keeps a pause set before it
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator paused the factory with the reason "looking"
      And an operator shut the factory down 20 minutes ago, and no cell is running
      And item "B" is queued
      When the control plane starts
      And the scheduler ticks
      Then the shutdown left from before is cleared
      And the pause is still active
      And no cell starts

  Rule: The kill switch still stops every cell at once during a shutdown

    @ac-10 @db
    Scenario: The kill switch during the wrap-up stops every cell at once, and the factory is shut down
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the operator shut the factory down 2 minutes ago
      When the operator turns on the kill switch and the scheduler ticks
      Then cells "cell-a" and "cell-d" are stopped with the launcher's stop
      And no cell starts
      When the operator opens Floor
      Then Floor shows "Shut down. It's safe to stop Docker or restart the factory."
