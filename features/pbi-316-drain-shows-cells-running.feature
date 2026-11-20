@pbi-316 @db
Feature: While the factory drains, Floor shows how many cells are still running, and says when none are
  Drain is a factory override on the dashboard's Controls. While the factory drains, the scheduler starts
  no cell and lets the cells already running finish. Today Floor only says "Draining" with the reason, so
  an owner waiting to restart the factory or stop Docker can't tell from Floor when the drain is done.
  Floor now shows how many cells are still running while the factory drains. It counts them as Prepare
  restart does: an item counts when it is InProgress and its cell still holds a live lease. An item whose
  lease ran out, or one that waits for a sign-off, an answer or a review, isn't counted. Once no cell is
  running, Floor says the drain is done and that the factory can be restarted or Docker stopped.
  Prepare restart's line on Floor reads as it does today. Those scenarios are tagged @regression and pass
  before the build.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: While the factory drains, Floor shows how many cells are still running

    @ac-1
    Scenario: Floor shows the one cell still running while the factory drains
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      When the operator drains the factory with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."
      And Floor shows the drain's reason "upgrading Docker"
      And Floor doesn't show "Drain done"

    @ac-1
    Scenario: Floor counts every cell still running while the factory drains
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When the operator opens Floor
      Then Floor shows "Draining: 2 cells still running."

    @ac-1
    Scenario: An item whose cell's lease ran out isn't counted as running
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "E" is running in cell "cell-e" whose lease ran out a minute ago
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."

    @ac-1
    Scenario: Items waiting for a sign-off, an answer or a review aren't counted as running
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "S" waits for an unanswered sign-off
      And item "N" waits for an unanswered question
      And item "R" is in review
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."

    @ac-1
    Scenario: The count follows the cells as they finish
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When cell "cell-d" finishes and exits
      And the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."

    @ac-1
    Scenario: While the factory both drains and prepares a restart, both lines give the same count
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "E" is running in cell "cell-e" whose lease ran out a minute ago
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      And the operator prepared a restart 1 minute ago
      When the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."
      And Floor shows "Preparing to restart: 1 cell still running. The factory won't stop it."

  Rule: Once no cell is running, Floor says the drain is done and the factory can be restarted or Docker stopped

    @ac-2
    Scenario: Once the last cell finishes, Floor says the drain is done
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And the operator drained the factory with the reason "upgrading Docker" 15 minutes ago
      When cell "cell-a" finishes and exits
      And the scheduler ticks
      And the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."
      And Floor doesn't show "still running"
      And no cell starts
      And item "B" is "Queued"

    @ac-2
    Scenario: Draining with no cell running is done at once
      Given the control plane is running with a fake board
      And an operator is signed in
      And no cell is running
      When the operator drains the factory with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."

    @ac-2
    Scenario: A drain whose only remaining item's lease ran out is done
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "E" is running in cell "cell-e" whose lease ran out a minute ago
      And item "R" is in review
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."

    @ac-2
    Scenario: Floor doesn't say the drain is done while a cell still runs
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 90 minutes ago
      When the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."
      And Floor doesn't show "Drain done"

    @ac-2
    Scenario: After Resume, Floor shows neither the drain's count nor that it's done
      Given the control plane is running with a fake board
      And an operator is signed in
      And no cell is running
      And the operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      When the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."
      When the operator resumes the factory with the reason "done upgrading"
      And the operator opens Floor
      Then Floor doesn't show "Drain done"
      And Floor doesn't show "Draining"

  Rule: Prepare restart's line on Floor reads as it does today

    @ac-3 @regression
    Scenario: Floor shows the cells still wrapping up while a restart is being prepared
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      When the operator prepares a restart with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Preparing to restart: 2 cells still running. The factory won't stop them. Reason: upgrading Docker."

    @ac-3 @regression
    Scenario: Floor says it's ready to restart once no cell is running
      Given the control plane is running with a fake board
      And an operator is signed in
      And no cell is running
      When the operator prepares a restart with the reason "upgrading Docker"
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker. Reason: upgrading Docker."

    @ac-3 @regression
    Scenario: Prepare restart's line doesn't take on the drain's wording when no drain is set
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is running in cell "cell-a" with a live lease
      And the operator prepared a restart 1 minute ago
      When the operator opens Floor
      Then Floor shows "Preparing to restart: 1 cell still running. The factory won't stop it."
      And Floor doesn't show "Draining"
      And Floor doesn't show "Drain done"
