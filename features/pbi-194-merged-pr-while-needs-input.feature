@pbi-194
Feature: An item whose PR merges while it waits in NeedsInput moves to Accepted instead of asking again
  A run can stop and ask a person a question after it has opened its PR. An address run that can't
  finish is one example. The item then waits in NeedsInput while the PR is still open on GitHub. A
  person may merge that PR, or close it, without answering. Today the poller reads only the PRs of
  InReview and InProgress items, so it never sees the merge. The item keeps waiting in NeedsInput and
  the dashboard keeps asking for an answer that no longer matters. An address run that finds its PR
  already merged also blocks and asks again, where open-pr stops and says why.
  With this item, the poller reads a NeedsInput item's PR the way it reads an InReview one's. A merge
  moves the item to Accepted with the merge commit recorded and closes its open question. A close
  without a merge withdraws the item. An address run whose PR has merged stops without asking anything
  and leaves the item for the poller to accept. An item whose PR is still open keeps waiting, as today.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The rest run the cell engine against a fake control plane, agent and repo.

  Rule: The poller moves a NeedsInput item whose PR merged to Accepted, with its merge commit, as it does an InReview one

    @ac-1 @db
    Scenario: A NeedsInput item whose PR merged moves to Accepted on the next poll, with its merge commit
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1 @db
    Scenario: A merge counts as a merge even when the item closed on the board in the same poll
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      And the merge closed the item on the board
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1 @db
    Scenario: A second poll after the merge leaves the item where the first one put it
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs twice
      Then the factory holds the item in state "Accepted"
      And the item's history shows exactly one move to "Accepted"

  Rule: The poller withdraws a NeedsInput item whose PR was closed without a merge, as it does an InReview one

    @ac-2 @db
    Scenario: A NeedsInput item whose PR a person closed without merging moves to Abandoned
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And the item still carries its "factory" label on the board
      And a person closed PR 57 without merging it, and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Abandoned"
      And the item's run records no merge commit

  Rule: Accepting a NeedsInput item closes its open question, so nobody is asked for an answer any more

    @ac-3 @db
    Scenario: The question the item was waiting on closes when its merged PR moves it to Accepted
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And the item waits on an open question "Address failed: CI failed on the PR"
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item has no open question
      And the question "Address failed: CI failed on the PR" is closed without an answer

    @ac-3 @db
    Scenario: The dashboard stops asking for an answer once the merged item is Accepted
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And the item waits on an open question "Address failed: CI failed on the PR"
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs once
      Then "Waiting on you" on the dashboard doesn't list the item
      And the item's page asks for no answer

  Rule: An address run whose PR has already merged stops without asking anything, and leaves the item for the poller

    @ac-4
    Scenario: An address run on a branch whose PR merged ends without blocking, naming the merged PR
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And PR 57 is one a person has already merged
      When the cell runs
      Then the address stage's last attempt ends failed
      And that attempt's message names PR 57 as already merged
      And the item doesn't move to NeedsInput
      And the owner is asked no question
      And no reply is posted on PR 57

    @ac-4
    Scenario: An address run with nothing to address on a branch whose PR merged also ends without blocking
      Given a run for item 482 that resumes at address
      And no trusted review text waits on the run's PR 57
      And PR 57 is one a person has already merged
      When the cell runs
      Then the address stage's last attempt ends failed
      And that attempt's message names PR 57 as already merged
      And the item doesn't move to NeedsInput
      And the owner is asked no question

    @ac-4
    Scenario: An address run whose PR merged reports no move for the item, so the poller is the one to accept it
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And PR 57 is one a person has already merged
      When the cell runs
      Then the cell reports no move for the item
      And the item doesn't move to InReview

  Rule: A NeedsInput item whose PR is still open keeps waiting for its answer, as today

    @ac-5 @db @regression
    Scenario: A NeedsInput item whose PR is still open stays in NeedsInput, its question still open
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And the item waits on an open question "Address failed: CI failed on the PR"
      And PR 57 is still open
      When the poller runs once
      Then the factory holds the item in state "NeedsInput"
      And the question "Address failed: CI failed on the PR" is still open
      And the item's run records no merge commit

    @ac-5 @db @regression
    Scenario: A trusted review on a NeedsInput item's open PR doesn't send the item to address
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And "octo" is an allowlisted user
      And PR 57 is still open
      And "octo" requested changes on PR 57 after the item began waiting
      When the poller runs once
      Then the factory holds the item in state "NeedsInput"
      And the item's run doesn't resume from "address"

    @ac-5 @db @regression
    Scenario: A NeedsInput item whose open PR conflicts with main stays in NeedsInput
      Given the factory holds an item in state "NeedsInput" whose open run has PR 57
      And PR 57 is still open and conflicts with main
      When the poller runs once
      Then the factory holds the item in state "NeedsInput"
      And the item's run doesn't resume from "address"
