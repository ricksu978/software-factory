@pbi-130 @db
Feature: A thread from the factory's own review never sends the item to address
  The factory's PR review posts its findings as threads on the PR, under the repo's trusted bot.
  Those threads belong to the PR review stage, which checks and resolves them itself. Only a trusted
  person's own review or thread sends an InReview item back to address. A thread the factory's review
  opened never does, through the webhook or the poller, even when a trusted person replies inside it.
  An address run that a person's own thread starts is handed that person's thread, and none of the
  factory's.
  The board, the repo host and GitHub's webhook deliveries are fakes here. Every scenario needs
  Postgres, which each test starts for itself, so cells and CI both run them. A comment counts only
  once it has stood for two minutes, so every comment here has stood longer than that.

  Background:
    Given the factory holds an item in state "InReview" with an open PR
    And the repo's trusted bot is "factory[bot]"
    And "octo" is an allowlisted user

  Rule: A thread the factory's own review opened never sends the item back to address

    @ac-2
    Scenario: A trusted person's reply inside the factory's thread doesn't send the item to address through the poller
      Given the factory's own review left an open thread "This misses the VAT." on the item's PR
      And "octo" replied "I'd rather keep it this way." inside that thread
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-2
    Scenario: The same reply delivered through the webhook, then seen by the poller, doesn't send the item to address
      Given the factory's own review left an open thread "This misses the VAT." on the item's PR
      And "octo" replied "I'd rather keep it this way." inside that thread
      When GitHub delivers octo's reply to the webhook as a review that only comments
      And the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-2
    Scenario: The factory's thread is known by its bot however the trusted bot was stored
      Given the repo's trusted bot is instead stored as "ricksu978-software-factory"
      And "ricksu978-software-factory[bot]"'s review left an open thread "This misses the VAT." on the item's PR
      And "octo" replied "I'd rather keep it this way." inside that thread
      When the poller runs once
      Then the factory holds the item in state "InReview"

    @ac-2
    Scenario: Several replies across the factory's threads still don't send the item to address
      Given the factory's own review left open threads "This misses the VAT." and "Rename this variable." on the item's PR
      And "octo" replied "I'd rather keep it this way." inside the thread "This misses the VAT."
      And "octo" replied "Agreed, but later." inside the thread "Rename this variable."
      When the poller runs once
      Then the factory holds the item in state "InReview"

  Rule: A person's own thread still sends the item to address, and the address run gets only the person's threads

    @ac-2
    Scenario: A person's own thread sends the item to address, and the factory's thread stays out of the address run
      Given the factory's own review left an open thread "This misses the VAT." on the item's PR
      And "octo" replied "I'd rather keep it this way." inside that thread
      And "octo" opened a thread of their own, "Why not use the tax table?", on the item's PR
      When the poller runs once
      And the address run asks for its context
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"
      And its trusted comments hold "Why not use the tax table?" by "octo"
      And no trusted comment holds "This misses the VAT."
      And no trusted comment holds "I'd rather keep it this way."
