@pbi-315
Feature: A head CI failed on stays failed across claims, so the next claim doesn't read CI on it again or charge an attempt
  Since #292, a head CI failed on is never read again within a claim. Nothing on it changed for CI to judge, so
  the run goes back to Green instead of being charged another attempt for the same failure. But a claim only
  remembers that for itself. When a claim ends on the question the factory asks after giving up on a CI
  failure, and a person answers it, the next claim of the same run starts on the same head as if CI had never
  failed there. Once Green and self-review pass, open-pr reads CI on that head again and is charged an attempt
  for a failure the run already knows about.
  With this item, a head CI failed on in one claim counts as failed in every later claim of the same run.
  The next claim goes back to Green without reading CI on that head again and without charging an attempt for
  it. A new commit on the branch clears this, just as it does within a claim today. That commit can be Green's
  fix, a person's push while the item waits, or the claim's merge of a newer base. CI is read on the new
  commit, and a failure there is charged as usual.
  In every scenario, item 482's run has its scenarios signed off, its PR is opened by the factory on base
  "main", and the base doesn't move unless a scenario says it does. The scenarios run the cell engine against
  a fake control plane, a fake agent and a fake repo host, so cells run them all.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise
    And in the first claim CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
    And in the first claim Green's fix for the CI failure makes no commit

  Rule: A head CI failed on in one claim counts as failed in the next claim of the same run, so the next claim goes back to Green without reading CI on it or charging an attempt

    @ac-1 @ac-3
    Scenario: A claim that ends on the CI question, and a next claim that starts on the same head, doesn't read CI on that head again
      Given in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes no commit
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then the first claim ended on the question saying the factory gave up fixing CI on "c0ffee1"
      And the next claim started on the commit "c0ffee1"
      And in the next claim the factory read CI on "c0ffee1" 0 times
      And exactly 1 attempt in the run says CI failed on "c0ffee1"

    @ac-1
    Scenario: The next claim goes back to Green with the failed check of the head CI failed on in the earlier claim
      Given in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes no commit
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then in the next claim Green ran 2 times
      And in the next claim Green's second brief says CI failed on "c0ffee1"
      And in the next claim Green's second brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7201"
      And in the next claim Green's second brief names the test "totals include VAT"
      And no attempt in the next claim says CI failed on "c0ffee1"

    @ac-1
    Scenario: Green leaving the head unchanged again in the next claim asks the question again, without a charged read of CI
      Given in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes no commit
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then the next claim ended on the question saying the factory gave up fixing CI on "c0ffee1"
      And the item moves to NeedsInput
      And the item doesn't move to Failed
      And in the next claim the factory read CI on "c0ffee1" 0 times

    @ac-1
    Scenario: Green fixing the failure in the next claim takes the item to review, with the earlier head read only once
      Given in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes the commit "c0ffee2"
      And CI passes on "c0ffee2"
      And the PR reviewer finds nothing on its first review
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then in the next claim the factory read CI on "c0ffee1" 0 times
      And exactly 1 attempt in the run says CI failed on "c0ffee1"
      And the factory read CI on "c0ffee2"
      And the owner is asked exactly 1 question
      And the item moves to InReview

  Rule: A new commit on the branch clears this, as it does within a claim today

    @ac-2
    Scenario: Green's new commit in the next claim is read, and a failure on it is charged with its own checks
      Given in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes the commit "c0ffee2"
      And CI reports the check "ci" failed on "c0ffee2" at "https://github.com/acme/widgets/actions/runs/7202", failing the test "rounds to the cent"
      And in the next claim Green's next fix for the CI failure makes the commit "c0ffee3"
      And CI passes on "c0ffee3"
      And the PR reviewer finds nothing on its first review
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then in the next claim the factory read CI on "c0ffee1" 0 times
      And exactly 1 attempt in the run says CI failed on "c0ffee1"
      And exactly 1 attempt in the run says CI failed on "c0ffee2"
      And in the next claim Green's third brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7202"
      And in the next claim Green's third brief names the test "rounds to the cent"
      And the item moves to InReview

    @ac-2 @regression
    Scenario: A commit a person pushed while the item waited is read in the next claim
      Given a person pushes the commit "f1x0001" to the item's branch while the item waits on the question
      And CI passes on "f1x0001"
      And in the next claim Green makes no commit
      And the PR reviewer finds nothing on its first review
      When the first claim's cell runs
      And the owner answers the question "I fixed it on the branch"
      And the next claim's cell runs from Green
      Then the next claim started on the commit "f1x0001"
      And the factory read CI on "f1x0001"
      And the owner is asked exactly 1 question
      And the item moves to InReview

    @ac-2 @regression
    Scenario: A commit a person pushed that CI fails on too is charged and goes back to Green with its own checks
      Given a person pushes the commit "f1x0001" to the item's branch while the item waits on the question
      And CI reports the check "e2e" failed on "f1x0001" at "https://github.com/acme/widgets/actions/runs/7301", failing the test "signs in"
      And in the next claim Green makes no commit
      And in the next claim Green's fix for the CI failure makes the commit "c0ffee2"
      And CI passes on "c0ffee2"
      And the PR reviewer finds nothing on its first review
      When the first claim's cell runs
      And the owner answers the question "I fixed it on the branch"
      And the next claim's cell runs from Green
      Then exactly 1 attempt in the run says CI failed on "f1x0001"
      And in the next claim Green's second brief names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7301"
      And in the next claim Green's second brief names the test "signs in"
      And the item moves to InReview

    @ac-2 @regression
    Scenario: The next claim's merge of a newer base makes a new commit, which is read
      Given "main" gets a new commit while the item waits on the question
      And in the next claim Green makes no commit
      And CI passes on the next claim's merge of the base
      And the PR reviewer finds nothing on its first review
      When the first claim's cell runs
      And the owner answers the question "Try once more"
      And the next claim's cell runs from Green
      Then the next claim started on a merge commit other than "c0ffee1"
      And the factory read CI on the next claim's merge of the base
      And the owner is asked exactly 1 question
      And the item moves to InReview
