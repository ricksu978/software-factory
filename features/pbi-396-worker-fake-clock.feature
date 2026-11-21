@pbi-396
Feature: The worker reads its timers from a clock it's given, so the worker lock scenarios move time on instead of waiting it out
  The worker (PBI 157, PBI 158) runs five timed jobs: the scheduler tick, every 15 seconds; the outbox loop, every
  second; each board poll, every 5 minutes; the standby's lock retry, every 15 seconds; and the holder's lock check,
  every 5 seconds. Today each one waits on the real clock, so PBI 157's and PBI 158's scenarios sit through real
  lock retries and ticks, and a takeover scenario waits at least 15 real seconds.
  This item gives the worker one clock that sets all its timers and supplies every time it records. A test can hand
  it a fake clock, which stands still until the test moves it on. Moving it on fires each timer that falls due, one
  after another, and waits for the work each one starts before it fires the next. A worker started with no clock
  uses the real one, and every interval stays as it is today.
  A closed lock connection still reaches the worker as an event, so a worker whose fake clock never moves still
  exits when it loses the lock.
  "Real seconds" below means time on the wall, and "the fake clock moves N seconds on" means the test moves the
  worker's clock without waiting.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them. The workers
  run against a fake board, a fake repo host, a fake readiness judge and a fake cell launcher. The @local ones run
  every scenario of a feature, @local ones included, so the owner runs them and the PR records the run.

  Rule: Every timer the worker sets runs on the clock it's given

    @ac-1 @db
    Scenario Outline: A worker on a fake clock runs its <job> again only once the clock has moved one interval on
      Given a fresh factory database with one board
      And a worker on a fake clock, with its default intervals, has run its <job> once
      When 3 real seconds pass with the fake clock standing still
      Then the worker has run its <job> 1 time
      When the fake clock moves <short> on
      Then the worker has run its <job> 1 time
      When the fake clock moves <rest> on
      Then the worker has run its <job> 2 times

      Examples:
        | job               | short                 | rest           |
        | scheduler tick    | 14 seconds            | 1 second       |
        | outbox loop       | 999 milliseconds      | 1 millisecond  |
        | board poll        | 4 minutes 59 seconds  | 1 second       |
        | lock check        | 4 seconds             | 1 second       |

    @ac-1 @db
    Scenario: A standby on a fake clock tries for the worker lock again only once the clock has moved 15 seconds on
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When 20 real seconds pass with the second worker's fake clock standing still
      Then the second worker has tried for the worker lock 1 time
      When the second worker's fake clock moves 14 seconds on
      Then the second worker has tried for the worker lock 1 time
      When the second worker's fake clock moves 1 second on
      Then the second worker has tried for the worker lock 2 times
      And the second worker is still standing by

    @ac-1 @db
    Scenario: Each tick records the fake clock's time as the worker's heartbeat
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a fake clock that reads "2026-01-01T09:00:00Z"
      When a worker on that clock, with its default intervals, starts and ticks once
      Then the heartbeat shows "2026-01-01T09:00:00Z"
      When the fake clock moves 15 seconds on
      Then the heartbeat shows "2026-01-01T09:00:15Z"

    @ac-1 @db
    Scenario: The heartbeat doesn't move while the fake clock stands still, however much real time passes
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a fake clock that reads "2026-01-01T09:00:00Z"
      And a worker on that clock, with its default intervals, has started and ticked once
      When 20 real seconds pass with the fake clock standing still
      Then the heartbeat shows "2026-01-01T09:00:00Z"
      And the worker has run its scheduler tick 1 time

    @ac-1 @db @regression
    Scenario: A worker given no clock ticks and works through the outbox on the real clock, at today's intervals
      Given a fresh factory database with WIP 2 and a review capacity of 3
      When a worker given no clock and no intervals starts and ticks once
      Then within 3 real seconds the worker has worked through the outbox again
      And the worker ticks a second time between 14 and 20 real seconds after its first tick
      And the heartbeat shows a time within 5 seconds of the real time of the worker's latest tick

    @ac-1 @db @regression
    Scenario: A standby given no clock says it tries again every 15 seconds and takes the lock on the real clock
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      When a second worker given no clock and no intervals starts beside it
      Then the second worker's log records that another worker holds the lock and it tries again every 15 seconds
      When the first worker stops
      Then within 20 real seconds of the first worker stopping, the second worker's log records that it took the lock

  Rule: A standby on a fake clock takes over once the clock moves 15 seconds on, with no real wait

    @ac-2 @db
    Scenario: The standby takes the lock once the first worker stops and its fake clock moves 15 seconds on
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When the first worker stops
      And the second worker's fake clock moves 15 seconds on
      Then within 5 real seconds of the first worker stopping, the second worker's log records that it took the lock
      When item "B" is queued
      And the second worker's fake clock moves 15 seconds on
      Then the second worker launched a cell for item "B"
      And item "B" is "InProgress"

    @ac-2 @db
    Scenario: Moved 14 seconds on, the standby still stands by, and one second more lets it take the lock
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When the first worker stops
      And the second worker's fake clock moves 14 seconds on
      Then the second worker is still standing by
      And the second worker launched no cell
      When the second worker's fake clock moves 1 second on
      Then within 5 real seconds of the first worker stopping, the second worker's log records that it took the lock

    @ac-2 @db
    Scenario: A standby whose fake clock stands still doesn't take the lock, however much real time passes
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When the first worker stops
      And 20 real seconds pass with the second worker's fake clock standing still
      Then the second worker is still standing by
      When the second worker's fake clock moves 15 seconds on
      Then within 5 real seconds the second worker's log records that it took the lock

    @ac-2 @db
    Scenario: A standby whose fake clock moves 15 seconds on while the first worker still runs keeps standing by
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When the second worker's fake clock moves 15 seconds on
      Then the second worker is still standing by
      And the second worker has tried for the worker lock 2 times
      When the first worker stops
      And the second worker's fake clock moves 15 seconds on
      Then within 5 real seconds of the first worker stopping, the second worker's log records that it took the lock

  Rule: Moving a fake clock on fires due timers one at a time, each after the work of the one before

    @ac-3 @db
    Scenario: On a 3-second tick, moving the clock 45 seconds on runs 15 more ticks
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a fake clock that reads "2026-01-01T09:00:00Z"
      And a worker on that clock, with a 3-second tick whose ticks await the database, has started and ticked once
      When the fake clock moves 45 seconds on
      Then the worker has run its scheduler tick 16 times
      And the ticks after the first started at 3-second steps from "2026-01-01T09:00:03Z" to "2026-01-01T09:00:45Z"
      And the heartbeat shows "2026-01-01T09:00:45Z"

    @ac-3 @db
    Scenario: Moving the clock 44 seconds on runs only 14 more ticks
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a worker on a fake clock, with a 3-second tick whose ticks await the database, has started and ticked once
      When the fake clock moves 44 seconds on
      Then the worker has run its scheduler tick 15 times

    @ac-3 @db
    Scenario: A slow tick finishes before the clock fires the next one, so no two ticks overlap
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a worker on a fake clock, with a 3-second tick whose ticks each wait half a real second on the database, has started and ticked once
      When the fake clock moves 15 seconds on
      Then the worker has run its scheduler tick 6 times
      And no tick started before the tick ahead of it had finished

    @ac-3 @db
    Scenario: Moving the clock on runs each job that falls due in the time it moves through
      Given a fresh factory database with one board
      And a worker on a fake clock, with a 3-second tick and its default outbox and poll intervals, has started and run each job once
      When the fake clock moves 6 seconds on
      Then the worker has run its scheduler tick 3 times
      And the worker has run its outbox loop 7 times
      And the worker has run its board poll 1 time

  Rule: A worker on a fake clock still exits once its lock connection closes

    @ac-4 @db
    Scenario Outline: A worker on a fake clock that never moves exits when its lock connection is <closed>
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And a worker on a fake clock, with its default intervals, has started and ticked once
      When 6 real seconds pass with the fake clock standing still
      Then the worker has run its scheduler tick 1 time
      And the worker has run its lock check 0 times
      When the worker's lock connection is <closed>
      Then within 5 real seconds the worker exits with an error saying it lost the worker lock
      When item "E" is queued
      And longer than one real scheduler tick passes
      Then no cell starts for item "E"

      Examples:
        | closed                                        |
        | ended by Postgres on an administrator's order |
        | closed by a lost network connection           |

    @ac-4 @db
    Scenario: A standby on a fake clock that never moves exits when its lock connection closes
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker on a fake clock, with its default intervals, has started beside it and is standing by
      When the first worker stops
      And 20 real seconds pass with the second worker's fake clock standing still
      Then the second worker is still standing by
      When the second worker's lock connection is ended by Postgres
      Then within 5 real seconds the second worker exits with an error saying its lock connection closed while it stood by

  Rule: PBI 157's and PBI 158's steps run their workers on fake clocks, and every scenario of theirs and PBI 376's still passes

    @ac-5 @db
    Scenario Outline: PBI <pbi>'s scenario "<scenario>" moves the clock on instead of waiting, and passes in under 10 real seconds
      When the owner runs PBI <pbi>'s scenario "<scenario>"
      Then the scenario passes
      And its steps took less than 10 real seconds in all

      Examples:
        | pbi | scenario                                                                                                    |
        | 157 | A standby stays idle through several retries while the first worker keeps running                          |
        | 157 | The standby starts work within 30 seconds of the first worker stopping                                     |
        | 157 | The standby polls the board within 30 seconds of the first worker stopping                                 |
        | 157 | The standby takes over when the first worker's session ends without a clean stop                           |
        | 157 | After a takeover, a worker started later stands by for the new holder                                      |
        | 157 | When the working worker loses its lock connection, the standby takes over within 30 seconds                |
        | 158 | The heartbeat stops moving when the running worker stops, and moves again once the standby takes over      |

    @ac-5 @db
    Scenario: Every worker PBI 157's and PBI 158's steps start in the test's own process runs on a fake clock
      When the owner runs every scenario of PBI 157 and PBI 158 not tagged @local
      Then every worker their steps started in the test's own process was started on a fake clock
      And every scenario passes

    @ac-5 @regression
    Scenario: PBI 157's and PBI 158's feature files are unchanged
      Then the feature file of PBI 157 is the same as on main before this item
      And the feature file of PBI 158 is the same as on main before this item

    @ac-5 @db @regression
    Scenario Outline: Every scenario of PBI <pbi> not tagged @local passes
      When the owner runs every scenario of PBI <pbi> not tagged @local
      Then every scenario passes
      And no scenario was skipped or left undefined

      Examples:
        | pbi |
        | 157 |
        | 158 |
        | 376 |

    @ac-5 @db @local @regression
    Scenario Outline: Every scenario of PBI <pbi>, @local ones included, passes
      When the owner runs every scenario of PBI <pbi>
      Then every scenario passes
      And no scenario was skipped or left undefined

      Examples:
        | pbi |
        | 158 |
        | 376 |
