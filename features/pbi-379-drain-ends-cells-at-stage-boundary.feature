@pbi-379
Feature: While the factory drains, each cell finishes its stage and ends its claim at the stage boundary, as Prepare restart does
  Drain is a factory override on the dashboard's Controls. While the factory drains, the scheduler starts no cell.
  Before PBI 379, a running cell's lease renewal told it to carry on under a drain, and the cell went on through
  every later stage until its run was done or waiting. So a drain could last as long as a whole run, and Floor's
  drain line (PBI 316) stayed above 0 all that time.
  With this item a drain ends cells as Prepare restart does (PBI 301). A running cell's lease renewal tells it to
  carry on, so it finishes the stage it's in, with that stage's own retries. When that stage ends, the cell starts
  no further stage. It ends its claim at the stage boundary, the run records the next stage as it does between
  claims, and the item waits in Queued. No attempt is recorded as stopped and no work-in-progress commit is made.
  Once the drain is cleared, each item that ended at a boundary is claimed again from the stage its run recorded.
  A pause, the kill switch or an operator's stop still tells the cell to stop, as before.
  The scheduler already starts nothing while the factory drains, so the one scenario that checks only that is
  tagged @regression and passes before the build.
  Item 482 is an issue in the repo "acme/widgets". Scenarios tagged @db need Postgres, which each test starts for
  itself, so cells and CI both run them. The rest run the cell engine against a fake control plane, agent and repo.

  Rule: While the factory drains, a running cell's lease renewal tells it to carry on and finish the stage it's in

    @ac-1 @db
    Scenario: Every live cell's renewal tells it to carry on and end at the stage boundary while the factory drains
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "D" is running in cell "cell-d" with a live lease
      When an operator drains the factory with the reason "upgrading Docker"
      And cell "cell-a" renews its lease
      And cell "cell-d" renews its lease
      Then both renewals are answered and tell the cell to carry on
      And both renewals tell the cell to end its claim at the next stage boundary
      And items "A" and "D" are "InProgress"

    @ac-1 @db
    Scenario: A renewal long after the drain was set still tells the cell to carry on to the stage boundary
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 90 minutes ago
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      And the renewal tells the cell to end its claim at the next stage boundary
      And cell "cell-a"'s lease is pushed out

    @ac-1 @db
    Scenario Outline: Under a drain, <reason> still tells the cell to stop
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 1 minute ago
      When cell "cell-a" renews its lease
      Then the renewal tells the cell to carry on
      And the renewal tells the cell to end its claim at the next stage boundary
      When <reason> is set
      And cell "cell-a" renews its lease
      Then the renewal tells the cell to stop

      Examples:
        | reason                               |
        | a pause of the factory               |
        | the kill switch                      |
        | an operator's stop on item "A"'s run |

    @ac-1
    Scenario: A cell whose renewals come while the factory drains finishes its stage, then goes no further
      Given a run for item 482 that is at green's first attempt
      And the factory is draining
      When the cell renews its lease 5 times while green's agent works
      And green's agent finishes and green's checks pass
      Then the agent's work at green was not cut short
      And the cell reports green's first attempt as passed
      And the cell starts no self-review attempt
      And the cell reports no attempt as stopped

    @ac-1
    Scenario: A drain set in the middle of a stage doesn't cut the stage short, and the cell ends after it
      Given a run for item 482 that is at self-review's first attempt
      And the factory is not draining
      When the cell renews its lease while self-review's agent works
      And an operator drains the factory
      And the cell renews its lease twice more while self-review's agent works
      And self-review's agent finishes and approves
      Then the agent's work at self-review was not cut short
      And the cell reports self-review's first attempt as passed
      And the cell doesn't run open-pr's agent
      And the cell makes no commit "work in progress, stopped"

  Rule: When a cell finishes a stage while the factory drains, it ends at that stage boundary and the item waits in Queued

    @ac-2
    Scenario Outline: A cell that finishes <stage> while the factory drains starts no further stage
      Given a run for item 482 that is at <stage>'s first attempt
      And the factory is draining
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
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      Then item "A" is "Queued"
      And item "A" holds no lease
      And item "A"'s run's next stage is self-review
      And item "A"'s green attempt is recorded as passed
      And no attempt of item "A"'s run is recorded as stopped
      And the run's branch holds no commit "work in progress, stopped"

    @ac-2 @db
    Scenario: A cell that ends at the boundary while the factory both drains and prepares a restart is released once
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 5 minutes ago
      And an operator prepared a restart 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      Then item "A" is "Queued"
      And item "A" holds no lease
      And item "A"'s run's next stage is self-review
      And no attempt of item "A"'s run is recorded as stopped

  Rule: A stage's own retries are part of the stage, so a cell under a drain still runs them

    @ac-3
    Scenario: A cell whose green attempt fails under a drain runs green's retry, then ends at the boundary
      Given a run for item 482 that is at green's first attempt
      And green allows 1 retry
      And the factory is draining
      When green's first attempt fails its checks
      And green's second attempt passes
      Then the cell reports green's first attempt as failed
      And the cell reports green's second attempt as passed
      And the cell starts no self-review attempt
      And the cell ends its claim at the stage boundary and exits
      And the cell reports no attempt as stopped

    @ac-3
    Scenario: A drain set during a stage's first attempt doesn't keep the cell from that stage's retry
      Given a run for item 482 that is at red's first attempt
      And red allows 2 retries
      And the factory is not draining
      When an operator drains the factory while red's first attempt runs
      And red's first attempt fails
      And red's second attempt fails
      And red's third attempt passes
      Then the cell reports red's third attempt as passed
      And the cell starts no green attempt
      And the cell ends its claim at the stage boundary and exits
      And the cell makes no commit "work in progress, stopped"

    @ac-3 @db
    Scenario: The item of a cell that ran a retry under a drain waits in Queued at the next stage
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 1 retry
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green, whose first attempt fails and whose second attempt passes
      Then item "A" is "Queued"
      And item "A"'s run's next stage is self-review
      And item "A"'s green attempts are recorded as failed, then passed
      And no attempt of item "A"'s run is recorded as stopped

  Rule: Nothing starts while the factory drains, and once the drain is cleared each item that ended at a boundary is claimed again from its run's next stage

    @ac-4 @db @regression
    Scenario: A queued item doesn't start while the factory drains
      Given a fresh factory database with WIP 3 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease
      And item "B" is queued
      And an operator drained the factory with the reason "upgrading Docker" 2 hours ago
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-4 @db
    Scenario: An item that ended at a boundary stays in Queued while the factory drains
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green to the end and green passed
      When the scheduler ticks
      And the scheduler ticks again
      Then no cell starts
      And item "A" is "Queued"
      And item "A"'s run's next stage is self-review

    @ac-4 @db
    Scenario: Once the drain is cleared, the item is claimed again from the stage its run recorded
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green to the end and green passed
      When an operator resumes the factory with the reason "done upgrading"
      And the scheduler ticks
      Then a cell starts for item "A"
      And item "A"'s run resumes at self-review
      And self-review's brief doesn't tell the agent to carry on from earlier work
      And green's attempt is still recorded as passed

    @ac-4 @db
    Scenario: Once the drain is cleared, every item that ended at a boundary is claimed again from its own stage
      Given the control plane is running with a fake board
      And the factory has WIP 2
      And item "A" is at green in cell "cell-a" with a live lease
      And item "D" is at self-review in cell "cell-d" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green to the end and green passed
      And cell "cell-d" ran self-review to the end and self-review passed
      When an operator resumes the factory with the reason "done upgrading"
      And the scheduler ticks
      Then cells start for items "A" and "D"
      And item "A"'s run resumes at self-review
      And item "D"'s run resumes at open-pr

  Rule: Floor's drain line counts a cell as running until it ends its claim, so it reaches 0 once every cell has finished its current stage

    @ac-5 @db
    Scenario: Floor's drain count falls as each cell finishes its current stage, and the drain is done once all have
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is at green in cell "cell-a" with a live lease
      And item "D" is at self-review in cell "cell-d" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      And the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."
      When cell "cell-d" runs self-review to the end and self-review passes
      And the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."
      And items "A" and "D" are "Queued"
      And no attempt of item "A"'s or item "D"'s run is recorded as stopped

    @ac-5 @db
    Scenario: A cell still in its stage counts as running on Floor while the factory drains
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is at green in cell "cell-a" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" renews its lease while green's agent works
      And the operator opens Floor
      Then Floor shows "Draining: 1 cell still running."
      And Floor doesn't show "Drain done"
      When green passes and cell "cell-a" ends its claim at the stage boundary
      And the operator opens Floor
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."

    @ac-5 @db
    Scenario: A cell that finished its stage under a drain doesn't keep Floor's count above 0 until its lease runs out
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A" is at green in cell "cell-a" with a live lease
      And the operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      And the operator opens Floor straight away, before cell "cell-a"'s lease would have run out
      Then Floor shows "Drain done. No cell is running, so it's safe to restart the factory or stop Docker."
      And Floor doesn't show "still running"
