@pbi-129
Feature: PR review groundwork: the factory's PR reviewer, and posting a review and resolving a thread
  The factory is getting a stage that reviews a pull request after it opens. This item lays the
  groundwork for it. The factory ships its own PR reviewer agent, "factory-pr-reviewer". It reviews
  one PR head against the PR review rubric in its brief, checks each open thread it's given, and
  ends with a verdict. A branch can't replace that agent with its own file of the same name.
  The repo host can post a review at a given commit, with a body and line comments. That review
  only ever comments: the repo host offers no way to approve a PR or request changes on it. The
  repo host can also resolve a review thread. The fake repo host records each review and each
  resolved thread, so the engine's tests can check what a stage posted.

  Rule: The factory ships a PR reviewer that reviews one PR head and ends with a verdict

    @ac-1
    Scenario: The factory ships its own PR reviewer agent
      When the factory's cell agents are read
      Then they include an agent named "factory-pr-reviewer"
      And its description says it reviews a pull request for the factory

    @ac-1
    Scenario: The PR reviewer reviews the one PR head its brief names, against the rubric in its brief
      When the factory's "factory-pr-reviewer" agent is read
      Then its instructions tell it to review the PR head its brief names
      And its instructions tell it to judge that head against the PR review rubric in its brief, and nothing else

    @ac-1
    Scenario: The PR reviewer checks each open thread it's given at that head
      When the factory's "factory-pr-reviewer" agent is read
      Then its instructions tell it to check each open thread in its brief against the PR head
      And its instructions tell it to say, for each of those threads, whether the head settles it

    @ac-1
    Scenario: The PR reviewer ends with APPROVED, or OPEN and the number of open findings
      When the factory's "factory-pr-reviewer" agent is read
      Then its instructions say its last line is exactly "APPROVED" when nothing is left open
      And its instructions say its last line is otherwise "OPEN: <n>", with n the number left open

  Rule: A checkout's own agent file doesn't replace the factory's PR reviewer

    @ac-2
    Scenario: A checkout's PR reviewer file doesn't replace the factory's PR reviewer
      Given a checkout holding its own "factory-pr-reviewer" agent file, whose instructions differ from the factory's
      When a cell run that names "factory-pr-reviewer" sets up its agent run in that checkout
      Then the PR reviewer the run gets has the factory's instructions
      And the PR reviewer the run gets doesn't have the checkout's instructions

    @ac-2
    Scenario: A checkout's PR reviewer file can't change the PR reviewer's tools
      Given a checkout holding its own "factory-pr-reviewer" agent file, which grants the tools "Read, Edit, Write, Bash"
      When a cell run that names "factory-pr-reviewer" sets up its agent run in that checkout
      Then the PR reviewer the run gets has the tools the factory's definition lists
      And the PR reviewer the run gets has no tool that only the checkout's file grants

    @ac-2
    Scenario: A cell run that names the PR reviewer gets the factory's definition when the checkout has no such file
      Given a checkout with no agent files of its own
      When a cell run that names "factory-pr-reviewer" sets up its agent run in that checkout
      Then the PR reviewer the run gets has the factory's instructions

  Rule: The repo host posts a review at a given commit, and that review only ever comments

    @ac-3
    Scenario: A review with a body and line comments is posted at the given commit
      Given GitHub's pull request 9 on "ricksu978/software-factory", whose requests are recorded
      When the factory posts a review on PR 9 at commit "1a2b3c4" with the body "Two things to look at" and these line comments:
        | path            | line | body                  |
        | src/totals.ts   | 12   | This misses the VAT.  |
        | src/totals.ts   | 40   | Rename this variable. |
      Then GitHub receives one review on PR 9
      And that review is at commit "1a2b3c4"
      And that review has the body "Two things to look at"
      And that review has a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      And that review has a line comment "Rename this variable." on line 40 of "src/totals.ts"
      And that review's event is "COMMENT"

    @ac-3
    Scenario: A review with no line comments posts its body alone, still as a comment
      Given GitHub's pull request 9 on "ricksu978/software-factory", whose requests are recorded
      When the factory posts a review on PR 9 at commit "1a2b3c4" with the body "Looks right to me" and no line comments
      Then GitHub receives one review on PR 9
      And that review has the body "Looks right to me"
      And that review has no line comments
      And that review's event is "COMMENT"

    @ac-3
    Scenario: The repo host has no way to approve or request changes
      When the repo host's way to post a review is read
      Then it takes the repo, the PR, the commit, the body and the line comments
      And it takes nothing that names a review event

    @ac-3
    Scenario Outline: A review handed an event of its own still posts as a comment
      Given GitHub's pull request 9 on "ricksu978/software-factory", whose requests are recorded
      When the factory posts a review on PR 9 at commit "1a2b3c4" with the body "Ship it", slipping in the event "<event>"
      Then GitHub receives one review on PR 9
      And that review's event is "COMMENT"
      And GitHub receives no review on PR 9 whose event is "<event>"

      Examples:
        | event           |
        | APPROVE         |
        | REQUEST_CHANGES |

  Rule: The repo host resolves a review thread by its id, and resolving it again changes nothing

    @ac-4
    Scenario: An open thread is resolved by its id
      Given GitHub's pull request 9 on "ricksu978/software-factory", with an open review thread "T-1", whose requests are recorded
      When the factory resolves thread "T-1"
      Then GitHub is asked to resolve thread "T-1"
      And thread "T-1" is resolved

    @ac-4
    Scenario: Resolving a thread that's already resolved succeeds and changes nothing
      Given GitHub's pull request 9 on "ricksu978/software-factory", with a resolved review thread "T-2", whose requests are recorded
      When the factory resolves thread "T-2"
      Then resolving thread "T-2" succeeds
      And thread "T-2" is still resolved
      And nothing else on PR 9 has changed

    @ac-4
    Scenario: A resolved thread drops out of the PR's open review comments on the fake repo host
      Given the fake repo host has PR 9 on "ricksu978/software-factory" with an open thread "T-3" saying "Rename this"
      When the factory resolves thread "T-3" on the fake repo host
      Then PR 9's open review comments no longer hold "Rename this"

    @ac-4
    Scenario: Resolving a thread twice on the fake repo host succeeds and changes nothing the second time
      Given the fake repo host has PR 9 on "ricksu978/software-factory" with an open thread "T-4" saying "Rename this"
      When the factory resolves thread "T-4" on the fake repo host
      And the factory resolves thread "T-4" on the fake repo host again
      Then resolving thread "T-4" the second time succeeds
      And the fake repo host records thread "T-4" as resolved once
      And PR 9's open review comments no longer hold "Rename this"

  Rule: The fake repo host records each review and each resolved thread for the engine's tests

    @ac-5
    Scenario: The fake repo host records a posted review with its commit, body and line comments
      Given the fake repo host has PR 9 on "ricksu978/software-factory"
      When the factory posts a review on PR 9 at commit "1a2b3c4" on the fake repo host, with the body "Two things to look at" and a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      Then the fake repo host's recorded reviews hold one review on PR 9
      And that recorded review is at commit "1a2b3c4" with the body "Two things to look at"
      And that recorded review has a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      And that recorded review only comments

    @ac-5
    Scenario: The fake repo host records every review, in the order they were posted
      Given the fake repo host has PR 9 on "ricksu978/software-factory"
      When the factory posts a review on PR 9 at commit "1a2b3c4" on the fake repo host, with the body "First pass"
      And the factory posts a review on PR 9 at commit "5d6e7f8" on the fake repo host, with the body "Second pass"
      Then the fake repo host's recorded reviews hold two reviews on PR 9
      And the first recorded review is at commit "1a2b3c4" with the body "First pass"
      And the second recorded review is at commit "5d6e7f8" with the body "Second pass"

    @ac-5
    Scenario: The fake repo host records each resolved thread
      Given the fake repo host has PR 9 on "ricksu978/software-factory" with open threads "T-5" and "T-6"
      When the factory resolves thread "T-5" on the fake repo host
      And the factory resolves thread "T-6" on the fake repo host
      Then the fake repo host's recorded resolved threads hold "T-5" and "T-6"

    @ac-5
    Scenario: A fake repo host with nothing posted records no reviews and no resolved threads
      Given the fake repo host has PR 9 on "ricksu978/software-factory" with an open thread "T-7" saying "Rename this"
      When nothing is posted or resolved on the fake repo host
      Then the fake repo host's recorded reviews are empty
      And the fake repo host's recorded resolved threads are empty
