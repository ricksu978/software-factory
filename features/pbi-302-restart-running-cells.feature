@pbi-302 @db
Feature: Floor shows how many cells are still running while a restart is prepared, then "Ready to restart"
  While a restart is being prepared (PBI 140), the owner waits for the cells to stop before restarting the factory
  or stopping Docker. Floor tells them how many cells are still running, as "Preparing to restart: 2 cells still
  running", and, while the wrap-up lasts, how many minutes are left in it. The count goes down as each cell wraps
  up and exits, or is stopped. A cell whose lease ran out is no longer running and isn't counted.
  When the wrap-up has run out but a cell is still running, because its stop failed, Floor still counts it. It
  doesn't claim minutes are left, and it doesn't say the factory is ready.
  Once no cell is running, Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory
  or stop Docker." and no count.
  Today Floor says "2 cells are wrapping up, with 9 minutes left before the factory stops them", and once the
  wrap-up runs out with a cell still running it says "0 minutes left". Each scenario below fails on that wording.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the control plane is running with a fake board and FACTORY_RESTART_WAIT_MINUTES unset
    And an operator is signed in

  Rule: While a restart is being prepared, Floor shows how many cells are still running

    @ac-1
    Scenario: Floor counts every cell still running during the wrap-up
      Given item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the operator prepared a restart 6 minutes ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart: 2 cells still running"
      And Floor shows "9 minutes left in the wrap-up"
      And Floor doesn't show "Ready to restart"

    @ac-1
    Scenario: Floor counts a single cell still running in the singular
      Given item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 1 minute ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"
      And Floor shows "14 minutes left in the wrap-up"

    @ac-1
    Scenario: The count goes down as a cell wraps up and exits
      Given item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the operator prepared a restart 3 minutes ago
      When cell "cell-a" wrapped up and exited during the wrap-up
      And the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"
      And Floor doesn't show "2 cells still running"

    @ac-1
    Scenario: A cell whose lease ran out isn't counted as still running
      Given item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" whose lease ran out a minute ago
      And the operator prepared a restart 3 minutes ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"

    @ac-1
    Scenario: A cell whose stop failed when the wrap-up ran out is still counted, with no minutes left claimed
      Given item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the launcher fails to stop cell "cell-a"
      And the operator prepared a restart 15 minutes ago
      When the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"
      And Floor shows "The wrap-up has run out"
      And Floor doesn't show "minutes left"
      And Floor doesn't show "Ready to restart"

  Rule: Once no cell is running, Floor shows "Ready to restart" and no count

    @ac-1
    Scenario: Floor goes from one cell still running to "Ready to restart" when the last cell exits
      Given item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 3 minutes ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"
      When cell "cell-a" wrapped up and exited during the wrap-up
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."
      And Floor doesn't show "still running"
      And Floor doesn't show "Preparing to restart"

    @ac-1
    Scenario: Floor shows "Ready to restart" once the wrap-up's end stops the last cell that failed to stop before
      Given item "A" is running in cell "cell-a" with a live lease
      And the launcher fails to stop cell "cell-a"
      And the operator prepared a restart 15 minutes ago
      When the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running"
      When the launcher can stop cell "cell-a" again
      And the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."
      And Floor doesn't show "still running"
