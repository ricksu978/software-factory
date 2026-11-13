@pbi-190
Feature: An unreadable PR review answer gets one restate before the item asks a person
  The factory's PR reviewer must end its answer in a set format: its findings, a verdict on each of
  its open threads, and a last line of APPROVED or "OPEN: <n>". Today an answer the factory can't
  read sends the item straight to NeedsInput, so a person is asked about a slip in the format. With
  this item, the PR review stage first asks the same reviewer session, once, to restate its answer
  in the required format, and says why the answer couldn't be read. It doesn't run a new review. A
  restated answer that reads correctly carries on as a first answer would. One that is still
  unreadable sends the item to NeedsInput as today, with the restated answer's reason. The restate
  is logged on the stage, so Run detail shows the reviewer needed a second ask, and it is not
  counted as a round of the review or as a new attempt at the stage.
  An answer can't be read when its last line is neither APPROVED nor "OPEN: <n>", when a finding has
  no file or no line, or when it says "OPEN: <n>" with no new finding and no thread held.
  The engine scenarios run against a fake control plane, a fake agent and a fake repo host, so cells
  run them all. A "round" is one review by the PR reviewer. A "restate" is the factory's second ask
  for the same review, in the same reviewer session.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise

  Rule: An unreadable answer gets one restate in the same reviewer session, quoting why it couldn't be read

    @ac-1
    Scenario: An answer whose last line is neither APPROVED nor OPEN gets a restate in the same session
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the factory asked the PR reviewer to restate its answer once
      And the restate went to the same PR reviewer session as its first review
      And the restate request quotes why the answer couldn't be read, naming the last line "Looks fine to me overall."
      And the restate request asks for the answer again in the required format, ending in APPROVED or "OPEN: <n>"

    @ac-1
    Scenario: The restate doesn't run a new review from scratch
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the PR reviewer was given the review brief once
      And the restate request doesn't hold the review brief again
      And the factory started no new PR reviewer session for the restate

    @ac-1
    Scenario: A finding with no line gets a restate that says the finding needs its line
      Given the PR reviewer's first review reports a finding "This misses the VAT." in "src/totals.ts" with no line, ending "OPEN: 1"
      And the PR reviewer restates its answer with the finding "This misses the VAT." on line 12 of "src/totals.ts", ending "OPEN: 1"
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the factory asked the PR reviewer to restate its first review once
      And the restate request quotes why the answer couldn't be read, saying a finding needs its text, a path and a line

    @ac-1
    Scenario: An OPEN answer with nothing open behind it gets a restate
      Given the PR reviewer's first review reports no finding and ends "OPEN: 2"
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the factory asked the PR reviewer to restate its answer once
      And the restate request quotes why the answer couldn't be read, saying it answered "OPEN: 2" with no new finding and no thread held

    @ac-1
    Scenario: An unreadable review in a later round gets its own restate
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer's second review ends with the line "All good now, I think."
      And the PR reviewer restates its second review as finding that thread fixed, with no new finding, ending APPROVED
      When the cell runs
      Then the factory asked the PR reviewer to restate its second review once
      And the restate went to the same PR reviewer session as its second review
      And the factory resolved the thread for "This misses the VAT."
      And the item moves to InReview

  Rule: A restated answer that reads correctly carries on as a first answer would

    @ac-2
    Scenario: A restated APPROVED passes the stage and the item moves to InReview
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the PR review stage passed
      And the factory posted one review on the PR, at the commit the PR reviewer reviewed, with no line comments
      And the PR addresser didn't run
      And the item moves to InReview
      And the item never moved to NeedsInput

    @ac-2
    Scenario: A restated OPEN posts its findings and the addresser answers them
      Given the PR reviewer's first review ends with the line "Two things to fix, see above."
      And the PR reviewer restates its answer with these findings, ending "OPEN: 2":
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both threads fixed on its second review, with no new finding
      When the cell runs
      Then the first review the factory posted on the PR is at the commit the PR reviewer reviewed first
      And that review has exactly 2 line comments
      And that review has a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      And that review has a line comment "Rename this variable." on line 40 of "src/totals.ts"
      And the PR addresser ran in this cell, after the first review
      And the PR addresser's brief holds "This misses the VAT." and "Rename this variable."
      And the item moves to InReview

    @ac-2
    Scenario: Nothing is posted on the PR from the unreadable answer itself
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the factory posted exactly one review on the PR
      And no review or comment on the PR holds "Looks fine to me overall."

  Rule: A restated answer that is still unreadable sends the item to NeedsInput with the restated answer's reason

    @ac-3
    Scenario: A restate that is still unreadable moves the item to NeedsInput, naming the restated answer's reason
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer ending with the line "Sorry, as I said, it looks fine."
      When the cell runs
      Then the item moves to NeedsInput
      And the question says the PR review couldn't read the PR reviewer's answer
      And the question names the last line "Sorry, as I said, it looks fine."
      And the question doesn't name the line "Looks fine to me overall."
      And the factory posted no review on the PR
      And the item never moved to InReview

    @ac-3
    Scenario: The factory asks for a restate only once
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer answers every restate request ending with the line "Sorry, as I said, it looks fine."
      When the cell runs
      Then the factory asked the PR reviewer to restate its answer once
      And the item moves to NeedsInput

    @ac-3
    Scenario: A restate unreadable for a different reason gives that reason
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer with a finding "This misses the VAT." in "src/totals.ts" with no line, ending "OPEN: 1"
      When the cell runs
      Then the item moves to NeedsInput
      And the question says a finding needs its text, a path and a line
      And the question doesn't name the line "Looks fine to me overall."

  Rule: The restate is logged on the PR review stage and shown on Run detail

    @ac-4
    Scenario: The PR review stage's record says the reviewer needed a second ask
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the PR review stage's record says the PR reviewer needed a second ask in round 1
      And that record gives why its first answer couldn't be read, naming the last line "Looks fine to me overall."

    @ac-4
    Scenario: The second ask is logged even when the restate is still unreadable
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer ending with the line "Sorry, as I said, it looks fine."
      When the cell runs
      Then the PR review stage's record says the PR reviewer needed a second ask in round 1
      And the item moves to NeedsInput

    @ac-4
    Scenario: Run detail shows that the PR reviewer needed a second ask
      Given item 482's PR review stage, attempt 1, recorded that the PR reviewer needed a second ask in round 1 because its last line was "Looks fine to me overall."
      When an operator opens Run detail for item 482
      Then the "Stages" section shows that the PR review stage's attempt 1 needed a second ask of the PR reviewer
      And it shows why the first answer couldn't be read

  Rule: The restate counts against neither the review's rounds nor the stage's attempts

    @ac-5
    Scenario: A restated review is still one round, in the same attempt
      Given the PR reviewer's first review ends with the line "Looks fine to me overall."
      And the PR reviewer restates its answer as APPROVED
      When the cell runs
      Then the PR body holds "PR review took 1 round."
      And the PR review stage ran 1 attempt
      And the item moves to InReview

    @ac-5
    Scenario: A restate in the 5th round still lets that round pass
      Given the PR reviewer reports a new finding on each of its first 4 reviews, and the PR addresser fixes each one with a new commit
      And the PR reviewer's 5th review ends with the line "Everything is addressed now."
      And the PR reviewer restates its 5th review as finding every thread fixed, with no new finding, ending APPROVED
      When the cell runs
      Then the PR review stage passed
      And the PR body holds "PR review took 5 rounds."
      And the item moves to InReview

    @ac-5
    Scenario: A restate in every round doesn't use up the rounds early
      Given the PR reviewer's every review needs a restate, and each restate reads correctly
      And the PR reviewer reports a new finding on each of its first 4 reviews, and the PR addresser fixes each one with a new commit
      And the PR reviewer finds nothing new and every thread fixed on its 5th review
      When the cell runs
      Then the factory asked the PR reviewer to restate 5 times, once per round
      And the PR body holds "PR review took 5 rounds."
      And the item moves to InReview
