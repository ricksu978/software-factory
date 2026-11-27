@pbi-366
Feature: A FeatureChangeRequest item waits without a WIP slot, gets reminders, is never abandoned for waiting, and shows on Floor and Run detail
  Since PBI 364, a stage after sign-off can ask to change a locked feature file. The item then moves from
  InProgress to FeatureChangeRequest, where it waits on the Product Owner to approve the change or ask for changes
  (PBI 365). With this item it waits on a person as an item in SignOff does (spec §5), with one difference: it is
  never abandoned for waiting. It holds no WIP slot, so another item can start in its place. It counts toward
  review capacity, so no new work starts while too many items wait on a person. The factory comments a reminder on
  the PBI 2 days and 4 days after the item moved to FeatureChangeRequest, once each. No reminder says the item will
  be abandoned, because however long it waits, it stays in FeatureChangeRequest until the owner decides, or until
  a person merges or closes its PR, removes its label or closes the item. The clock starts when the item moved to
  FeatureChangeRequest.
  Floor's "Waiting on you" and the item's Run detail show the item as waiting on the Product Owner, with a link to
  the request: the "Feature change request" section of the item's Run detail, which PBI 364 added. Both show this
  on the dashboard and in the SPA.
  In each scenario, item "482" titled "Hold empty orders" is an issue in the repo "acme/widgets". Its request asks
  to change "features/pbi-482-orders.feature" because "An empty order is held, not refused". Scenarios tagged @db
  need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: An item in FeatureChangeRequest holds no WIP slot

    @ac-1 @db
    Scenario: With WIP 1, an item in FeatureChangeRequest leaves the slot to a queued item and counts as waiting
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "B" is queued
      When the scheduler ticks
      Then a cell starts for item "B"
      And item "482" is "FeatureChangeRequest"
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
      And Floor shows "3 of 3 waiting"

    @ac-1 @db
    Scenario: An item in FeatureChangeRequest alone fills a review capacity of 1
      Given a factory with WIP 1 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "B" is queued
      When the scheduler ticks
      Then no cell starts
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

    @ac-1 @db
    Scenario: An answered sign-off still resumes while an item in FeatureChangeRequest holds the brake on
      Given a factory with WIP 2 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "S" waits for a sign-off that has been answered
      And item "B" is queued
      When the scheduler ticks
      Then a cell starts for item "S"
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: A priority-1 item still gets past the brake an item in FeatureChangeRequest holds on
      Given a factory with WIP 2 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 1 hour ago
      And item "P" is queued with priority 1
      And item "B" is queued with priority 2
      When the scheduler ticks
      Then a cell starts for item "P"
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: An item whose request the owner has decided no longer counts, while one still waiting does
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 3 hours ago, then the Product Owner approved the change and it is "Queued"
      And item "483" moved to FeatureChangeRequest 1 hour ago
      When a viewer opens Floor
      Then Floor shows "1 of 3 waiting"

  Rule: The factory reminds the owner on the PBI 2 days and 4 days after the item moved to FeatureChangeRequest, once each

    @ac-1 @db
    Scenario: An item that has waited 2 days gets one reminder on the PBI
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has one reminder comment that it still waits on the Product Owner's decision on its feature change request
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: An item that has waited 4 days gets its second reminder
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 4 days and 1 hour ago
      And item "482" got its day-2 reminder
      When the scheduler ticks
      Then item "482" on the board has two reminder comments that it still waits on the Product Owner's decision on its feature change request
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: The day-2 reminder is sent once however many times the scheduler ticks
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks three times
      Then item "482" on the board has exactly one reminder comment that it still waits on the Product Owner's decision on its feature change request

    @ac-1 @db
    Scenario: An item that has waited under 2 days gets no reminder yet, while one past 2 days does
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 1 day and 23 hours ago
      And item "483" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has no reminder comment
      And item "483" on the board has one reminder comment that it still waits on the Product Owner's decision on its feature change request

    @ac-1 @db
    Scenario: The reminder clock starts when the item moved to FeatureChangeRequest, not when its sign-off was asked
      Given a factory with WIP 1 and a review capacity of 3
      And item "482"'s sign-off was asked 6 days ago and answered 5 days and 12 hours ago
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has one reminder comment that it still waits on the Product Owner's decision on its feature change request
      And item "482" is "FeatureChangeRequest"

    @ac-1 @db
    Scenario: An item that left FeatureChangeRequest gets no reminder, while one still waiting does
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 2 hours ago, then the Product Owner approved the change and it is "Queued"
      And item "483" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has no reminder comment
      And item "483" on the board has one reminder comment that it still waits on the Product Owner's decision on its feature change request

    @ac-1 @db
    Scenario: No third reminder comes after day 4, however long the item waits
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 4 days and 1 hour ago
      When the scheduler ticks
      And 6 more days pass and the scheduler ticks again
      Then item "482" on the board has exactly two reminder comments that it still waits on the Product Owner's decision on its feature change request

  Rule: No reminder says the item will be abandoned

    @ac-1 @db
    Scenario: The day-2 reminder doesn't say the item will be abandoned
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 2 days and 1 hour ago
      When the scheduler ticks
      Then item "482" on the board has one reminder comment that it still waits on the Product Owner's decision on its feature change request
      And that reminder doesn't say the item will be abandoned

    @ac-1 @db
    Scenario: The day-4 reminder doesn't say the item will be abandoned
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 4 days and 1 hour ago
      And item "482" got its day-2 reminder
      When the scheduler ticks
      Then item "482" on the board has two reminder comments that it still waits on the Product Owner's decision on its feature change request
      And neither reminder says the item will be abandoned

  Rule: An item in FeatureChangeRequest is never abandoned for waiting

    @ac-1 @db
    Scenario: An item that has waited more than 5 days stays in FeatureChangeRequest and still counts as waiting
      Given a factory with WIP 1 and a review capacity of 3
      And item "482" moved to FeatureChangeRequest 5 days and 1 hour ago
      And item "482" got its day-2 and day-4 reminders
      When the scheduler ticks
      Then item "482" is "FeatureChangeRequest"
      And item "482" has never been moved to Abandoned
      And Floor shows "1 of 3 waiting"

    @ac-1 @db
    Scenario: An item that has waited 30 days stays in FeatureChangeRequest and still holds the brake on
      Given a factory with WIP 1 and a review capacity of 1
      And item "482" moved to FeatureChangeRequest 30 days ago
      And item "482" got its day-2 and day-4 reminders
      And item "B" is queued
      When the scheduler ticks
      Then item "482" is "FeatureChangeRequest"
      And no cell starts
      And item "B" is "Queued"

    @ac-1 @db
    Scenario: An item waiting in SignOff past 5 days is still abandoned, while one in FeatureChangeRequest as long is not
      Given a factory with WIP 1 and a review capacity of 3
      And item "S" waited for an unanswered sign-off asked 5 days and 1 hour ago
      And item "482" moved to FeatureChangeRequest 5 days and 1 hour ago
      And both items got their day-2 and day-4 reminders
      When the scheduler ticks
      Then item "S" is "Abandoned"
      And item "482" is "FeatureChangeRequest"
      And Floor shows "1 of 3 waiting"

    @ac-1 @db
    Scenario: An item that has waited a week still shows under "Waiting on you"
      Given item "482" moved to FeatureChangeRequest 7 days ago
      When the scheduler ticks and a viewer opens Floor
      Then "Waiting on you" lists "Hold empty orders"
      And "Waiting on you" shows "Hold empty orders" as waiting "7 d"

  Rule: Floor's "Waiting on you" shows an item in FeatureChangeRequest as waiting on the Product Owner, with a link to the request

    @ac-2 @db
    Scenario Outline: An item in FeatureChangeRequest shows under "Waiting on you" on <where> as waiting on the Product Owner
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens Floor on <where>
      Then "Waiting on you" lists "Hold empty orders"
      And "Waiting on you" shows "Hold empty orders" as waiting on the Product Owner
      And "Waiting on you" shows "Hold empty orders" as waiting "3 h"

      Examples:
        | where         |
        | the dashboard |
        | the SPA       |

    @ac-2 @db
    Scenario Outline: The item on "Waiting on you" on <where> links to its feature change request
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens Floor on <where>
      Then "Waiting on you" shows a "Feature change request" link for "Hold empty orders"
      And the link goes to the "Feature change request" section of item "482"'s Run detail
      And "#482" on "Waiting on you" still links to "https://github.com/acme/widgets/issues/482"
      And "Hold empty orders" on "Waiting on you" still links to the item's Run detail

      Examples:
        | where         |
        | the dashboard |
        | the SPA       |

    @ac-2 @db
    Scenario Outline: On <where>, only the item in FeatureChangeRequest shows a feature change request link
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      And item "57" titled "Import a year" waits for sign-off
      When a viewer opens Floor on <where>
      Then "Waiting on you" shows a "Feature change request" link for "Hold empty orders"
      And "Waiting on you" shows no "Feature change request" link for "Import a year"
      And "Waiting on you" doesn't show "Import a year" as waiting on the Product Owner's decision on a feature change request

      Examples:
        | where         |
        | the dashboard |
        | the SPA       |

    @ac-2 @db
    Scenario: An item whose request the owner has decided leaves "Waiting on you", while one still waiting stays
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      And item "483" titled "Refund an order" moved to FeatureChangeRequest 5 hours ago, then the Product Owner approved the change and it is "Queued"
      When a viewer opens Floor
      Then "Waiting on you" lists "Hold empty orders"
      And "Waiting on you" doesn't list "Refund an order"

  Rule: Run detail shows an item in FeatureChangeRequest as waiting on the Product Owner, with a link to the request

    @ac-2 @db
    Scenario Outline: Run detail on <where> shows the item as waiting on the Product Owner next to its state
      Given item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens item "482"'s Run detail on <where>
      Then the line with the item's state "FeatureChangeRequest" says it waits on the Product Owner
      And that line shows a "Feature change request" link to the page's "Feature change request" section
      And the page's "Feature change request" section shows "features/pbi-482-orders.feature"
      And the page's "Feature change request" section shows "An empty order is held, not refused"

      Examples:
        | where         |
        | the dashboard |
        | the SPA       |

    @ac-2 @db
    Scenario Outline: Run detail on <where> of an item in SignOff shows no feature change request link
      Given item "57" titled "Import a year" waits for sign-off
      And item "482" moved to FeatureChangeRequest 3 hours ago
      When a viewer opens item "57"'s Run detail on <where>
      And a viewer opens item "482"'s Run detail on <where>
      Then item "57"'s Run detail has no "Feature change request" link
      And item "482"'s Run detail has a "Feature change request" link

      Examples:
        | where         |
        | the dashboard |
        | the SPA       |
