@pbi-255 @db
Feature: A red main after a merge files a bug item the factory fixes first, and only the merge that broke it is charged
  Today an Accepted item whose merge commit fails CI on main moves to Failed, and the factory comments on the
  item. Nothing tells the factory to fix main, and every later merge on a red main fails too, so each of those
  items is charged for a failure it didn't cause.
  With this item, the factory compares CI on a red merge commit with CI on that commit's first parent, the main
  commit it was merged onto. When the first parent passed, the merge broke main: the item is charged, and the
  factory files one bug item with the opt-in label that names the merge commit, the PR and item it came from,
  each failed check with its URL, and the failing tests where the check's log names them. That bug item is the
  next item claimed, ahead of the rest of the queue. When the first parent failed the same checks, main was
  already red: the item isn't charged, stays Accepted and waits on main, and no second bug item is filed. Once
  CI passes on a main commit that contains a waiting item's merge commit, that item moves to Done. While main is
  red, the Floor says so and names the commit that broke it and its bug item.
  In every scenario, GitHub, the board and CI are fakes. The repo is "acme/widgets" and its main branch is
  "main". Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory holds item 482 in state "Accepted" after its PR 57 merged into "main" as commit "m3rg001"
    And commit "m3rg001"'s first parent on "main" is commit "p4r3nt1"

  Rule: A merge commit that fails CI after its first parent passed is charged, and the factory files one bug item for it

    @ac-1
    Scenario: A red merge onto a green main files one bug item with the opt-in label and charges the item
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      When the poller runs once
      Then the factory has filed exactly one bug item
      And the bug item carries the "factory" label
      And the factory holds item 482 in state "Failed"

    @ac-1
    Scenario: The bug item names the merge commit, the PR and the item it came from
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      When the poller runs once
      Then the bug item names the merge commit "m3rg001"
      And the bug item names PR 57
      And the bug item names item 482

    @ac-1
    Scenario: The bug item names each failed check with its URL, and no check that passed
      Given CI passed every check on commit "p4r3nt1"
      And CI ran these checks on commit "m3rg001":
        | check | result  | url                                       |
        | test  | failure | https://github.com/acme/widgets/runs/901  |
        | bdd   | failure | https://github.com/acme/widgets/runs/902  |
        | lint  | success | https://github.com/acme/widgets/runs/903  |
      When the poller runs once
      Then the bug item names the failed check "test" with the URL "https://github.com/acme/widgets/runs/901"
      And the bug item names the failed check "bdd" with the URL "https://github.com/acme/widgets/runs/902"
      And the bug item doesn't name the check "lint"

    @ac-1
    Scenario: The bug item names the failing tests the check's log names
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      And the log of the check "test" on commit "m3rg001" names the failing tests "parses the config" and "reads the board"
      When the poller runs once
      Then the bug item names the failing test "parses the config"
      And the bug item names the failing test "reads the board"

    @ac-1
    Scenario: A failed check whose log names no test still files the bug item, with the check and no tests
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "build" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/904"
      And the log of the check "build" on commit "m3rg001" names no failing test
      When the poller runs once
      Then the factory has filed exactly one bug item
      And the bug item names the failed check "build" with the URL "https://github.com/acme/widgets/runs/904"
      And the bug item names no failing test

    @ac-1
    Scenario: A second poll after the bug item is filed files no second one
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      When the poller runs twice
      Then the factory has filed exactly one bug item
      And item 482's history shows exactly one move to "Failed"

    @ac-1
    Scenario: A merge that fails a check its first parent passed is charged, even when the first parent failed another check
      Given CI failed the check "lint" on commit "p4r3nt1" and passed the check "test"
      And CI failed the checks "lint" and "test" on commit "m3rg001"
      When the poller runs once
      Then the factory has filed exactly one bug item
      And the bug item names the failed check "test"
      And the factory holds item 482 in state "Failed"

  Rule: The bug item is claimed next, ahead of the rest of the queue

    @ac-2
    Scenario: The bug item is claimed before Queued items with a higher priority and a better backlog rank
      Given the factory holds item 490 in state "Queued" with priority 9 and backlog rank 1
      And the factory holds item 491 in state "Queued" with priority 5 and backlog rank 2
      And the factory holds, in state "Queued", the bug item it filed because commit "m3rg001" broke "main"
      When the scheduler claims the next item
      Then the bug item is the item claimed
      And the factory holds item 490 in state "Queued"
      And the factory holds item 491 in state "Queued"

    @ac-2
    Scenario: The Floor's "Production Line" list shows the bug item first to claim
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And the factory holds item 490 in state "Queued" with priority 9 and backlog rank 1
      And the factory holds, in state "Queued", the bug item it filed because commit "m3rg001" broke "main"
      When "octo" opens the Floor
      Then the first item to claim in the Floor's "Production Line" list is the bug item
      And item 490 comes after it

    @ac-2
    Scenario: Once the bug item is claimed, the rest of the queue is claimed in its usual order
      Given the factory holds item 490 in state "Queued" with priority 9 and backlog rank 1
      And the factory holds item 491 in state "Queued" with priority 5 and backlog rank 2
      And the factory holds, in state "Queued", the bug item it filed because commit "m3rg001" broke "main"
      When the scheduler claims the next item
      And the scheduler claims the next item again
      Then the first item claimed is the bug item
      And the second item claimed is item 490

  Rule: A merge onto a main already red with the same checks isn't charged, waits on main, and files no second bug item

    @ac-3
    Scenario: A merge commit failing the same checks as its first parent leaves the item Accepted
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/905"
      When the poller runs once
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows no move to "Failed"
      And item 482 waits on "main"

    @ac-3
    Scenario: A merge onto a main already red, whose break filed a bug item, files no second bug item
      Given item 480's merge commit "p4r3nt1" broke "main" and the factory filed a bug item for it
      And CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/905"
      When the poller runs once
      Then the factory has filed exactly one bug item
      And that bug item names the merge commit "p4r3nt1"
      And the factory holds item 482 in state "Accepted"

    @ac-3
    Scenario: The factory doesn't comment on the waiting item that it failed its Definition of Done
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/905"
      When the poller runs once
      Then item 482 has no comment saying it failed its Definition of Done

    @ac-3
    Scenario: A waiting item stays Accepted over later polls while main stays red
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/905"
      When the poller runs 3 times
      Then the factory holds item 482 in state "Accepted"
      And the factory has filed no bug item

  Rule: A waiting item moves to Done once CI passes on a main commit that contains its merge commit

    @ac-4
    Scenario: CI passing on a later main commit moves the waiting item to Done
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001"
      And item 482 waits on "main" because commit "p4r3nt1" failed the same checks
      And commit "f1x0001" lands on "main" after commit "m3rg001"
      And CI passed every check on commit "f1x0001"
      When the poller runs once
      Then the factory holds item 482 in state "Done"

    @ac-4
    Scenario: A later main commit that is still red leaves the waiting item Accepted
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001"
      And item 482 waits on "main" because commit "p4r3nt1" failed the same checks
      And commit "n3xt001" lands on "main" after commit "m3rg001"
      And CI failed the check "test" on commit "n3xt001"
      When the poller runs once
      Then the factory holds item 482 in state "Accepted"

    @ac-4
    Scenario: A green commit that doesn't contain the waiting item's merge commit leaves it Accepted
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001"
      And item 482 waits on "main" because commit "p4r3nt1" failed the same checks
      And CI passed every check on commit "p4r3nt1"'s first parent "0ld0001"
      When the poller runs once
      Then the factory holds item 482 in state "Accepted"

    @ac-4
    Scenario: One green main commit moves every item waiting on main to Done
      Given CI failed the check "test" on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001"
      And the factory holds item 483 in state "Accepted" after its PR 58 merged into "main" as commit "m3rg002" after commit "m3rg001"
      And CI failed the check "test" on commit "m3rg002"
      And items 482 and 483 wait on "main" because commit "p4r3nt1" failed the same checks
      And commit "f1x0001" lands on "main" after commit "m3rg002"
      And CI passed every check on commit "f1x0001"
      When the poller runs once
      Then the factory holds item 482 in state "Done"
      And the factory holds item 483 in state "Done"

  Rule: The Floor shows that main is red, with the commit that broke it and its bug item, until CI on main passes again

    @ac-5
    Scenario: The Floor says main is red and names the commit that broke it and its bug item
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      And the poller has run once
      When "octo" opens the Floor
      Then the Floor says "main" is red
      And that notice names the commit "m3rg001"
      And that notice names the bug item

    @ac-5
    Scenario: A later red merge that isn't charged leaves the notice naming the commit that broke main
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      And the poller has run once
      And the factory holds item 483 in state "Accepted" after its PR 58 merged into "main" as commit "m3rg002" after commit "m3rg001"
      And CI failed the check "test" on commit "m3rg002"
      And the poller has run again
      When "octo" opens the Floor
      Then the Floor says "main" is red
      And that notice names the commit "m3rg001"
      And that notice doesn't name the commit "m3rg002"

    @ac-5
    Scenario: The Floor stops saying main is red once CI on main passes again
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      And the poller has run once
      When "octo" opens the Floor
      Then the Floor says "main" is red
      When commit "f1x0001" lands on "main" after commit "m3rg001"
      And CI passed every check on commit "f1x0001"
      And the poller runs once
      And "octo" opens the Floor
      Then the Floor doesn't say "main" is red
