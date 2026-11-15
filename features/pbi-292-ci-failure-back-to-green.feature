@pbi-292
Feature: A CI failure on the factory's own commit goes back to Green to be fixed, and the item shows that CI failed
  When CI fails on a commit a stage pushed, spec §6 rows 7 and 8 send the run back to Green to fix it. Today
  address doesn't: it retries itself. When the PR addresser has nothing left to change, as when it answered
  every thread with a reply, each retry reads CI again on the same commit, is charged as an attempt, and fails
  the same way. The finding that goes back is only "CI failed on <commit>", so Green never learns which check
  failed or which tests.
  With this item, a stage with no agent work left to change the commit doesn't retry on it. The run goes back
  to Green, and Green's findings name each failed check, its URL and the failing tests. Reading CI again on a
  head that hasn't changed since its last failed read is never charged as an attempt. When Green leaves the
  commit CI failed on unchanged, the factory has nothing new for CI to judge, so it gives up and asks a person.
  The question names each failed check with its URL and the failing tests, and says what the factory tried.
  While Green is fixing a CI failure, the Floor and the item's page show the item as fixing CI, with the
  failed checks and the commit, instead of a plain stage name. A CI failure the base shares is still the
  base's, as PBI 215 has it, and is never handed to Green as the item's own.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them. The
  rest run the cell engine against a fake control plane, a fake agent and a fake repo host, so cells run them
  all.

  Rule: A CI failure on a commit a stage pushed, when the stage has no agent work left to change it, goes back to Green with each failed check, its URL and the failing tests

    Background:
      Given a run for item 482 whose PR is in review
      And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
      And CI passes on every commit unless a scenario says otherwise

    @ac-1
    Scenario: Address that only replied doesn't retry on the commit CI failed on, and the run goes back to Green
      Given the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then address ran 1 time
      And the cell ran these stages, in order:
        | stage       |
        | address     |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the item moves to InReview

    @ac-1
    Scenario: Green's findings name the failed check, its URL, the failing tests and the commit
      Given the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the tests "parses the config" and "reads the board"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then Green's brief says CI failed on "m3rge01"
      And Green's brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"
      And Green's brief names the tests "parses the config" and "reads the board"

    @ac-1
    Scenario: Every failed check is named with its own URL, and a check that passed isn't
      Given the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And these checks report on "m3rge01":
        | check | status | url                                             | failing tests     |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7100 |                   |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7101 | parses the config |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7102 | signs in          |
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then address ran 1 time
      And Green's brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"
      And Green's brief names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7102"
      And Green's brief names the tests "parses the config" and "signs in"
      And Green's brief doesn't name the check "lint"

    @ac-1
    Scenario: A failed check that names no failing test still goes back to Green with its name and URL
      Given the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", naming no failing test
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then address ran 1 time
      And Green's brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"
      And Green's brief says CI named no failing test for the check "ci"

    @ac-1
    Scenario: The address attempt's message names the failed check and its URL
      Given the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the address attempt's message names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"
      And the address attempt's message names the test "parses the config"

  Rule: A CI failure on the head open-pr pushed goes back to Green with each failed check, its URL and the failing tests

    Background:
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise

    @ac-1
    Scenario: Green's second brief names the check that failed on the PR's head, its URL and the failing test
      Given CI reports the check "ci" failed on the PR's first head at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And Green's second brief says CI failed on the PR's first head
      And Green's second brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And Green's second brief names the test "totals include VAT"

  Rule: Reading CI again on a head that hasn't changed since its last failed read is never charged as an attempt

    Background:
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise

    @ac-2
    Scenario: Green that leaves the commit CI failed on unchanged isn't followed by a charged read of CI on it
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And Green's fix for the CI failure makes no commit
      When the cell runs
      Then exactly 1 attempt in the run says CI failed on "c0ffee1"
      And the factory read CI on "c0ffee1" no more than 1 time after it failed
      And Green ran 2 times
      And the item doesn't move to Failed

    @ac-2
    Scenario: Address that only replied is charged one attempt for the commit CI failed on, not one per retry
      Given a run for item 482 whose PR is in review
      And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
      And the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then exactly 1 attempt in the run says CI failed on "m3rge01"
      And the factory read CI on "m3rge01" no more than 1 time after it failed

    @ac-2
    Scenario: A head that changed is read again and its failure is charged, with its own checks
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And Green's fix makes the commit "c0ffee2"
      And CI reports the check "ci" failed on "c0ffee2" at "https://github.com/acme/widgets/actions/runs/7202", failing the test "rounds to the cent"
      And CI passes after Green's next fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then exactly 1 attempt in the run says CI failed on "c0ffee1"
      And exactly 1 attempt in the run says CI failed on "c0ffee2"
      And Green ran 3 times
      And Green's third brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7202"
      And Green's third brief names the test "rounds to the cent"
      And the item moves to InReview

  Rule: While the factory is fixing a CI failure, the Floor and the item's page show it as fixing CI, with the failed checks and the commit

    Background:
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard

    @ac-3 @db
    Scenario: The Floor shows an item at Green after a CI failure as fixing CI, naming the check and the commit
      Given item 482 is in progress at Green, fixing the CI failure of the check "ci" at "https://github.com/acme/widgets/actions/runs/7201" on commit "c0ffee1"
      When "octo" opens the Floor
      Then item 482's stage on the Floor says it is fixing CI
      And item 482's row on the Floor names the check "ci"
      And item 482's row on the Floor names the commit "c0ffee1"
      And item 482's stage on the Floor isn't the plain stage name "green"

    @ac-3 @db
    Scenario: The item's page shows it as fixing CI, naming each failed check with its URL and the commit
      Given item 482 is in progress at Green, fixing the CI failure of the checks "ci" at "https://github.com/acme/widgets/actions/runs/7201" and "e2e" at "https://github.com/acme/widgets/actions/runs/7202" on commit "c0ffee1"
      When "octo" opens item 482's page
      Then the item's page says it is fixing CI
      And the item's page names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And the item's page names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7202"
      And the item's page names the commit "c0ffee1"

    @ac-3 @db
    Scenario: The Floor names every failed check of an item fixing CI
      Given item 482 is in progress at Green, fixing the CI failure of the checks "ci" at "https://github.com/acme/widgets/actions/runs/7201" and "e2e" at "https://github.com/acme/widgets/actions/runs/7202" on commit "c0ffee1"
      When "octo" opens the Floor
      Then item 482's stage on the Floor says it is fixing CI
      And item 482's row on the Floor names the checks "ci" and "e2e"

    @ac-3 @db
    Scenario: Only the item fixing CI is shown as fixing CI
      Given item 482 is in progress at Green, fixing the CI failure of the check "ci" at "https://github.com/acme/widgets/actions/runs/7201" on commit "c0ffee1"
      And item 483 is in progress at Green, with no CI failure to fix
      When "octo" opens the Floor
      Then item 482's stage on the Floor says it is fixing CI
      And item 483's stage on the Floor doesn't say it is fixing CI

    @ac-3
    Scenario: The cell tells the factory Green is fixing CI, with the failed checks and the commit
      Given a run for item 482 whose scenarios were signed off
      And CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then Green's second attempt was reported as fixing CI on "c0ffee1"
      And that report names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And Green's first attempt wasn't reported as fixing CI

  Rule: When the factory gives up on a CI failure and asks a person, the question names each failed check with its URL and the failing tests, and says what the factory tried

    Background:
      Given a run for item 482 whose scenarios were signed off
      And CI passes on every commit unless a scenario says otherwise

    @ac-4
    Scenario: Green leaving the failed commit unchanged makes the factory ask one question naming the check, its URL and the failing tests
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the tests "totals include VAT" and "rounds to the cent"
      And Green's fix for the CI failure makes no commit
      When the cell runs
      Then the item moves to NeedsInput
      And the owner is asked exactly 1 question
      And the question names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And the question names the tests "totals include VAT" and "rounds to the cent"
      And the question names the commit "c0ffee1"

    @ac-4
    Scenario: The question names every failed check with its own URL, and no check that passed
      Given these checks report on the PR's first head "c0ffee1":
        | check | status | url                                             | failing tests      |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7200 |                    |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7201 | totals include VAT |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7202 | signs in           |
      And Green's fix for the CI failure makes no commit
      When the cell runs
      Then the item moves to NeedsInput
      And the question names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And the question names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7202"
      And the question names the tests "totals include VAT" and "signs in"
      And the question doesn't name the check "lint"

    @ac-4
    Scenario: The question says what the factory tried
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And Green's fix makes the commit "c0ffee2"
      And CI reports the check "ci" failed on "c0ffee2" at "https://github.com/acme/widgets/actions/runs/7202", failing the test "totals include VAT"
      And Green's next fix for the CI failure makes no commit
      When the cell runs
      Then the item moves to NeedsInput
      And the question says Green tried to fix the CI failure 2 times
      And the question names the commits "c0ffee1" and "c0ffee2" that CI failed on
      And the question says Green's last attempt left "c0ffee2" unchanged
      And the question names the check "ci" and "https://github.com/acme/widgets/actions/runs/7202"

    @ac-4
    Scenario: Giving up on a CI failure asks a person instead of failing the item
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And Green's fix for the CI failure makes no commit
      When the cell runs
      Then the item doesn't move to Failed
      And the item moves to NeedsInput
      And the item never moved to InReview

  Rule: A CI failure the base shares is still the base's, not the item's own

    Background:
      Given CI passes on every commit unless a scenario says otherwise

    @ac-5
    Scenario: CI failing the same tests on the base commit asks the base question instead of sending the item to Green
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And CI reports the check "ci" failed on the PR's first head at "https://github.com/acme/widgets/actions/runs/7201", failing the test "parses the config"
      And CI reports the check "ci" failed on "b4se001" at "https://github.com/acme/widgets/actions/runs/7001", failing the test "parses the config"
      When the cell runs
      Then Green ran 1 time
      And the item moves to NeedsInput
      And the owner is asked exactly 1 question
      And the question says the base fails in the cell
      And the question names the test "parses the config"
      And the question names the base commit "b4se001"

    @ac-5
    Scenario: A CI failure the base shares isn't shown or reported as the item fixing CI
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And CI reports the check "ci" failed on the PR's first head at "https://github.com/acme/widgets/actions/runs/7201", failing the test "parses the config"
      And CI reports the check "ci" failed on "b4se001" at "https://github.com/acme/widgets/actions/runs/7001", failing the test "parses the config"
      When the cell runs
      Then the item moves to NeedsInput
      And no attempt was reported as fixing CI
      And the question doesn't say Green failed after its attempts

    @ac-5
    Scenario: A CI failure on a test the base passes is the item's own and goes back to Green
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And CI reports the check "ci" failed on the PR's first head at "https://github.com/acme/widgets/actions/runs/7201", failing the tests "parses the config" and "totals include VAT"
      And CI reports the check "ci" failed on "b4se001" at "https://github.com/acme/widgets/actions/runs/7001", failing the test "parses the config"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then Green ran 2 times
      And Green's second brief names the test "totals include VAT"
      And the owner is asked no question
      And the item moves to InReview

    @ac-5 @regression
    Scenario: A Definition of Done failure the base shares still asks the base question
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      And on commit "b4se001" the command fails the test "parses the config"
      When the cell runs
      Then Green ran 1 time
      And the item moves to NeedsInput
      And the question says the base fails in the cell
      And the question names the base commit "b4se001"
      And the item doesn't move to Failed

    @ac-5 @regression @db
    Scenario: The Floor still shows the base failure for an item waiting on the base question
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "parses the config"
      When "octo" opens the Floor
      Then the Floor says the base fails in cells
      And that notice names the test "parses the config"
      And that notice names item 482
      And item 482's stage on the Floor doesn't say it is fixing CI
