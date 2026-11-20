@pbi-219 @db
Feature: The worker runs board mirroring, comment commands and decision announcements from the outbox
  Step 3 of the control plane redesign (2026-11-07 design, §07 "An outbox in place of hooks") continues here.
  PBI 218 made every transition, override, applied decision and webhook comment write an outbox row in the
  same transaction as its event. This item makes the worker the one place those rows are handled. The worker
  mirrors each transition and override onto the item's board, runs each comment command, and posts each
  decision's announcement on the item, all from outbox rows. It removes a row once every effect of it has
  succeeded. The after-commit transition hooks go away, so the process that made a change no longer acts on
  the board itself. Nothing reaches the board until the worker works through the outbox.
  Today's dashboard announces a decision itself as it applies it. Once the worker announces each decision
  from its outbox row, the dashboard must only apply the decision, or the item would get the announcement
  twice. The same holds for a decision made by a comment.
  Retry timing and the point at which a failing row is set aside are not part of this item.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. They run
  the worker, the dashboard and GitHub's webhook against a fake board and a fake repo host. "The worker
  works through the outbox" means the worker handles every row that is due, once, and then stops.

  Background:
    Given a fresh factory database with two boards, "main" and "side"
    And the board "main" shows a status for each of "InProgress", "SignOff", "NeedsInput", "Failed" and "Done"
    And the outbox is empty

  Rule: The worker mirrors each transition onto the item's board from its outbox row

    @ac-1
    Scenario: A transition reaches the board only when the worker handles its row
      Given item "#11" on board "main" is "Queued"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      Then the board still shows item "#11" as it was, with no status change and no claim
      When the worker works through the outbox
      Then the board shows item "#11" with the status for "InProgress"
      And the board shows item "#11" claimed by the factory
      And the outbox is empty

    @ac-1
    Scenario: A transition made by the cell API is mirrored by the worker
      Given item "#11" on board "main" is "InProgress" with a running cell
      When the cell reports through the cell API that its scenarios are ready for sign-off
      Then the board still shows item "#11" with the status for "InProgress"
      When the worker works through the outbox
      Then the board shows item "#11" with the status for "SignOff"
      And item "#11" on the board has one comment saying it waits for sign-off on the scenarios
      And the outbox is empty

    @ac-1
    Scenario: A finished item is released and closed on the board
      Given item "#11" on board "main" is "InReview" with an open PR
      When item "#11" on board "main" moves to "Accepted" on a merge and then to "Done" on a verified definition of done
      And the worker works through the outbox
      Then the board shows item "#11" with the status for "Done"
      And the board shows item "#11" released and closed
      And the outbox is empty

    @ac-1
    Scenario: An item waiting for an answer gets one comment with its question
      Given item "#11" on board "main" is "InProgress" with a running cell
      When the cell asks "Which currency should totals use?" and item "#11" moves to "NeedsInput"
      And the worker works through the outbox
      Then the board shows item "#11" with the status for "NeedsInput"
      And item "#11" on the board has exactly one comment saying it waits for an answer, quoting "Which currency should totals use?"
      And the outbox is empty

    @ac-1
    Scenario: One item's rows are mirrored in the order its moves were made
      Given item "#11" on board "main" is "Queued"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And item "#11" on board "main" then moves to "SignOff"
      And the worker works through the outbox
      Then the board's last status for item "#11" is the status for "SignOff"
      And the board was set to the status for "InProgress" before the status for "SignOff"
      And the outbox is empty

    @ac-1
    Scenario: A withdrawn item's open PR is closed by the worker
      Given item "#11" on board "main" is "InReview" with an open PR
      When item "#11" on board "main" is withdrawn from the backlog and moves to "Abandoned"
      Then the PR of item "#11" is still open
      When the worker works through the outbox
      Then the PR of item "#11" is closed with a note that the item was withdrawn
      And the board shows item "#11" released
      And the outbox is empty

  Rule: The worker mirrors each operator's override onto the item's board from its outbox row

    @ac-1
    Scenario: An override made on the dashboard reaches the board only when the worker handles its row
      Given item "#11" on board "main" is "InProgress"
      When an operator overrides item "#11" to "Failed" from the dashboard with the reason "stuck run"
      Then the board still shows item "#11" with the status for "InProgress"
      When the worker works through the outbox
      Then the board shows item "#11" with the status for "Failed"
      And the board shows item "#11" released
      And item "#11" on the board has one comment saying it failed and waits for an operator to re-queue it
      And the outbox is empty

  Rule: A row whose effect fails stays in the outbox and holds back no other item

    @ac-1
    Scenario: A board that refuses an update leaves the row in the outbox, while another item is still mirrored
      Given item "#11" on board "main" is "Queued"
      And item "#12" on board "main" is "Queued"
      And the board refuses every update to item "#11"
      When the scheduler moves item "#11" and item "#12" on board "main" to "InProgress"
      And the worker works through the outbox
      Then the board shows item "#12" with the status for "InProgress"
      And the outbox still holds the board mirror row for item "#11"
      And the outbox holds no row for item "#12"

    @ac-1
    Scenario: A row that failed is mirrored once the board accepts updates again
      Given item "#11" on board "main" is "Queued"
      And the board refuses every update to item "#11"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And the worker works through the outbox
      And the board accepts updates to item "#11" again
      And the row for item "#11" is due again and the worker works through the outbox
      Then the board shows item "#11" with the status for "InProgress"
      And the outbox is empty

  Rule: The worker runs each comment command from its outbox row

    @ac-1
    Scenario: A product owner's /approve comment is applied by the worker, not as the webhook arrives
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner with the GitHub login "pat"
      When GitHub delivers a comment "/approve" by "pat" on issue "#11" in the item's repo
      Then item "#11" is still waiting in "SignOff" with its scenarios not signed off
      When the worker works through the outbox
      Then the scenarios of item "#11" are signed off by "Pat" and its run resumes at Red
      And the outbox is empty

    @ac-1
    Scenario: A comment command is announced exactly once on the item
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner with the GitHub login "pat"
      When GitHub delivers a comment "/changes Cover refunds too" by "pat" on issue "#11" in the item's repo
      And the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the scenarios were sent back for changes, quoting "Cover refunds too"
      And the outbox is empty

    @ac-1
    Scenario: A refused comment command gets one reply from the worker and changes nothing
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Olu" is an operator but not a product owner, with the GitHub login "olu"
      When GitHub delivers a comment "/approve" by "olu" on issue "#11" in the item's repo
      Then item "#11" on the board has no reply yet
      When the worker works through the outbox
      Then item "#11" on the board has exactly one reply to "olu" saying only a product owner can sign off scenarios
      And item "#11" is still waiting in "SignOff" with its scenarios not signed off
      And the outbox is empty

    @ac-1
    Scenario: A comment naming an item on two boards is applied only to the item whose repo it was made in
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off, in repo "acme/shop"
      And item "#11" on board "side" is waiting in "SignOff" for its scenarios to be signed off, in repo "acme/tools"
      And "Pat" is a product owner with the GitHub login "pat"
      When GitHub delivers a comment "/approve" by "pat" on issue "#11" in repo "acme/shop"
      And the worker works through the outbox
      Then the scenarios of item "#11" on board "main" are signed off by "Pat"
      And item "#11" on board "side" is still waiting in "SignOff" with its scenarios not signed off
      And the outbox is empty

  Rule: The worker posts each decision's announcement from its outbox row, once

    @ac-1
    Scenario: An answer's announcement quotes the answer as it was given
      Given item "#11" on board "main" is waiting in "NeedsInput" for an answer
      And "Olu" is an operator
      When "Olu" answers item "#11" with "Use euros" and the decision commits
      Then item "#11" on the board has no announcement yet
      When the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the answer was received, quoting "Use euros"
      And the outbox is empty

    @ac-1
    Scenario: The same announcement row handled twice posts one comment
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner
      When "Pat" approves the scenarios of item "#11" and the decision commits
      And the worker handles that decision's announcement row twice, as it would after a crash before removing it
      Then item "#11" on the board has exactly one comment saying the scenarios were signed off

  Rule: No transition hook remains

    @ac-1
    Scenario: The factory offers no way to run code after a transition other than the outbox
      When the factory's source is searched for a transition hook to register
      Then there is no "onTransition" hook, and no part of the factory registers one

  Rule: The dashboard applies a decision and leaves its announcement to the worker

    @ac-2
    Scenario: A sign-off on the dashboard is announced by the worker, exactly once
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner signed in to the dashboard
      When "Pat" approves the scenarios of item "#11" on the dashboard
      Then the dashboard takes "Pat" back to item "#11"
      And the scenarios of item "#11" are signed off by "Pat"
      And item "#11" on the board has no announcement yet
      When the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the scenarios were signed off

    @ac-2
    Scenario: An answer on the dashboard is announced by the worker, exactly once
      Given item "#11" on board "main" is waiting in "NeedsInput" for an answer
      And "Olu" is an operator signed in to the dashboard
      When "Olu" answers item "#11" on the dashboard with "Use euros"
      Then item "#11" on the board has no announcement yet
      When the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the answer was received, quoting "Use euros"

    @ac-2
    Scenario: A dashboard decision whose announcement the board refuses is announced once the board recovers
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner signed in to the dashboard
      And the board refuses every comment on item "#11"
      When "Pat" approves the scenarios of item "#11" on the dashboard
      And the worker works through the outbox
      Then the scenarios of item "#11" are signed off by "Pat"
      And the outbox still holds the decision announcement row for item "#11"
      When the board accepts comments on item "#11" again
      And the row for item "#11" is due again and the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the scenarios were signed off
      And the outbox is empty
