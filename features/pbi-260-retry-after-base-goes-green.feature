@pbi-260
Feature: An item stopped by a red base retries by itself once CI on the base passes again
  Since PBI 215, a stage whose Definition of Done fails the same tests on the base commit stops and asks
  one question. That question says the base fails in the cell and names the base commit. Today the item
  then waits in NeedsInput until a person answers, even after someone has fixed the base and CI passes
  on it again. With this item, once CI passes on a newer commit of the base branch, the factory answers
  every such question itself. The answer names the commit CI passed on. The factory logs the re-queue as
  a system event, and the item is claimed again at the stage it stopped at, with no person involved. That
  claim merges the base, as every claim does, so a conflict that arose while the item waited is resolved
  then. An item waiting on any other kind of question still waits for a person. An item on Hold is
  re-queued only once it's released.
  In every scenario, commit "b4se002" on "main" comes after commit "b4se001", and commit "b4se000" comes
  before it. Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both
  run them. GitHub, the board, the agent and the repo are fakes.

  Rule: CI passing on a newer base commit re-queues every item stopped by an older base failure, at the stage it stopped at

    @ac-1 @db
    Scenario: An item stopped at Green by a red base is claimed again at Green once CI passes on a newer base commit
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the green stage
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler runs once
      Then the factory holds item 482 in state "InProgress"
      And the item's run resumes from "green"
      And nobody answered item 482's question in person

    @ac-1 @db
    Scenario: An item stopped at address by a red base is claimed again at address
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the address stage
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler runs once
      Then the factory holds item 482 in state "InProgress"
      And the item's run resumes from "address"

    @ac-1 @db
    Scenario: Every item stopped by an older base failure is re-queued by the same pass
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And item 483 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se000"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      Then item 482's question is answered
      And item 483's question is answered
      And the scheduler can claim item 482 and item 483 again

    @ac-1 @db
    Scenario: CI passing on the same base commit the cell failed on doesn't re-queue the item, and a newer pass does
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se001" of "main"
      When the poller runs once
      Then item 482's question is still open
      When CI passes on commit "b4se002" of "main"
      And the poller runs once
      Then item 482's question is answered

    @ac-1 @db
    Scenario: CI passing on a base commit older than the failure doesn't re-queue the item, and a newer pass does
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se000" of "main"
      When the poller runs once
      Then item 482's question is still open
      When CI passes on commit "b4se002" of "main"
      And the poller runs once
      Then item 482's question is answered

    @ac-1 @db
    Scenario: CI still pending or failing on the newer base commit doesn't re-queue the item until it passes
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI is still running on commit "b4se002" of "main"
      When the poller runs once
      Then item 482's question is still open
      When CI fails on commit "b4se002" of "main"
      And the poller runs once
      Then item 482's question is still open
      When CI passes on commit "b4se003" of "main", which comes after "b4se002"
      And the poller runs once
      Then item 482's question is answered

    @ac-1 @db
    Scenario: CI passing on another base branch re-queues only the items on that branch
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And item 483 on base "release" waits in NeedsInput on a question saying the base fails in the cell at commit "re1ease1"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      Then item 482's question is answered
      And item 483's question is still open

    @ac-1 @db
    Scenario: A second poll after the base passes re-queues the item only once
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      When the poller runs twice
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue after the base passed

  Rule: The factory answers the question itself, naming the base commit CI passed on, and logs the re-queue as a system event

    @ac-2 @db
    Scenario: The answer names the base commit CI passed on and comes from the factory, not a person
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      Then item 482's question is answered by the factory
      And the answer names the base commit "b4se002"
      And the answer says CI passed on it

    @ac-2 @db
    Scenario: The re-queue is a system event on the item naming the base commit
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      Then item 482 has a system event recording its re-queue after CI passed on base commit "b4se002"
      And the event's actor is the system, not a person

    @ac-2 @db
    Scenario: The dashboard stops asking for an answer once the factory has answered
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And "octo" opens the dashboard
      Then "Waiting on you" on the dashboard doesn't list item 482
      And the Floor doesn't say the base fails in cells

    @ac-2 @db
    Scenario: The re-queue shows in the activity log
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And a viewer opens the activity log
      Then the activity log lists item 482's re-queue after the base passed

  Rule: The re-queued item merges the base when it's claimed, so a conflict that arose while it waited is resolved then

    @ac-3 @db
    Scenario: The re-queued item's claim merges the newer base before its stage runs
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the green stage
      And "origin/main" is at commit "b4se002"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then the cell merged commit "b4se002" into the item's branch
      And it merged before the green stage began

    @ac-3 @db
    Scenario: A conflict with the base that arose while the item waited is resolved on the claim
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the green stage
      And "origin/main" is at commit "b4se002"
      And the item's branch conflicts with commit "b4se002"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then the cell resolved the conflict before the green stage began
      And the item's branch holds commit "b4se002"
      And the green stage runs on the merged branch
      And the owner is asked no question about the conflict

    @ac-3 @db
    Scenario: The base fix reaches the item, so the stage that stopped on the red base passes
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the green stage
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And commit "b4se002" of "main" fixes the test "parses the config"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler claims the item and its cell runs
      Then "npm test" passes on the item's branch
      And the item moves to InReview

  Rule: An item whose open question has no base failure waits for a person, as today

    @ac-4 @db @regression
    Scenario: An item waiting on another kind of question stays in NeedsInput when the base passes
      Given item 482 on base "main" waits in NeedsInput on a question "Address failed: CI failed on the PR"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler runs once
      Then the factory holds item 482 in state "NeedsInput"
      And item 482's question is still open

    @ac-4 @db @regression
    Scenario: An item waiting on another kind of question resumes once a person answers it
      Given item 482 on base "main" waits in NeedsInput on a question "Address failed: CI failed on the PR"
      And CI passes on commit "b4se002" of "main"
      When the owner answers item 482's question
      And the scheduler runs once
      Then the factory holds item 482 in state "InProgress"

    @ac-4 @db
    Scenario: The base passing re-queues the item stopped by the red base and leaves the other waiting
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And item 483 on base "main" waits in NeedsInput on a question "Address failed: CI failed on the PR"
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's question is still open
      And item 483 has no system event recording a re-queue after the base passed

  Rule: An item on Hold isn't re-queued until it's released

    @ac-5 @db
    Scenario: A held item stays in NeedsInput when the base passes, while an unheld one is re-queued
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And item 483 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And an operator has put item 483 on Hold
      And CI passes on commit "b4se002" of "main"
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And item 483's question is still open
      And the factory holds item 483 in state "NeedsInput"
      And item 483 has no system event recording a re-queue after the base passed

    @ac-5 @db
    Scenario: A held item is re-queued once it's released, after the base passed while it was held
      Given item 482 on base "main" waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And the item stopped at the green stage
      And an operator has put item 482 on Hold
      And CI passes on commit "b4se002" of "main"
      And the poller has run once
      When an operator releases item 482
      And the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the answer names the base commit "b4se002"
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "green"
