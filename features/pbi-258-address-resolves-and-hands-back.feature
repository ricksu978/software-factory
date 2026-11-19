@pbi-258
Feature: Address resolves the threads it deals with, and address with nothing to do hands the PR back
  When an unresolved thread with a trusted comment sends the item back, address reads every comment in
  that thread, then fixes the code or replies. Until now it left the thread unresolved, so the person had
  to resolve it, and a reply of theirs in it could send the item back again. Now address resolves each
  thread once it has dealt with it: after its fix has passed CI and its reply, if any, is posted. A thread
  it didn't answer stays unresolved.
  An item can also reach address with nothing left to do there, for example when the person resolved
  their thread after the poller had already sent the item back. Until now address then asked the owner
  "no trusted review text to address", and the item waited in NeedsInput for no reason. Now, when
  address starts with no trusted review text and no merge conflict with the base, it ends without asking
  anything. The run goes on to the "pr-review" stage, and the item returns to InReview once that review
  passes, as it does after address answers a review.
  Every scenario runs the engine against a fake control plane, a fake agent and a fake repo host, so
  cells run them all. A "round" is one review by the PR reviewer.

  Background:
    Given a run for item 482 that resumes at address
    And PR 57 is still open
    And the branch merges the base with no conflict
    And CI passes on every commit unless a scenario says otherwise

  Rule: Address reads the unresolved thread's comments, answers them, and resolves the thread once it has

    @ac-3
    Scenario: Address reads every comment in the thread, fixes the code, and resolves the thread after CI passes
      Given "octo"'s unresolved thread on line 12 of "src/totals.ts" on PR 57 holds these comments, oldest first:
        | author       | comment                                          |
        | octo         | Why not use the tax table?                       |
        | factory[bot] | Now uses the tax table.                          |
        | octo         | Not fixed, the total still skips the tax table.  |
      And the PR addresser fixes that thread with a new commit
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR addresser's brief holds "Why not use the tax table?", "Now uses the tax table." and "Not fixed, the total still skips the tax table."
      And the factory resolved octo's thread on line 12 of "src/totals.ts"
      And the factory resolved that thread only after CI passed on the addresser's new commit
      And the item moves to InReview

    @ac-3
    Scenario: Address that answers with a reply and no code change posts the reply, then resolves the thread
      Given "octo"'s unresolved thread "Why not use the tax table?" on line 12 of "src/totals.ts" on PR 57 sent the item back to address
      And the PR addresser replies "The tax table has no rate for this region, so the flat rate stays." on that thread, with no code change
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory posted the reply "The tax table has no rate for this region, so the flat rate stays." in the thread "Why not use the tax table?"
      And the factory resolved the thread "Why not use the tax table?" after posting that reply
      And the item moves to InReview

    @ac-3
    Scenario: A thread the addresser didn't answer stays unresolved, while the one it answered is resolved
      Given "octo"'s unresolved thread "Why not use the tax table?" on line 12 of "src/totals.ts" on PR 57 sent the item back to address
      And "octo"'s unresolved thread "Name the retry limit." on line 30 of "src/retry.ts" is also on PR 57
      And the PR addresser replies "The tax table has no rate for this region, so the flat rate stays." on the thread "Why not use the tax table?", and neither fixes nor replies to "Name the retry limit."
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory resolved the thread "Why not use the tax table?"
      And the factory didn't resolve the thread "Name the retry limit."

  Rule: Address with no review text and no conflict ends without a question and goes on to the PR review

    @ac-6
    Scenario: Address with nothing to do ends passed, and the PR review hands the PR back
      Given no trusted review text waits on the run's PR 57
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the address stage's last attempt ends passed
      And the cell ran these stages, in order:
        | stage     |
        | address   |
        | pr-review |
      And the item doesn't move to NeedsInput
      And the owner is asked no question
      And the item moves to InReview
      And the cell ends done

    @ac-6
    Scenario: Address with nothing to do runs no PR addresser and posts nothing on the PR
      Given no trusted review text waits on the run's PR 57
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the PR addresser never ran
      And no reply is posted on PR 57
      And the PR reviewer's brief names PR 57's current head as the head to review

    @ac-6
    Scenario: The item stays InProgress until the PR review after an empty address passes
      Given no trusted review text waits on the run's PR 57
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the item was still InProgress when the PR reviewer ran
      And the item moved to InReview after the PR review stage ended

    @ac-6
    Scenario: A person who resolved their thread after it sent the item back gets the PR back without a question
      Given "octo"'s thread "Why not use the tax table?" sent the item back to address
      And "octo" resolved that thread before the cell started
      And no other trusted review text waits on the run's PR 57
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the owner is asked no question
      And the item moves to InReview

  Rule: The PR review after an empty address runs its rounds before the item returns to InReview

    @ac-6
    Scenario: A finding from the PR review is answered in the same cell before the item returns to InReview
      Given no trusted review text waits on the run's PR 57
      And the PR reviewer reports a finding "This misses the VAT." on line 20 of "src/totals.ts" on its first review
      And the PR addresser fixes that finding with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR reviewer ran 2 times
      And the factory resolved the thread for "This misses the VAT."
      And the item never moved to InReview before the PR review stage passed
      And the item moves to InReview

    @ac-6
    Scenario: A finding the PR review still holds after two replies keeps the item out of InReview
      Given no trusted review text waits on the run's PR 57
      And the PR reviewer reports a finding "Rename this variable." on line 40 of "src/totals.ts" on its first review
      And the PR addresser replies "The name matches the invoice field, so it stays." on that thread each time, with no code change
      And the PR reviewer holds that thread on every later review, saying "The name still hides that it's net of VAT."
      When the cell runs
      Then the PR reviewer ran 3 times
      And the item moves to NeedsInput, with a question that names the thread for "Rename this variable."
      And no question says "no trusted review text to address"
      And the item never moved to InReview
