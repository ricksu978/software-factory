@pbi-26
Feature: A database for cells
  A cell has no Docker daemon, so it can't start the throwaway Postgres that tests start in CI.
  Instead the cell image carries the Postgres binaries, and every test that needs a database starts
  its own server inside the cell. So a cell runs the database suites and the @db scenarios as CI does,
  two test runs never share a server, and the factory's own database stays out of a cell's reach.

  @ac-1
  Scenario: This repo's Definition of Done runs the database suites and the @db scenarios
    When the factory reads this repo's .factory/dod.md and .factory/config.yml
    Then no command sets FACTORY_DB_TESTS=skip
    And the scenario filter leaves out only "@local"

  @ac-1 @local
  Scenario: A cell runs the database suites with no Docker daemon
    Given the cell image built from this checkout
    When a cell runs the database suites "src/store/items.test.ts" and "src/store/leases.test.ts" with the gates' environment
    Then every test in those files runs and passes
    And none is skipped

  @ac-2 @local
  Scenario: Two test databases started at once in one cell share nothing
    Given the cell image built from this checkout
    When a cell starts two test databases at once, then adds an item and the role "reviewer_a" in the first
    Then the second has no items
    And the second has no role "reviewer_a"

  @ac-3 @local
  Scenario: A cell can use its own test database but can't reach a database outside the cell
    Given the cell image built from this checkout
    And a Postgres server published on the host, outside the cell network
    When a cell on the cell network starts its own test database and then tries the outside server
    Then its own test database answers
    And the outside server can't be reached
