@pbi-261
Feature: The worker reads default policies from main's fetched commit, so a merged policy change takes effect without a restart
  A repo with no `.factory/<name>.md` of its own uses the factory's default from `policy/`. Today the
  worker reads those defaults from the operator's checkout on disk, both for the readiness fingerprint
  and for the criteria the readiness gate checks. So a change to a default policy merged to `main`
  doesn't count until someone pulls it into the checkout and restarts, while a local edit nobody merged
  counts at once. With this item the worker reads each default policy from the commit of `main` it last
  fetched, the same commit it builds the cell image from. A merged change to a default policy then
  re-checks every NotReady item on the next poll, as a change to a repo's own policy file does, with no
  restart of the worker or the control plane, and Floor asks for no restart. Cells keep reading the
  defaults baked into their image.
  These scenarios run the worker against a fake `main` (a bare repo the operator's checkout fetches
  from), a fake board, a fake readiness judge and a fake cell launcher, so cells and CI both run them.
  Repo "acme/web" has no readiness files of its own, so it uses every default policy.

  Background:
    Given the factory serves repo "acme/web", which has no policy files of its own
    And the worker last fetched `main` at commit "aaa111"
    And the default "dor.md" at commit "aaa111" holds the line "Size is 5 or less"

  Rule: The readiness gate checks the default criteria from main's fetched commit, not from the checkout's disk

    @ac-1
    Scenario: The gate checks a new item against the default dor.md on main, not an uncommitted edit in the checkout
      Given the operator's checkout has an uncommitted edit to "policy/dor.md" that adds the line "Has a designer's sign-off"
      And a new item "A" in repo "acme/web" arrives on the board
      When the poller runs once
      Then the readiness judge was asked about the line "Size is 5 or less" for item "A"
      And the readiness judge was not asked about the line "Has a designer's sign-off"

    @ac-1
    Scenario: The gate checks a new item against a default dor.md merged to main that the checkout hasn't pulled
      Given `main` gains commit "bbb222" whose default "dor.md" adds the line "Names the user it serves"
      And the operator's checkout still holds the default "dor.md" from commit "aaa111"
      And a new item "A" in repo "acme/web" arrives on the board
      When the poller runs once
      Then the readiness judge was asked about the line "Names the user it serves" for item "A"

    @ac-1
    Scenario: A local commit in the checkout that isn't on main never reaches the gate
      Given the operator's checkout holds a local commit "eee555" that isn't on `main` and adds the line "Has a designer's sign-off" to "policy/dor.md"
      And a new item "A" in repo "acme/web" arrives on the board
      When the poller runs once
      Then the readiness judge was not asked about the line "Has a designer's sign-off"

    @ac-1
    Scenario: When fetching main fails, the gate keeps the defaults from the commit it last fetched
      Given `main` can't be fetched
      And the operator's checkout has an uncommitted edit to "policy/dor.md" that adds the line "Has a designer's sign-off"
      And a new item "A" in repo "acme/web" arrives on the board
      When the poller runs once
      Then the readiness judge was asked about the line "Size is 5 or less" for item "A"
      And the readiness judge was not asked about the line "Has a designer's sign-off"

  Rule: The readiness fingerprint covers the defaults on main's fetched commit, not the checkout's disk

    @ac-1
    Scenario: An uncommitted edit to a default policy in the checkout leaves the fingerprint as it was
      Given the readiness fingerprint for repo "acme/web" was taken with `main` at commit "aaa111"
      When the operator's checkout gains an uncommitted edit to "policy/risk.md"
      Then the readiness fingerprint for repo "acme/web" is unchanged

    @ac-1
    Scenario: A default policy change merged to main gives a new fingerprint before the checkout pulls it
      Given the readiness fingerprint for repo "acme/web" was taken with `main` at commit "aaa111"
      When `main` gains commit "bbb222" that changes only "policy/scenarios.md"
      And the worker fetches `main`
      Then the readiness fingerprint for repo "acme/web" differs from the one taken at commit "aaa111"

  Rule: A merged change to a default policy re-checks every NotReady item, as a change to a repo's own policy file does

    @ac-2
    Scenario Outline: A merged change to any default readiness policy re-checks every NotReady item as a policy change
      Given the factory holds two items in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And neither the items nor the repo's own files change
      And `main` gains commit "bbb222" that changes only "<file>"
      And the readiness judge now passes every line
      When the poller runs once
      Then both items are in state "Queued"
      And each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

      Examples:
        | file                 |
        | policy/dor.md        |
        | policy/scenarios.md  |
        | policy/pr-review.md  |
        | policy/risk.md       |

    @ac-2
    Scenario: An item that still fails under the merged default comes back NotReady with a fresh comment
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And `main` gains commit "bbb222" whose default "dor.md" adds the line "Names the user it serves"
      And the readiness judge fails the line "Names the user it serves" because "No user is named"
      When the poller runs once
      Then the factory holds the item in state "NotReady"
      And the item's history shows one move "policy_changed"
      And the board item has a new readiness comment saying "No user is named"

    @ac-2
    Scenario: A merged default change re-checks NotReady items in every repo that uses that default
      Given the factory also serves repo "acme/api", which has no policy files of its own
      And the factory holds an item in state "NotReady" in repo "acme/web" and another in repo "acme/api"
      And `main` gains commit "bbb222" that changes only "policy/dor.md"
      When the poller runs once
      Then each item's history shows one move "policy_changed"

    @ac-2
    Scenario: Later polls after a merged default change don't re-check the item again
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And `main` gains commit "bbb222" that changes only "policy/dor.md"
      And the readiness judge still fails every line
      When the poller runs three times
      Then the factory holds the item in state "NotReady"
      And the item's history shows exactly one move "policy_changed"
      And the readiness judge was asked about the item once

    @ac-2
    Scenario: An uncommitted edit to a default policy in the checkout re-checks nothing
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And the operator's checkout gains an uncommitted edit to "policy/dor.md"
      When the poller runs once
      Then the item's history shows no move "policy_changed"
      And the readiness judge was not asked about the item

  Rule: A merged default policy change takes effect with no restart, and Floor asks for none

    @ac-3
    Scenario: A merged default change takes effect in the running worker, and neither process restarts
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And `main` gains commit "bbb222" that changes only "policy/dor.md"
      And the readiness judge now passes every line
      When the poller runs once
      Then the item is in state "Queued"
      And the item's history shows one move "policy_changed"
      And the worker has not restarted
      And the control plane has not restarted

    @ac-3
    Scenario: Floor shows no restart notice while the merged default change takes effect
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And `main` gains commit "bbb222" that changes only "policy/risk.md"
      When the poller runs once
      Then the item's history shows one move "policy_changed"
      And Floor doesn't say a restart is needed

    @ac-3
    Scenario: A second merged default change also takes effect without a restart
      Given the factory holds an item in repo "acme/web" in state "NotReady", checked against commit "aaa111"
      And the readiness judge still fails every line
      And `main` gains commit "bbb222" that changes only "policy/dor.md"
      And the poller runs once
      When `main` gains commit "ccc333" that changes only "policy/pr-review.md"
      And the poller runs once
      Then the item's history shows exactly two moves "policy_changed"
      And the worker has not restarted
      And Floor doesn't say a restart is needed

  Rule: Cells keep reading the default policies from their own image

    @ac-4 @regression
    Scenario: A running cell keeps the defaults its image was built with after a default change merges
      Given item "B" is running in a cell on the cell image built from commit "aaa111"
      And the default "pr-review.md" at commit "aaa111" holds the line "Names every changed file"
      And `main` gains commit "bbb222" whose default "pr-review.md" replaces that line with "Links the item"
      When the cell for item "B" loads its default "pr-review.md"
      Then the cell's "pr-review.md" holds the line "Names every changed file"
      And the cell's "pr-review.md" doesn't hold the line "Links the item"

    @ac-4 @regression
    Scenario: A cell started on the rebuilt image reads the defaults baked into that image
      Given `main` gains commit "bbb222" whose default "risk.md" adds the line "Touches billing"
      And the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And item "B" is queued
      When the scheduler starts a cell for item "B"
      And the cell for item "B" loads its default "risk.md"
      Then the cell's "risk.md" holds the line "Touches billing"
