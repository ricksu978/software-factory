@pbi-318
Feature: PR review checks every open thread the factory's reviewer opened, including ones from an earlier claim
  The PR review stage posts the PR reviewer's findings as threads on the PR, under the repo's trusted
  bot, and keeps track of the ones still open. Today it keeps that track only within one claim. A later
  claim that reaches PR review starts with no threads, so a thread an earlier claim left open is never
  checked again, never resolved, and doesn't keep the stage from passing. The review's summary
  leaves it out of "earlier threads still open", so #270's review said "0 earlier threads still open"
  with one of them open on the PR. Round numbers start again at 1 in each claim, too.
  With this item, each claim that reaches PR review starts by reading the PR's open review threads.
  Every open thread the factory's reviewer opened is the stage's own, with its conversation so far,
  whichever claim opened it. The stage passes only when none of them is open. The review's summary
  counts them all, and round numbers carry on from the last round any earlier claim posted.
  Every scenario runs the engine against a fake control plane, a fake agent and a fake repo host, so
  cells run them all. A "round" is one review by the PR reviewer. A "claim" is one cell's run of the
  item. A thread "from an earlier claim" is one the fake repo host already holds on the PR when the
  cell starts, opened by the factory's reviewer under the trusted bot. A person's thread is never one
  of the factory's threads.

  Background:
    Given a run for item 482 whose scenarios were signed off and whose PR is open
    And the repo's trusted bot is "factory[bot]"
    And CI passes on every commit unless a scenario says otherwise

  Rule: A claim that reaches PR review takes up every open thread the factory's reviewer opened, with its conversation so far

    @ac-1
    Scenario: The PR reviewer's first brief holds an open thread an earlier claim opened
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer finds that thread fixed on its first review, with no new finding
      When the cell runs from the PR review
      Then the factory read the PR's open review threads before the PR reviewer first ran
      And the PR reviewer's first brief holds "This misses the VAT." on "src/totals.ts:12" as one of its own threads to check
      And the item moves to InReview

    @ac-1
    Scenario: An earlier claim's thread comes with its conversation so far, in order
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the addresser replied "VAT is added by the caller." inside that thread
      And the PR reviewer replied "Still open: the caller in src/export.ts doesn't add it." inside that thread
      And the PR reviewer finds that thread fixed on its first review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer's first brief holds "This misses the VAT." with this conversation, in order:
        | from     | reply                                                       |
        | author   | VAT is added by the caller.                                 |
        | reviewer | Still open: the caller in src/export.ts doesn't add it.     |

    @ac-1
    Scenario: The addresser is handed an earlier claim's thread the reviewer still holds
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds that thread on its first review, saying "Still no VAT on line 12.", with no new finding
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the PR addresser's first brief holds "This misses the VAT." on "src/totals.ts:12" with "Still no VAT on line 12."
      And the factory replied "Still open" inside that thread, naming the head the PR reviewer reviewed first

    @ac-1
    Scenario: Earlier claims' threads and this claim's threads are checked together
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer finds that thread fixed on its first review, and reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts"
      And the PR addresser fixes "Add a test for zero." with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer's first brief holds "This misses the VAT." as one of its own threads to check
      And the factory resolved the thread "This misses the VAT." after the first review
      And the PR reviewer's second brief holds "Add a test for zero." as one of its own threads to check
      And the PR reviewer's second brief doesn't hold "This misses the VAT."
      And the item moves to InReview

    @ac-1
    Scenario: A person's open thread on the PR isn't taken up as one of the factory's
      Given a trusted person's open thread "Why not use the tax table?" on line 12 of "src/totals.ts"
      And an earlier claim's PR review left an open thread "Rename this variable." on line 40 of "src/totals.ts"
      And the PR reviewer finds "Rename this variable." fixed on its first review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer's first brief holds "Rename this variable." as one of its own threads to check
      And the PR reviewer's first brief doesn't hold "Why not use the tax table?" as one of its own threads
      And the factory didn't resolve the thread "Why not use the tax table?"
      And the item moves to InReview

    @ac-1
    Scenario: A factory thread already resolved on the PR isn't taken up again
      Given an earlier claim's PR review left a resolved thread "This misses the VAT." on line 12 of "src/totals.ts"
      And an earlier claim's PR review left an open thread "Rename this variable." on line 40 of "src/totals.ts"
      And the PR reviewer finds "Rename this variable." fixed on its first review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer's first brief holds "Rename this variable." as one of its own threads to check
      And the PR reviewer's first brief doesn't hold "This misses the VAT."

  Rule: The stage passes only when none of the factory's threads is open on the PR, whichever claim opened them

    @ac-2
    Scenario: An earlier claim's thread the reviewer still holds keeps the stage from passing
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds that thread on its first review, saying "Still no VAT on line 12.", with no new finding
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer ran 2 times
      And the PR review stage didn't pass after the first review
      And the item moves to InReview

    @ac-2
    Scenario: An earlier claim's thread the reviewer finds fixed is resolved, and the stage passes
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer finds that thread fixed on its first review, with no new finding
      When the cell runs from the PR review
      Then the factory resolved the thread "This misses the VAT."
      And no thread the factory's reviewer opened is open on the PR
      And the PR review stage passed
      And the item moves to InReview

    @ac-2
    Scenario: A clean review with no new finding doesn't pass the stage while an earlier claim's thread is open
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds that thread on every review, with no new finding
      And the PR addresser replies "VAT is added by the caller." to that thread each time, with no code change
      When the cell runs from the PR review
      Then the item never moved to InReview
      And the item moves to NeedsInput
      And the factory's message names "This misses the VAT." as still open on the PR

    @ac-2
    Scenario: A person's open thread neither holds the stage nor stands in for the factory's own
      Given a trusted person's open thread "Why not use the tax table?" on line 12 of "src/totals.ts"
      And an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds "This misses the VAT." on its first review, saying "Still no VAT on line 12.", with no new finding
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the PR reviewer ran 2 times
      And the PR review stage passed with the thread "Why not use the tax table?" still open on the PR
      And the factory didn't resolve the thread "Why not use the tax table?"
      And the item moves to InReview

  Rule: The review's summary counts every open factory thread on the PR in its "earlier threads still open", whichever claim opened them

    @ac-3
    Scenario: The #270 case: one thread from an earlier claim still open is counted in the summary
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds that thread on its first review, saying "Still no VAT on line 12.", with no new finding
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the first review's summary says "0 new findings, 1 earlier thread still open."

    @ac-3
    Scenario: The summary counts an earlier claim's thread together with a thread from this claim
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And the PR reviewer holds that thread on its first review, saying "Still no VAT on line 12.", and reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts"
      And the PR addresser fixes "Add a test for zero." with a new commit, and doesn't fix "This misses the VAT."
      And the PR reviewer finds "Add a test for zero." fixed on its second review, holds "This misses the VAT.", with no new finding
      And the PR addresser fixes "This misses the VAT." with a new commit
      And the PR reviewer finds that thread fixed on its third review, with no new finding
      When the cell runs from the PR review
      Then the first review's summary says "1 new finding, 1 earlier thread still open."
      And the second review's summary says "0 new findings, 1 earlier thread still open."

    @ac-3
    Scenario: Two threads from two different earlier claims are both counted
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And another, later claim's PR review left an open thread "Rename this variable." on line 40 of "src/totals.ts"
      And the PR reviewer holds both threads on its first review, with no new finding
      And the PR addresser fixes both with a new commit
      And the PR reviewer finds both fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the first review's summary says "0 new findings, 2 earlier threads still open."

    @ac-3
    Scenario: Of an earlier claim's threads, only those the reviewer still holds are counted as still open
      Given an earlier claim's PR review left an open thread "This misses the VAT." on line 12 of "src/totals.ts"
      And an earlier claim's PR review left an open thread "Rename this variable." on line 40 of "src/totals.ts"
      And the PR reviewer finds "Rename this variable." fixed on its first review, holds "This misses the VAT.", with no new finding
      And the PR addresser fixes "This misses the VAT." with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the first review's summary says "0 new findings, 1 earlier thread still open."
      And the second review's summary says "0 new findings, 0 earlier threads still open."

  Rule: Round numbers carry on across claims from the last round any earlier claim posted on the PR

    @ac-4
    Scenario: A claim's first round follows the last round an earlier claim posted
      Given an earlier claim posted the factory's PR reviews for rounds 1 and 2 on the PR
      And the PR reviewer finds nothing on its first review
      When the cell runs from the PR review
      Then the first review the factory posted in this cell says it is round 3

    @ac-4
    Scenario: Rounds carry on past the last of several earlier claims
      Given an earlier claim posted the factory's PR reviews for rounds 1 and 2 on the PR
      And another, later claim posted the factory's PR review for round 3 on the PR
      And the PR reviewer reports a finding "Add a test for zero." on line 20 of "src/totals.test.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs from the PR review
      Then the first review the factory posted in this cell says it is round 4
      And the second review the factory posted in this cell says it is round 5

    @ac-4
    Scenario: Rounds carry on even when an earlier claim left no thread open
      Given an earlier claim posted the factory's PR reviews for rounds 1 and 2 on the PR
      And no thread the factory's reviewer opened is open on the PR
      And the PR reviewer finds nothing on its first review
      When the cell runs from the PR review
      Then the first review the factory posted in this cell says it is round 3

    @ac-4
    Scenario: A person's review on the PR doesn't move the round count on
      Given an earlier claim posted the factory's PR review for round 1 on the PR
      And a trusted person posted a review on the PR after it
      And the PR reviewer finds nothing on its first review
      When the cell runs from the PR review
      Then the first review the factory posted in this cell says it is round 2

  Rule: A thread one claim leaves open is checked by the next claim's review at the new head

    @ac-5
    Scenario: The next claim's review finds an earlier claim's thread fixed at the new head and resolves it
      Given in the first claim the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And in the first claim the PR addresser fixes it with a new commit
      And the first claim ends on a usage limit before the PR reviewer reviews the addresser's commit
      And in the next claim the PR reviewer finds that thread fixed on its first review, with no new finding
      When the first claim's cell runs
      And the next claim's cell runs from the PR review
      Then the thread "This misses the VAT." was still open on the PR when the next claim started
      And the next claim's PR reviewer's first brief names the addresser's commit as the head to review
      And the next claim's PR reviewer's first brief holds "This misses the VAT." on "src/totals.ts:12" as one of its own threads to check
      And the factory resolved the thread "This misses the VAT." in the next claim
      And the next claim's first review says it is round 2, with "0 new findings, 0 earlier threads still open."
      And the item moves to InReview

    @ac-5
    Scenario: The next claim's review holds an earlier claim's thread still failing at the new head
      Given in the first claim the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And in the first claim the PR addresser fixes it with a new commit
      And the first claim ends on a usage limit before the PR reviewer reviews the addresser's commit
      And in the next claim the PR reviewer holds that thread on its first review, saying "Still no VAT on line 12.", with no new finding
      And in the next claim the PR addresser fixes it with a new commit
      And in the next claim the PR reviewer finds that thread fixed on its second review, with no new finding
      When the first claim's cell runs
      And the next claim's cell runs from the PR review
      Then in the next claim the factory replied "Still open" inside the thread "This misses the VAT.", naming the first claim addresser's commit
      And the next claim's first review says "0 new findings, 1 earlier thread still open."
      And the next claim's PR addresser's first brief holds "This misses the VAT." with "Still no VAT on line 12."
      And the PR review stage didn't pass in the next claim until the reviewer found that thread fixed
      And the item moves to InReview

    @ac-5
    Scenario: A thread left open by a claim that ended in NeedsInput is checked when the item is claimed again
      Given in the first claim the PR reviewer holds a finding "This misses the VAT." on line 12 of "src/totals.ts" until the PR review blocks
      And the item moves to NeedsInput at the end of the first claim, with that thread open on the PR
      And the item's question is answered and the item is claimed again
      And in the next claim the PR reviewer finds that thread fixed on its first review, with no new finding
      When the first claim's cell runs
      And the next claim's cell runs from the PR review
      Then the next claim's PR reviewer's first brief holds "This misses the VAT." as one of its own threads to check
      And the factory resolved the thread "This misses the VAT." in the next claim
      And the item moves to InReview
