@pbi-389
Feature: A cell runs the full suite once per commit
  Today Green's gate runs the repo's `bdd.run`, `commands.test` and `commands.lint`. Then the Definition of
  Done check runs line 1's `run:` command at the same commit, which runs the same full suite a second time.
  The self-reviewer is told nothing about the gate, so it often runs the full suite a third time.
  With this item, when Green's gate passed at a commit and its commands cover a Definition of Done line's
  `run:` command, the check doesn't run that command again. It passes the line with Green's gate run as its
  evidence, naming the commit and the scenario counts. A line that runs anything the gate didn't run, or a
  check at a commit the gate didn't run at, runs its command as today.
  The self-reviewer's brief says where the full suite passed, so the reviewer runs no full suite. It may run
  single scenarios with the repo's `bdd.run` tag filter, or single test files.
  A commit that self-review's fixes make still gets the full suite once, in the gate it goes through. CI runs
  it again on the PR's head, and nothing merges without CI passing there.
  Every scenario uses a repo whose commands leave a mark in the checkout when they run, so a scenario can
  tell which commands the cell ran and at which commit.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And the repo's "bdd.run" is "npm run bdd -- --tags \"not @local\""
    And the repo's "commands.test" is "npm test"
    And the repo's "commands.lint" is "npm run lint"

  Rule: When Green's gate passed at a commit, a Definition of Done line its commands cover passes on the gate's run

    Background:
      Given the repo's Definition of Done line 1 is "Tests and scenarios pass. `run: npm test && npm run bdd -- --tags \"not @local\"`"

    @ac-1
    Scenario: Line 1 passes on Green's gate run, and the cell doesn't run its command again
      Given Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 passes
      And the cell didn't run line 1's command
      And the cell ran "npm test" once at "c0ffee1"
      And the cell ran "npm run bdd -- --tags \"not @local\"" once at "c0ffee1"

    @ac-1
    Scenario: Line 1's reason names Green's gate run, the commit and the scenario counts
      Given Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then line 1's reason says Green's gate passed it
      And line 1's reason names the commit "c0ffee1"
      And line 1's reason names 12 scenarios passed and 0 failed

    @ac-1
    Scenario: The stored Definition of Done results for the commit carry the gate's evidence
      Given Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then the stored Definition of Done results for "c0ffee1" show line 1 passed
      And the stored reason for line 1 names Green's gate, "c0ffee1" and 12 scenarios passed

    @ac-1
    Scenario Outline: A line whose command is "<command>" is covered by Green's gate
      Given the repo's Definition of Done line 1 is "Tests pass. `run: <command>`"
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 1 passes
      And the cell didn't run line 1's command

      Examples:
        | command                                                        |
        | npm test                                                       |
        | npm run bdd -- --tags "not @local"                             |
        | npm run lint                                                   |
        | npm test && npm run bdd -- --tags "not @local" && npm run lint |

    @ac-1
    Scenario: A run that goes from Green through self-review to open-pr runs the full suite once at Green's commit
      Given Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      And the self-reviewer approves in its first round without a new commit
      When the cell runs Green, self-review and open-pr
      Then the cell ran "npm run bdd -- --tags \"not @local\"" once at "c0ffee1"
      And the cell ran "npm test" once at "c0ffee1"
      And the cell didn't run line 1's command at "c0ffee1"
      And the PR body shows Definition of Done line 1 passed at "c0ffee1"

  Rule: A line whose command Green's gate didn't cover at that commit runs as it does today

    Background:
      Given the repo's Definition of Done line 1 is "Tests and scenarios pass. `run: npm test && npm run bdd -- --tags \"not @local\"`"

    @ac-2 @regression
    Scenario: A line that runs a command the gate never ran runs it
      Given the repo's Definition of Done line 2 is "Types check. `run: npm run typecheck`"
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then the cell ran line 2's command at "c0ffee1"
      And Definition of Done line 2 passes with the reason "exit 0"

    @ac-2 @regression
    Scenario: An uncovered line whose command fails fails the line as it does today
      Given the repo's Definition of Done line 2 is "Types check. `run: npm run typecheck`"
      And line 2's command fails in the checkout with exit code 2
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then the cell ran line 2's command at "c0ffee1"
      And Definition of Done line 2 fails with a reason that starts "exit 2"
      And the stage's findings say Definition of Done line 2 failed

    @ac-2 @regression
    Scenario: A line that joins a gate command to one the gate didn't run runs its whole command
      Given the repo's Definition of Done line 2 is "Types and tests pass. `run: npm run typecheck && npm test`"
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then the cell ran line 2's command at "c0ffee1"
      And Definition of Done line 2 passes with the reason "exit 0"

    @ac-2 @regression
    Scenario: Green's gate run at an earlier commit doesn't stand in for the commit being checked
      Given Green's gate passed at "c0ffee1" with 12 scenarios passed and none failed
      And the branch has since moved to commit "beef002"
      When the cell checks the Definition of Done at "beef002"
      Then the cell ran line 1's command at "beef002"
      And Definition of Done line 1 passes with the reason "exit 0"

    @ac-2 @regression
    Scenario: A line that isn't a run: line is still judged as it is today
      Given the repo's Definition of Done line 2 is "The spec describes the change."
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passes at "c0ffee1" with 12 scenarios passed and none failed
      When Green checks the Definition of Done at "c0ffee1"
      Then Definition of Done line 2 was sent to the judge

  Rule: The self-reviewer's brief says where the full suite passed, so the reviewer runs only single scenarios or test files

    Background:
      Given Green's implementation is at commit "c0ffee1"
      And Green's gate passed at "c0ffee1" with 12 scenarios passed and none failed

    @ac-3
    Scenario: The brief gives Green's gate result, the command, the scenario counts and the commit
      When self-review runs its first round
      Then the self-reviewer's brief says the full suite passed in Green's gate at "c0ffee1"
      And the self-reviewer's brief names the command "npm run bdd -- --tags \"not @local\""
      And the self-reviewer's brief names 12 scenarios passed and 0 failed

    @ac-3
    Scenario: The brief tells the reviewer to run no full suite
      When self-review runs its first round
      Then the self-reviewer's brief says not to run the full suite

    @ac-3
    Scenario: The brief names the repo's tag filter for running single scenarios, and allows single test files
      When self-review runs its first round
      Then the self-reviewer's brief says a single scenario can be run with "npm run bdd" and a "--tags" filter
      And the self-reviewer's brief says single test files may be run to check a finding

    @ac-3
    Scenario: After a fix commit, the next round's brief still names the commit where the full suite passed
      Given the self-reviewer holds a finding open in its first round
      And the fix for that finding is committed as "beef002"
      When self-review runs its second round
      Then the self-reviewer's brief says the full suite passed in Green's gate at "c0ffee1"
      And the self-reviewer's brief doesn't say the full suite passed at "beef002"

  Rule: A commit that self-review's fixes make gets the full suite once in its gate, and again from CI on the PR's head

    Background:
      Given the repo's Definition of Done line 1 is "Tests and scenarios pass. `run: npm test && npm run bdd -- --tags \"not @local\"`"
      And Green's implementation is at commit "c0ffee1"
      And Green's gate passed at "c0ffee1" with 12 scenarios passed and none failed
      And the self-reviewer holds a finding open in its first round
      And the fix for that finding is committed as "beef002"
      And the self-reviewer approves in its second round

    @ac-4 @regression
    Scenario: Open-pr's Definition of Done check runs line 1's command once at the fix commit
      When the cell runs self-review and open-pr
      Then the cell ran line 1's command once at "beef002"
      And the PR body shows Definition of Done line 1 passed at "beef002"

    @ac-4 @regression
    Scenario: The fix commit is the PR's head, so CI runs the full suite on it
      When the cell runs self-review and open-pr
      Then the PR's head is "beef002"
      And the factory waits for CI on "beef002"

  Rule: Nothing merges without CI passing the full suite on the PR's head

    Background:
      Given the factory holds an item in state "InReview" whose open run has PR 57 in "acme/widgets" at head "beef002"
      And "octo" has approved PR 57
      And PR 57's Definition of Done shows line 1 passed on Green's gate run
      And PR 57's Definition of Done leaves no line for the person who merges

    @ac-5 @regression
    Scenario: A PR whose CI passed on its head merges
      Given CI reports the check "ci" passed on "beef002"
      And GitHub reports PR 57 as "clean"
      When the poller runs once
      Then the factory has merged PR 57 with a squash merge

    @ac-5 @regression
    Scenario: A PR whose CI failed on its head doesn't merge, even with line 1 passed on Green's gate run
      Given CI reports the check "ci" failed on "beef002"
      And GitHub reports PR 57 as "blocked"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"

    @ac-5 @regression
    Scenario: CI passing on an earlier commit doesn't let the PR merge while CI on its head is pending
      Given CI reports the check "ci" passed on "c0ffee1"
      And CI hasn't reported the check "ci" on "beef002"
      And GitHub reports PR 57 as "blocked"
      When the poller runs once
      Then the factory hasn't merged PR 57
      And the factory holds the item in state "InReview"
