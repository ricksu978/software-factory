@pbi-158
Feature: The worker records a heartbeat each tick, and aspire run starts it after migrate
  Step 2c of the control plane redesign (2026-11-07 design, §07 "Worker health" and §12) has the worker
  record a heartbeat on every scheduler tick: the factory's one heartbeat row holds the time of its latest
  tick. A later step shows it on the floor, and says "scheduler not ticking" once it goes stale. That way
  a stopped worker doesn't look like a quiet factory. So the heartbeat moves on every tick, including a
  tick with nothing to do, a tick under the kill switch, and a tick that fails, because each one shows
  the worker is alive. Only the worker that holds the worker lock ticks (PBI 157), so a standby writes no
  heartbeat, and a worker that lost the lock writes no more.
  Under `aspire run` the worker starts only after migrate has finished, serves no port, and still
  starts a cell for a queued factory item.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the worker against a fake board, a fake repo host, a fake readiness judge and a fake cell
  launcher. The @local ones need Docker, the Aspire CLI and the owner's secrets, so the owner runs them
  and the PR records the run.

  Rule: Each scheduler tick records the worker's heartbeat

    @ac-1 @db
    Scenario: The worker's first tick records the heartbeat on a fresh database
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the factory has no worker heartbeat yet
      When the worker starts and ticks once
      Then the factory has exactly one worker heartbeat
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: Each later tick moves the heartbeat forward, and it stays one heartbeat
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker is running and has ticked once
      And the heartbeat shows the time of that first tick
      When the worker ticks twice more
      Then the heartbeat shows the time of the worker's latest tick
      And the heartbeat is later than the first tick
      And the factory has exactly one worker heartbeat

    @ac-1 @db
    Scenario: A tick with nothing to do still records the heartbeat
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the factory holds no item
      When the worker starts and ticks once
      Then no cell starts
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: A tick that starts a cell records the heartbeat too
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When the worker starts and ticks once
      Then a cell starts for item "A"
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: A heartbeat left by an earlier worker is replaced by the new worker's first tick
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the factory's worker heartbeat was last recorded an hour ago
      When the worker starts and ticks once
      Then the factory has exactly one worker heartbeat
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: A tick under the kill switch starts no cell but still records the heartbeat
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      And the worker's environment sets FACTORY_KILL=1
      When the worker starts and ticks once
      Then no cell starts
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: A tick that fails is logged and still records the heartbeat
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      And the cell launcher fails every time
      When the worker starts and ticks once
      Then the worker's log records that a scheduler tick failed
      And the heartbeat shows the time of the worker's latest tick

    @ac-1 @db
    Scenario: A heartbeat that can't be written is logged, and the worker keeps ticking
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker's heartbeat can't be written
      And item "A" is queued
      When the worker starts and ticks once
      Then the worker's log records that the heartbeat couldn't be written
      And a cell starts for item "A"
      When the heartbeat can be written again
      And the worker ticks again
      Then the heartbeat shows the time of the worker's latest tick

  Rule: Only the worker holding the worker lock records the heartbeat

    @ac-1 @db
    Scenario: A standby beside the running worker leaves the heartbeat to the running worker
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      When both workers have run for longer than one scheduler tick
      Then the heartbeat shows the time of the first worker's latest tick
      And the second worker never recorded the heartbeat

    @ac-1 @db
    Scenario: The heartbeat stops moving when the running worker stops, and moves again once the standby takes over
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running and has ticked once
      And a second worker has started beside it
      When the first worker stops
      Then the heartbeat still shows the time of the first worker's last tick until the second worker takes the lock
      And within 30 seconds of the first worker stopping, the heartbeat shows the time of the second worker's latest tick

    @ac-1 @db
    Scenario: A worker that lost its lock connection records no more heartbeats
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker is running and has ticked once
      And the heartbeat shows the time of the worker's latest tick
      When the worker's lock connection is ended by Postgres
      Then the worker exits with an error saying it lost the worker lock
      When longer than one scheduler tick passes
      Then the heartbeat still shows the time of the worker's last tick before it lost the lock

  Rule: Under aspire run, the worker starts after migrate, serves no port, and starts cells

    @ac-2 @local
    Scenario: aspire run starts the worker after migrate, with no port, and its heartbeat moves
      # The worker starts the egress proxy from the cell image, so the image comes first.
      Given the image "factory-cell:local" is built
      When I start "aspire run" and wait until the worker resource's console shows its first scheduler tick
      Then Aspire shows the worker resource started only after the migrate resource finished successfully
      And Aspire shows no endpoint for the worker resource
      And the worker's process listens on no port
      And the factory database's worker heartbeat is less than 30 seconds old
      And a minute later the worker heartbeat is still less than 30 seconds old

    @ac-2 @local
    Scenario: Under aspire run, a queued factory item still starts a cell, and the heartbeat moves with the ticks
      Given the image "factory-cell:local" is built
      And "aspire run" is running and the worker resource's console shows its first scheduler tick
      When a factory item is queued
      Then within one scheduler tick a cell starts for the item
      And the item is "InProgress"
      And the worker heartbeat is later than the time the item was queued
      And PBI 2's @local scenarios pass
