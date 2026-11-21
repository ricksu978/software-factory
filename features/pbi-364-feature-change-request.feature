@pbi-364
Feature: A stage after sign-off can request a change to a locked feature, and the item moves to FeatureChangeRequest
  Once the owner signs off an item's scenarios, its feature files are locked at the lock commit. Today a
  stage that finds a locked scenario wrong has no way to say so: any edit it makes to a locked file is
  put back as it was at the lock commit, and the item carries on. With this item, a stage that runs
  after sign-off can ask to change a locked feature file. Its report names each file it wants to change
  and why. The factory still restores the locked files, pushes the rest of the stage's work, and moves
  the item from InProgress to FeatureChangeRequest. The request shows on the item page and as a comment
  on the PBI. For each file it shows the change from the lock commit to the proposed version, before and
  after, with the stage's reason, the way sign-off shows scenarios today. An edit to a locked file with
  no request is still restored silently. In each scenario, item 482's feature file
  "features/pbi-482-orders.feature" was locked at sign-off, and at the lock commit it holds the step
  "Then the order is refused". The cell engine runs against a fake control plane, agent and repo, and
  the board is a fake.

  Rule: A stage that asks to change a locked feature file moves the item to FeatureChangeRequest

    @ac-1
    Scenario Outline: A <stage> stage that asks to change a locked feature file moves the item to FeatureChangeRequest
      Given a run for item 482 that resumes at <stage>
      And item 482 is InProgress
      And the <stage> agent changes "Then the order is refused" to "Then the order is held for review" in "features/pbi-482-orders.feature"
      And the <stage> agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs
      Then item 482 moves from InProgress to FeatureChangeRequest

      Examples:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | address     |

    @ac-1
    Scenario: The request records each file the report names and the reason it gives
      Given a run for item 482 that resumes at green
      And the green agent changes "Then the order is refused" to "Then the order is held for review" in "features/pbi-482-orders.feature"
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs
      Then item 482 has a feature change request
      And the request names "features/pbi-482-orders.feature" with the reason "An empty order is held, not refused"

    @ac-1
    Scenario: A request for several locked feature files records each with its own reason
      Given item 482's feature files "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature" were locked at sign-off
      And a run for item 482 that resumes at green
      And the green agent edits both "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature"
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      And the green agent's report asks to change "features/pbi-482-refunds.feature" because "A refund needs the order's number"
      When the cell runs
      Then item 482 moves from InProgress to FeatureChangeRequest
      And the request names "features/pbi-482-orders.feature" with the reason "An empty order is held, not refused"
      And the request names "features/pbi-482-refunds.feature" with the reason "A refund needs the order's number"

    @ac-1
    Scenario: The locked files are restored and the rest of the stage's work is pushed
      Given a run for item 482 that resumes at green
      And the green agent edits "features/pbi-482-orders.feature" and "src/orders.ts" in one commit
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs
      Then item 482 moves from InProgress to FeatureChangeRequest
      And "features/pbi-482-orders.feature" on the pushed branch matches the lock commit
      And the green agent's change to "src/orders.ts" is on the pushed branch

    @ac-1
    Scenario: The proposed version of a locked file is never pushed
      Given a run for item 482 that resumes at green
      And the green agent changes "Then the order is refused" to "Then the order is held for review" in "features/pbi-482-orders.feature"
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs
      Then item 482 moves from InProgress to FeatureChangeRequest
      And every push of the branch has "features/pbi-482-orders.feature" as it was at the lock commit

    @ac-1
    Scenario: An item waiting on a feature change request goes no further in its run
      Given a run for item 482 that resumes at self-review
      And the self-reviewer holds one finding open in its first round
      And the fix pass changes "Then the order is refused" to "Then the order is held for review" in "features/pbi-482-orders.feature"
      And the fix pass's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs
      Then item 482 moves from InProgress to FeatureChangeRequest
      And the PR is not opened

  Rule: An edit to a locked feature file with no request is restored silently, as today

    @ac-1 @regression
    Scenario: A stage that edits a locked feature file without asking has the edit undone and the item carries on
      Given a run for item 482 that resumes at open-pr
      And the summary pass edits a scenario in "features/pbi-482-orders.feature"
      And the open-pr report asks to change no feature file
      When the cell runs
      Then "features/pbi-482-orders.feature" on the branch matches the lock commit
      And the PR is opened
      And item 482 is not in FeatureChangeRequest
      And the owner is asked no question

  Rule: The request shows each file's change from the lock commit, before and after, with the stage's reason, on the item page

    @ac-2 @db
    Scenario: The item page shows the file, its change before and after, and the reason
      Given item 482 is in FeatureChangeRequest
      And its request asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      And the proposed version changes "Then the order is refused" to "Then the order is held for review"
      When the owner opens item 482's page
      Then the page shows the heading "features/pbi-482-orders.feature"
      And under it the page shows "Then the order is refused" as the line before
      And under it the page shows "Then the order is held for review" as the line after
      And under it the page shows the reason "An empty order is held, not refused"

    @ac-2 @db
    Scenario: Every file in the request shows on the item page, each with its own change and reason
      Given item 482's feature files "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature" were locked at sign-off
      And item 482 is in FeatureChangeRequest
      And its request asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      And its request asks to change "features/pbi-482-refunds.feature" because "A refund needs the order's number"
      When the owner opens item 482's page
      Then the page shows the change to "features/pbi-482-orders.feature" with the reason "An empty order is held, not refused"
      And the page shows the change to "features/pbi-482-refunds.feature" with the reason "A refund needs the order's number"

    @ac-2 @db
    Scenario: Markup in a proposed line or a reason shows as text, not as part of the page
      Given item 482 is in FeatureChangeRequest
      And its request asks to change "features/pbi-482-orders.feature" because "Show <b>held</b> orders"
      And the proposed version changes "Then the order is refused" to "Then the page shows \"<script>alert(1)</script>\""
      When the owner opens item 482's page
      Then the page shows the text "Then the page shows \"<script>alert(1)</script>\"" as the line after
      And the page shows the text "Show <b>held</b> orders" as the reason
      And the page holds no script or bold text from the request

  Rule: The request shows as a comment on the PBI, the way sign-off shows scenarios today

    @ac-2
    Scenario: Moving to FeatureChangeRequest posts the request as a comment on the PBI
      Given a run for item 482 that resumes at green
      And the green agent changes "Then the order is refused" to "Then the order is held for review" in "features/pbi-482-orders.feature"
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      When the cell runs and the factory handles the move
      Then item 482 on the board has one new comment for the feature change request
      And the comment names "features/pbi-482-orders.feature"
      And the comment shows "Then the order is refused" as the line before and "Then the order is held for review" as the line after
      And the comment gives the reason "An empty order is held, not refused"

    @ac-2
    Scenario: The PBI comment shows every file in the request, each with its own change and reason
      Given item 482's feature files "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature" were locked at sign-off
      And a run for item 482 that resumes at green
      And the green agent edits both "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature"
      And the green agent's report asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused"
      And the green agent's report asks to change "features/pbi-482-refunds.feature" because "A refund needs the order's number"
      When the cell runs and the factory handles the move
      Then item 482 on the board has one new comment for the feature change request
      And the comment shows the change to "features/pbi-482-orders.feature" with the reason "An empty order is held, not refused"
      And the comment shows the change to "features/pbi-482-refunds.feature" with the reason "A refund needs the order's number"

    @ac-2
    Scenario: The move handled twice posts one comment
      Given item 482 has moved to FeatureChangeRequest with a request to change "features/pbi-482-orders.feature"
      When the factory handles the move twice
      Then item 482 on the board has exactly one comment for the feature change request
