@pbi-140
Feature: Prepare restart lets local cells wrap up for 15 minutes, so each item resumes where it stopped
  An owner who wants to restart the factory or stop Docker needs the cells to stop cleanly first. Prepare
  restart is a factory override on the dashboard's Controls, and like every override it needs a reason.
  While a restart is being prepared, the scheduler starts nothing, and every live cell is told to stop at
  its next lease renewal, as a pause does. A cell stopped this way pushes its work-in-progress commit
  before it exits. The cell API keeps answering, so a cell that is wrapping up can renew, push and
  report. When the wrap-up runs out, after FACTORY_RESTART_WAIT_MINUTES (15 by default), the factory
  stops every cell still running. Once no cell runs, Floor says it's safe to restart. A control plane that
  starts clears a restart override left from before, and so does Resume. After the restart, each item
  carries on at the stage it was in, from the commit it pushed. An attempt cut short by the restart is
  recorded as stopped and doesn't use up any of that stage's retries.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  The rest run the cell engine against a fake control plane, agent and repo.

  Rule: Prepare restart is a factory override on the dashboard's Controls, and it needs a reason

    @ac-1 @db
    Scenario: An operator sees Prepare restart among the factory's Controls
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator opens Floor
      Then the Controls offer Prepare restart beside Pause, Drain, Resume and the kill switch

    @ac-1 @db
    Scenario: Preparing a restart with a reason is stored and logged as a factory override
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator prepares a restart with the reason "upgrading Docker"
      Then the factory holds an active factory override "restart" with the reason "upgrading Docker"
      And the override records the operator who set it
      And the log records the factory override "restart"

    @ac-1 @db
    Scenario: Preparing a restart needs a reason, as every override does
      Given the control plane is running with a fake board
      And an operator is signed in
      When the operator prepares a restart with the reason ""
      Then the dashboard answers 400
      And no override is recorded
      When the operator prepares a restart with the reason "upgrading Docker"
      Then the factory holds an active factory override "restart" with the reason "upgrading Docker"

  Rule: While a restart is being prepared, the scheduler starts no cell, and Floor counts down the wrap-up

    @ac-2 @db
    Scenario: A queued item doesn't start while a restart is being prepared
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "B" is queued
      And an operator prepared a restart 1 minute ago
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-2 @db
    Scenario: An answered item, which starts even while the waiting brake is on, doesn't start while a restart is being prepared
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "S" waits for a sign-off that has been answered
      And an operator prepared a restart 1 minute ago
      When the scheduler ticks
      Then no cell starts

    @ac-2 @db
    Scenario: Floor shows "Preparing to restart" with the whole wrap-up left once the restart is prepared
      Given the control plane is running with a fake board and FACTORY_RESTART_WAIT_MINUTES unset
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      When the operator prepares a restart with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Preparing to restart" with 15 minutes left in the wrap-up

    @ac-2 @db
    Scenario: The minutes left go down as the wrap-up runs
      Given the control plane is running with a fake board and FACTORY_RESTART_WAIT_MINUTES unset
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 6 minutes ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart" with 9 minutes left in the wrap-up

  Rule: Every live cell is told to stop at its next lease renewal, and the cell API keeps answering it

    @ac-3 @db
    Scenario: Every live cell's next renewal tells it to stop
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      When an operator prepares a restart with the reason "upgrading Docker"
      And cell "cell-a" renews its lease
      And cell "cell-d" renews its lease
      Then both renewals are answered and tell the cell to stop

    @ac-3 @db
    Scenario: The same renewal told the cell to carry on before the restart was prepared
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      When an operator prepares a restart with the reason "upgrading Docker"
      And cell "cell-a" renews its lease
      Then the renewal tells the cell to stop

    @ac-3 @db
    Scenario: A cell that is wrapping up can renew, push its branch and report that its stage stopped
      Given the control plane is running with a fake board
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 2 minutes ago
      When cell "cell-a" renews its lease
      Then the cell API answers the renewal and tells the cell to stop
      When cell "cell-a" asks for what it needs to push its branch
      Then the cell API answers it
      When cell "cell-a" reports that its green attempt stopped
      Then the cell API accepts the report
      And item "A"'s run records that green attempt as stopped

    @ac-3 @db
    Scenario: The scheduler doesn't stop the cells itself before the wrap-up runs out
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 1 minute ago
      When the scheduler ticks
      Then no cell is stopped
      And cell "cell-a"'s next renewal tells it to stop

  Rule: A cell stopped for a restart pushes its work in progress, and a cell that lost its lease pushes nothing

    @ac-4
    Scenario: A cell told to stop for a restart commits and pushes its work in progress before it exits
      Given a run for item 482 that is at green with uncommitted changes
      When the cell's lease renewal tells it to stop for a restart
      Then the cell commits its changes as work in progress
      And the cell pushes that commit to the run's branch before it exits
      And the cell exits as stopped

    @ac-4
    Scenario: A cell told to stop for a restart with nothing uncommitted still pushes its branch
      Given a run for item 482 that is at green with a commit it hasn't pushed and no uncommitted changes
      When the cell's lease renewal tells it to stop for a restart
      Then the run's branch holds that commit before the cell exits
      And the cell exits as stopped

    @ac-4 @regression
    Scenario: While a restart is being prepared, a cell whose lease was lost pushes nothing
      Given a run for item 482 that is at green with uncommitted changes
      And the factory is preparing to restart
      When the cell's lease renewal says its lease was lost
      Then the cell pushes nothing
      And the cell exits as stopped

    @ac-4 @regression
    Scenario: A cell told to stop that finds its lease lost before it pushes pushes nothing
      Given a run for item 482 that is at green with uncommitted changes
      And the cell's lease renewal tells it to stop for a restart
      When the cell checks its lease before pushing and finds it lost
      Then the cell pushes nothing
      And the cell exits as stopped

  Rule: When the wrap-up runs out, the factory stops every cell still running

    @ac-5 @db
    Scenario Outline: The wrap-up lasts FACTORY_RESTART_WAIT_MINUTES, 15 by default
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And FACTORY_RESTART_WAIT_MINUTES is <setting>
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And an operator prepared a restart <before> minutes ago
      When the scheduler ticks
      Then no cell is stopped
      When <wait> minutes have passed since the restart was prepared and the scheduler ticks
      Then cells "cell-a" and "cell-d" are stopped with the launcher's stop

      Examples:
        | setting | before | wait |
        | unset   | 14     | 15   |
        | 5       | 4      | 5    |

    @ac-5 @db
    Scenario: Only the cells still running are stopped when the wrap-up runs out
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And an operator prepared a restart 15 minutes ago
      And cell "cell-a" wrapped up and exited during the wrap-up
      When the scheduler ticks
      Then cell "cell-d" is stopped with the launcher's stop
      And cell "cell-a" is not stopped

    @ac-5 @db
    Scenario: A cell whose stop fails doesn't keep the others running
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the launcher fails to stop cell "cell-a"
      And an operator prepared a restart 15 minutes ago
      When the scheduler ticks
      Then cell "cell-d" is stopped with the launcher's stop
      And the log records that stopping cell "cell-a" failed

  Rule: Once no cell is running, Floor says it's safe to restart, and the scheduler still starts nothing

    @ac-6 @db
    Scenario: After the wrap-up stops the last cells, Floor says it's ready to restart
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And the operator prepared a restart 15 minutes ago
      When the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."
      And Floor doesn't show "Preparing to restart"
      And no cell starts
      And item "B" is "Queued"

    @ac-6 @db
    Scenario: When every cell wraps up early, Floor says so before the wrap-up runs out
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 3 minutes ago
      And cell "cell-a" wrapped up and exited during the wrap-up
      When the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."

    @ac-6 @db
    Scenario: Preparing a restart with no cell running is ready at once
      Given the control plane is running with a fake board
      And an operator is signed in
      And no cell is running
      When the operator prepares a restart with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."

    @ac-6 @db
    Scenario: The scheduler starts nothing long after the factory became ready to restart
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "B" is queued
      And an operator prepared a restart 2 hours ago, and no cell is running
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

  Rule: A starting control plane clears a restart override left from before, and so does Resume

    @ac-7 @db
    Scenario: A restarted control plane clears the old restart override and starts work
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator prepared a restart 20 minutes ago, and no cell is running
      And item "B" is queued
      When the control plane starts
      And the scheduler ticks
      Then the restart override left from before is cleared
      And a cell starts for item "B"

    @ac-7 @db
    Scenario: A restarted control plane clears a restart override but keeps a pause set before it
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And an operator paused the factory with the reason "looking"
      And an operator prepared a restart 20 minutes ago, and no cell is running
      And item "B" is queued
      When the control plane starts
      And the scheduler ticks
      Then the restart override left from before is cleared
      And the pause is still active
      And no cell starts

    @ac-7 @db
    Scenario: Resume during the wrap-up clears the restart override and work starts again
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "B" is queued
      And the operator prepared a restart 2 minutes ago
      When the operator resumes the factory with the reason "changed my mind"
      And the scheduler ticks
      Then the restart override is cleared, recording the operator who cleared it
      And Floor doesn't show "Preparing to restart"
      And a cell starts for item "B"

    @ac-7 @db
    Scenario: After Resume, a running cell's renewal tells it to carry on
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 1 minute ago
      When the operator resumes the factory with the reason "changed my mind"
      And cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on

  Rule: After the restart, an item a wrap-up stopped resumes at its stage, from the commit it pushed

    @ac-8 @db
    Scenario Outline: An item stopped at <stage> resumes at <stage> on its branch at the commit it pushed
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" was at <stage> in cell "cell-a" when the wrap-up stopped it, and the cell pushed its work in progress
      When the factory restarts and a cell starts for item "A"
      Then item "A"'s run resumes at <stage>
      And the new cell's checkout of the run's branch is at the work-in-progress commit the stopped cell pushed

      Examples:
        | stage       |
        | red         |
        | green       |
        | self-review |

    @ac-8
    Scenario: The resumed stage's agent carries on from the work in progress instead of starting over
      Given a run for item 482 that resumes at green after a restart, on a branch holding a work-in-progress commit
      When the cell runs
      Then green's brief tells the agent its earlier work is already on the branch and to carry on from it
      And the cell doesn't reset or discard the work-in-progress commit

    @ac-8 @db
    Scenario: An item whose cell finished its stage during the wrap-up resumes at the next stage
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" was at green in cell "cell-a" when the restart was prepared
      And cell "cell-a" reported green passed and pushed before it stopped
      When the factory restarts and a cell starts for item "A"
      Then item "A"'s run resumes at self-review
      And green's attempt is recorded as passed

  Rule: An attempt cut short by a restart is recorded as stopped and uses up none of the stage's retries

    @ac-9
    Scenario: A cell stopped for a restart reports its open attempt as stopped
      Given a run for item 482 that is at green's first attempt
      When the cell's lease renewal tells it to stop for a restart
      Then the cell reports green's first attempt as stopped
      And the cell reports no green attempt as failed

    @ac-9 @db
    Scenario: The stopped attempt shows as stopped on the item's Run detail
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A"'s green attempt 1 was stopped by a restart
      When the operator opens item "A"'s Run detail
      Then green's attempt 1 shows as stopped
      And no green attempt shows as failed

    @ac-9
    Scenario: The resumed stage still has every one of its retries
      Given green allows 1 retry
      And a run for item 482 whose green attempt 1 was stopped by a restart
      When the run resumes at green and every green attempt fails
      Then the cell makes 2 green attempts after the stopped one before it reports green's retries used up
      And green's attempt 1 is still recorded as stopped

  Rule: An item whose cell was stopped by the launcher resumes the same way, from its last pushed commit

    @ac-10 @db
    Scenario: An item whose cell the wrap-up's end stopped resumes at its stage from its last pushed commit
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" was at green in cell "cell-a", and its last pushed commit is red's
      And an operator prepared a restart 15 minutes ago
      When the scheduler ticks
      Then cell "cell-a" is stopped with the launcher's stop
      And item "A"'s open green attempt is recorded as stopped
      When the factory restarts and a cell starts for item "A"
      Then item "A"'s run resumes at green
      And the new cell's checkout of the run's branch is at red's commit

    @ac-10 @db
    Scenario: An item stopped by the launcher after an earlier work-in-progress push resumes from that push
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" was at green in cell "cell-a", and its last pushed commit is a work-in-progress commit
      And an operator prepared a restart 15 minutes ago
      When the scheduler ticks
      Then cell "cell-a" is stopped with the launcher's stop
      And item "A"'s open green attempt is recorded as stopped
      When the factory restarts and a cell starts for item "A"
      Then item "A"'s run resumes at green
      And the new cell's checkout of the run's branch is at that work-in-progress commit
