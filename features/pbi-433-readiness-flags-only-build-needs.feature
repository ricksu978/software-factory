@pbi-433
Feature: The readiness check flags only what building an item needs
  The readiness judge adds a flag for each thing an item asks for that no cell may do: credentials
  or secrets, changes to CI or workflows, or access outside its own repo. Today the judge's prompt
  doesn't say whether that means what a cell needs to build the item or what the finished feature
  does once it runs. So the judge flags an item whose feature stores a credential or reads another
  repo, though a cell can build and test it with stand-ins and never touch a real credential or repo.
  With this item, the prompt tells the judge to flag a credential, a CI or workflow change, or access
  outside the item's repo only when a cell would need it to build or test the item. A feature that
  handles credentials or other repos once it runs is no flag when its tests use stand-ins. An item
  that asks a person to change a workflow, or asks a cell to use a real credential, is still flagged.
  Since the prompt is part of the readiness logic (PBI 149), the change re-checks every NotReady item.
  The judge is a model, so most scenarios read the prompt the factory gives it, for an item in a
  repo with the factory's default dor.md. Scenarios tagged @db need Postgres, which each test starts
  for itself, so cells and CI both run them. The board, the repo and the readiness judge are fakes.

  Rule: The judge flags a credential, a CI or workflow change, or outside access only when building or testing the item needs it

    @ac-1
    Scenario: The prompt asks for a flag only for what a cell would need to build or test the item
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt asks the judge to flag a credential or secret only when a cell would need it to build or test the item
      And the prompt asks the judge to flag a CI or workflow change only when a cell would need it to build or test the item
      And the prompt asks the judge to flag access outside the item's repo only when a cell would need it to build or test the item

    @ac-1
    Scenario: The prompt no longer flags everything an item mentions about credentials, CI or other repos
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt doesn't ask the judge to flag each thing the item asks for without saying it means what building or testing the item needs

    @ac-1
    Scenario: The rule holds for every item, whatever its text says
      Given an item in a repo with the factory's default dor.md, whose text says "Store the user's API token and read their other repos"
      When the factory writes the readiness judge's prompt for the item
      Then the prompt asks the judge to flag a credential or secret only when a cell would need it to build or test the item
      And the item's text appears only inside the fenced item data

  Rule: A feature that handles credentials or other repos once it runs is no flag when its tests use stand-ins

    @ac-2
    Scenario: The prompt says a feature that stores or uses credentials once it runs is no flag when its tests use stand-ins
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt says a feature that stores or uses credentials once it runs is not a flag when the item's tests use stand-ins

    @ac-2
    Scenario: The prompt says a feature that reads and writes other repos once it runs is no flag when its tests use stand-ins
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt says a feature that reads or writes other repos once it runs is not a flag when the item's tests use stand-ins

  Rule: An item that asks a person to change a workflow, or a cell to use a real credential, is still flagged

    @ac-3
    Scenario: The prompt still flags an item that asks a person to change a workflow
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt tells the judge to flag an item whose text asks a person to change a workflow

    @ac-3
    Scenario: The prompt still flags an item that asks a cell to use a real credential
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt tells the judge to flag an item whose text asks a cell to use a real credential

    @ac-3
    Scenario: The stand-in exception doesn't cover an item that asks a cell to use a real credential
      Given an item in a repo with the factory's default dor.md
      When the factory writes the readiness judge's prompt for the item
      Then the prompt says the stand-in exception doesn't apply when the item asks a cell to use a real credential

  Rule: The new prompt changes the readiness logic, so every NotReady item is checked again

    @ac-4
    Scenario: The factory's readiness logic now has a different fingerprint from the one before this item
      Given the readiness logic as it stood before this item, with the judge's prompt of that time
      When the factory computes its current readiness logic
      Then the current logic's fingerprint for a set of repo files differs from the earlier logic's fingerprint for the same files
      And the readiness version is the same as before this item

    @ac-4 @db
    Scenario: Every NotReady item checked under the earlier prompt is checked again on the next poll
      Given the factory holds two items in state "NotReady", checked under the judge's prompt as it stood before this item
      And neither the items nor the repo's readiness files change
      And the factory starts with its current readiness logic
      And the readiness judge now passes every line
      When the poller runs once
      Then both items are in state "Queued"
      And each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

    @ac-4 @db
    Scenario: A NotReady item still flagged under the new prompt comes back NotReady with a fresh comment
      Given the factory holds an item in state "NotReady", checked under the judge's prompt as it stood before this item
      And the factory starts with its current readiness logic
      And the readiness judge flags "asks a person to change a workflow"
      When the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows one move "policy_changed"
      And the readiness judge was asked about the item once
      And the board item has a new readiness comment naming the flag "asks a person to change a workflow"
