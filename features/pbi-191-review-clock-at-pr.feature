@pbi-191 @db
Feature: The review clock starts when the PR opens, so a review left during the factory's PR review still counts
  The review clock is the time after which a trusted person's review counts: a review or open-thread
  comment newer than the clock sends an InReview item back to address. Until now the clock started at
  the first "PR opened" report, which the cell sends only after the factory's own PR review passes.
  The PR is already open on GitHub while that review runs, and the item is still InProgress. A person
  who reviewed it in that window was ignored, because their review was older than the clock.
  With this item, the clock starts when the cell records the PR in the open-pr stage. A review left
  while the factory's PR review runs then counts, and it sends the item to address on the first poll
  after the item reaches InReview. The factory's own threads still never count, a review from before
  the PR opened still doesn't count, and the claim that starts an address run still moves the clock.
  The board, the repo host and the cell API's caller are fakes here. Every scenario needs Postgres,
  which each test starts for itself, so cells and CI both run them. The times are one day's wall
  clock. A line comment counts only once it has stood two minutes (Run contract 10).

  Background:
    Given the repo's trusted bot is "factory[bot]"
    And "octo" is an allowlisted user
    And the factory holds an item in state "InProgress" whose run is at the open-pr stage, with no PR yet

  Rule: The review clock starts when the cell records the PR, not at the first "PR opened" report

    @ac-1
    Scenario: Recording the PR starts the review clock
      When the cell records PR 57 at 10:00
      Then the run's review clock reads 10:00

    @ac-1
    Scenario: The first "PR opened" report after the PR was recorded leaves the clock where it started
      Given the cell recorded PR 57 at 10:00
      When the cell reports PR 57 opened at 10:20
      Then the run's review clock reads 10:00
      And the factory holds the item in state "InReview"

    @ac-1
    Scenario: Recording the same PR again, as a retried open-pr attempt does, doesn't move the clock
      Given the cell recorded PR 57 at 10:00
      When the cell records PR 57 again at 10:05
      Then the run's review clock reads 10:00

  Rule: A trusted review requesting changes while the factory's PR review runs sends the item to address once it is InReview

    @ac-2
    Scenario: A review requesting changes during the factory's PR review sends the item to address on the first poll in InReview
      Given the cell recorded PR 57 at 10:00
      And "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

    @ac-2
    Scenario: A poll while the item is still InProgress leaves it there, and the first poll in InReview sends it to address
      Given the cell recorded PR 57 at 10:00
      And "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 10:10
      When the poller runs once at 10:15
      Then the factory holds the item in state "InProgress"
      When the cell reports PR 57 opened at 10:20
      And the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

    @ac-2
    Scenario: The address run started by that review is handed the person's review
      Given the cell recorded PR 57 at 10:00
      And "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      When the address run claims the item at 10:30 and asks for its context
      Then its trusted comments hold "Why not use the tax table?" by "octo"

  Rule: A trusted line comment in an open thread in the same window counts once it has stood two minutes

    @ac-3
    Scenario: A person's line comment during the factory's PR review sends the item to address once it has stood two minutes
      Given the cell recorded PR 57 at 10:00
      And "octo" opened a thread, "This misses the VAT.", on line 12 of "src/totals.ts" in PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

    @ac-3
    Scenario: A line comment that hasn't yet stood two minutes waits for a later poll
      Given the cell recorded PR 57 at 10:00
      And "octo" opened a thread, "This misses the VAT.", on line 12 of "src/totals.ts" in PR 57 at 10:19
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:20
      Then the factory holds the item in state "InReview"
      When the poller runs once at 10:22
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

  Rule: A thread the factory's own review opened never sends the item to address, whenever it was left

    @ac-4 @regression
    Scenario: The factory's own thread from its PR review, with a person's reply inside it, leaves the item InReview
      Given the cell recorded PR 57 at 10:00
      And the factory's own review left an open thread "Rename this variable." on PR 57 at 10:05
      And "octo" replied "I'd rather keep it this way." inside that thread at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-4 @regression
    Scenario: The factory's own thread left after the item reached InReview leaves the item InReview
      Given the cell recorded PR 57 at 10:00
      And the cell reported PR 57 opened at 10:20
      And the factory's own review left an open thread "Rename this variable." on PR 57 at 10:30
      And "octo" replied "I'd rather keep it this way." inside that thread at 10:31
      When the poller runs once at 10:40
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-4
    Scenario: A person's own thread in the window still counts beside the factory's thread, and the address run gets only theirs
      Given the cell recorded PR 57 at 10:00
      And the factory's own review left an open thread "Rename this variable." on PR 57 at 10:05
      And "octo" opened a thread, "This misses the VAT.", on line 12 of "src/totals.ts" in PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      When the address run claims the item at 10:30 and asks for its context
      Then its trusted comments hold "This misses the VAT." by "octo"
      And no trusted comment holds "Rename this variable."

  Rule: A review submitted before the PR opened doesn't count

    @ac-5 @regression
    Scenario: A review requesting changes from before the cell recorded the PR leaves the item InReview
      Given "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 09:50
      And the cell recorded PR 57 at 10:00
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-5
    Scenario: Of two reviews, only the one after the PR was recorded counts
      Given "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 09:50
      And the cell recorded PR 57 at 10:00
      And "octo" submitted a review requesting changes, "This misses the VAT.", on PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

  Rule: The claim that starts an address run moves the review clock to that claim's time

    @ac-6 @regression
    Scenario: The claim for an address run moves the clock to the claim's time
      Given the cell recorded PR 57 at 10:00
      And the cell reported PR 57 opened at 10:20
      And "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 10:30
      And the poller ran once at 10:35
      When the address run claims the item at 10:40
      Then the run's review clock reads 10:40

    @ac-6
    Scenario: A review from the window that the address run already took doesn't send the item to address again
      Given the cell recorded PR 57 at 10:00
      And "octo" submitted a review requesting changes, "Why not use the tax table?", on PR 57 at 10:10
      And the cell reported PR 57 opened at 10:20
      When the poller runs once at 10:25
      Then the factory holds the item in state "Queued"
      When the address run claims the item at 10:30
      And the address run reports PR 57 opened again at 10:50
      And the poller runs once at 10:55
      Then the run's review clock reads 10:30
      And the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"
