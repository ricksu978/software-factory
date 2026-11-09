@pbi-159
Feature: A change to the split prompt re-checks every NotReady item once, like a judge prompt change
  The factory fingerprints what its readiness check reads. Since PBI 149 that fingerprint covers
  the repo's readiness files, the judge's prompt and the readiness version, and a new fingerprint
  re-checks every NotReady item once. The readiness check also rests on the prompt the factory
  gives the coding model when it splits an oversized item, and the fingerprint leaves that prompt
  out. So when the factory ships a better split prompt, items it split under the old prompt keep
  the old proposal until someone edits them. And a split proposal is posted once per item text, so
  even a re-check wouldn't post a fresh one.
  With this item, the fingerprint covers the split prompt too. A change to it re-checks every
  NotReady item once, on the next poll, and an oversized item gets one fresh proposal written from
  the new prompt. A re-check for any other reason still posts no second proposal for item text
  already split under the same prompt.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board, the repo, the readiness judge and the coding model are fakes. The rest need no
  database.

  Rule: The readiness fingerprint covers the split prompt

    @ac-1
    Scenario: A different split prompt gives a different fingerprint for the same repo files and judge prompt
      Given one readiness check that reads a set of repo files with the factory's current logic
      And another that reads the same files with the same judge prompt and readiness version and a split prompt that differs by one word
      Then the two checks have different fingerprints

    @ac-1
    Scenario: The fingerprint with the split prompt differs from the one PBI 149 gave
      Given one readiness check that reads a set of repo files with the factory's current logic
      Then its fingerprint differs from the fingerprint of the same files with the judge prompt and readiness version alone

    @ac-1
    Scenario: The same split prompt gives the same fingerprint
      Given one readiness check that reads a set of repo files with the factory's current logic
      And another that reads the same files with the same logic and a split prompt that differs by one word
      And a third that reads the same files with the same logic and that same changed split prompt
      Then the second and third checks have the same fingerprint
      And the first and second checks have different fingerprints

  Rule: A new split prompt re-checks every NotReady item on the next poll, as a policy change

    @ac-2 @db
    Scenario: After a restart with a new split prompt, every NotReady item is re-checked as a policy change
      Given the factory holds two items in state "NotReady", checked against the repo's current readiness files
      And neither the items nor the repo's readiness files change
      And the factory restarts with a split prompt that differs by one word
      And the readiness judge now passes every line
      When the poller runs once
      Then both items are in state "Queued"
      And each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

    @ac-2 @db
    Scenario: An item that still fails after a new split prompt is re-checked and comes back NotReady with a fresh comment
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And neither the item nor the repo's readiness files change
      And the factory restarts with a split prompt that differs by one word
      And the readiness judge still fails line 1 because "Size is 8"
      When the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows one move "policy_changed"
      And the readiness judge was asked about the item once
      And the board item has a new readiness comment saying "Size is 8"

    @ac-2 @db
    Scenario: A new split prompt re-checks NotReady items in every repo the factory serves
      Given the factory holds an item in state "NotReady" in repo "acme/web" and another in repo "acme/api"
      And neither the items nor either repo's readiness files change
      And the factory restarts with a split prompt that differs by one word
      When the poller runs once
      Then each item's history shows one move "policy_changed"

    @ac-2 @db
    Scenario: A new split prompt re-checks only the NotReady items
      Given the factory holds an item "Login page" in state "NotReady", checked against the repo's current readiness files
      And the factory holds an item "Signup page" in state "Queued"
      And the factory restarts with a split prompt that differs by one word
      When the poller runs once
      Then the history of "Login page" shows one move "policy_changed"
      And the history of "Signup page" shows no new move
      And the readiness judge was not asked about "Signup page"

    @ac-2 @db
    Scenario: Later polls after a new split prompt don't re-check the item again
      Given the factory holds an item in state "NotReady", checked against the repo's current readiness files
      And the factory restarts with a split prompt that differs by one word
      And the readiness judge still fails every line
      When the poller runs three times
      Then the factory holds the item in state "NotReady"
      And the item's history shows exactly one move "policy_changed"
      And the readiness judge was asked about the item once

  Rule: An oversized item re-checked after a new split prompt gets one fresh proposal from the new prompt

    @ac-3 @db
    Scenario: An oversized NotReady item gets a fresh split proposal written from the new prompt
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And neither the item nor the repo's readiness files change
      And the readiness judge still fails line 1 because "No title" and still reports the item oversized
      And the coding model proposes a valid split
      And the factory restarts with a split prompt that differs by one word
      When the poller runs once
      Then the board item has two split proposal comments
      And the coding model was asked for a split of the item once since the restart
      And that request carries the new split prompt's wording

    @ac-3 @db
    Scenario: The fresh proposal lists the split the coding model gave under the new prompt
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the factory restarts with a split prompt that differs by one word
      And under that prompt the coding model proposes children "Card payments" and "Bank transfers"
      When the poller runs once
      Then the newest split proposal comment lists children "Card payments" and "Bank transfers"

    @ac-3 @db
    Scenario: Later polls after a new split prompt post no third proposal
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the coding model proposes a valid split
      And the factory restarts with a split prompt that differs by one word
      When the poller runs three times
      Then the board item has two split proposal comments

    @ac-3 @db
    Scenario: An oversized item whose new split is invalid gets no fresh proposal, and its readiness comment says why
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails line 1 because "No title" and still reports the item oversized
      And the factory restarts with a split prompt that differs by one word
      And under that prompt the coding model proposes a split which leaves criterion 4 to no child
      When the poller runs once
      Then the item's history shows one move "policy_changed"
      And the board item has one split proposal comment
      And the board item has a new readiness comment saying a split couldn't be proposed because criterion 4 goes to no child

    @ac-3 @db
    Scenario: An item the judge no longer finds oversized gets no fresh proposal
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the factory restarts with a split prompt that differs by one word
      And the readiness judge still fails every line but now reports the item not oversized
      When the poller runs once
      Then the item's history shows one move "policy_changed"
      And the coding model was not asked for a split since the restart
      And the board item has one split proposal comment

  Rule: A re-check from any other cause posts no second proposal for item text already split under the same prompt

    @ac-4 @db @regression
    Scenario: A dor.md change re-checks an oversized item but posts no second proposal
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the coding model proposes a valid split
      And the item's text doesn't change
      And the repo's dor.md changes
      When the poller runs once
      Then the item's history shows one move "policy_changed"
      And the board item has one split proposal comment

    @ac-4 @db @regression
    Scenario: A new judge prompt re-checks an oversized item but posts no second proposal
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the coding model proposes a valid split
      And the item's text doesn't change
      And the factory restarts with a judge prompt that differs by one word and the same split prompt
      When the poller runs once
      Then the item's history shows one move "policy_changed"
      And the board item has one split proposal comment

    @ac-4 @db
    Scenario: A dor.md change after a split prompt change posts no proposal beyond the fresh one
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the coding model proposes a valid split
      And the item's text doesn't change
      And the factory restarts with a split prompt that differs by one word
      And the poller runs once
      When the repo's dor.md changes
      And the poller runs once
      Then the item's history shows exactly two moves "policy_changed"
      And the board item has two split proposal comments

  Rule: A restart with an unchanged split prompt re-checks nothing and posts no split comment

    @ac-5 @db
    Scenario: A restart after a split prompt change was taken up re-checks nothing more
      Given the factory holds an oversized item in state "NotReady" that already has one split proposal comment
      And the readiness judge still fails every line and still reports the item oversized
      And the coding model proposes a valid split
      And the factory restarts with a split prompt that differs by one word
      And the poller runs once
      When the factory restarts again with the same split prompt, judge prompt and readiness version
      And the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows exactly one move "policy_changed"
      And the readiness judge was asked about the item once since the first restart
      And the board item has two split proposal comments
