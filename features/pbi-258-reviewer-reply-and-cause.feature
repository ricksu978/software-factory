@pbi-258 @db
Feature: A reviewer's verified-fix reply doesn't send the item back to address, and the move names its cause
  Once the factory has addressed a trusted person's thread and the item is back in InReview, the person
  often replies inside that thread to say the fix is good, and resolves it. That reply asks for nothing,
  so it must not send the item back to address. A reply in a thread that stays open, such as "Not fixed",
  still does, and so does a conflict GitHub reports. An approval asks for nothing either, even with a
  summary. Each time the factory does send the item back, the "changes_requested" event says why: which
  review or thread comment, and when it was submitted, or that GitHub reported the PR not mergeable.
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

  Rule: A trusted reply inside a thread that is resolved doesn't send the item back to address

    @ac-1
    Scenario: A reviewer who requests changes with only a reply in their own thread, then resolves it, doesn't send the item to address
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-1
    Scenario: The same reply in a thread someone else resolved before the poller read it doesn't send the item to address
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "ricksu978" resolved the thread "Why not use the tax table?"
      When the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

    @ac-1
    Scenario: The same reply delivered through the webhook, then seen by the poller, doesn't send the item to address
      Given "octo" submitted a review requesting changes whose only text is the reply "Verified, fixed." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      When GitHub delivers octo's review to the webhook
      And the poller runs once
      Then the factory holds the item in state "InReview"
      And the item's run doesn't resume from "address"

  Rule: A trusted reply in a thread that stays open still sends the item back to address

    @ac-2 @regression
    Scenario: A "Not fixed" reply in a thread that stays open sends the item to address
      Given "octo" replied "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?"
      And the thread "Why not use the tax table?" is still open
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

    @ac-2 @regression
    Scenario: A review requesting changes whose reply sits in a thread that stays open sends the item to address
      Given "octo" submitted a review requesting changes whose only text is the reply "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?"
      And the thread "Why not use the tax table?" is still open
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

    @ac-2 @regression
    Scenario: A reply in an open thread sends the item to address even when another thread is resolved
      Given "octo" opened a thread of their own, "Name the retry limit.", on the item's PR
      And "octo" replied "Verified, fixed." inside the thread "Why not use the tax table?"
      And "octo" resolved the thread "Why not use the tax table?"
      And the thread "Name the retry limit." is still open
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"

  Rule: An approval doesn't send the item back to address, even with a summary

    @ac-3
    Scenario: An approval with a summary and a thank-you reply in a thread left open doesn't send the item to address
      Given "octo" approved the item's PR with the summary "Looks good, thanks for the fix.", replying "Fixed, thanks." inside the thread "Why not use the tax table?" as part of that approval
      And the thread "Why not use the tax table?" is still open
      When the poller runs once
      Then the item's run doesn't resume from "address"
      And the factory never moved the item on "changes_requested"

  Rule: The changes_requested event names what caused it

    @ac-4
    Scenario: A move caused by a reply in an open thread names that comment and when it was submitted
      Given "octo" replied "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?", in a review submitted at "2026-11-14T09:00:00Z"
      And the thread "Why not use the tax table?" is still open
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a thread comment by "octo" reading "Not fixed, the total still skips the tax table."
      And the item's "changes_requested" event names "2026-11-14T09:00:00Z" as the time that comment was submitted
      And the item's "changes_requested" event doesn't say GitHub reported the PR not mergeable

    @ac-4
    Scenario: A move caused by a review's summary names that review and when it was submitted
      Given "octo" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a review by "octo" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-4
    Scenario: A move made by the webhook names the review it was delivered
      Given "octo" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When GitHub delivers octo's review to the webhook
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event names a review by "octo" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-4
    Scenario: With several trusted comments waiting, the event names the newest one
      Given "octo" replied "Not fixed, the total still skips the tax table." inside the thread "Why not use the tax table?", in a review submitted at "2026-11-14T09:00:00Z"
      And the thread "Why not use the tax table?" is still open
      And "ricksu978" requested changes on the item's PR with only the summary "Name the retry limit.", in a review submitted at "2026-11-14T09:05:00Z"
      When the poller runs once
      Then the item's "changes_requested" event names a review by "ricksu978" whose summary reads "Name the retry limit."
      And the item's "changes_requested" event names "2026-11-14T09:05:00Z" as the time that review was submitted

    @ac-4
    Scenario: A move caused by a conflict says GitHub reported the PR not mergeable
      Given "octo" resolved the thread "Why not use the tax table?"
      And GitHub reports the item's PR as not mergeable
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's "changes_requested" event says GitHub reported the PR not mergeable
      And the item's "changes_requested" event names no review or thread comment
