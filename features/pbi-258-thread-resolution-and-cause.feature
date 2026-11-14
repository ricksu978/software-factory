@pbi-258 @db
Feature: Only an unresolved review thread sends the item back to address, and the move names its cause
  Once the factory has addressed a trusted person's thread and the item is back in InReview, the person
  often replies inside that thread to say the fix is good, and resolves it. Until now a review that
  requested changes counted even when its only text sat in a thread that was resolved, so a reply like
  "Verified, fixed." sent the item back to address with nothing to do. Now a thread sends the item back
  only when it is unresolved at the moment the poller reads it. What its comments say never matters:
  a resolved "Not fixed" sends nothing back, and an unresolved "Verified, fixed." does. An approval
  asks for nothing, even with a summary. Each time the factory does send the item back, the
  "changes_requested" event says why: which review or thread comment, and when it was submitted, or
  that GitHub reported the PR not mergeable.
  The board, the repo host and GitHub's webhook deliveries are fakes here. Every scenario needs Postgres,
  which each test starts for itself, so cells and CI both run them. A comment counts only once it has
  stood for two minutes, so every comment here has stood longer than that. The person's first thread and
  the factory's reply in it came before the item last came back to InReview. Every comment a scenario
  adds came after.

  Background:
    Given the factory holds an item in state "InReview" with an open PR
    And the repo's trusted bot is "factory[bot]"
    And "octo" is an allowlisted user
    And "ricksu978" is an allowlisted user
    And "octo" opened a thread of their own, "Why not use the tax table?", on the item's PR
    And the factory replied "Now uses the tax table." inside that thread
    And the item came back to InReview after that reply

  Rule: Whether a thread sends the item back depends only on whether it is resolved when the poller reads it

    @ac-1
    Scenario: A "Not fixed" reply in a thread that is resolved when the poller reads it doesn't send the item back
      Given "octo" submitted a review requesting changes whose only text is the reply "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"
      And the item has no "changes_requested" event since it came back to InReview

    @ac-1 @ac-3
    Scenario: A "Verified, fixed." reply in a thread left unresolved sends the item back, naming that reply
      Given "octo" replied "Verified, fixed." inside the thread "Why not use the tax table?", in a review submitted at "2026-11-14T09:00:00Z"
      And the thread "Why not use the tax table?" is still unresolved
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"
      And the item's "changes_requested" event names a thread comment by "octo" reading "Verified, fixed."

    @ac-1
    Scenario: Of two threads holding the same reply, only the unresolved one is named as the cause
      Given "octo" opened a thread of their own, "Name the retry limit.", on the item's PR
      And "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?", at "2026-11-14T09:00:00Z"
      And "octo" resolved the thread "Why not use the tax table?"
      And "octo" replied "Verified, fixed." inside the thread "Name the retry limit.", in a review submitted at "2026-11-14T08:55:00Z"
      And the thread "Name the retry limit." is still unresolved
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names the comment inside the thread "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T08:55:00Z" as the time that comment was submitted
      And the item's "changes_requested" event doesn't name the thread "Why not use the tax table?"

  Rule: A resolved thread never sends the item back, whoever replied in it and whatever the reply says

    @ac-2
    Scenario: A reviewer who requests changes with only a reply in their own thread, then resolves it, doesn't send the item back
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"
      And the item has no "changes_requested" event since it came back to InReview

    @ac-2
    Scenario: A reply in a thread someone else resolved before the poller read it doesn't send the item back
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "ricksu978" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-2
    Scenario: Another trusted person's reply in a resolved thread doesn't send the item back
      Given "ricksu978" submitted a review requesting changes whose only text is the reply "Still wrong for refunds." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"
      And the item has no "changes_requested" event since it came back to InReview

    @ac-2
    Scenario: A reply GitHub's webhook delivered before the thread was resolved doesn't send the item back
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      When GitHub delivers octo's review to the webhook
      And "octo" resolves the thread "Why not use the tax table?"
      And the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

  Rule: An approval doesn't send the item back, even with a summary

    @ac-4
    Scenario: An approval with a summary, after a request for changes whose only text sits in a resolved thread, doesn't send the item back
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      And "octo" then approved the item's PR with the summary "Looks good, thanks for the fix."
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"
      And the item has no "changes_requested" event since it came back to InReview

  Rule: The changes_requested event names what caused it

    @ac-5
    Scenario: A move caused by a comment in an unresolved thread names that comment and when it was submitted
      Given "octo" replied "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?", in a review submitted at "2026-11-14T09:00:00Z"
      And the thread "Why not use the tax table?" is still unresolved
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a thread comment by "octo" reading "Not fixed, the total still skips the tax table."
      And the item's "changes_requested" event names "2026-11-14T09:00:00Z" as the time that comment was submitted
      And the item's "changes_requested" event doesn't say GitHub reported the PR not mergeable

    @ac-5
    Scenario: A move caused by a review's summary names that review and when it was submitted
      Given "octo" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a review by "octo" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-5
    Scenario: A move made by the webhook names the review it was delivered
      Given "octo" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When GitHub delivers octo's review to the webhook
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a review by "octo" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-5
    Scenario: With several trusted comments waiting, the event names the newest one
      Given "octo" replied "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?", in a review submitted at "2026-11-14T09:00:00Z"
      And the thread "Why not use the tax table?" is still unresolved
      And "ricksu978" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When the poller runs once
      Then the item's "changes_requested" event names a review by "ricksu978" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-5
    Scenario: A move caused by a conflict says GitHub reported the PR not mergeable
      Given "octo" resolved the thread "Why not use the tax table?"
      And GitHub reports the item's PR as not mergeable
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event says GitHub reported the PR not mergeable
      And the item's "changes_requested" event names no review or thread comment
