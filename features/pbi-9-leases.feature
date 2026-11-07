@pbi-9 @db
Feature: Leases with generation fencing
  A claim hands one cell an item and raises the lease generation, so an older cell is fenced out.
  A renewal only counts with the current generation, and a lease that runs out sends the item back
  to Queued for a new cell to resume. Each call takes the time as an argument, so the scenarios name it.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  @ac-1
  Scenario Outline: A claim raises the generation by 1 and leases the item for 300 seconds
    Given a fresh factory database whose one claimable item is in state "<state>" at lease generation 6
    When "cell-a" claims the next item at "2026-11-06T10:00:00Z"
    Then the claim returns that item at generation 7
    And the stored item's state is "InProgress"
    And the stored item's lease generation is 7
    And the stored item's lease owner is "cell-a"
    And the stored item's lease expires at "2026-11-06T10:05:00Z"

    Examples:
      | state      |
      | Queued     |
      | SignOff    |
      | NeedsInput |

  @ac-2
  Scenario: A renewal with the current generation pushes the lease out
    Given a fresh factory database with an item in state "InProgress" at lease generation 4, leased by "cell-a" until "2026-11-06T10:05:00Z"
    When the lease is renewed with generation 4 at "2026-11-06T10:01:00Z"
    Then the renewal returns "ok"
    And the stored item's lease expires at "2026-11-06T10:06:00Z"

  @ac-2
  Scenario: A renewal with an old generation is lost and changes nothing
    Given a fresh factory database with an item in state "InProgress" at lease generation 4, leased by "cell-a" until "2026-11-06T10:05:00Z"
    When the lease is renewed with generation 3 at "2026-11-06T10:01:00Z"
    Then the renewal returns "lost"
    And the stored item's state is "InProgress"
    And the stored item's lease generation is 4
    And the stored item's lease owner is "cell-a"
    And the stored item's lease expires at "2026-11-06T10:05:00Z"

  @ac-3
  Scenario: Two concurrent claims on one Queued item return one claim and one null
    Given a fresh factory database whose one claimable item is in state "Queued" at lease generation 0
    When "cell-a" claims the next item at "2026-11-06T10:00:00Z", and before that transaction commits "cell-b" claims the next item
    Then "cell-a" gets the item and "cell-b" gets null
    And the stored item's lease generation is 1
    And the stored item's lease owner is "cell-a"
    And the item has exactly one run
    And the event table holds exactly one new row, a "transition" from "Queued" to "InProgress" on "claimed"

  @ac-4
  Scenario: An expired lease sends the item back to Queued with its resume pointer unchanged
    Given a fresh factory database with an item in state "InProgress" at lease generation 4, leased by "cell-a" until "2026-11-06T10:05:00Z"
    And the item's open run resumes from "green"
    When leases expire at "2026-11-06T10:05:01Z"
    Then the expiry returns that item
    And the stored item's state is "Queued"
    And the stored item's lease generation is 5
    And the stored item has no lease owner and no lease expiry
    And the item's open run still resumes from "green"
    And the event table holds exactly one new row, a "transition" from "InProgress" to "Queued" on "lease_expired"

  @ac-4
  Scenario: A lease that hasn't run out yet is left alone
    Given a fresh factory database with an item in state "InProgress" at lease generation 4, leased by "cell-a" until "2026-11-06T10:05:00Z"
    When leases expire at "2026-11-06T10:04:59Z"
    Then the expiry returns no items
    And the stored item's state is "InProgress"
    And the stored item's lease generation is 4

  @ac-4
  Scenario: An expired lease on an item that isn't InProgress is ignored
    Given a fresh factory database with an item in state "SignOff" at lease generation 4, leased by "cell-a" until "2026-11-06T10:05:00Z"
    When leases expire at "2026-11-06T10:05:01Z"
    Then the expiry returns no items
    And the stored item's state is "SignOff"
    And the stored item's lease generation is 4
