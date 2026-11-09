@pbi-142
Feature: A PR that merges or closes while its item is InProgress is seen
  When a person merges a factory PR while the item is still InProgress, for example while the cell
  is addressing review, the webhook moves the item to Accepted. The poller is the fallback for a
  webhook that never arrived, but today it only reads the PRs of InReview items, so it misses the
  merge. The item stays InProgress, the scheduler sends it back to open-pr, and every cell finds a
  merged branch and fails in the same way, so the item never leaves open-pr.
  With this item, the poller treats an InProgress item's PR the way it treats an InReview one's: a
  merge moves the item to Accepted, and a close without a merge withdraws it. A cell that reaches
  open-pr on a branch whose PR has already merged stops there and says why, and an open-pr attempt
  that breaks always reports itself as failed, with the reason, so it is never left looking as if
  it is still running.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The rest run the cell engine against a fake control plane, agent and repo.

  Rule: The poller moves an InProgress item whose PR merged to Accepted, as the webhook does

    @ac-1 @db
    Scenario: An InProgress item whose PR merged moves to Accepted on the next poll, with its merge commit
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1 @db
    Scenario: A merge counts as a merge even when the item closed on the board in the same poll
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      And the merge closed the item on the board
      When the poller runs once
      Then the factory holds the item in state "Accepted"
      And the item's run records the merge commit "abc123"

    @ac-1 @db
    Scenario: A second poll after the merge leaves the item where the first one put it
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And a person merged PR 57 as commit "abc123", and no webhook said so
      When the poller runs twice
      Then the factory holds the item in state "Accepted"
      And the item's history shows exactly one move to "Accepted"

  Rule: The poller withdraws an InProgress item whose PR was closed without a merge, as it does an InReview one

    @ac-2 @db
    Scenario: An InProgress item whose PR a person closed without merging moves to Abandoned
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And the item still carries its "factory" label on the board
      And a person closed PR 57 without merging it, and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Abandoned"
      And the item's run records no merge commit

  Rule: A cell never opens a new PR for a branch whose PR has already merged

    @ac-3
    Scenario: A cell resuming at open-pr on a branch whose PR merged stops, naming the merged PR
      Given a run for item 482 that resumes at open-pr
      And the run's branch has PR 57, which a person has already merged
      When the cell runs
      Then no PR is opened or updated for the run's branch
      And no reviewers are requested
      And the open-pr stage's last attempt ends failed
      And that attempt's message names PR 57 as already merged
      And the item doesn't move to InReview

  Rule: An open-pr attempt that breaks reports itself failed, with the reason

    @ac-4
    Scenario Outline: An error while <step> ends the open-pr attempt as failed, with the error's message
      Given a run for item 482 that resumes at open-pr
      And the repo host fails with "GitHub answered 502" when the cell is <step>
      When the cell runs
      Then the open-pr stage's last attempt ends failed
      And that attempt's message holds "GitHub answered 502"
      And no open-pr attempt is left started

      Examples:
        | step                         |
        | opening the PR               |
        | asking for reviewers         |
        | reading the PR's CI checks   |
