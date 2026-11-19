@pbi-266
Feature: A PR review finding on a line outside the diff goes in the review's summary, so the review still lands
  The PR review stage posts the PR reviewer's findings as one review at the head it reviewed, with
  one line comment per finding. GitHub can only place a line comment on a line in the PR's diff, and
  turns down the whole review with a 422 when one finding names a line outside it. Today that moves
  the item to NeedsInput, though nothing is wrong with the code or the finding.
  With this item, the stage checks each finding's place against the PR's diff at the reviewed head
  before it posts. A finding GitHub can place goes as a line comment, as today. A finding it can't
  goes in the review's summary instead, as a bullet naming its place and its text. If GitHub still
  turns the review down with a 422, the stage posts it once more with every finding in the summary.
  A finding in the summary is a new finding like any other: the PR addresser answers it in the same
  round, and the PR reviewer checks it on the next round. The stage's message says which findings
  moved to the summary and why.
  Every scenario runs the engine against a fake control plane, a fake agent and a fake repo host, so
  cells run them all. The fake repo host acts as GitHub does: it turns down, with a 422, any review
  with a line comment on a line outside the PR's diff at the review's commit. A "round" is one review
  by the PR reviewer. A finding's "place" is its file and line, written as `path:line`.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise
    And the PR's diff at every head covers lines 1 to 50 of "src/totals.ts" and lines 1 to 30 of "src/totals.test.ts", unless a scenario says otherwise

  Rule: Before posting, the stage checks each finding's place against the PR's diff at the reviewed head, and a finding GitHub can place goes as a line comment

    @ac-1
    Scenario: The stage reads the PR's diff at the head the reviewer reviewed before it posts the review
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then before posting its first review the factory read the PR's diff at the commit the PR reviewer reviewed first
      And before posting its second review the factory read the PR's diff at the addresser's new commit
      And the first review has exactly 1 line comment, "This misses the VAT.", on line 12 of "src/totals.ts"
      And the first review's summary doesn't hold "This misses the VAT."
      And the item moves to InReview

    @ac-1
    Scenario: Findings in the diff stay line comments when another finding in the same review isn't
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 90   | This total is unused. |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR addresser fixes all three with a new commit
      And the PR reviewer finds all three fixed on its second review, with no new finding
      When the cell runs
      Then the first review the factory posted is at the commit the PR reviewer reviewed first
      And that review has exactly 2 line comments
      And that review has a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      And that review has a line comment "Rename this variable." on line 40 of "src/totals.ts"
      And that review has no line comment "This total is unused."

    @ac-1
    Scenario: A line the diff covers only at the reviewed head is placed as a line comment there
      Given the PR's diff at the PR's first head covers lines 1 to 50 of "src/totals.ts"
      And the PR's diff at the addresser's first commit also covers lines 60 to 80 of "src/totals.ts"
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer reports a finding "Round this total." on line 70 of "src/totals.ts" on its second review, and finds the first one fixed
      And the PR addresser fixes "Round this total." with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then before posting its second review the factory read the PR's diff at the addresser's first commit
      And the second review has exactly 1 line comment, "Round this total.", on line 70 of "src/totals.ts"
      And the second review's summary doesn't hold "Round this total."
      And the item moves to InReview

  Rule: A finding whose line isn't in the diff goes in the review's summary as a bullet naming its place and its text, so the review still lands

    @ac-2
    Scenario: A finding on a line past the diff goes in the summary, and the review lands
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the factory posted a review on the PR at the commit the PR reviewer reviewed first
      And that review has no line comments
      And that review's summary holds a bullet naming "src/totals.ts:90" and "This total is unused."
      And that review only comments

    @ac-2
    Scenario: A finding on a file the PR doesn't change goes in the summary
      Given the PR reviewer reports a finding "The README still names the old flag." on line 3 of "README.md" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the first review the factory posted has no line comments
      And that review's summary holds a bullet naming "README.md:3" and "The README still names the old flag."
      And the item moves to InReview

    @ac-2
    Scenario: Each finding outside the diff gets its own bullet in the summary
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding                               |
        | src/totals.ts | 90   | This total is unused.                 |
        | README.md     | 3    | The README still names the old flag.  |
        | src/totals.ts | 12   | This misses the VAT.                  |
      And the PR addresser fixes all three with a new commit
      And the PR reviewer finds all three fixed on its second review, with no new finding
      When the cell runs
      Then the first review the factory posted has exactly 1 line comment, "This misses the VAT.", on line 12 of "src/totals.ts"
      And that review's summary holds a bullet naming "src/totals.ts:90" and "This total is unused."
      And that review's summary holds a bullet naming "README.md:3" and "The README still names the old flag."
      And that review's summary doesn't hold a bullet for "This misses the VAT."

    @ac-2
    Scenario: The summary still states the round's counts when it holds findings
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the first review's summary says it is round 1 with 1 new finding
      And the first review's summary holds a bullet naming "src/totals.ts:90" and "This total is unused."

  Rule: If GitHub still turns the review down with a 422, the stage posts it once more with every finding in the summary

    @ac-3
    Scenario: A review GitHub turns down though every line is in the diff is posted again with every finding in the summary
      Given GitHub turns down the first review the factory posts with a 422, though every finding's line is in the PR's diff
      And the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both fixed on its second review, with no new finding
      When the cell runs
      Then the factory tried to post the first round's review 2 times, at the commit the PR reviewer reviewed first
      And the review that landed for the first round has no line comments
      And that review's summary holds a bullet naming "src/totals.ts:12" and "This misses the VAT."
      And that review's summary holds a bullet naming "src/totals.ts:40" and "Rename this variable."
      And the item moves to InReview

    @ac-3
    Scenario: A finding already in the summary stays there when the review is posted again
      Given GitHub turns down the first review the factory posts with a 422, though every finding's line is in the PR's diff
      And the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 90   | This total is unused. |
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both fixed on its second review, with no new finding
      When the cell runs
      Then the review that landed for the first round has no line comments
      And that review's summary holds a bullet naming "src/totals.ts:12" and "This misses the VAT."
      And that review's summary holds a bullet naming "src/totals.ts:90" and "This total is unused."

    @ac-3
    Scenario: The stage posts the review only once more, and a second 422 isn't retried again
      Given GitHub turns down every review the factory posts with a 422
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      When the cell runs
      Then the factory tried to post the first round's review 2 times
      And the second try had no line comments and held "This misses the VAT." in its summary
      And the PR addresser didn't run
      And the item never moved to InReview

    @ac-3
    Scenario: A review GitHub takes on the first try is posted only once
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the factory tried to post the first round's review 1 time
      And the factory posted one review per round on the PR

  Rule: A finding in the summary counts as a new finding, which the addresser answers in the same round and the reviewer checks on the next

    @ac-4
    Scenario: A round whose only finding is in the summary doesn't pass the stage
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer ran 2 times
      And the PR body holds "PR review took 2 rounds."
      And the item moves to InReview

    @ac-4
    Scenario: The addresser answers a summary finding in the same round, as it answers a line comment
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 90   | This total is unused. |
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both fixed on its second review, with no new finding
      When the cell runs
      Then the PR addresser ran in this cell, after the first review
      And the PR addresser's brief holds "This misses the VAT." on "src/totals.ts:12"
      And the PR addresser's brief holds "This total is unused." on "src/totals.ts:90"
      And the addresser's fix is pushed

    @ac-4
    Scenario: The reviewer checks a summary finding on the next round, at the addresser's new head
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer's second brief names the addresser's new commit as the head to review
      And the PR reviewer's second brief holds "This total is unused." on "src/totals.ts:90" as one of its own findings to check

    @ac-4
    Scenario: The addresser's reply to a summary finding reaches the reviewer on the next round
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser replies "It's read by the export job." to that finding, with no code change
      And the PR reviewer accepts that reply on its second review, with no new finding
      When the cell runs
      Then the PR reviewer's second brief holds "This total is unused." with the reply "It's read by the export job."
      And the item moves to InReview

    @ac-4
    Scenario: A summary finding the reviewer still holds keeps the stage from passing
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer holds that finding on its second review, saying "It's still never read.", with no new finding
      And the PR addresser fixes it again with a new commit
      And the PR reviewer finds that finding fixed on its third review, with no new finding
      When the cell runs
      Then the PR reviewer ran 3 times
      And the PR addresser's second brief holds "This total is unused." with "It's still never read."
      And the PR body holds "PR review took 3 rounds."
      And the item moves to InReview

    @ac-4
    Scenario: A summary finding the reviewer finds settled isn't handed to it again
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, and reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts"
      And the PR addresser fixes "Add a test for zero." with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then the PR reviewer's third brief doesn't hold "This total is unused."
      And the item moves to InReview

  Rule: A misplaced line no longer sends the item to NeedsInput, and the stage message says which findings moved to the summary and why

    @ac-5
    Scenario: A finding outside the diff doesn't move the item to NeedsInput
      Given the PR reviewer reports a finding "This total is unused." on line 90 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the item never moved to NeedsInput
      And the PR review stage passed
      And the item moves to InReview

    @ac-5
    Scenario: The stage message names each finding moved to the summary because its line isn't in the diff
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding                               |
        | src/totals.ts | 12   | This misses the VAT.                  |
        | src/totals.ts | 90   | This total is unused.                 |
        | README.md     | 3    | The README still names the old flag.  |
      And the PR addresser fixes all three with a new commit
      And the PR reviewer finds all three fixed on its second review, with no new finding
      When the cell runs
      Then the pr-review stage's message names "src/totals.ts:90" and "README.md:3" as moved to the review's summary
      And the pr-review stage's message says their lines aren't in the PR's diff
      And the pr-review stage's message doesn't name "src/totals.ts:12" as moved to the review's summary

    @ac-5
    Scenario: The stage message says GitHub's 422 moved every finding to the summary
      Given GitHub turns down the first review the factory posts with a 422, though every finding's line is in the PR's diff
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that finding fixed on its second review, with no new finding
      When the cell runs
      Then the pr-review stage's message names "src/totals.ts:12" as moved to the review's summary
      And the pr-review stage's message says GitHub turned the review down with a 422
      And the item never moved to NeedsInput
      And the item moves to InReview

    @ac-5
    Scenario: A review with every finding in the diff says nothing about the summary in the stage message
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the pr-review stage's message doesn't say any finding moved to the review's summary
      And before posting its first review the factory read the PR's diff at the commit the PR reviewer reviewed first
