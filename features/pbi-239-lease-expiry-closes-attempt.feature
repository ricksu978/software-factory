@pbi-239
Feature: An attempt whose cell died is closed as stopped when its lease expires
  A cell that dies mid-stage never reports its attempt, so the attempt stays "started" for good. When the
  cell's lease runs out, the factory sends the item back to Queued, but the attempt is left open. Run
  detail then shows it as started and "didn't finish", next to the attempts of the cell that came after.
  With this item, whenever the factory sends an InProgress item back to Queued because its lease ran out,
  or because a restart ended its cell's claim, every attempt of the item's run that is still started is
  closed. It gets the status stopped, ends at that moment, and carries a message saying the cell's lease
  ran out. Like any stopped attempt, it uses up none of the stage's retries. Run detail shows it as
  stopped, with that message. A migration closes the attempts left open by cells that died before this
  change, in the same way.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: When a lease runs out, every started attempt of the item's run is closed as stopped, with a message saying the lease ran out

    @ac-1 @db
    Scenario: The started attempt of an item whose lease ran out is closed as stopped at the moment of expiry
      Given a fresh factory database with an item in state "InProgress", leased by "cell-a" until "2026-11-14T10:05:00Z"
      And the item's run has green attempt 1 started at "2026-11-14T10:01:00Z" and never reported
      When leases expire at "2026-11-14T10:05:01Z"
      Then the stored item's state is "Queued"
      And green's attempt 1 is recorded as stopped
      And green's attempt 1 ended at "2026-11-14T10:05:01Z"
      And green's attempt 1 has a message saying the cell's lease ran out

    @ac-1 @db
    Scenario: Every started attempt of the run is closed, not only the newest
      Given a fresh factory database with an item in state "InProgress", leased by "cell-a" until "2026-11-14T10:05:00Z"
      And the item's run has red attempt 1 started at "2026-11-14T09:30:00Z" and never reported
      And the item's run has green attempt 1 started at "2026-11-14T10:01:00Z" and never reported
      When leases expire at "2026-11-14T10:05:01Z"
      Then red's attempt 1 is recorded as stopped, ended at "2026-11-14T10:05:01Z", with a message saying the cell's lease ran out
      And green's attempt 1 is recorded as stopped, ended at "2026-11-14T10:05:01Z", with a message saying the cell's lease ran out

    @ac-1 @db
    Scenario: Attempts that already ended keep the status, end time and message they had
      Given a fresh factory database with an item in state "InProgress", leased by "cell-a" until "2026-11-14T10:05:00Z"
      And the item's run has specify attempt 1 that passed at "2026-11-14T09:10:00Z" with the message "Wrote 4 scenarios"
      And the item's run has red attempt 1 that failed at "2026-11-14T09:20:00Z" with the message "A scenario passed at Red"
      And the item's run has red attempt 2 started at "2026-11-14T09:21:00Z" and never reported
      When leases expire at "2026-11-14T10:05:01Z"
      Then red's attempt 2 is recorded as stopped, ended at "2026-11-14T10:05:01Z", with a message saying the cell's lease ran out
      And specify's attempt 1 is still recorded as passed, ended at "2026-11-14T09:10:00Z", with the message "Wrote 4 scenarios"
      And red's attempt 1 is still recorded as failed, ended at "2026-11-14T09:20:00Z", with the message "A scenario passed at Red"

    @ac-1 @db
    Scenario: A lease that hasn't run out yet leaves its attempt started
      Given a fresh factory database with an item in state "InProgress", leased by "cell-a" until "2026-11-14T10:05:00Z"
      And the item's run has green attempt 1 started at "2026-11-14T10:01:00Z" and never reported
      And another item in state "InProgress", leased by "cell-b" until "2026-11-14T10:03:00Z", whose run has build attempt 1 started and never reported
      When leases expire at "2026-11-14T10:04:00Z"
      Then the other item's build attempt 1 is recorded as stopped, with a message saying the cell's lease ran out
      And the stored item's state is "InProgress"
      And green's attempt 1 is still recorded as started, with no end time and no message

  Rule: A restart that sends a cell's item back to Queued closes its started attempts the same way

    @ac-2 @db
    Scenario: A cell the wrap-up's end stops has its open attempt closed as stopped, with the lease message
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease, at green attempt 1, started and never reported
      And an operator prepared a restart 15 minutes ago
      When the scheduler ticks
      Then cell "cell-a" is stopped with the launcher's stop
      And item "A" is in state "Queued"
      And item "A"'s green attempt 1 is recorded as stopped, ended at the moment of that tick
      And item "A"'s green attempt 1 has a message saying the cell's lease ran out

    @ac-2 @db
    Scenario: A cell that wraps up for a restart also leaves no other attempt of its run started
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And item "A" is running in cell "cell-a" with a live lease, at green attempt 2
      And item "A"'s run still holds green attempt 1, started by a cell that died and never reported
      And an operator prepared a restart 2 minutes ago
      When cell "cell-a" reports green's attempt 2 as stopped
      Then item "A" is in state "Queued"
      And item "A"'s green attempt 2 is recorded as stopped
      And item "A"'s green attempt 1 is recorded as stopped, ended at the moment of that report, with a message saying the cell's lease ran out

  Rule: An attempt closed when its lease ran out uses up none of the stage's retries, as a stopped attempt doesn't today

    @ac-3 @db
    Scenario: The stage after an expired lease still has every one of its retries
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And green allows 1 retry
      And item "A"'s cell died at green attempt 1, started and never reported, and its lease ran out
      When the scheduler ticks and a cell starts for item "A", and every green attempt fails
      Then the cell makes 2 green attempts after attempt 1 before it reports green's retries used up
      And item "A"'s green attempt 1 is still recorded as stopped, with a message saying the cell's lease ran out

    @ac-3 @db
    Scenario: A stage with no retries left to spare can still pass after an expired lease
      Given a fresh factory database with WIP 1 and a review capacity of 3
      And green allows 0 retries
      And item "A"'s cell died at green attempt 1, started and never reported, and its lease ran out
      When the scheduler ticks and a cell starts for item "A", and its green attempt passes
      Then item "A"'s run moves on past green
      And item "A"'s green attempt 1 is recorded as stopped and its green attempt 2 as passed
      And item "A" wasn't failed for using up green's retries

  Rule: Run detail shows an attempt closed this way as stopped, with the lease message

    @ac-4 @db
    Scenario: Run detail shows the closed attempt as stopped, with the lease message and no transcript link
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A"'s green attempt 1, which has no transcript, was closed as stopped when its cell's lease ran out
      When the operator opens item "A"'s Run detail
      Then green's attempt 1 shows as stopped
      And green's attempt 1 shows the message saying the cell's lease ran out
      And green's attempt 1 shows no transcript link
      And green's attempt 1 doesn't show "didn't finish"

    @ac-4 @db
    Scenario: A closed attempt that did store a transcript still links it
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A"'s green attempt 1, which has a stored transcript, was closed as stopped when its cell's lease ran out
      When the operator opens item "A"'s Run detail
      Then green's attempt 1 shows as stopped
      And green's attempt 1 shows the message saying the cell's lease ran out
      And green's attempt 1 links its transcript

    @ac-4 @db
    Scenario: The attempt that came after the closed one shows as it was reported
      Given the control plane is running with a fake board
      And an operator is signed in
      And item "A"'s green attempt 1 was closed as stopped when its cell's lease ran out
      And item "A"'s green attempt 2 failed with the message "2 scenarios still fail"
      When the operator opens item "A"'s Run detail
      Then green's attempt 1 shows as stopped, with the message saying the cell's lease ran out
      And green's attempt 2 shows as failed, with the message "2 scenarios still fail"

  Rule: A migration closes the attempts that cells which died before this change left started

    @ac-5 @db
    Scenario: A started attempt whose run has a later attempt is closed by the migration
      Given a database at today's schema holding an open run whose green attempt 1 is started and never reported
      And that run's green attempt 2 started after it and passed
      When the factory migrates that database
      Then green's attempt 1 is recorded as stopped, with an end time of when the migration ran
      And green's attempt 1 has a message saying the cell's lease ran out
      And green's attempt 2 is still recorded as passed

    @ac-5 @db
    Scenario: A started attempt whose run has a later attempt at another stage is closed by the migration
      Given a database at today's schema holding an open run whose red attempt 1 is started and never reported
      And that run's green attempt 1 started after it and is still started
      When the factory migrates that database
      Then red's attempt 1 is recorded as stopped, with a message saying the cell's lease ran out
      And green's attempt 1 is still recorded as started, with no end time

    @ac-5 @db
    Scenario: A started attempt whose run has ended is closed by the migration, even as the run's last attempt
      Given a database at today's schema holding a run that ended, whose last attempt, build attempt 1, is started and never reported
      When the factory migrates that database
      Then build's attempt 1 is recorded as stopped, with an end time of when the migration ran
      And build's attempt 1 has a message saying the cell's lease ran out

    @ac-5 @db
    Scenario: The newest attempt of an open run is left started, because its cell may still be running
      Given a database at today's schema holding an open run whose newest attempt, green attempt 3, is started
      And that run's green attempt 2, before it, is started and never reported
      When the factory migrates that database
      Then green's attempt 2 is recorded as stopped, with a message saying the cell's lease ran out
      And green's attempt 3 is still recorded as started, with no end time and no message

    @ac-5 @db
    Scenario: Attempts that already ended keep what they had through the migration
      Given a database at today's schema holding a run that ended, whose specify attempt 1 passed with the message "Wrote 4 scenarios" and whose red attempt 1 failed with the message "A scenario passed at Red"
      And that run's green attempt 1 is started and never reported
      When the factory migrates that database
      Then green's attempt 1 is recorded as stopped, with a message saying the cell's lease ran out
      And specify's attempt 1 is still recorded as passed, with its end time and the message "Wrote 4 scenarios"
      And red's attempt 1 is still recorded as failed, with its end time and the message "A scenario passed at Red"
