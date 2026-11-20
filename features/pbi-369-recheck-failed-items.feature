@pbi-369 @db
Feature: The factory re-checks Failed items every few hours and moves one back when its DoD failure no longer stands
  An Accepted item goes to Failed with the event "dod_failed" when the factory's post-merge rules say its merge
  broke main. Those rules have changed since some items failed. Since PBI 255, a red merge commit whose first
  parent failed the same checks means main was already red, so the item waits on main and isn't charged. An item
  charged under the older rules, such as #222, stays Failed though today's rules would not charge it. CI on a
  merge commit can also pass when it's run again.
  With this item, every `failed_recheck_hours` hours the factory re-checks each item that went to Failed with
  "dod_failed". The key lives in the repo's ".factory/config.yml", and it's 8 when the key is missing. A re-check
  runs today's post-merge rules on the item's merge commit, the same ones an Accepted item gets. When they no
  longer say the merge broke main, the item goes from Failed to Accepted with the event "rechecked", and the
  item gets a comment that says why. From Accepted it waits on main, or goes to Done, as today. When the rules
  still say the merge broke main, the item stays Failed and nothing is commented. Floor and Run detail show when
  each Failed item was last re-checked.
  Unless a scenario says otherwise, the repo is "acme/widgets", its main branch is "main", and its
  ".factory/config.yml" has no `failed_recheck_hours` key. Item 482's PR 57 merged into "main" as commit
  "m3rg001", whose first parent on "main" is commit "p4r3nt1". Item 482 went to Failed with the event
  "dod_failed" at 2026-11-20 08:00 UTC, when CI failed the check "ci" on "m3rg001" after CI passed it on
  "p4r3nt1". GitHub, CI, the board and the clock are fakes. Every scenario needs Postgres, which each test starts
  for itself, so cells and CI both run them.

  Background:
    Given the factory holds item 482 in state "Failed" after the event "dod_failed" at "2026-11-20 08:00" UTC
    And item 482's PR 57 merged into "main" as commit "m3rg001"
    And commit "m3rg001"'s first parent on "main" is commit "p4r3nt1"

  Rule: Every `failed_recheck_hours` hours the factory re-checks each item that went to Failed with "dod_failed", and the key is 8 when it's missing

    @ac-1
    Scenario: With no key set, an item is first re-checked 8 hours after it failed, and not before
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 15:59" UTC
      And the poller runs at "2026-11-20 16:00" UTC
      Then item 482 has been re-checked exactly once
      And item 482 was last re-checked at "2026-11-20 16:00" UTC

    @ac-1
    Scenario: With no key set, an item is re-checked again every 8 hours while it stays Failed
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs every 10 minutes from "2026-11-20 08:10" to "2026-11-21 08:10" UTC
      Then item 482 has been re-checked exactly 3 times
      And item 482 was re-checked at "2026-11-20 16:00", "2026-11-21 00:00" and "2026-11-21 08:00" UTC

    @ac-1
    Scenario: The repo's `failed_recheck_hours` sets how often an item is re-checked
      Given the repo's ".factory/config.yml" sets `failed_recheck_hours` to 2
      And CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs every 10 minutes from "2026-11-20 08:10" to "2026-11-20 14:10" UTC
      Then item 482 has been re-checked exactly 3 times
      And item 482 was re-checked at "2026-11-20 10:00", "2026-11-20 12:00" and "2026-11-20 14:00" UTC

    @ac-1
    Scenario: An item that went to Failed for another reason isn't re-checked
      Given the factory holds item 483 in state "Failed" after the event "retries_exhausted" at "2026-11-20 08:00" UTC
      And CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then item 482 was last re-checked at "2026-11-20 16:00" UTC
      And item 483 has never been re-checked
      And the factory holds item 483 in state "Failed"

  Rule: When today's post-merge rules no longer say the merge broke main, the item goes from Failed to Accepted with the event "rechecked", and the item gets a comment saying why

    @ac-2
    Scenario: A merge onto a main that was already red goes back to Accepted and waits on main
      Given CI failed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows a move from "Failed" to "Accepted" with the event "rechecked"
      And item 482 waits on "main"

    @ac-2
    Scenario: The comment says main was already red, naming the merge commit and its first parent
      Given CI failed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then item 482 has exactly one new comment
      And the comment says the re-check found "main" was already red
      And the comment names the merge commit "m3rg001" and its first parent "p4r3nt1"
      And the comment says the item is Accepted and waits on "main"

    @ac-2
    Scenario: An item waiting on main after a re-check goes to Done once CI passes on a later main commit that contains its merge
      Given CI failed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      And the poller ran at "2026-11-20 16:00" UTC
      And "main" gains commit "l4t3r01", which contains "m3rg001"
      And CI passed every check on commit "l4t3r01"
      When the poller runs at "2026-11-20 16:10" UTC
      Then the factory holds item 482 in state "Done"
      And item 482's history shows the moves "Failed" to "Accepted" to "Done", in that order

    @ac-2
    Scenario: A merge commit whose CI now passes goes back to Accepted and then to Done
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI on commit "m3rg001" was run again and passed every check
      When the poller runs at "2026-11-20 16:00" UTC
      And the poller runs at "2026-11-20 16:10" UTC
      Then item 482's history shows a move from "Failed" to "Accepted" with the event "rechecked"
      And the factory holds item 482 in state "Done"
      And item 482 has a new comment that says CI now passes on the merge commit "m3rg001"

    @ac-2
    Scenario: A merge commit whose only unpassed checks were cancelled goes back to Accepted and waits on main
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI's check "ci" on commit "m3rg001" was cancelled, and no check failed on it
      When the poller runs at "2026-11-20 16:00" UTC
      Then the factory holds item 482 in state "Accepted"
      And item 482's history shows a move from "Failed" to "Accepted" with the event "rechecked"
      And item 482 waits on "main"
      And item 482 has a new comment that says CI on the merge commit "m3rg001" was cancelled and no check failed

    @ac-2
    Scenario: An item moved back by a re-check is commented on once, however many times the poller runs
      Given CI failed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs every 10 minutes from "2026-11-20 16:00" to "2026-11-21 08:00" UTC
      Then item 482 has exactly one new comment
      And item 482's history shows exactly one move with the event "rechecked"
      And the factory holds item 482 in state "Accepted"

  Rule: When today's rules still say the merge broke main, the item stays Failed and nothing is commented

    @ac-3
    Scenario: A merge that still broke main stays Failed, and the re-check leaves no comment
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      When the poller runs at "2026-11-20 16:00" UTC
      Then item 482 was last re-checked at "2026-11-20 16:00" UTC
      And the factory holds item 482 in state "Failed"
      And item 482 has no new comment
      And item 482's history shows no move after "2026-11-20 08:00" UTC

    @ac-3
    Scenario: Re-checks that change nothing file no second bug item and make no noise over a day
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      And the factory filed one bug item for the break at "m3rg001" when item 482 failed
      When the poller runs every 10 minutes from "2026-11-20 08:10" to "2026-11-21 08:10" UTC
      Then item 482 has been re-checked exactly 3 times
      And the factory holds item 482 in state "Failed"
      And item 482 has no new comment
      And the factory has filed exactly one bug item

  Rule: Replaying #222's case moves it from Failed to Accepted, and then to Done once main is green

    Background:
      Given the repo is "ricksu978/software-factory"
      And the factory holds item 222 in state "Failed" after the event "dod_failed" at "2026-11-10 12:00" UTC
      And item 222's PR 250 merged into "main" as commit "d93b936"
      And commit "d93b936"'s first parent on "main" is commit "8d4fe69"
      And CI failed the check "ci" on commit "8d4fe69"
      And CI failed the check "ci" on commit "d93b936"

    @ac-4
    Scenario: #222 is re-checked and goes from Failed to Accepted, waiting on main
      When the poller runs at "2026-11-20 16:00" UTC
      Then the factory holds item 222 in state "Accepted"
      And item 222's history shows a move from "Failed" to "Accepted" with the event "rechecked"
      And item 222 waits on "main"
      And item 222 has a new comment that names the merge commit "d93b936" and its first parent "8d4fe69"

    @ac-4
    Scenario: #222 goes to Done once CI passes on a later main commit that contains its merge
      Given the poller ran at "2026-11-20 16:00" UTC
      And "main" gains commit "3df4f2e", which contains "d93b936"
      And CI passed every check on commit "3df4f2e"
      When the poller runs at "2026-11-20 16:10" UTC
      Then the factory holds item 222 in state "Done"
      And item 222's history shows the moves "Failed" to "Accepted" to "Done", in that order

  Rule: Floor and Run detail show when each Failed item was last re-checked

    @ac-5
    Scenario: Floor shows when a Failed item was last re-checked
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      And the poller ran at "2026-11-20 16:00" UTC
      And an operator whose time zone is UTC is signed in
      When the operator opens Floor
      Then Floor shows item 482 as last re-checked at "2026-11-20 16:00"

    @ac-5
    Scenario: Run detail shows when a Failed item was last re-checked
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      And the poller ran at "2026-11-20 16:00" UTC
      And an operator whose time zone is UTC is signed in
      When the operator opens item 482's Run detail
      Then Run detail shows the item was last re-checked at "2026-11-20 16:00"

    @ac-5
    Scenario: Floor and Run detail show the newest re-check after one that changed nothing
      Given CI passed the check "ci" on commit "p4r3nt1"
      And CI failed the check "ci" on commit "m3rg001"
      And the poller ran at "2026-11-20 16:00" UTC
      And the poller ran at "2026-11-21 00:00" UTC
      And an operator whose time zone is UTC is signed in
      When the operator opens Floor
      And the operator opens item 482's Run detail
      Then Floor shows item 482 as last re-checked at "2026-11-21 00:00"
      And Run detail shows the item was last re-checked at "2026-11-21 00:00"

    @ac-5
    Scenario: A Failed item not yet re-checked says so on Floor and Run detail
      Given an operator whose time zone is UTC is signed in
      When the operator opens Floor
      And the operator opens item 482's Run detail
      Then Floor shows item 482 as not yet re-checked
      And Run detail shows the item hasn't been re-checked yet
