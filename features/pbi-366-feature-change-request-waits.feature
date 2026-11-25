@pbi-366
Feature: A FeatureChangeRequest item waits without a WIP slot, gets reminders, is abandoned after 5 days, and shows on Floor and Run detail
  Since PBI 364, a stage after sign-off can ask to change a locked feature file, and the item moves from
  InProgress to FeatureChangeRequest, where it waits on the Product Owner. With this item it waits the way an
  item in SignOff does (spec §5). It holds no WIP slot, so another item can start in its place, and it counts
  toward review capacity, so while too many items wait on a person no new work starts. The factory comments a
  reminder on the PBI 2 days and 4 days after the item moved to FeatureChangeRequest, once each, and moves it to
  Abandoned once it has waited more than 5 days. The clock starts when the item moved to FeatureChangeRequest.
  Floor's "Waiting on you" and the item's Run detail show the item as waiting on the Product Owner, with a link to
  the request: the "Feature change request" section of the item's Run detail, which PBI 364 added.
  In each scenario, item "482" titled "Hold empty orders" is an issue in the repo "acme/widgets", and its request
  asks to change "features/pbi-482-orders.feature" because "An empty order is held, not refused". Scenarios
  tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: An item in FeatureChangeRequest holds no WIP slot

    @ac-1 @db
    Scenario: With WIP 1, an item in FeatureChangeRequest leaves the slot to a queued item and counts as waiting
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "B" is queued
      When the scheduler ticks
      Then a cell starts for item "B"
      And Floor shows "1 of 3 waiting"

  Rule: An item in FeatureChangeRequest counts toward review capacity

    @ac-1 @db
    Scenario: With review capacity reached by an item in FeatureChangeRequest and two others, no queued item starts
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "S" waits for an unanswered sign-off
      And item "R" is in review
      And item "B" is queued
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: An item in FeatureChangeRequest alone fills a review capacity of 1
      Given a factory with WIP 1 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "B" is queued
      When the scheduler ticks
      Then no cell starts
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: An answered sign-off still starts while an item in FeatureChangeRequest holds the brake on
      Given a factory with WIP 2 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "S" waits for a sign-off that has been answered
      And item "B" is queued
      When the scheduler ticks
      Then a cell starts for item "S"
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: Each item in FeatureChangeRequest counts once toward review capacity
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "483" moved to FeatureChangeRequest 2 hours ago
      And item "B" is queued
      When the scheduler ticks
      Then a cell starts for item "B"
      And Floor shows "2 of 3 waiting"

  Rule: The factory reminds the owner on the PBI 2 days and 4 days after the item moved to FeatureChangeRequest, once each

    @ac-1 @db
    Scenario: An item that has waited 2 days gets one reminder on the PBI
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has one reminder comment that it still waits on the owner
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: An item that has waited 4 days gets its second reminder
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 4 days and 1 hour ago
      And item "482" got its day-2 reminder
      When the scheduler ticks
      Then item "482" on the board has two reminder comments that it still waits on the owner
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: The day-2 reminder is sent once however many times the scheduler ticks
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks three times
      Then item "482" on the board has exactly one reminder comment that it still waits on the owner

    @ac-1 @db
    Scenario: The reminder clock starts when the item moved to FeatureChangeRequest, not when its sign-off was asked
      Given a factory with WIP 1 and a review capacity of 3
      And item "482"'s sign-off was asked 6 days ago and answered 5 days and 12 hours ago
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has one reminder comment that it still waits on the owner
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: An item that has waited under 2 days gets no reminder yet, while one past 2 days does
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 day and 23 hours ago
      And item "483" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has no reminder comment
      And item "483" on the board has one reminder comment that it still waits on the owner

    @ac-1 @db
    Scenario: An item that left FeatureChangeRequest gets no reminder, while one still waiting does
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 2 hours ago, then its PR was merged and it is "Accepted"
      And item "483" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has no reminder comment
      And item "483" on the board has one reminder comment that it still waits on the owner

  Rule: An item that has waited in FeatureChangeRequest more than 5 days goes to Abandoned

    @ac-1 @db
    Scenario: An item that has waited more than 5 days is abandoned
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 5 days and 1 hour ago
      And item "482" got its day-2 and day-4 reminders
      When the scheduler ticks
      Then item "482" is "Abandoned"
      And item "482"'s move to Abandoned is recorded as timed out

    @ac-1 @db
    Scenario: An item that has waited just under 5 days is not abandoned yet, while one past 5 days is
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 4 days and 23 hours ago
      And item "483" moved to FeatureChangeRequest 5 days and 1 hour ago
      When the scheduler ticks
      Then item "482" is "FeatureChangeRequest"
      And item "483" is "Abandoned"

    @ac-1 @db
    Scenario: When an item in FeatureChangeRequest is abandoned, the waiting count drops and a queued item starts
      Given a factory with WIP 1 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 6 days ago
      And item "B" is queued
      When the scheduler ticks
      Then item "482" is "Abandoned"
      And a cell starts for item "B"

  Rule: Floor's "Waiting on you" shows an item in FeatureChangeRequest as waiting on the Product Owner, with a link to the request

    @ac-2 @db
    Scenario: An item in FeatureChangeRequest shows under "Waiting on you" as waiting on the Product Owner
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens Floor
      Then "Waiting on you" lists "Hold empty orders"
      And "Waiting on you" shows "Hold empty orders" as waiting on the Product Owner
      And "Waiting on you" shows "Hold empty orders" as waiting "3 h"

    @ac-2 @db
    Scenario: The item on "Waiting on you" links to its feature change request
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens Floor
      Then "Waiting on you" shows a "Feature change request" link for "Hold empty orders"
      And the link goes to the "Feature change request" section of item "482"'s Run detail
      And "#482" on "Waiting on you" still links to "https://github.com/acme/widgets/issues/482"
      And "Hold empty orders" on "Waiting on you" still links to the item's Run detail

    @ac-2 @db
    Scenario: Only the item in FeatureChangeRequest shows a feature change request link
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      And item "57" titled "Import a year" waits for sign-off
      When a viewer opens Floor
      Then "Waiting on you" shows a "Feature change request" link for "Hold empty orders"
      And "Waiting on you" shows no "Feature change request" link for "Import a year"

    @ac-2 @db
    Scenario: An abandoned item no longer shows under "Waiting on you"
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      And item "483" titled "Refund an order" moved to FeatureChangeRequest 6 days ago
      When the scheduler ticks and a viewer opens Floor
      Then "Waiting on you" lists "Hold empty orders"
      And "Waiting on you" doesn't list "Refund an order"

  Rule: Run detail shows an item in FeatureChangeRequest as waiting on the Product Owner, with a link to the request

    @ac-2 @db
    Scenario: Run detail shows the item as waiting on the Product Owner next to its state
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens item "482"'s Run detail
      Then the line with the item's state "FeatureChangeRequest" says it waits on the Product Owner
      And that line shows a "Feature change request" link to the page's "Feature change request" section
      And the page's "Feature change request" section shows "features/pbi-482-orders.feature"

    @ac-2 @db
    Scenario: Run detail of an item that has left FeatureChangeRequest shows no feature change request link
      Given item "482" moved to FeatureChangeRequest 6 days ago
      When the scheduler ticks and a viewer opens item "482"'s Run detail
      Then the line with the item's state shows "Abandoned"
      And the line with the item's state doesn't say it waits on the Product Owner
      And the page has no "Feature change request" link
