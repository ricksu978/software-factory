@pbi-149
Feature: A change to the factory's readiness logic re-checks every NotReady item once
  The factory fingerprints what its readiness check reads, and a new fingerprint re-checks every
  NotReady item. Today that fingerprint covers only the repo's six readiness files. The readiness
  check also rests on the factory's own logic: the prompt it gives the judge, and the engine rules
  no policy file can weaken. When the factory ships a better prompt or a new engine rule, items it
  turned away under the old logic stay NotReady until someone edits them or their repo's files.
  With this item, the fingerprint covers the factory's readiness logic too. A change to the judge's
  prompt counts by itself. A change to the engine rules counts when the change raises the readiness
  version in the code. Either one re-checks every NotReady item once, on the next poll.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board, the repo and the readiness judge are fakes. The rest need no database.

  Rule: The readiness fingerprint covers the judge's prompt and the readiness version, as well as the repo's files

    @ac-1
    Scenario: A different judge prompt gives a different fingerprint for the same repo files
      Given one readiness check that reads a set of repo files with the factory's current logic
      And another that reads the same files with a judge prompt that differs by one word
      Then the two checks have different fingerprints

    @ac-1
    Scenario: A higher readiness version gives a different fingerprint for the same repo files
      Given one readiness check that reads a set of repo files with the factory's current logic
      And another that reads the same files with the readiness version raised by one
      Then the two checks have different fingerprints

    @ac-1
    Scenario: The fingerprint differs from one that covers the repo files alone
      Given one readiness check that reads a set of repo files with the factory's current logic
      Then its fingerprint differs from the fingerprint of the repo files alone

  Rule: A new judge prompt re-checks every NotReady item on the next poll, as a policy change

    @ac-2 @db
    Scenario: After a restart with a new judge prompt, every NotReady item is re-checked as a policy change
      Given the factory holds two items in state "NotReady", checked against the repo's current readiness files
      And neither the items nor the repo's readiness files change
      And the factory restarts with a judge prompt that differs by one word
      And the readiness judge now passes every line
      When the poller runs once
      Then both items are in state "Queued"
      And each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

    @ac-2 @db
    Scenario: An item that still fails under the new prompt is re-checked and comes back NotReady with a fresh comment
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And the factory restarts with a judge prompt that differs by one word
      And the readiness judge still fails line 1 because "Size is 8"
      When the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows one move "policy_changed"
      And the readiness judge was asked about the item once
      And the board item has a new readiness comment saying "Size is 8"

    @ac-2 @db
    Scenario: A new judge prompt re-checks NotReady items in every repo the factory serves
      Given the factory holds an item in state "NotReady" in repo "acme/web" and another in repo "acme/api"
      And the factory restarts with a judge prompt that differs by one word
      When the poller runs once
      Then each item's history shows one move "policy_changed"

  Rule: Raising the readiness version re-checks every NotReady item the same way

    @ac-3 @db
    Scenario: After a restart with a raised readiness version, every NotReady item is re-checked as a policy change
      Given the factory holds two items in state "NotReady", checked against the repo's current readiness files
      And neither the items nor the repo's readiness files change
      And the factory restarts with the readiness version raised by one
      And the readiness judge now passes every line
      When the poller runs once
      Then both items are in state "Queued"
      And each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

  Rule: Each NotReady item is re-checked once per logic change

    @ac-4 @db
    Scenario: Later polls after a logic change don't re-check the item again
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And the factory restarts with a judge prompt that differs by one word
      And the readiness judge still fails every line
      When the poller runs three times
      Then the factory holds the item in state "NotReady"
      And the item's history shows exactly one move "policy_changed"
      And the readiness judge was asked about the item once

    @ac-4 @db
    Scenario: A second logic change re-checks the item a second time
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And the readiness judge still fails every line
      And the factory restarts with a judge prompt that differs by one word
      And the poller runs once
      When the factory restarts with the readiness version raised by one
      And the poller runs once
      Then the item's history shows exactly two moves "policy_changed"
      And the readiness judge was asked about the item twice

  Rule: A restart with unchanged readiness logic re-checks nothing

    @ac-5 @db
    Scenario: A restart after a logic change was taken up re-checks nothing more
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And the readiness judge still fails every line
      And the factory restarts with a judge prompt that differs by one word
      And the poller runs once
      When the factory restarts again with the same judge prompt and readiness version
      And the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows exactly one move "policy_changed"
      And the readiness judge was asked about the item once
