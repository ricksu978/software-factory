@pbi-95 @db
Feature: Migrate writes each repo's trusted bot, so the factory knows its own App
  The factory trusts its own App's comments and ignores its own PR closes, and it finds that App
  through the repo's trusted bot. Until now nothing wrote it. A source entry in the sources file can
  now name the App's bot login, and each migrate run writes that login to the entry's repo. An entry
  that names no bot login leaves the repo's trusted bot as it was. This repo's own sources file names
  "ricksu978-software-factory[bot]", the bot login of the App the platform spike set up.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: A source entry that names a bot login sets its repo's trusted bot

    @ac-1
    Scenario: A new repo gets the bot login its entry names
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      When migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "factory-app[bot]"

    @ac-1
    Scenario: A later run with a different bot login replaces the earlier one
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      And migrate has run against that sources file
      When the entry for "o/r" names the bot login "renamed-app[bot]" instead
      And migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "renamed-app[bot]"

    @ac-1
    Scenario: Running again with the same bot login keeps it
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      And migrate has run against that sources file
      When migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "factory-app[bot]"

    @ac-1
    Scenario: Each entry's bot login goes to its own repo only
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      And the same sources file has an entry for "o/other" that names the bot login "other-app[bot]"
      When migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "factory-app[bot]"
      And the repo "o/other" has the trusted bot "other-app[bot]"

  Rule: A source entry that names no bot login leaves its repo's trusted bot alone

    @ac-2
    Scenario: Dropping the bot login from an entry keeps the login an earlier run wrote
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      And migrate has run against that sources file
      When the entry for "o/r" no longer names a bot login
      And migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "factory-app[bot]"

    @ac-2
    Scenario: An entry without a bot login leaves its neighbour's bot login untouched
      Given a sources file whose entry for "o/r" names the bot login "factory-app[bot]"
      And the same sources file has an entry for "o/other" that names no bot login
      When migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "factory-app[bot]"
      And the repo "o/other" has no trusted bot

    @ac-2 @regression
    Scenario: A trusted bot stored some other way survives an entry without a bot login
      Given the repo "o/r" already has the trusted bot "hand-set-app[bot]"
      And a sources file whose entry for "o/r" names no bot login
      When migrate runs against that sources file
      Then the repo "o/r" has the trusted bot "hand-set-app[bot]"

  Rule: This repo's sources file names the factory's own App

    @ac-3
    Scenario: This repo's sources file names the App's bot login
      When this repo's sources file is read
      Then its entry for "ricksu978/software-factory" names the bot login "ricksu978-software-factory[bot]"

    @ac-3
    Scenario: Migrate against this repo's sources file gives this repo the App as its trusted bot
      When migrate runs against this repo's sources file
      Then the repo "ricksu978/software-factory" has the trusted bot "ricksu978-software-factory[bot]"
