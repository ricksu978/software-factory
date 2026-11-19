@pbi-305 @db
Feature: An item blocked on "no trusted review text" goes back to address once its PR conflicts or gets a new review
  An address run that finds no trusted review text and no conflict to resolve stops and asks one question:
  "no trusted review text to address". The item then waits in NeedsInput with its PR still open. Today it
  waits there until a person answers, even after its PR starts to conflict with its base or a trusted
  person asks for changes on it, which are the very things address is there for.
  With this item, the poller answers that question itself once it reads the item's PR as conflicting with
  its base, or once a trusted review or a comment in a still-open thread, newer than the question, asks for
  changes. The answer names what changed: the conflict, or the review and its time. No person gave it, so
  it names nobody as the one who answered, as the factory's answer after a base passes does (PBI 260). The
  re-queue is logged as a system event, and the item is claimed again at address.
  A person's answer, a Hold or an earlier poll that got there first wins, and nothing is answered or logged
  twice. An item waiting on any other question still waits for a person.
  In every scenario, "octo" is an allowlisted user and "stranger" isn't. Item 482's open run has PR 57 in
  "acme/widgets", on base "main". Every scenario needs Postgres, which each test starts for itself, so cells
  and CI both run them. GitHub, the board, the agent and the repo are fakes.

  Rule: A PR that conflicts with its base sends the item waiting on "no trusted review text" back to address

    @ac-1
    Scenario: The PR conflicting with its base re-queues the item at address
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And the item stopped at the address stage
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "address"

    @ac-1
    Scenario: A PR whose mergeability GitHub hasn't worked out yet doesn't re-queue the item, and a conflict read later does
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub hasn't yet worked out whether PR 57 conflicts with its base
      When the poller runs once
      Then item 482's question is still open
      When GitHub reports PR 57 as conflicting with its base
      And the poller runs once
      Then item 482's question is answered by the factory

    @ac-1
    Scenario: A PR that merges cleanly and has no new review leaves the item waiting, until it conflicts
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as merging cleanly with its base
      And nobody has reviewed PR 57 since the question was asked
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"
      When GitHub reports PR 57 as conflicting with its base
      And the poller runs once
      Then item 482's question is answered by the factory

    @ac-1
    Scenario: A conflicting PR re-queues every item waiting on the question, each once
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And item 483 waits in NeedsInput on the question "no trusted review text to address", with PR 58 in "acme/widgets"
      And GitHub reports PR 57 as conflicting with its base
      And GitHub reports PR 58 as conflicting with its base
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's question is answered by the factory

  Rule: A trusted review or open-thread comment asking for changes, newer than the question, sends the item back to address

    @ac-2
    Scenario: A trusted review asking for changes after the question re-queues the item at address
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And the item stopped at the address stage
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "address"

    @ac-2
    Scenario: A trusted comment in a still-open thread after the question re-queues the item at address
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And the item stopped at the address stage
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" commented "Please rename this" in a still-open thread on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "address"

    @ac-2
    Scenario: A trusted review from before the question doesn't re-queue the item, and a newer one does
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" requested changes on PR 57 at "2026-11-10T08:00:00Z"
      When the poller runs once
      Then item 482's question is still open
      When "octo" requests changes on PR 57 at "2026-11-10T10:30:00Z"
      And the poller runs once
      Then item 482's question is answered by the factory

    @ac-2
    Scenario: A review from someone not on the allowlist doesn't re-queue the item, and a trusted one does
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "stranger" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      Then item 482's question is still open
      And item 482 has no system event recording a re-queue for address
      When "octo" requests changes on PR 57 at "2026-11-10T11:00:00Z"
      And the poller runs once
      Then item 482's question is answered by the factory

    @ac-2
    Scenario: A reply inside one of the factory's own review threads doesn't re-queue the item, and a person's thread does
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" replied at "2026-11-10T10:30:00Z" inside a still-open thread the factory's PR reviewer started on PR 57
      When the poller runs once
      Then item 482's question is still open
      When "octo" comments "Please rename this" in a new thread on PR 57 at "2026-11-10T11:00:00Z"
      And the poller runs once
      Then item 482's question is answered by the factory

  Rule: The factory answers the question itself, naming what changed, and logs the re-queue as a system event

    @ac-3
    Scenario: The answer after a conflict names the conflict and comes from the factory, not a person
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      Then item 482's question is answered by the factory
      And nobody answered item 482's question in person
      And the answer says PR 57 conflicts with its base "main"

    @ac-3
    Scenario: The answer after a review names the review and its time
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      Then item 482's question is answered by the factory
      And nobody answered item 482's question in person
      And the answer says a trusted review asked for changes on PR 57
      And the answer names the time "2026-11-10T10:30:00Z"

    @ac-3
    Scenario: The re-queue is a system event on the item naming what changed
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      Then item 482 has a system event recording its re-queue for address after PR 57 conflicted with its base
      And the event names item 482's question
      And the event's actor is the system, not a person

    @ac-3
    Scenario: The re-queue event after a review names the review's time
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      Then item 482 has a system event recording its re-queue for address after a review at "2026-11-10T10:30:00Z"
      And the event's actor is the system, not a person

    @ac-3
    Scenario: The dashboard stops asking for an answer once the factory has answered
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      And "octo" opens the dashboard
      Then "Waiting on you" on the dashboard doesn't list item 482

  Rule: A person's answer, a Hold or an earlier poll that comes first wins, and nothing is answered or logged twice

    @ac-4
    Scenario: A person's answer given first stands, while an unanswered item is re-queued
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And item 483 waits in NeedsInput on the question "no trusted review text to address", with PR 58 in "acme/widgets"
      And the owner has answered item 483's question "Leave it, I'll fix it by hand"
      And GitHub reports PR 57 as conflicting with its base
      And GitHub reports PR 58 as conflicting with its base
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's answer is still "Leave it, I'll fix it by hand", given by the owner
      And item 483 has no system event recording a re-queue for address

    @ac-4
    Scenario: A person who answers while the poller is reading the PR wins, and the factory doesn't answer over them
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And item 483 waits in NeedsInput on the question "no trusted review text to address", with PR 58 in "acme/widgets"
      And GitHub reports PR 57 as conflicting with its base
      And GitHub reports PR 58 as conflicting with its base
      And the owner answers item 483's question "Leave it" while the poller is reading PR 58
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's answer is still "Leave it", given by the owner
      And item 483 has no system event recording a re-queue for address

    @ac-4
    Scenario: A held item stays in NeedsInput when its PR conflicts, while an unheld one is re-queued
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And item 483 waits in NeedsInput on the question "no trusted review text to address", with PR 58 in "acme/widgets"
      And an operator has put item 483 on Hold
      And GitHub reports PR 57 as conflicting with its base
      And GitHub reports PR 58 as conflicting with its base
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And item 483's question is still open
      And the factory holds item 483 in state "NeedsInput"
      And item 483 has no system event recording a re-queue for address

    @ac-4
    Scenario: A held item is re-queued at address once it's released
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And the item stopped at the address stage
      And an operator has put item 482 on Hold
      And GitHub reports PR 57 as conflicting with its base
      And the poller has run once
      When an operator releases item 482
      And the poller runs once
      And the scheduler runs once
      Then item 482's question is answered by the factory
      And the factory holds item 482 in state "InProgress"
      And the item's run resumes from "address"

    @ac-4
    Scenario: A second poll re-queues the item only once
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs twice
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue for address

    @ac-4
    Scenario: Two polls running at once re-queue the item only once
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And GitHub reports PR 57 as conflicting with its base
      When two polls run at the same time
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue for address

    @ac-4
    Scenario: A PR that both conflicts and has a new review re-queues the item once
      Given item 482 waits in NeedsInput on the question "no trusted review text to address", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as conflicting with its base
      And "octo" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      Then item 482's question is answered exactly once
      And item 482 has exactly one system event recording a re-queue for address

  Rule: An item waiting on any other question stays put, as today

    @ac-5 @regression
    Scenario: An item waiting on another question stays in NeedsInput when its PR conflicts
      Given item 482 waits in NeedsInput on the question "Address failed: CI failed on the PR"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-5 @regression
    Scenario: An item waiting on another question stays in NeedsInput when a trusted review asks for changes
      Given item 482 waits in NeedsInput on the question "Address failed: CI failed on the PR", asked at "2026-11-10T09:00:00Z"
      And GitHub reports PR 57 as merging cleanly with its base
      And "octo" requested changes on PR 57 at "2026-11-10T10:30:00Z"
      When the poller runs once
      And the scheduler runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-5 @regression
    Scenario: An item stopped by a red base stays in NeedsInput when its PR conflicts, while the base is still red
      Given item 482 waits in NeedsInput on a question saying the base fails in the cell at commit "b4se001"
      And CI still fails on the newest commit of "main"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      Then item 482's question is still open
      And the factory holds item 482 in state "NeedsInput"

    @ac-5
    Scenario: A conflict re-queues the item waiting on "no trusted review text" and leaves one waiting on another question
      Given item 482 waits in NeedsInput on the question "no trusted review text to address"
      And item 483 waits in NeedsInput on the question "Address failed: CI failed on the PR", with PR 58 in "acme/widgets"
      And GitHub reports PR 57 as conflicting with its base
      And GitHub reports PR 58 as conflicting with its base
      When the poller runs once
      Then item 482's question is answered by the factory
      And item 483's question is still open
      And item 483 has no system event recording a re-queue for address
