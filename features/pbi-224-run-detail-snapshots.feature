@pbi-224
Feature: Run detail keeps a snapshot of the criteria and scenarios a run was signed off on
  Run detail used to read the item's acceptance criteria and the run's feature files from GitHub on
  every view. The redesign moves that read to one moment: when a cell reports its scenarios written,
  the cell API records the run's scenarios sha, and with this item it also stores the item's
  acceptance criteria and the text of each locked file at that sha. Run detail then reads only the
  factory's own database. A changes round can send a new scenarios sha with a different list of
  files, so each new sha replaces that run's earlier snapshot.
  Runs that recorded a scenarios sha before this item have no snapshot. A one-off worker command
  reads theirs from GitHub once. It skips a run that already has its files stored, so running it
  again changes nothing.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board and the repo are fakes.

  Background:
    Given a repo "acme/shop" on a board whose opt-in label is "factory"
    And an issue "Card payments" in "acme/shop" whose acceptance criteria are "A customer can pay by card" and "A declined card shows why"

  Rule: Recording a run's scenarios sha stores the item's criteria and each locked file's text at that sha

    @ac-1 @db
    Scenario: A cell's scenarios, once written, are stored with the item's criteria
      Given the factory holds "Card payments" in progress, with a cell working on its run
      And "acme/shop" holds "features/pay.feature" and "features/decline.feature" at commit "abc123"
      When the cell reports its scenarios written at commit "abc123", locking "features/pay.feature" and "features/decline.feature"
      Then the run's stored acceptance criteria are "A customer can pay by card" and "A declined card shows why", in that order
      And the run's stored files are "features/decline.feature" and "features/pay.feature", each at commit "abc123"
      And each stored file's text is that file's text in "acme/shop" at commit "abc123"

    @ac-1 @db
    Scenario: The owner sees the stored criteria and scenarios at sign-off without the factory reading GitHub
      Given the factory holds "Card payments" in progress, with a cell working on its run
      And "acme/shop" holds "features/pay.feature" at commit "abc123", with a scenario tagged @ac-1 named "Paying by card"
      And the cell has reported its scenarios written at commit "abc123", locking "features/pay.feature"
      And the repo stops answering every read
      When the owner opens Run detail for "Card payments"
      Then Run detail lists the criterion "A customer can pay by card" with the scenario "Paying by card" under it
      And Run detail shows the text of "features/pay.feature" at commit "abc123"
      And Run detail offers the owner the Sign off form

    @ac-1 @db
    Scenario: A new scenarios sha replaces the run's earlier snapshot, dropping a file no longer locked
      Given the factory holds "Card payments" in progress, with a cell working on its run
      And "acme/shop" holds "features/pay.feature" and "features/decline.feature" at commit "abc123"
      And the cell has reported its scenarios written at commit "abc123", locking "features/pay.feature" and "features/decline.feature"
      And the owner asked for changes to the scenarios
      And "acme/shop" holds a changed "features/pay.feature" and a new "features/refund.feature" at commit "def456"
      When the cell reports its scenarios written at commit "def456", locking "features/pay.feature" and "features/refund.feature"
      Then the run's stored files are "features/pay.feature" and "features/refund.feature", each at commit "def456"
      And the stored text of "features/pay.feature" is its changed text at commit "def456"
      And the run has no stored file "features/decline.feature"

    @ac-1 @db
    Scenario: A new scenarios sha stores the item's criteria as they read at that moment
      Given the factory holds "Card payments" in progress, with a cell working on its run
      And "acme/shop" holds "features/pay.feature" at commit "abc123" and at commit "def456"
      And the cell has reported its scenarios written at commit "abc123", locking "features/pay.feature"
      And the issue's acceptance criteria were then changed to "A customer can pay by card" and "A refund returns the money"
      When the cell reports its scenarios written at commit "def456", locking "features/pay.feature"
      Then the run's stored acceptance criteria are "A customer can pay by card" and "A refund returns the money", in that order

    @ac-1 @db
    Scenario: Replacing one run's snapshot leaves every other run's snapshot as it was
      Given an issue "Bank transfers" in "acme/shop" whose acceptance criteria are "A customer can pay by transfer"
      And the factory holds "Card payments" and "Bank transfers" in progress, each with a cell working on its run
      And "acme/shop" holds "features/pay.feature" and "features/transfer.feature" at commit "abc123" and at commit "def456"
      And the cell on "Bank transfers" has reported its scenarios written at commit "abc123", locking "features/transfer.feature"
      And the cell on "Card payments" has reported its scenarios written at commit "abc123", locking "features/pay.feature"
      When the cell on "Card payments" reports its scenarios written at commit "def456", locking "features/pay.feature"
      Then the run of "Bank transfers" still stores "features/transfer.feature" at commit "abc123"
      And the run of "Bank transfers" still stores the acceptance criterion "A customer can pay by transfer"

    @ac-1 @db
    Scenario: A refused report of new scenarios leaves the run's earlier snapshot in place
      Given the factory holds "Card payments" in progress, with a cell working on its run
      And "acme/shop" holds "features/pay.feature" at commit "abc123"
      And the cell has reported its scenarios written at commit "abc123", locking "features/pay.feature"
      When the cell reports its scenarios written at commit "def456", locking no files
      Then the cell API refuses the report
      And the run's stored files are "features/pay.feature", at commit "abc123"
      And the run's stored acceptance criteria are "A customer can pay by card" and "A declined card shows why", in that order

  Rule: A one-off worker command fills the snapshot of every earlier run that has a scenarios sha and none stored

    @ac-2 @db
    Scenario: The backfill fills each run that has a scenarios sha and no stored files, and only those
      Given an issue "Bank transfers" in "acme/shop" whose acceptance criteria are "A customer can pay by transfer"
      And an issue "Payment receipts" in "acme/shop" whose acceptance criteria are "A receipt follows each payment"
      And "acme/shop" holds "features/pay.feature" and "features/decline.feature" at commit "abc123"
      And a run of "Card payments" that recorded scenarios sha "abc123", locking "features/pay.feature" and "features/decline.feature", before snapshots were stored
      And a run of "Payment receipts" that never recorded a scenarios sha
      When the operator runs the snapshot backfill
      Then the run of "Card payments" stores the acceptance criteria "A customer can pay by card" and "A declined card shows why", in that order
      And the run of "Card payments" stores "features/decline.feature" and "features/pay.feature", each at commit "abc123", with their text in "acme/shop" at that commit
      And the run of "Payment receipts" stores no acceptance criteria and no files

    @ac-2 @db
    Scenario: The backfill leaves a run whose snapshot is already stored as it was
      Given "acme/shop" holds "features/pay.feature" at commit "abc123"
      And the factory holds "Card payments" in progress, with a cell working on its run
      And the cell has reported its scenarios written at commit "abc123", locking "features/pay.feature"
      And "features/pay.feature" at commit "abc123" in "acme/shop" now reads differently
      And the issue's acceptance criteria were then changed to "A customer can pay by card"
      When the operator runs the snapshot backfill
      Then the stored text of "features/pay.feature" is still the text it had when the cell reported its scenarios
      And the run's stored acceptance criteria are still "A customer can pay by card" and "A declined card shows why"

    @ac-2 @db
    Scenario: Running the backfill a second time changes nothing
      Given "acme/shop" holds "features/pay.feature" at commit "abc123"
      And a run of "Card payments" that recorded scenarios sha "abc123", locking "features/pay.feature", before snapshots were stored
      And the operator has run the snapshot backfill once
      And "features/pay.feature" at commit "abc123" in "acme/shop" now reads differently
      And the issue's acceptance criteria were then changed to "A customer can pay by card"
      When the operator runs the snapshot backfill again
      Then the stored text of "features/pay.feature" is still the text the first backfill stored
      And the run's stored acceptance criteria are still "A customer can pay by card" and "A declined card shows why"
      And the second backfill reports that it filled no runs

    @ac-2 @db
    Scenario: A run the backfill couldn't read is left unfilled, so the next backfill fills it
      Given an issue "Bank transfers" in "acme/shop" whose acceptance criteria are "A customer can pay by transfer"
      And "acme/shop" holds "features/pay.feature" and "features/transfer.feature" at commit "abc123"
      And a run of "Card payments" that recorded scenarios sha "abc123", locking "features/pay.feature", before snapshots were stored
      And a run of "Bank transfers" that recorded scenarios sha "abc123", locking "features/transfer.feature", before snapshots were stored
      And the repo refuses every read of "features/transfer.feature"
      When the operator runs the snapshot backfill
      Then the run of "Card payments" stores "features/pay.feature" at commit "abc123"
      And the run of "Bank transfers" stores no acceptance criteria and no files
      And the backfill reports that it couldn't fill the run of "Bank transfers"
      When the repo answers reads again
      And the operator runs the snapshot backfill again
      Then the run of "Bank transfers" stores "features/transfer.feature" at commit "abc123", with its text in "acme/shop" at that commit
