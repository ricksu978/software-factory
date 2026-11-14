@pbi-212
Feature: A PR merged while a stage waits for CI ends the stage as merged instead of failing it
  Three stages push a commit and then wait for CI on it: open-pr once the PR is open, address once
  it pushes its fixes, and the PR review once the PR addresser pushes a fix for its findings. A
  person may merge the PR during that wait. When GitHub then deletes the branch, the commit is no
  longer on it. When the merge keeps the branch, the commit is now on main too. Either way, the
  factory today refuses to say whether CI passed on the commit, so the stage breaks with an error
  that the cell can't explain. Yet open-pr, when it finds the PR already merged, stops calmly and
  names the merged PR.
  With this item, a stage that finds the PR merged while it waits for CI stops in the same way. It
  names the merged PR, runs no further attempt, asks nobody anything and moves the item nowhere.
  The poller then accepts the item, as it does any merged PR. A PR closed without a merge, with its
  branch gone, also ends the stage, and the poller withdraws the item. A commit that isn't on the
  run's branch while its PR is still open is refused, as today, so a cell can't ask about CI on a
  commit that isn't its own.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The rest run the cell engine against a fake control plane, agent and repo host. In each of
  those, the run's PR is PR 57.

  Rule: A stage that finds its PR merged while it waits for CI stops without failing, and leaves the item for the poller

    @ac-1
    Scenario: Address stops, naming the merged PR, when a person merges the PR and deletes its branch while CI runs
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And a person merges PR 57 and deletes its branch while address waits for CI on its push
      When the cell runs
      Then the cell ends without an error
      And the address stage ran exactly one attempt
      And that attempt's message names PR 57 as already merged
      And the owner is asked no question
      And the cell reports no move for the item
      And no reply is posted on PR 57

    @ac-1
    Scenario: Address stops, naming the merged PR, when a person merges the PR and keeps its branch while CI runs
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And a person merges PR 57 with a merge commit and keeps its branch while address waits for CI on its push
      When the cell runs
      Then the cell ends without an error
      And the address stage ran exactly one attempt
      And that attempt's message names PR 57 as already merged
      And the owner is asked no question
      And the cell reports no move for the item

    @ac-1
    Scenario: The item stays InProgress after the stage stops, so the poller is the one to accept it
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And a person merges PR 57 and deletes its branch while address waits for CI on its push
      When the cell runs
      Then the cell ends without an error
      And the item doesn't move to NeedsInput
      And the item doesn't move to InReview
      And the item doesn't move to Failed
      And the item is still InProgress when the cell ends

    @ac-1
    Scenario: The stopped stage costs the item none of its retries
      Given a run for item 482 that resumes at address
      And the address stage allows 2 retries
      And a trusted reviewer asked for changes on the run's PR 57
      And a person merges PR 57 and deletes its branch while address waits for CI on its push
      When the cell runs
      Then the cell ends without an error
      And the address stage ran exactly one attempt
      And the item's retries aren't reported exhausted
      And the address agent was briefed exactly once

  Rule: The factory still refuses to report CI on a commit that isn't the run's own while its PR is open

    @ac-2 @db @regression
    Scenario: A cell asking about a commit that isn't on its branch is refused while the PR is open
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And PR 57 is still open
      And commit "c0ffee1" is on no branch of the run's repo that the run owns
      When the run's cell asks the factory whether CI passed on commit "c0ffee1"
      Then the factory refuses, saying "c0ffee1" isn't on the run's branch
      And the factory gives no CI status for "c0ffee1"

    @ac-2 @db @regression
    Scenario: A cell asking about a commit of main is refused while the PR is open
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And PR 57 is still open
      And commit "babe123" is on main and on the run's branch
      When the run's cell asks the factory whether CI passed on commit "babe123"
      Then the factory refuses, saying "babe123" is on main
      And the factory gives no CI status for "babe123"

    @ac-2 @regression
    Scenario: A stage whose pushed commit is no longer on its branch, while the PR is open, still fails as today
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And PR 57 is still open
      And the factory refuses to report CI on address's push because the commit isn't on the run's branch
      When the cell runs
      Then the address stage's last attempt ends failed
      And that attempt's message says the commit isn't on the run's branch
      And that attempt's message doesn't name PR 57 as already merged

  Rule: A stage whose branch is gone because the PR was closed without a merge stops, and the poller withdraws the item

    @ac-3
    Scenario: Address stops, naming the closed PR, when a person closes the PR without merging and deletes its branch
      Given a run for item 482 that resumes at address
      And a trusted reviewer asked for changes on the run's PR 57
      And a person closes PR 57 without merging it and deletes its branch while address waits for CI on its push
      When the cell runs
      Then the cell ends without an error
      And the address stage ran exactly one attempt
      And that attempt's message names PR 57 as closed without a merge
      And that attempt's message doesn't name PR 57 as already merged
      And the owner is asked no question
      And the cell reports no move for the item

    @ac-3 @db @regression
    Scenario: The poller withdraws the item whose PR was closed without a merge
      Given the factory holds an item in state "InProgress" whose open run has PR 57
      And the item still carries its "factory" label on the board
      And a person closed PR 57 without merging it, and no webhook said so
      When the poller runs once
      Then the factory holds the item in state "Abandoned"
      And the item's run records no merge commit

  Rule: Every stage that waits for CI stops the same way when the PR merges during the wait

    @ac-4
    Scenario Outline: <stage> stops, naming the merged PR, when the PR merges while it waits for CI on <push>
      Given a run for item 482 that resumes at <stage>
      And <setup>
      And a person merges PR 57 and deletes its branch while <stage> waits for CI on <push>
      When the cell runs
      Then the cell ends without an error
      And the <stage> stage ran exactly one attempt
      And that attempt's message names PR 57 as already merged
      And the owner is asked no question
      And the cell reports no move for the item

      Examples:
        | stage     | setup                                                         | push                         |
        | open-pr   | the run's branch has its PR 57 open                           | the PR's head                |
        | address   | a trusted reviewer asked for changes on the run's PR 57       | its push                     |
        | pr-review | the PR reviewer reports a finding the PR addresser fixes      | the PR addresser's fix       |

    @ac-4
    Scenario: The PR review asks for no reviewers and posts no further review once the PR merged under it
      Given a run for item 482 that resumes at pr-review
      And the PR reviewer reports a finding the PR addresser fixes
      And a person merges PR 57 and deletes its branch while pr-review waits for CI on the PR addresser's fix
      When the cell runs
      Then the cell ends without an error
      And the PR reviewer ran once
      And no reviewers are requested
      And the item doesn't move to InReview

    @ac-4
    Scenario: open-pr asks for no reviewers once the PR merged under it
      Given a run for item 482 that resumes at open-pr
      And the run's branch has its PR 57 open
      And a person merges PR 57 with a merge commit and keeps its branch while open-pr waits for CI on the PR's head
      When the cell runs
      Then the open-pr stage ran exactly one attempt
      And that attempt's message names PR 57 as already merged
      And no reviewers are requested
      And the item doesn't move to InReview
