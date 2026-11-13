@pbi-128
Feature: PR review stage: the factory reviews its own PR before people do
  Once the factory opens a PR and CI passes on it, a "pr-review" stage runs before any person is
  asked to look. The factory's PR reviewer, "factory-pr-reviewer", reviews the PR at its head
  commit. The factory posts the reviewer's findings as one review at that commit, with one line
  comment per finding. When there are findings, the factory's PR addresser answers each one in the
  same cell, by fixing the code or replying on its thread. The reviewer then checks each of its
  threads at the new head. The factory resolves each thread the reviewer finds settled. A thread the
  reviewer still holds stays open, with a reply that says what still fails.
  The stage passes when a review brings no new finding and none of the factory's threads is open.
  The PR body then says how many rounds the stage took, and only then does the item move to InReview.
  A finding still held after the addresser has replied to it twice, or no clean review after 5
  rounds, moves the item to NeedsInput and names the open threads. CI failing on the addresser's fix
  sends the item back to Green, and that counts against Green's retries.
  Every scenario runs the engine against a fake control plane, a fake agent and a fake repo host, so
  cells run them all. A "round" is one review by the PR reviewer. Threads that people open on the PR
  aren't the factory's threads.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise

  Rule: The PR review stage runs after the PR opens and CI passes, and the item reaches InReview only after it

    @ac-1
    Scenario: The PR review stage runs after the PR opens, and the item moves to InReview after it
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the item moves to InReview
      And the cell ends done

    @ac-1
    Scenario: The PR review runs the factory's PR reviewer on the PR's head commit
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR review ran the agent "factory-pr-reviewer"
      And the PR reviewer's brief names the PR's head commit as the one to review
      And the PR reviewer's brief names the PR it reviews

    @ac-1
    Scenario: The item is still InProgress while the PR reviewer runs
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the item was still InProgress when the PR reviewer ran
      And the item moved to InReview after the PR review stage ended

    @ac-1
    Scenario: The PR review waits for CI on the PR to pass
      Given CI fails on the PR's first head and passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the PR reviewer never reviewed the commit CI failed on
      And the item moves to InReview

  Rule: The factory posts each review as one review at the commit it reviewed, with one line comment per finding

    @ac-2
    Scenario: Two findings are posted as one review with two line comments at the reviewed commit
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR reviewer finds nothing on its second review
      When the cell runs
      Then the first review the factory posted on the PR is at the commit the PR reviewer reviewed first
      And that review has exactly 2 line comments
      And that review has a line comment "This misses the VAT." on line 12 of "src/totals.ts"
      And that review has a line comment "Rename this variable." on line 40 of "src/totals.ts"
      And that review only comments

    @ac-2
    Scenario: Each round's findings go in a review of their own, at the head that round reviewed
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts" on its second review, and finds the first one fixed
      And the PR reviewer finds nothing on its third review
      When the cell runs
      Then the factory posted one review per round on the PR
      And each review the factory posted is at the commit that round reviewed
      And the second review is at the addresser's new commit, not at the PR's first head
      And the second review has exactly 1 line comment, "Add a test for zero.", on line 20 of "src/totals.test.ts"

    @ac-2
    Scenario: A review with no findings is posted with no line comments
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory posted one review on the PR, at the commit the PR reviewer reviewed
      And that review has no line comments
      And that review only comments

  Rule: When a review has findings, the PR addresser answers them in the same cell and the reviewer checks its threads at the new head

    @ac-3
    Scenario: The addresser answers the review's findings in the same cell
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR addresser ran in this cell, after the first review
      And the PR addresser's brief holds "This misses the VAT."
      And the addresser ran the agent "factory-pr-addresser"
      And the item never left InProgress between the first review and the addresser's fix
      And the addresser's fix is pushed

    @ac-3
    Scenario: The reviewer checks each of its threads at the addresser's new head
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both threads fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer's second brief names the addresser's new commit as the head to review
      And the PR reviewer's second brief holds both of its threads, "This misses the VAT." and "Rename this variable."

    @ac-3
    Scenario: A reply on the thread instead of a fix goes on the thread, and the reviewer sees it
      Given the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread, with no code change
      And the PR reviewer accepts that reply on its second review, with no new finding
      When the cell runs
      Then the thread for "Rename this variable." holds the reply "The name matches the invoice field, so it stays."
      And the PR reviewer's second brief holds that thread with the reply "The name matches the invoice field, so it stays."

    @ac-3
    Scenario: A review with no findings doesn't run the addresser
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR reviewer ran once
      And the PR addresser didn't run
      And the item moves to InReview

    @ac-3
    Scenario: A person's thread on the PR isn't handed to the reviewer as one of its own
      Given a trusted person has an open thread "Why not use the tax table?" on the PR
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer's second brief holds the thread "This misses the VAT." as one of its own
      And the PR reviewer's second brief doesn't hold "Why not use the tax table?" as one of its own threads

  Rule: The factory resolves each thread the reviewer finds settled, and a held thread stays open with a reply saying what still fails

    @ac-4
    Scenario: A thread the reviewer finds fixed is resolved
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the factory resolved the thread for "This misses the VAT."

    @ac-4
    Scenario: A thread whose reply the reviewer accepts is resolved
      Given the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread, with no code change
      And the PR reviewer accepts that reply on its second review, with no new finding
      When the cell runs
      Then the factory resolved the thread for "Rename this variable."

    @ac-4
    Scenario: A thread the reviewer still holds stays open, with a reply naming what still fails
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer holds that thread on its second review, saying "VAT is still left out for exports."
      And the PR addresser fixes it again with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then after the second review the thread for "This misses the VAT." was still open
      And that thread holds a reply from the factory saying "VAT is still left out for exports."
      And the factory resolved that thread only after the third review

    @ac-4
    Scenario: In one round the factory resolves the settled threads and leaves the held one open
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding                 |
        | src/totals.ts | 12   | This misses the VAT.    |
        | src/totals.ts | 40   | Rename this variable.   |
        | src/export.ts | 7    | Exports skip rounding.  |
      And the PR addresser fixes "This misses the VAT." and "Exports skip rounding." with a new commit
      And the PR addresser replies "The name matches the invoice field, so it stays." on the thread for "Rename this variable."
      And on its second review the PR reviewer finds "This misses the VAT." fixed, accepts the reply on "Rename this variable.", and holds "Exports skip rounding.", saying "Rounding is still skipped for zero amounts."
      And the PR addresser fixes "Exports skip rounding." again with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then after the second review the threads for "This misses the VAT." and "Rename this variable." were resolved
      And after the second review the thread for "Exports skip rounding." was still open, with a reply from the factory saying "Rounding is still skipped for zero amounts."

    @ac-4
    Scenario: The factory never resolves a person's thread
      Given a trusted person has an open thread "Why not use the tax table?" on the PR
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the factory resolved the thread for "This misses the VAT."
      And the thread "Why not use the tax table?" is still open

  Rule: The stage passes on a review with no new finding and none of the factory's threads open, and the PR body states the rounds

    @ac-5
    Scenario: A clean second review passes the stage, and the PR body says it took 2 rounds
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR review stage passed
      And the PR body holds "PR review took 2 rounds."
      And the PR body still holds "Refs #482"
      And the item moves to InReview

    @ac-5
    Scenario: A clean first review passes the stage in 1 round
      Given the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR review stage passed
      And the PR body holds "PR review took 1 round."
      And the item moves to InReview

    @ac-5
    Scenario: A review with no new finding doesn't pass while one of the factory's threads is still held
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer holds that thread on its second review, saying "VAT is still left out for exports.", with no new finding
      And the PR addresser fixes it again with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then the PR reviewer ran 3 times
      And the PR body holds "PR review took 3 rounds."
      And the item moves to InReview

    @ac-5
    Scenario: A review that settles every thread but brings a new finding doesn't pass
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts" on its second review, and finds the first one fixed
      And the PR addresser fixes "Add a test for zero." with a new commit
      And the PR reviewer finds nothing on its third review
      When the cell runs
      Then the PR reviewer ran 3 times
      And the PR body holds "PR review took 3 rounds."
      And the item moves to InReview

    @ac-5
    Scenario: A person's open thread doesn't hold up the stage
      Given a trusted person has an open thread "Why not use the tax table?" on the PR
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR review stage passed
      And the PR body holds "PR review took 1 round."
      And the item moves to InReview

  Rule: A finding held after 2 replies, or no clean review in 5 rounds, moves the item to NeedsInput naming the open threads

    @ac-6
    Scenario: A finding still held after the addresser has replied to it twice moves the item to NeedsInput
      Given the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread each time, with no code change
      And the PR reviewer holds that thread on every later review, saying "The name still hides that it's net of VAT."
      When the cell runs
      Then the PR reviewer ran 3 times
      And the PR addresser replied on that thread 2 times
      And the item moves to NeedsInput, with a question that names the thread for "Rename this variable."
      And the thread for "Rename this variable." is still open
      And the item never moved to InReview

    @ac-6
    Scenario: A finding held after only 1 reply gets another round
      Given the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread
      And the PR reviewer holds that thread on its second review, saying "The name still hides that it's net of VAT."
      And the PR addresser then fixes it with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs
      Then the PR reviewer ran 3 times
      And the item moves to InReview

    @ac-6
    Scenario: The question names only the thread that's still held
      Given the PR reviewer reports these findings on its first review:
        | path          | line | finding               |
        | src/totals.ts | 12   | This misses the VAT.  |
        | src/totals.ts | 40   | Rename this variable. |
      And the PR addresser fixes "This misses the VAT." with a new commit
      And the PR addresser replies "The name matches the invoice field, so it stays." on the thread for "Rename this variable." each time, with no code change
      And the PR reviewer finds "This misses the VAT." fixed on its second review, and holds "Rename this variable." on every review, with no new finding
      When the cell runs
      Then the item moves to NeedsInput, with a question that names the thread for "Rename this variable."
      And the question doesn't name the thread for "This misses the VAT."

    @ac-6
    Scenario: No clean review after 5 rounds moves the item to NeedsInput, naming the open threads
      Given the PR reviewer reports a new finding on every review, and the PR addresser fixes each one with a new commit
      When the cell runs
      Then the PR reviewer ran 5 times
      And the item moves to NeedsInput, with a question that names each of the factory's threads still open
      And the item never moved to InReview

    @ac-6
    Scenario: A clean review on the 5th round still passes
      Given the PR reviewer reports a new finding on each of its first 4 reviews, and the PR addresser fixes each one with a new commit
      And the PR reviewer finds nothing new and every thread fixed on its 5th review
      When the cell runs
      Then the PR reviewer ran 5 times
      And the PR body holds "PR review took 5 rounds."
      And the item moves to InReview

  Rule: CI failing on the addresser's fix sends the item back to Green, counted against Green's retries

    @ac-7
    Scenario: CI failing on the addresser's fix sends the item back to Green
      Given the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And CI fails on the addresser's first fix
      And the PR reviewer finds nothing open on its review after Green's fix
      When the cell runs
      Then the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And Green ran 2 times
      And Green's second brief says CI failed on the addresser's fix
      And the factory posted no review at the commit CI failed on
      And the item moves to InReview

    @ac-7
    Scenario: CI failing on every addresser fix uses up Green's retries and fails the item
      Given the PR reviewer reports a new finding on every review, and the PR addresser fixes each one with a new commit
      And CI fails on every commit the PR addresser makes, and passes on every other
      When the cell runs
      Then Green ran 4 times
      And the item moves to Failed
      And the item never moved to InReview

    @ac-7
    Scenario: Green's retries spent before the PR review count against the trip back
      Given CI fails on the PR's head after each of Green's first 3 attempts, and passes after its 4th
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And CI fails on the addresser's first fix
      When the cell runs
      Then Green ran 4 times
      And the item moves to Failed
      And the item never moved to InReview
