@pbi-317 @db
Feature: A NeedsInput item waiting on an older "CI failed" question goes back to Green on its own
  Before #292, address retried itself on a CI failure and then stopped with one question: "Address failed:"
  followed by its findings, one line each, such as "CI failed on m3rge01". Since #292 a new CI failure goes
  back to Green to be fixed, with each failed check, its URL and the failing tests as Green's findings. But an
  item that asked the older question before #292 still waits in NeedsInput until a person answers it, though
  the factory now knows what to do with it.
  With this item, the poller answers such a question itself when every line it names is a CI failure. The
  answer says what the factory does next: it sends the item back to Green to fix the CI failure. No person
  gave the answer, so it names nobody as the one who answered, as #305's and PBI 260's answers do, and the
  re-queue is logged as a system event. The item is claimed again. The claim merges the base, as every claim
  does, and the run goes to Green with the failed checks of the PR's head as its findings, as #292 does for
  a new failure. A question that names anything besides CI failures still waits for a person. A person's
  answer, a Hold or an earlier poll that got there first wins, and nothing is answered or logged twice.
  In every scenario, item 482's open run has PR 57 in "acme/widgets", on base "main", and stopped at the
  address stage. Every scenario needs Postgres, which each test starts for itself, so cells and CI both run
  them. GitHub, CI, the board, the agent and the repo are fakes.

  Rule: An unheld item waiting on an "Address failed" question that names only CI failures is answered once and claimed again at Green

    @ac-1
    Scenario: An item waiting on an older "CI failed" question is claimed again at Green
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "green"

    @ac-1
    Scenario: A question naming several CI failures, one per retry, is answered too
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        - CI failed on m3rge01
        - CI failed on m3rge02, the PR addresser's fix for the PR review's findings
        """
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the item's run resumes from "green"

    @ac-1
    Scenario: Every item waiting on an older "CI failed" question is answered by the same poll
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And item 483, with PR 58 in "acme/widgets", waits in NeedsInput on an "Address failed" question naming only the CI failure on "0ther01"
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's question is answered by the factory

    @ac-1
    Scenario: The claim merges the base before Green runs
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And "origin/main" is at commit "b4se002"
      And PR 57's head is commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then the cell merged commit "b4se002" into the item's branch
      And it merged before the green stage began
      And address didn't run before the green stage

    @ac-1
    Scenario: Green's findings name each failed check of the PR's head, its URL and the failing tests
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And PR 57's head is commit "m3rge01"
      And these checks report on "m3rge01":
        | check | status | url                                               | failing tests     |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7100 |                   |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7101 | parses the config |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7102 | signs in          |
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then Green's brief says CI failed on "m3rge01"
      And Green's brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"
      And Green's brief names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7102"
      And Green's brief names the tests "parses the config" and "signs in"
      And Green's brief doesn't name the check "lint"

    @ac-1
    Scenario: Green's findings come from the PR's head now, not from the commit the question named
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And PR 57's head has since moved to commit "m3rge02"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And CI reports the check "e2e" failed on "m3rge02" at "https://github.com/acme/widgets/actions/runs/7202", failing the test "signs in"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then Green's brief says CI failed on "m3rge02"
      And Green's brief names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7202"
      And Green's brief names the test "signs in"
      And Green's brief doesn't name the test "parses the config"

    @ac-1
    Scenario: Green is shown as fixing CI on the PR's head once the item is claimed again
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And PR 57's head is commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then Green's first attempt was reported as fixing CI on "m3rge01"
      And that report names the check "ci" and "https://github.com/acme/widgets/actions/runs/7101"

    @ac-1
    Scenario: Green fixing the CI failure takes the item back to review
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And PR 57's head is commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then the owner is asked no question
      And the item moves to InReview

  Rule: The factory's answer names what it does next, names nobody as the one who answered, and is logged as a system event

    @ac-2
    Scenario: The answer says the item goes back to Green to fix the CI failure, and comes from the factory, not a person
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs once
      Then item 482's question is answered by the factory
      And nobody answered item 482's question in person
      And the answer says the factory sends the item back to Green to fix the CI failure

    @ac-2
    Scenario: The re-queue is a system event on the item naming its question
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs once
      Then item 482 has a system event recording its re-queue for Green after an older CI failure
      And the event names item 482's question
      And the event's actor is the system, not a person

    @ac-2
    Scenario: The dashboard stops asking for an answer once the factory has answered
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs once
      And "octo" opens the dashboard
      Then "Waiting on you" on the dashboard doesn't list item 482

    @ac-2
    Scenario: The re-queue shows in the activity log
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs once
      And a viewer opens the activity log
      Then the activity log lists item 482's re-queue for Green after an older CI failure

  Rule: A question that names anything besides CI failures stays put, as today

    @ac-3 @regression
    Scenario: An "Address failed" question naming a CI failure and something else stays open
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        - the locked scenario file "features/pbi-12-poller.feature" changed
        """
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-3 @regression
    Scenario: An "Address failed" question naming no CI failure stays open
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - Definition of Done failed: `npm test` exited 1
        """
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-3 @regression
    Scenario: A question saying no CI ran on the PR stays open
      Given item 482 waits in NeedsInput on the question "no CI ran on the PR"
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-3 @regression
    Scenario: The question Green asks after giving up on a CI failure stays open
      Given item 482 waits in NeedsInput on the question Green asks after leaving commit "c0ffee1", which CI failed on, unchanged
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-3 @regression
    Scenario: An item stopped by a red base stays in NeedsInput while the base is still red
      Given item 482 waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI still fails on the newest commit of "main"
      When the poller runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-3
    Scenario: The poll answers the question naming only CI failures and leaves the one naming something else
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And item 483, with PR 58 in "acme/widgets", waits in NeedsInput on an "Address failed" question naming the CI failure on "0ther01" and a changed locked scenario file
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's question is still open
      And item 483 has no system event recording a re-queue for Green after an older CI failure

  Rule: A person's answer, a Hold or an earlier poll that comes first wins, and nothing is answered or logged twice

    @ac-4
    Scenario: A person's answer given first stands, while an unanswered item is answered by the factory
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And item 483, with PR 58 in "acme/widgets", waits in NeedsInput on an "Address failed" question naming only the CI failure on "0ther01"
      And the owner has answered item 483's question "Leave it, I'll fix it by hand"
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's answer is still "Leave it, I'll fix it by hand", given by the owner
      And item 483 has no system event recording a re-queue for Green after an older CI failure

    @ac-4
    Scenario: A person who answers while the poller is at work wins, and the factory doesn't answer over them
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And item 483, with PR 58 in "acme/widgets", waits in NeedsInput on an "Address failed" question naming only the CI failure on "0ther01"
      And the owner answers item 483's question "Leave it" just before the poller answers it
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's answer is still "Leave it", given by the owner
      And item 483 has no system event recording a re-queue for Green after an older CI failure

    @ac-4
    Scenario: A held item stays in NeedsInput, while an unheld one is answered and claimed again
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And item 483, with PR 58 in "acme/widgets", waits in NeedsInput on an "Address failed" question naming only the CI failure on "0ther01"
      And an operator has put item 483 on Hold
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And item 483's question is still open
      And the factory holds item 483 in state "NeedsInput"
      And item 483 has no system event recording a re-queue for Green after an older CI failure

    @ac-4
    Scenario: A held item is answered and claimed again at Green once it's released
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      And an operator has put item 482 on Hold
      And the poller has run once
      When an operator releases item 482
      And the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "green"

    @ac-4
    Scenario: A second poll answers the question only once
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When the poller runs twice
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue for Green after an older CI failure

    @ac-4
    Scenario: Two polls running at once answer the question only once
      Given item 482 waits in NeedsInput on the question:
        """
        Address failed:
        - CI failed on m3rge01
        """
      When two polls run at the same time
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue for Green after an older CI failure
