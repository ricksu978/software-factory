@pbi-301
Feature: While a restart is being prepared, a cell finishes its stage and ends at the stage boundary
  Before PBI 301, preparing a restart (PBI 140) told every live cell to stop at its next lease renewal. The cell
  cut its stage short, committed and pushed "work in progress, stopped", and reported the attempt stopped, so
  the restarted factory resumed that stage from half-done work.
  With this item, a running cell's lease renewal tells it to carry on while a restart is being prepared, so
  the cell finishes the stage it is in as if no restart were pending. When that stage ends, the cell starts no
  further stage. It ends its claim at the stage boundary, the run records the next stage as it does between
  claims, and the item waits in Queued until the restart is done. No attempt is recorded as stopped and no
  work-in-progress commit is made. A pause, the kill switch or an operator's stop still tells the cell to stop,
  as before.
  Item 482 is an issue in the repo "acme/widgets". Scenarios tagged @db need Postgres, which each test starts
  for itself, so cells and CI both run them. The rest run the cell engine against a fake control plane, agent
  and repo.

  Rule: While a restart is being prepared, a running cell's lease renewal tells it to carry on

    @ac-1 @db
    Scenario: Every live cell's renewal tells it to carry on while a restart is being prepared
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      When an operator prepares a restart with the reason "upgrading Docker"
      And cell "cell-a" renews its lease
      And cell "cell-d" renews its lease
      Then both renewals are answered and tell the cell to carry on
      And items "A" and "D" are "InProgress"

    @ac-1 @db
    Scenario: A renewal tells the cell to carry on long after the restart was prepared
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 90 minutes ago
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      And cell "cell-a"'s lease is pushed out

    @ac-1 @db
    Scenario Outline: Under a restart being prepared, <reason> still tells the cell to stop
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator prepared a restart 1 minute ago
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      When <reason> is set
      And cell "cell-a" renews its lease
      Then the renewal tells the cell to stop

      Examples:
        | reason                               |
        | a pause of the factory               |
        | the kill switch                      |
        | an operator's stop on item "A"'s run |

    @ac-1
    Scenario: A cell whose renewals come while a restart is being prepared finishes its stage
      Given a run for item 482 that is at green's first attempt
      And the factory is preparing to restart
      When the cell renews its lease 5 times while green's agent works
      And green's agent finishes and green's checks pass
      Then the agent's work at green was not cut short
      And the cell reports green's first attempt as passed
      And the cell reports no attempt as stopped

    @ac-1
    Scenario: A restart prepared in the middle of a stage doesn't cut the stage short
      Given a run for item 482 that is at self-review's first attempt
      And the factory is not preparing to restart
      When the cell renews its lease while self-review's agent works
      And the factory starts preparing to restart
      And the cell renews its lease twice more while self-review's agent works
      And self-review's agent finishes and approves
      Then the agent's work at self-review was not cut short
      And the cell reports self-review's first attempt as passed
      And the cell makes no commit "work in progress, stopped"

  Rule: When a cell finishes a stage while a restart is being prepared, it ends at that stage boundary and the item waits in Queued

    @ac-2
    Scenario Outline: A cell that finishes <stage> while a restart is being prepared starts no further stage
      Given a run for item 482 that is at <stage>'s first attempt
      And the factory is preparing to restart
      When <stage> passes
      Then the cell reports <stage>'s first attempt as passed
      And the cell starts no <next> attempt
      And the cell doesn't run <next>'s agent
      And the cell ends its claim at the stage boundary and exits
      And the cell reports no attempt as stopped
      And the cell makes no commit "work in progress, stopped"

      Examples:
        | stage       | next        |
        | red         | green       |
        | green       | self-review |
        | self-review | open-pr     |

    @ac-2 @db
    Scenario: The run records the next stage, the item waits in Queued, and no attempt is recorded as stopped
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator prepared a restart 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      Then item "A" is "Queued"
      And item "A" holds no lease
      And item "A"'s run's next stage is self-review
      And item "A"'s green attempt is recorded as passed
      And no attempt of item "A"'s run is recorded as stopped
      And the run's branch holds no commit "work in progress, stopped"

    @ac-2 @db
    Scenario: The item stays in Queued while the restart is being prepared
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator prepared a restart 2 minutes ago
      And cell "cell-a" ran green to the end and green passed
      When the scheduler ticks
      And the scheduler ticks again
      Then no cell starts
      And item "A" is "Queued"
      And item "A"'s run's next stage is self-review

    @ac-2 @db
    Scenario: Once the restart is done, the item starts its next stage fresh
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator prepared a restart 2 minutes ago
      And cell "cell-a" ran green to the end and green passed
      When the control plane starts
      And the scheduler ticks
      Then a cell starts for item "A"
      And item "A"'s run resumes at self-review
      And self-review's brief doesn't tell the agent to carry on from earlier work
      And green's attempt is still recorded as passed

    @ac-2 @db
    Scenario: Once the last cell ends at its stage boundary, Floor says it's ready to restart
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is at green in cell "cell-a" with a live lease
      And the operator prepared a restart 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      And the operator opens Floor
      Then Floor shows "Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker."
      And item "A" is "Queued"
      And no attempt of item "A"'s run is recorded as stopped

    @ac-2
    Scenario: A restart cleared before the stage ends lets the cell go on to the next stage
      Given a run for item 482 that is at green's first attempt
      And the factory is preparing to restart
      When the cell renews its lease while green's agent works
      And an operator resumes the factory before green ends
      And green passes
      Then the cell reports green's first attempt as passed
      And the cell starts self-review's first attempt
      And the cell reports no attempt as stopped
