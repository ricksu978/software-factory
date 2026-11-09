@pbi-156
Feature: The worker runs the scheduler tick, the board poller and the egress proxy set-up
  Step 2a of the control plane redesign (2026-11-07 design, §07 and §12) moves the background jobs out of
  today's control plane into a worker of their own, started from src/worker/main.ts. The worker sets up
  the egress proxy that cells reach the outside through, runs the scheduler's tick, and polls each board
  with the readiness judge, as today's control plane does now. Today's control plane, src/main.ts, keeps
  serving the cell API, GitHub's webhook and the dashboard, but stops running those jobs, so each job runs
  in exactly one process. Until step 3 brings the outbox, the worker mirrors its own transitions onto the
  board the way today's control plane does, so a person watching the board sees no difference.
  The advisory lock that keeps a second worker idle is not part of this step.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the worker and the control plane against a fake board, a fake repo host, a fake readiness
  judge and a fake cell launcher. The @local one needs Docker, the Aspire CLI and the owner's secrets, so
  the owner runs it and the PR records the run.

  Rule: The worker sets up the egress proxy before it starts any cell

    @ac-1 @db
    Scenario: The worker sets up the egress proxy when it starts
      Given a fresh factory database with one board
      When the worker starts
      Then the egress proxy has been set up for the cell image, the cell API's address and the blob account

    @ac-1 @db
    Scenario: The egress proxy is set up before the worker's first tick
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When the worker starts and ticks once
      Then the egress proxy was set up before a cell started for item "A"

    @ac-1 @db
    Scenario: A worker whose egress proxy can't be set up stops and starts no cell
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      And the egress proxy can't be set up
      When the worker starts
      Then the worker exits with an error saying the egress proxy couldn't be set up
      And no cell starts
      And item "A" is "Queued"

    @ac-1
    Scenario: A worker missing a setting it needs refuses to start
      Given the worker's environment doesn't set CELL_IMAGE
      When the worker starts
      Then the worker exits with an error naming CELL_IMAGE
      And no egress proxy is set up

  Rule: The worker runs the scheduler's tick

    @ac-1 @db
    Scenario: A queued item starts in a cell the worker launches
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When the worker starts and ticks once
      Then a cell starts for item "A"
      And item "A" is "InProgress"

    @ac-1 @db
    Scenario: The worker keeps ticking, so an item queued after it started is picked up
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker is running and has ticked once
      When item "B" is queued
      And the worker ticks again
      Then a cell starts for item "B"

    @ac-1 @db
    Scenario: A failed tick is logged and the next tick still runs
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      And the cell launcher fails once and then works
      When the worker starts and ticks twice
      Then the worker's log records that a scheduler tick failed
      And a cell starts for item "A"

    @ac-1 @db
    Scenario: The kill switch stops the worker's tick from starting cells
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      And the worker's environment sets FACTORY_KILL=1
      When the worker starts and ticks once
      Then no cell starts
      And item "A" is "Queued"

  Rule: The worker polls each board and asks the readiness judge about new items

    @ac-1 @db
    Scenario: A new item the judge finds ready is queued by the worker
      Given a fresh factory database with one board
      And the board holds a new item "R" with acceptance criteria
      And the readiness judge finds item "R" ready
      When the worker starts and polls the board once
      Then the readiness judge was asked about item "R"
      And item "R" is "Queued"

    @ac-1 @db
    Scenario: A new item the judge finds not ready is held back by the worker
      Given a fresh factory database with one board
      And the board holds a new item "N" with acceptance criteria
      And the readiness judge finds item "N" not ready
      When the worker starts and polls the board once
      Then item "N" is "NotReady"

    @ac-1 @db
    Scenario: The worker polls every board it has
      Given a fresh factory database with two boards, "first" and "second"
      And board "first" holds a new item "F1" the readiness judge finds ready
      And board "second" holds a new item "S1" the readiness judge finds ready
      When the worker starts and polls each board once
      Then item "F1" is "Queued"
      And item "S1" is "Queued"

    @ac-1 @db
    Scenario: A board that fails to answer doesn't stop the worker polling the others
      Given a fresh factory database with two boards, "first" and "second"
      And board "first" fails every call
      And board "second" holds a new item "S1" the readiness judge finds ready
      When the worker starts and polls each board once
      Then the worker's log records that polling board "first" failed
      And item "S1" is "Queued"

  Rule: Today's control plane no longer runs the tick, the poller or the egress proxy set-up

    @ac-1 @db
    Scenario: Today's control plane starts no cell for a queued item
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When today's control plane starts and has run for longer than one scheduler tick
      Then no cell starts
      And item "A" is "Queued"

    @ac-1 @db
    Scenario: Today's control plane doesn't poll the board or ask the readiness judge
      Given a fresh factory database with one board
      And the board holds a new item "R" with acceptance criteria
      And the readiness judge finds item "R" ready
      When today's control plane starts and has run for longer than one board poll
      Then the board was never polled
      And the readiness judge was never asked about item "R"
      And the factory holds no item "R"

    @ac-1 @db
    Scenario: Today's control plane doesn't set up the egress proxy
      Given a fresh factory database with one board
      When today's control plane starts
      Then no egress proxy is set up

    @ac-1 @db
    Scenario: With the worker and today's control plane both running, a queued item starts in one cell only
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When today's control plane and the worker both start and have run for longer than one scheduler tick
      Then exactly one cell starts for item "A"
      And the worker launched it

    @ac-1 @local
    Scenario: aspire run starts the worker beside today's control plane, and a queued item still starts
      # The worker starts the egress proxy from the cell image, so the image comes first.
      Given the image "factory-cell:local" is built
      When I start "aspire run" and wait until the control resource answers
      Then Aspire shows a worker resource started from src/worker/main.ts
      And the worker resource's console shows its first scheduler tick
      And the control resource's console shows a dashboard sign-in link
      And PBI 2's @local scenarios pass

  Rule: Until the outbox lands, the worker mirrors its own transitions onto the board

    @ac-2 @db
    Scenario: An item the worker starts is claimed on the board and shows as in progress
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the board shows the factory's state "InProgress" as "In progress"
      And item "A" is queued
      When the worker starts and ticks once
      Then the board item "A" is claimed
      And the board item "A" shows "In progress"

    @ac-2 @db
    Scenario: An item the worker's poller queues shows as queued on the board
      Given a fresh factory database with one board
      And the board shows the factory's state "Queued" as "Ready"
      And the board holds a new item "R" with acceptance criteria
      And the readiness judge finds item "R" ready
      When the worker starts and polls the board once
      Then the board item "R" shows "Ready"

    @ac-2 @db
    Scenario: An item withdrawn from the board while in review is released and its PR closed
      Given a fresh factory database with one board
      And item "W" is in review with open PR 42
      And item "W" has been withdrawn from the board
      When the worker starts and polls the board once
      Then item "W" is "Abandoned"
      And the board item "W" is released
      And PR 42 is closed with a note that the item was withdrawn

    @ac-2 @db
    Scenario: A merged item whose definition of done the worker verifies is closed on the board
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "D" is accepted, its PR merged and its definition of done met
      When the worker starts and ticks once
      Then item "D" is "Done"
      And the board item "D" is released and closed

    @ac-2 @db
    Scenario: A worker transition is mirrored once, even with today's control plane running
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the board shows the factory's state "InProgress" as "In progress"
      And item "A" is queued
      When today's control plane and the worker both start and have run for longer than one scheduler tick
      Then the board item "A" was claimed exactly once
      And the board item "A" was set to "In progress" exactly once

    @ac-2 @db
    Scenario: A board call that fails while mirroring is logged, and the worker's transition still stands
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the board shows the factory's state "InProgress" as "In progress"
      And the board refuses to set any status
      And item "A" is queued
      When the worker starts and ticks once
      Then item "A" is "InProgress"
      And the worker's log records that board mirroring's setStatus failed for item "A"
      And the board item "A" is claimed
