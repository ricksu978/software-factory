@pbi-354 @db
Feature: A red-main bug item names the spec section it implements, so the readiness gate passes it
  When a merge breaks main, the factory files a bug item (PBI 255). Its body names the merge commit, the PR and item
  it came from, the failed checks and the failing tests, and gives one acceptance criterion: CI passes on main again.
  It doesn't name the plan task or spec section it implements, and the Definition of Ready asks every item to name
  one, so the readiness gate fails the very item the factory has to fix first.
  With this item, the body of every such bug item says it implements the design spec's §10 "Red main" rule: the
  rule under §10 Failure and recovery that tells the factory to compare a red merge with its first parent and file a
  bug item when the merge broke main.
  In every scenario, GitHub, the board and CI are fakes, as in PBI 255. The repo is "acme/widgets" and its main
  branch is "main". Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory holds item 482 in state "Accepted" after its PR 57 merged into "main" as commit "m3rg001"
    And commit "m3rg001"'s first parent on "main" is commit "p4r3nt1"

  Rule: The bug item the factory files for a merge that broke main names spec §10's "Red main" rule as what it implements

    @ac-1
    Scenario: A red merge onto a green main files a bug item that says it implements spec §10 "Red main"
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      When the poller runs once
      Then the factory has filed exactly one bug item
      And the bug item's body says it implements the design spec's §10 "Red main" rule

    @ac-1
    Scenario: The section the bug item names is the design spec's section that holds the Red main rule
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "test" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/901"
      When the poller runs once
      Then the spec section the bug item's body says it implements is a section of the design spec
      And that section of the design spec holds the "Red main" rule

    @ac-1
    Scenario: A bug item whose failed check's log names no test still names spec §10 "Red main"
      Given CI passed every check on commit "p4r3nt1"
      And CI failed the check "build" on commit "m3rg001", with the URL "https://github.com/acme/widgets/runs/904"
      And the log of the check "build" on commit "m3rg001" names no failing test
      When the poller runs once
      Then the bug item names no failing test
      And the bug item's body says it implements the design spec's §10 "Red main" rule

    @ac-1
    Scenario: A bug item for several failed checks names spec §10 "Red main" once, apart from the checks and tests
      Given CI passed every check on commit "p4r3nt1"
      And CI ran these checks on commit "m3rg001":
        | check | result  | url                                       |
        | test  | failure | https://github.com/acme/widgets/runs/901  |
        | bdd   | failure | https://github.com/acme/widgets/runs/902  |
        | lint  | success | https://github.com/acme/widgets/runs/903  |
      And the log of the check "test" on commit "m3rg001" names the failing tests "parses the config" and "reads the board"
      When the poller runs once
      Then the bug item's body says it implements the design spec's §10 "Red main" rule
      And the bug item's body names spec §10 "Red main" exactly once
      And no failed check's line and no failing test's line in the bug item names spec §10

