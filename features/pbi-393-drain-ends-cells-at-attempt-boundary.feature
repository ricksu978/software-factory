@pbi-393
Feature: Under a drain or a restart being prepared, a cell stops at the attempt boundary too, so a failing stage's retries wait for the next claim
  Since PBI 301 and PBI 379, a running cell carries on while the factory drains or a restart is being prepared,
  finishes the stage it's in and ends its claim at the stage boundary. But a stage's retries were part of the
  stage, so a cell whose attempt failed went on to run every retry the stage allows before it ended. A stage
  that kept failing could hold a drain or a restart open for hours.
  With this item, a cell whose attempt fails while the factory drains or a restart is being prepared starts no
  further attempt. It ends its claim at that attempt boundary, and the item waits in Queued at the same stage.
  The failed attempt is recorded as failed and counts against the stage's retries, as today. No attempt is
  recorded as stopped and no work-in-progress commit is made. Once the drain or restart is cleared, the item is
  claimed again at the same stage, and the next attempt's brief carries the failed attempt's findings, as a retry
  within one claim does today.
  A stage whose retries are spent fails or blocks the item as today, and an attempt that passes ends the claim at
  the stage boundary as PBI 379 and PBI 301 made it. Those scenarios check behaviour that already exists, so they
  are tagged @regression and pass before the build.
  Item 482 is an issue in the repo "acme/widgets". Scenarios tagged @db need Postgres, which each test starts for
  itself, so cells and CI both run them. The rest run the cell engine against a fake control plane, agent and repo.

  Rule: While the factory drains or a restart is being prepared, a cell whose attempt fails starts no further attempt and ends its claim

    @ac-1
    Scenario Outline: A cell whose <stage> attempt fails while the factory drains starts no retry
      Given a run for item 482 that is at <stage>'s first attempt
      And <stage> allows 2 retries
      And the factory is draining
      When <stage>'s first attempt fails
      Then the cell starts no second <stage> attempt
      And the cell starts no <next> attempt
      And the cell ends its claim at the attempt boundary and exits

      Examples:
        | stage   | next        |
        | red     | green       |
        | green   | self-review |
        | address | pr-review   |

    @ac-1
    Scenario: A cell whose green attempt fails while a restart is being prepared starts no retry
      Given a run for item 482 that is at green's first attempt
      And green allows 2 retries
      And the factory is preparing to restart
      When green's first attempt fails its checks
      Then the cell starts no second green attempt
      And the cell ends its claim at the attempt boundary and exits

    @ac-1
    Scenario: A drain set in the middle of an attempt that then fails ends the claim at that attempt
      Given a run for item 482 that is at green's first attempt
      And green allows 2 retries
      And the factory is not draining
      When the cell renews its lease while green's agent works
      And an operator drains the factory
      And the cell renews its lease while green's agent works
      And green's first attempt fails its checks
      Then the agent's work at green was not cut short
      And the cell starts no second green attempt
      And the cell ends its claim at the attempt boundary and exits

    @ac-1
    Scenario: A retry already running when the drain is set ends the claim when it fails too
      Given a run for item 482 that is at red's first attempt
      And red allows 2 retries
      And the factory is not draining
      When red's first attempt fails
      And an operator drains the factory while red's second attempt runs
      And red's second attempt fails
      Then the cell starts no third red attempt
      And the cell ends its claim at the attempt boundary and exits

    @ac-1 @db
    Scenario: The item waits in Queued at the same stage after its attempt fails under a drain
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 2 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green's first attempt, which fails its checks
      Then item "A" is "Queued"
      And item "A" holds no lease
      And item "A"'s run's next stage is green

    @ac-1 @db
    Scenario: The item waits in Queued at the same stage after its attempt fails while a restart is being prepared
      Given the control plane is running with a fake board
      And item "A" is at red in cell "cell-a" with a live lease
      And red allows 2 retries
      And an operator prepared a restart 2 minutes ago
      When cell "cell-a" runs red's first attempt, which fails
      Then item "A" is "Queued"
      And item "A" holds no lease
      And item "A"'s run's next stage is red

    @ac-1 @db
    Scenario: The item stays in Queued at its stage while the factory still drains
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 2 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green's first attempt, which failed its checks
      When the scheduler ticks
      And the scheduler ticks again
      Then no cell starts
      And item "A" is "Queued"
      And item "A"'s run's next stage is green

  Rule: The failed attempt is recorded as failed and counts against the stage's retries, and nothing is recorded as stopped

    @ac-2
    Scenario: The cell reports the attempt as failed, reports none as stopped and makes no work-in-progress commit
      Given a run for item 482 that is at green's first attempt
      And green allows 2 retries
      And the factory is draining
      When green's first attempt fails its checks
      Then the cell reports green's first attempt as failed
      And the cell reports no attempt as stopped
      And the cell makes no commit "work in progress, stopped"
      And the cell starts no second green attempt

    @ac-2 @db
    Scenario: The run records the attempt as failed and none as stopped
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 2 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green's first attempt, which fails its checks
      Then item "A"'s green attempts are recorded as failed, once
      And no attempt of item "A"'s run is recorded as stopped
      And the run's branch holds no commit "work in progress, stopped"
      And item "A" is "Queued"

    @ac-2 @db
    Scenario: An attempt that failed under a drain uses up one of the stage's retries
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 1 retry
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green's first attempt, which failed its checks
      When an operator resumes the factory with the reason "done upgrading"
      And the scheduler ticks
      And the new cell runs green and every green attempt fails
      Then the new cell makes 1 green attempt before it reports green's retries used up
      And item "A" moves to Failed
      And item "A"'s green attempts are recorded as failed, twice

  Rule: Once the drain or restart is cleared, the item is claimed again at the same stage, and the next attempt carries the failed attempt's findings

    @ac-3 @db
    Scenario: Once the drain is cleared, the item is claimed again at the stage whose attempt failed
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 2 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green's first attempt, which failed the test "totals include VAT"
      When an operator resumes the factory with the reason "done upgrading"
      And the scheduler ticks
      Then a cell starts for item "A"
      And item "A"'s run resumes at green
      And the new cell's first green attempt is green's second attempt
      And green's second brief says its last attempt failed
      And green's second brief names the test "totals include VAT"
      And green's second brief doesn't tell the agent to carry on from earlier work

    @ac-3 @db
    Scenario: Once the restart is done, the item is claimed again at the stage whose attempt failed
      Given the control plane is running with a fake board
      And item "A" is at red in cell "cell-a" with a live lease
      And red allows 2 retries
      And an operator prepared a restart 2 minutes ago
      And cell "cell-a" ran red's first attempt, which failed
      When the control plane starts
      And the scheduler ticks
      Then a cell starts for item "A"
      And item "A"'s run resumes at red
      And the new cell's first red attempt is red's second attempt
      And red's second brief says its last attempt failed, with the first attempt's findings

    @ac-3 @db
    Scenario: The resumed attempt can pass, and the run goes on to the next stage
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 2 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      And cell "cell-a" ran green's first attempt, which failed its checks
      When an operator resumes the factory with the reason "done upgrading"
      And the scheduler ticks
      And the new cell runs green and green's second attempt passes
      Then the new cell starts self-review's first attempt
      And item "A"'s green attempts are recorded as failed, then passed

  Rule: A stage whose retries are spent fails or blocks the item as today, whether or not the factory drains

    @ac-4 @regression
    Scenario Outline: Green's last attempt failing <when> fails the item
      Given a run for item 482 that is at green's first attempt
      And green allows 0 retries
      And <condition>
      When green's first attempt fails its checks
      Then the cell reports green's retries used up
      And the item moves to Failed
      And the cell reports no attempt as stopped

      Examples:
        | when                                | condition                             |
        | while the factory drains            | the factory is draining               |
        | while a restart is being prepared   | the factory is preparing to restart   |
        | with no drain and no restart        | the factory is not draining           |

    @ac-4 @regression
    Scenario Outline: Address's last attempt failing <when> asks the question it asks today
      Given a run for item 482 that is at address's first attempt
      And address allows 0 retries
      And <condition>
      When address's first attempt fails
      Then the item moves to NeedsInput
      And the cell reports no attempt as stopped

      Examples:
        | when                         | condition                   |
        | while the factory drains     | the factory is draining     |
        | with no drain and no restart | the factory is not draining |

    @ac-4 @db @regression
    Scenario: An item whose last retry fails under a drain is Failed, not Queued
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And green allows 0 retries
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green's first attempt, which fails its checks
      Then item "A" is "Failed"
      And item "A" holds no lease
      And no attempt of item "A"'s run is recorded as stopped

    @ac-4 @regression
    Scenario: With no drain, a failing stage still runs its retries within one claim
      Given a run for item 482 that is at green's first attempt
      And green allows 1 retry
      And the factory is not draining
      When green's first attempt fails its checks
      And green's second attempt passes
      Then the cell reports green's first attempt as failed
      And the cell reports green's second attempt as passed
      And the cell starts self-review's first attempt

  Rule: An attempt that passes under a drain or a restart ends the claim at the stage boundary, as PBI 379 and PBI 301 made it

    @ac-5 @regression
    Scenario Outline: A cell whose <stage> attempt passes <when> ends at the stage boundary
      Given a run for item 482 that is at <stage>'s first attempt
      And <condition>
      When <stage> passes
      Then the cell reports <stage>'s first attempt as passed
      And the cell starts no <next> attempt
      And the cell ends its claim at the stage boundary and exits
      And the cell reports no attempt as stopped
      And the cell makes no commit "work in progress, stopped"

      Examples:
        | stage | next        | when                              | condition                           |
        | red   | green       | while the factory drains          | the factory is draining             |
        | green | self-review | while the factory drains          | the factory is draining             |
        | green | self-review | while a restart is being prepared | the factory is preparing to restart |

    @ac-5 @db @regression
    Scenario: The item of a cell whose attempt passed under a drain waits in Queued at the next stage
      Given the control plane is running with a fake board
      And item "A" is at green in cell "cell-a" with a live lease
      And an operator drained the factory with the reason "upgrading Docker" 2 minutes ago
      When cell "cell-a" runs green to the end and green passes
      Then item "A" is "Queued"
      And item "A"'s run's next stage is self-review
      And no attempt of item "A"'s run is recorded as stopped
