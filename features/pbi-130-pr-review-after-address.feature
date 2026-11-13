@pbi-130
Feature: PR review runs again after the factory addresses a person's review
  When a trusted person's review sends an item back to address, the factory's PR addresser answers it
  and pushes. Until now the item went straight back to InReview once CI passed on that push, so the
  factory's own PR reviewer never saw the new code. Now, once CI passes on what address pushed, the
  "pr-review" stage runs on the PR's new head in the same cell, as it does after the PR first opens.
  The item returns to InReview only after that review passes.
  Every scenario runs the engine against a fake control plane, a fake agent and a fake repo host, so
  cells run them all. A "round" is one review by the PR reviewer. A person's thread is never one of
  the factory's threads.

  Background:
    Given a run for item 482 whose PR is in review
    And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
    And CI passes on every commit unless a scenario says otherwise

  Rule: After address answers a person's review and CI passes, the PR review runs on the new head before the item returns to InReview

    @ac-1
    Scenario: The PR review runs after address, and the item returns to InReview after it
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the cell ran these stages, in order:
        | stage     |
        | address   |
        | pr-review |
      And the item moves to InReview
      And the cell ends done

    @ac-1
    Scenario: The PR reviewer reviews the commit the addresser pushed
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR review ran the agent "factory-pr-reviewer"
      And the PR reviewer's brief names the addresser's new commit as the head to review
      And the PR reviewer's brief names the PR it reviews
      And the factory posted one review on the PR, at the addresser's new commit

    @ac-1
    Scenario: The item is still InProgress while the PR reviewer runs after address
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the item was still InProgress when the PR reviewer ran
      And the item moved to InReview after the PR review stage ended

    @ac-1
    Scenario: The person's thread is left to the person, not taken up by the PR review
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR reviewer's brief doesn't hold "Why not use the tax table?" as one of its own threads
      And the factory didn't resolve the thread "Why not use the tax table?"
      And the item moves to InReview

  Rule: The PR review after address waits for CI to pass, and never reviews a commit CI failed on

    @ac-1
    Scenario: CI failing on the addresser's first fix holds the PR review back until a fix passes
      Given the PR addresser fixes the person's thread with a new commit on each attempt
      And CI fails on the addresser's first fix and passes on its second
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR reviewer ran once
      And the PR reviewer's brief names the addresser's second fix as the head to review
      And the PR reviewer never reviewed the commit CI failed on
      And the factory posted no review at the commit CI failed on
      And the item moves to InReview

  Rule: A PR review after address that brings findings runs its rounds before the item returns to InReview

    @ac-1
    Scenario: A finding on the addresser's commit is answered in the same cell before the item returns to InReview
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer reports a finding "This misses the VAT." on line 20 of "src/totals.ts" on its first review
      And the PR addresser fixes that finding with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer ran 2 times
      And the PR reviewer's second brief names the addresser's newest commit as the head to review
      And the factory resolved the thread for "This misses the VAT."
      And the item never moved to InReview before the PR review stage passed
      And the item moves to InReview

    @ac-1
    Scenario: A finding still held after the addresser has replied to it twice keeps the item out of InReview
      Given the PR addresser fixes the person's thread with a new commit
      And the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread each time, with no code change
      And the PR reviewer holds that thread on every later review, saying "The name still hides that it's net of VAT."
      When the cell runs
      Then the PR reviewer ran 3 times
      And the item moves to NeedsInput, with a question that names the thread for "Rename this variable."
      And the item never moved to InReview
