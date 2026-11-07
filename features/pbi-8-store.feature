@pbi-8 @db
Feature: Schema, transitions and event log
  The store writes every state change and its event together, refuses moves the state machine
  doesn't allow, fences cells through the lease generation, and keeps the event log append-only.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  @ac-1
  Scenario: A legal transition writes the new state and exactly one event
    Given a fresh factory database with an item in state "Eligible"
    When the item takes the event "ready"
    Then the stored item's state is "Queued"
    And the event table holds exactly one new row, a "transition" from "Eligible" to "Queued" on "ready"

  @ac-1
  Scenario: The state and its event commit together or not at all
    Given a fresh factory database with an item in state "Eligible"
    And the event table refuses new rows
    When the item takes the event "ready"
    Then the move fails
    And the stored item's state is "Eligible"

  @ac-2
  Scenario: An illegal transition throws and changes nothing
    Given a fresh factory database with an item in state "Done"
    When the item takes the event "claimed"
    Then the move fails with IllegalTransition
    And the stored item's state is "Done"
    And the event table holds no new row

  @ac-3
  Scenario: Leaving InProgress raises the lease generation and clears the lease
    Given a fresh factory database with an item in state "InProgress" at lease generation 4, leased by "cell-a"
    When the item takes the event "pr_opened"
    Then the stored item's lease generation is 5
    And the stored item has no lease owner and no lease expiry

  @ac-3
  Scenario: A move between two other states leaves the lease alone
    Given a fresh factory database with an item in state "Eligible" at lease generation 4, leased by "cell-a"
    When the item takes the event "ready"
    Then the stored item's lease generation is 4
    And the stored item's lease owner is "cell-a"

  @ac-4
  Scenario: The app role can't rewrite the event log
    Given a fresh factory database with one event row
    When I connect as "factory_app" and update that event row
    Then the update fails with a permission error
    And the event row is unchanged

  @ac-5
  Scenario: dbTest skips database tests only when asked
    When I run a test file that uses dbTest with "FACTORY_DB_TESTS=skip"
    Then its test is reported as skipped
    When I run the same test file without that variable
    Then its test runs and passes
