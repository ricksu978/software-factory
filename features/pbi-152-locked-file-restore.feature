@pbi-152
Feature: A stage that edits a locked feature file has the edit undone, and the item carries on
  Once the owner signs off an item's scenarios, its feature files are locked at the lock commit.
  Today, when self-review's fix pass edits one, often because the self-reviewer asked for a scenario
  change, the factory asks the owner that "a locked feature file changed since sign-off". No answer
  fixes that: the edit is still on the branch, so the next cell trips the same check and the item
  loops. Red, green and address retry, but from the same edited files, so every retry fails too.
  With this item, every agent that works after sign-off is told which feature files are locked. The
  self-reviewer asks for no scenario change, and puts a scenario it thinks is wrong in the PR body as
  a note for the person who merges. When any stage's work changes a locked feature file anyway, the
  factory puts the locked files back as they were at the lock commit, commits that, says so in that
  attempt's findings, and carries on. The owner is never asked about it.
  All these scenarios run the cell engine against a fake control plane, agent and repo. In each one,
  item 482's feature file "features/pbi-482-orders.feature" was locked at sign-off.

  Rule: Self-review's fix pass is told which feature files are locked, and that a change to one is undone

    @ac-1
    Scenario: The fix pass's brief names the locked feature files and says a change to one is undone
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in its first round
      When the cell runs
      Then the fix pass's brief names "features/pbi-482-orders.feature" as locked
      And the fix pass's brief says the factory undoes any change to a locked feature file

    @ac-1
    Scenario: Every round's fix pass is told about the locked feature files, not only the first
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in each of its first two rounds
      When the cell runs
      Then the fix pass's brief in round 2 names "features/pbi-482-orders.feature" as locked
      And the fix pass's brief in round 2 says the factory undoes any change to a locked feature file

  Rule: The self-reviewer is told the feature files are locked, so a scenario it doubts becomes a note in the PR body

    @ac-2
    Scenario: The self-reviewer's brief names the locked feature files and says it may not ask for a scenario change
      Given a run for item 482 that resumes at self-review
      When the cell runs
      Then the self-reviewer's brief names "features/pbi-482-orders.feature" as locked
      And the self-reviewer's brief says no finding it holds open may ask for a change to a scenario
      And the self-reviewer's brief says a scenario it thinks is wrong goes in the PR body as a note for the person who merges

    @ac-2
    Scenario: A scenario the self-reviewer thinks is wrong reaches the PR body as a note for the person who merges
      Given a run for item 482 that resumes at self-review
      And the self-reviewer approves, noting that the scenario "An order with no lines is refused" looks wrong
      When the cell runs
      Then the PR is opened
      And the PR's body holds the note about the scenario "An order with no lines is refused" for the person who merges
      And "features/pbi-482-orders.feature" on the branch matches the lock commit

  Rule: A locked feature file that a stage's work changed is restored to the lock commit, and the stage carries on

    @ac-3
    Scenario: Self-review's fix pass edits a locked feature file, and the next round runs on the restored file
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in its first round and approves in its second
      And the first fix pass edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the branch has a commit that restores "features/pbi-482-orders.feature" to the lock commit
      And the self-reviewer's second round sees "features/pbi-482-orders.feature" as it was at the lock commit
      And the self-review stage passes
      And the PR is opened
      And the owner is asked no question

    @ac-3
    Scenario: The self-reviewer's approving round leaves a locked feature file edited, and the PR opens with it restored
      Given a run for item 482 that resumes at self-review
      And the self-reviewer approves in its first round
      And an edit to "features/pbi-482-orders.feature" is left uncommitted when it approves
      When the cell runs
      Then the branch has a commit that restores "features/pbi-482-orders.feature" to the lock commit
      And the self-review stage passes
      And the PR is opened
      And the owner is asked no question

    @ac-3
    Scenario: Open-pr's summary pass edits a locked feature file, and the PR opens with it restored
      Given a run for item 482 that resumes at open-pr
      And the summary pass edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the branch has a commit that restores "features/pbi-482-orders.feature" to the lock commit
      And the PR is opened at a head where "features/pbi-482-orders.feature" matches the lock commit
      And the owner is asked no question

    @ac-3
    Scenario: A deleted locked feature file is put back
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in its first round and approves in its second
      And the first fix pass deletes "features/pbi-482-orders.feature"
      When the cell runs
      Then "features/pbi-482-orders.feature" on the branch matches the lock commit
      And the PR is opened
      And the owner is asked no question

    @ac-3
    Scenario: Only the locked feature files are restored, and the rest of the stage's work is kept
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in its first round and approves in its second
      And the first fix pass edits "features/pbi-482-orders.feature" and "src/orders.ts" in one commit
      When the cell runs
      Then "features/pbi-482-orders.feature" on the branch matches the lock commit
      And the fix pass's change to "src/orders.ts" is still on the branch
      And the PR is opened

    @ac-3
    Scenario: Every locked feature file is restored when a stage changed several
      Given item 482's feature files "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature" were locked at sign-off
      And a run for item 482 that resumes at open-pr
      And the summary pass edits both "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature"
      When the cell runs
      Then "features/pbi-482-orders.feature" on the branch matches the lock commit
      And "features/pbi-482-refunds.feature" on the branch matches the lock commit
      And the PR is opened
      And the owner is asked no question

    @ac-3
    Scenario: A restored locked file is never pushed in its edited form
      Given a run for item 482 that resumes at open-pr
      And the summary pass edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the branch is pushed at least once
      And every push of the branch has "features/pbi-482-orders.feature" as it was at the lock commit

  Rule: The attempt whose edit was undone says so, so the agent's next try knows why

    @ac-4
    Scenario Outline: A <stage> attempt that edited a locked feature file has a finding naming the restore and why
      Given a run for item 482 that resumes at <stage>
      And the <stage> agent's first attempt edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the <stage> stage's first attempt ends failed
      And that attempt's message says "features/pbi-482-orders.feature" was restored to the lock commit
      And that attempt's message says the file is locked since the owner signed off
      And the <stage> agent's second brief says its edit to "features/pbi-482-orders.feature" was undone, and why

      Examples:
        | stage   |
        | red     |
        | green   |
        | address |

    @ac-4
    Scenario: The self-reviewer and the fix pass both hear that a fix pass's edit was undone
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in each of its first two rounds
      And the first fix pass edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the self-reviewer's second round brief says the fix pass's edit to "features/pbi-482-orders.feature" was undone, and why
      And the second fix pass's brief says the earlier edit to "features/pbi-482-orders.feature" was undone, and why

    @ac-4
    Scenario: Open-pr's message names the restore it made
      Given a run for item 482 that resumes at open-pr
      And the summary pass edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the open-pr stage's last attempt's message says "features/pbi-482-orders.feature" was restored to the lock commit

  Rule: Red, green and address retry from the restored files, so a later attempt can pass

    @ac-5
    Scenario Outline: A <stage> attempt that edited a locked feature file is followed by one that passes
      Given a run for item 482 that resumes at <stage>
      And the <stage> agent's first attempt edits a scenario in "features/pbi-482-orders.feature"
      And the <stage> agent's second attempt changes no locked feature file and does the stage's work
      When the cell runs
      Then the <stage> agent's second attempt starts from "features/pbi-482-orders.feature" as it was at the lock commit
      And the <stage> stage's second attempt passes
      And the owner is asked no question

      Examples:
        | stage   |
        | red     |
        | green   |
        | address |

    @ac-5
    Scenario: Red's retry keeps the step definitions the first attempt wrote
      Given a run for item 482 that resumes at red
      And red's first attempt writes the step definitions and edits a scenario in "features/pbi-482-orders.feature"
      And red's second attempt changes nothing
      When the cell runs
      Then the red stage's second attempt passes
      And the step definitions the first attempt wrote are still on the branch

    @ac-5
    Scenario: An address attempt that edited a locked feature file still posts its replies once a later attempt passes
      Given a run for item 482 that resumes at address with one trusted review comment
      And the address agent's first attempt edits a scenario in "features/pbi-482-orders.feature"
      And the address agent's second attempt changes no locked feature file and writes a reply to the comment
      When the cell runs
      Then the address stage's second attempt passes
      And the reply is posted on the comment's thread
      And the owner is asked no question

  Rule: The owner is never asked about a locked feature file that changed since sign-off

    @ac-6
    Scenario Outline: A <stage> stage that edits a locked feature file asks the owner nothing about it
      Given a run for item 482 that resumes at <stage>
      And every <stage> attempt edits a scenario in "features/pbi-482-orders.feature"
      When the cell runs
      Then the owner is asked no question that says a locked feature file changed since sign-off
      And "features/pbi-482-orders.feature" on the branch matches the lock commit

      Examples:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | address     |
