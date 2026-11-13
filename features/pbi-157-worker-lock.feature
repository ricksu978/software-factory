@pbi-157
Feature: Only one worker works at a time, and a standby takes over when it stops
  Step 2b of the control plane redesign (2026-11-07 design, §07 "Exactly one worker" and §12) keeps a
  second worker idle. Two workers would each claim their own item, which overshoots the WIP limit, and
  each would poll and judge every board. So the worker holds the factory's worker lock, a session-level
  Postgres advisory lock on a connection of its own. A worker that can't take the lock is a standby: it
  claims nothing, polls nothing and tries again every 15 seconds, which covers a revision swap where the
  old and new worker overlap. Postgres releases the lock when the holder's session ends, even an
  unclean end, so the standby takes over. A worker whose lock connection closes stops ticking and exits,
  and the platform restarts it. It never keeps working through its pool without the lock.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  Each worker gets its own fake board, fake cell launcher and fake readiness judge, so a scenario can
  tell which worker did the work.

  Rule: A second worker started beside a running one stands by and does nothing

    @ac-1 @db
    Scenario: A second worker claims no item while the first one runs
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running and has ticked once
      When a second worker starts
      And item "A" is queued
      And both workers have run for longer than one scheduler tick
      Then the second worker launched no cell
      And exactly one cell starts for item "A"
      And the first worker launched it

    @ac-1 @db
    Scenario: A second worker polls no board and asks the readiness judge nothing
      Given a fresh factory database with one board
      And the board holds a new item "R" with acceptance criteria
      And the first worker is running and has polled the board once
      When a second worker starts
      And both workers have run for longer than one board poll
      Then the second worker never polled the board
      And the second worker's readiness judge was never asked about item "R"

    @ac-1 @db
    Scenario: The second worker's log says it is standing by for the running worker
      Given a fresh factory database with one board
      And the first worker is running
      When a second worker starts
      Then the second worker's log records that another worker holds the lock and it is standing by

    @ac-1 @db
    Scenario: A standby stays idle through several retries while the first worker keeps running
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      When item "A" is queued
      And both workers have run for 45 seconds
      Then the second worker launched no cell
      And the second worker never polled the board
      And the first worker is still running

    @ac-1 @db
    Scenario: Three workers started together leave exactly one working
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And item "A" is queued
      When three workers start at the same time
      And all three have run for longer than one scheduler tick
      Then exactly one cell starts for item "A"
      And exactly one of the three workers launched a cell or polled the board

  Rule: Once the running worker stops, the standby takes over within 30 seconds

    @ac-1 @db
    Scenario: The standby starts work within 30 seconds of the first worker stopping
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      And the second worker has launched no cell
      When the first worker stops
      And item "B" is queued
      Then within 30 seconds of the first worker stopping, the second worker launches a cell for item "B"
      And item "B" is "InProgress"

    @ac-1 @db
    Scenario: The standby polls the board within 30 seconds of the first worker stopping
      Given a fresh factory database with one board
      And the board holds a new item "R" with acceptance criteria
      And the readiness judge finds item "R" ready
      And the first worker is running and has polled the board once
      And a second worker has started beside it
      And the second worker has never polled the board
      When the first worker stops
      Then within 30 seconds of the first worker stopping, the second worker has polled the board
      And the second worker's log records that it took the lock

    @ac-1 @db
    Scenario: The standby takes over when the first worker's session ends without a clean stop
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      And the second worker has launched no cell
      When the first worker dies without stopping cleanly, so Postgres ends its sessions
      And item "C" is queued
      Then within 30 seconds the second worker launches a cell for item "C"

    @ac-1 @db
    Scenario: After a takeover, a worker started later stands by for the new holder
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      And the first worker has stopped and the second worker has taken over
      When a third worker starts
      And item "D" is queued
      And the workers have run for longer than one scheduler tick
      Then the third worker launched no cell
      And the second worker launched the cell for item "D"

  Rule: A worker whose lock connection closes stops ticking and exits

    @ac-2 @db
    Scenario Outline: A worker whose lock connection is <closed> stops ticking and exits
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker is running and has ticked once
      When the worker's lock connection is <closed>
      Then the worker exits with an error saying it lost the worker lock
      When item "E" is queued
      And longer than one scheduler tick passes
      Then no cell starts for item "E"
      And item "E" is "Queued"

      Examples:
        | closed                                        |
        | ended by Postgres on an administrator's order |
        | closed by a lost network connection           |

    @ac-2 @db
    Scenario: A worker whose lock connection closes stops polling the board too
      Given a fresh factory database with one board
      And the worker is running and has polled the board once
      When the worker's lock connection is ended by Postgres
      Then the worker exits with an error saying it lost the worker lock
      When the board gains a new item "F" with acceptance criteria
      And longer than one board poll passes
      Then the board was polled no more times after the lock connection ended
      And the factory holds no item "F"

    @ac-2 @db
    Scenario: A worker that loses another pool connection keeps working, and exits only when its lock connection closes
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the worker is running and has ticked once
      When Postgres ends one of the worker's other idle connections
      And item "G" is queued
      And the worker ticks again
      Then a cell starts for item "G"
      And the worker is still running
      When the worker's lock connection is ended by Postgres
      Then the worker exits with an error saying it lost the worker lock

    @ac-2 @db
    Scenario: The process exits with a failure code so the platform restarts it
      Given a fresh factory database with one board
      And the worker is running as its own process
      When the worker's lock connection is ended by Postgres
      Then the worker's process exits with a non-zero code
      And the worker's log records that it lost the worker lock

    @ac-1 @ac-2 @db
    Scenario: When the working worker loses its lock connection, the standby takes over within 30 seconds
      Given a fresh factory database with WIP 2 and a review capacity of 3
      And the first worker is running
      And a second worker has started beside it
      And the second worker has launched no cell
      When the first worker's lock connection is ended by Postgres
      And item "H" is queued
      Then the first worker exits with an error saying it lost the worker lock
      And within 30 seconds the second worker launches a cell for item "H"
      And exactly one cell starts for item "H"
