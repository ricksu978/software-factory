@pbi-229
Feature: A Definition of Done line can name a CI check that stands in for its command
  A line in a repo's ".factory/dod.md" can carry a command, such as `run: npm test`, that the cell runs in
  its checkout to judge the line. Running the full suite again in the cell repeats work CI has already done
  on the same commit. With this item a line can also name a CI check, such as `ci: ci`. When that check
  passed on the commit being judged, the line passes on the check's word, and the cell doesn't run the
  command. When the check failed, the line fails. When CI hasn't reported on the commit, as at Green before
  any PR exists, the cell runs the command as it does today. A line that names a check CI never ran on that
  commit falls back to its command, and the stage's findings say the check was missing.
  The factory's PR addresser now runs only the tests for the code it changed, and leaves the full suite to
  CI and the Definition of Done check. This repo's own Definition of Done names its "ci" check on line 1.
  Every scenario that judges a line uses a command that leaves a mark in the checkout when it runs, so a
  scenario can tell whether the cell ran it.

  Rule: A check that passed on the commit being judged passes the line, and the cell doesn't run the command

    Background:
      Given a run for item 482 whose scenarios were signed off
      And the repo's Definition of Done line 1 is "Tests pass. `run: npm test` `ci: ci`"

    @ac-1
    Scenario: The line passes on the named check, with the check's name and URL as its reason
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7001"
      When the cell checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 passes
      And line 1's reason names the check "ci" and "https://github.com/acme/widgets/actions/runs/7001"
      And the cell didn't run line 1's command

    @ac-1
    Scenario: A passed check stands in even when the line's command would fail
      Given line 1's command fails in the checkout
      And the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7001"
      When the cell checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 passes
      And the cell didn't run line 1's command
      And the stage's findings don't name Definition of Done line 1

    @ac-1
    Scenario: Only the named check counts, so another check failing doesn't fail the line
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7001"
      And CI reports the check "lint" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7002"
      When the cell checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 passes
      And line 1's reason names the check "ci" and "https://github.com/acme/widgets/actions/runs/7001"
      And line 1's reason doesn't name the check "lint"
      And the cell didn't run line 1's command

    @ac-1
    Scenario: The check's verdict is stored with the commit it was judged at
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7001"
      When the cell checks the Definition of Done at "c0ffee1"
      Then the stored Definition of Done results for "c0ffee1" show line 1 passed
      And the stored reason for line 1 names the check "ci" and "https://github.com/acme/widgets/actions/runs/7001"

  Rule: When there's no PR or CI hasn't reported on the commit, the cell runs the line's command as it does today

    Background:
      Given a run for item 482 whose scenarios were signed off
      And the repo's Definition of Done line 1 is "Tests pass. `run: npm test` `ci: ci`"

    @ac-2 @regression
    Scenario: At Green, before any PR exists, the cell runs the line's command
      Given no PR exists for the item
      When the cell checks the Definition of Done at Green
      Then the cell ran line 1's command
      And Definition of Done line 1 passes with the reason "exit 0"

    @ac-2 @regression
    Scenario: At Green, a failing command fails the line as it does today
      Given no PR exists for the item
      And line 1's command fails in the checkout with exit code 1
      When the cell checks the Definition of Done at Green
      Then the cell ran line 1's command
      And Definition of Done line 1 fails with a reason that starts "exit 1"

    @ac-2 @regression
    Scenario: A PR whose CI hasn't reported on the commit gets the command run
      Given the item's PR is open at commit "c0ffee1"
      And no CI run has reported on "c0ffee1"
      When the cell checks the Definition of Done at "c0ffee1"
      Then the cell ran line 1's command
      And Definition of Done line 1 passes with the reason "exit 0"
      And the stage's findings don't say any check was missing

    @ac-2 @regression
    Scenario: A check that passed on an earlier commit doesn't stand in for the commit being judged
      Given the item's PR was at commit "c0ffee1" and is now at commit "beef002"
      And CI reports the check "ci" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7001"
      And no CI run has reported on "beef002"
      And line 1's command fails in the checkout with exit code 1
      When the cell checks the Definition of Done at "beef002"
      Then the cell ran line 1's command
      And Definition of Done line 1 fails with a reason that starts "exit 1"

  Rule: A check that failed on the commit being judged fails the line, with the check's name and URL as its reason

    Background:
      Given a run for item 482 whose scenarios were signed off
      And the repo's Definition of Done line 1 is "Tests pass. `run: npm test` `ci: ci`"

    @ac-3
    Scenario: The line fails on the named check's failure
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7003"
      When the cell checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 fails
      And line 1's reason names the check "ci" and "https://github.com/acme/widgets/actions/runs/7003"
      And the cell didn't run line 1's command

    @ac-3
    Scenario: A failed check fails the line even when the line's command would pass
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci" failed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7003"
      And line 1's command passes in the checkout
      When the cell checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 fails
      And the stage's findings say Definition of Done line 1 failed, naming the check "ci" and "https://github.com/acme/widgets/actions/runs/7003"

  Rule: A line that names a check CI didn't run on the commit falls back to its command, and the findings say the check was missing

    Background:
      Given a run for item 482 whose scenarios were signed off
      And the repo's Definition of Done line 1 is "Tests pass. `run: npm test` `ci: ci`"

    @ac-4
    Scenario: A missing check falls back to the command, which passes the line
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "lint" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7002"
      And CI reports no check named "ci" on "c0ffee1"
      When the cell checks the Definition of Done at "c0ffee1"
      Then the cell ran line 1's command
      And Definition of Done line 1 passes with the reason "exit 0"
      And the stage's findings say the check "ci" was missing on "c0ffee1"

    @ac-4
    Scenario: A missing check falls back to the command, which fails the line
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "lint" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7002"
      And CI reports no check named "ci" on "c0ffee1"
      And line 1's command fails in the checkout with exit code 1
      When the cell checks the Definition of Done at "c0ffee1"
      Then the cell ran line 1's command
      And Definition of Done line 1 fails with a reason that starts "exit 1"
      And the stage's findings say the check "ci" was missing on "c0ffee1"

    @ac-4
    Scenario: A check of a similar name doesn't stand in for the named one
      Given the item's PR is open at commit "c0ffee1"
      And CI reports the check "ci-nightly" passed on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7004"
      When the cell checks the Definition of Done at "c0ffee1"
      Then the cell ran line 1's command
      And line 1's reason doesn't name the check "ci-nightly"
      And the stage's findings say the check "ci" was missing on "c0ffee1"

  Rule: The PR addresser runs only the tests for the code it changed, and leaves the full suite to CI and the Definition of Done check

    @ac-5
    Scenario: The addresser is told to run only the tests for the code it changed
      When the address stage sets up its agent run
      Then the addresser the run gets is told to run only the tests for the code it changed

    @ac-5
    Scenario: The addresser is told to leave the full suite to CI and the Definition of Done check
      When the address stage sets up its agent run
      Then the addresser the run gets is told to leave the full test suite to CI and the Definition of Done check

  Rule: This repo's own Definition of Done names its "ci" check on line 1

    @ac-6
    Scenario: Line 1 of this repo's Definition of Done names the "ci" check and keeps its command
      When the factory reads this repo's ".factory/dod.md"
      Then Definition of Done line 1 names the CI check "ci"
      And Definition of Done line 1 still has the command "npm run typecheck && npm test && npm run bdd -- --tags \"not @local\""
      And this repo's CI has a check named "ci"
