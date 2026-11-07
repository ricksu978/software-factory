@pbi-105
Feature: An activity log, so the owner can see what the factory is doing
  The dashboard gets an activity page at /activity that lists the factory's latest events, newest
  first, so the owner can follow what the factory did without reading the database. Floor links to it.
  The page shows only an event's time, its item, its kind and, for a move between states, where the
  item came from, where it went and why. Nothing else an event carries reaches the page. The control
  plane's console also gets one line for each transition it commits.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: The activity log lists the 100 most recent events, newest first

    @ac-1 @db
    Scenario: Each row shows the event's time, item, kind and, for a move, its states
      Given item "95" titled "Export a month" was claimed at 09:00, moving from "Queued" to "InProgress" on "claimed"
      And an operator stopped item "95"'s run at 09:05, moving it from "InProgress" to "Failed"
      And the owner approved item "95"'s sign-off at 09:10, recorded as a "decision" event
      When a viewer opens the activity log
      Then the log lists 3 events, the 09:10 one first, then the 09:05 one, then the 09:00 one
      And the 09:00 row shows its time, "95", "Export a month", "transition", "Queued", "InProgress" and "claimed"
      And the 09:05 row shows its time, "95", "Export a month", "override", "InProgress" and "Failed"
      And the 09:10 row shows its time, "95", "Export a month" and "decision", and no states

    @ac-1 @db
    Scenario: Only the 100 most recent events are listed
      Given the factory has recorded 105 events, one a minute
      When a viewer opens the activity log
      Then the log lists 100 events
      And the first row is the newest event
      And the 5 oldest events are not listed

    @ac-1 @db
    Scenario: An event of another kind shows no states, even if it carries some
      Given item "95" has a "comment" event that carries a "from" of "Queued" and a "to" of "Failed"
      When a viewer opens the activity log
      Then the "comment" row shows no states

    @ac-1 @db
    Scenario: A factory with no events shows an empty log
      Given the factory has recorded no events
      When a viewer opens the activity log
      Then the page is the activity log
      And the log lists no events

  Rule: Every signed-in user can open the activity log, and nobody else

    @ac-2 @db
    Scenario Outline: A signed-in <role> can open the activity log
      Given "pat", a <role>, is signed in
      And item "95" titled "Export a month" was claimed
      When "pat" opens the activity log
      Then the response is 200
      And the log lists the claim of item "95"

      Examples:
        | role     |
        | viewer   |
        | operator |
        | owner    |

    @ac-2 @db
    Scenario: A signed-out request gets the sign-in page, and signing in opens the log
      Given "pat", a viewer, is not signed in
      And item "95" titled "Export a month" was claimed
      When a request without a sign-in opens the activity log
      Then the response is the same sign-in page a signed-out request for Floor gets
      When "pat" signs in and opens the activity log again
      Then the log lists the claim of item "95"

  Rule: Only an event's states and its event name reach the page, and titles are escaped

    @ac-3 @db
    Scenario: A transition's other details stay off the page
      Given item "95" failed readiness with the dor.md line "Has a Size of 5 or less" and a detail "run-token-7f3a"
      When a viewer opens the activity log
      Then the item's row shows "Eligible", "NotReady" and "readiness_failed"
      And the page doesn't contain "Has a Size of 5 or less"
      And the page doesn't contain "run-token-7f3a"

    @ac-3 @db
    Scenario: An override's reason stays off the page
      Given an operator stopped item "95"'s run with the reason "secret-reason-91c2"
      When a viewer opens the activity log
      Then the item's row shows "InProgress" and "Failed"
      And the page doesn't contain "secret-reason-91c2"

    @ac-3 @db
    Scenario: A decision's text stays off the page
      Given the owner approved item "95"'s sign-off with the text "decision-text-5d1e"
      When a viewer opens the activity log
      Then the log lists the "decision" event
      And the page doesn't contain "decision-text-5d1e"

    @ac-3 @db
    Scenario: An item's title shows as text, never as markup
      Given item "95" titled "<script>alert(1)</script> & <b>bold</b>" was claimed
      When a viewer opens the activity log
      Then the item's row shows the title "<script>alert(1)</script> & <b>bold</b>" as plain text
      And the page has no script or bold element from the title

  Rule: Floor links to the activity log

    @ac-4 @db
    Scenario: Floor has a link to the activity log
      Given a viewer is signed in
      When the viewer opens Floor
      Then Floor has a link to "/activity"

  Rule: Each committed transition writes one line to the control plane's console

    @ac-5 @db
    Scenario: A committed transition writes one console line naming the item, its states and the event
      Given item "95" is Eligible
      When the item fails readiness and the transition commits
      Then the control plane's console has exactly one line "item 95: Eligible -> NotReady (readiness_failed)"

    @ac-5 @db
    Scenario: Two committed transitions write two lines, in order
      Given item "95" is Queued
      When the item is claimed and the transition commits
      And the item's lease expires and the transition commits
      Then the control plane's console has the line "item 95: Queued -> InProgress (claimed)"
      And after it the line "item 95: InProgress -> Queued (lease_expired)"

    @ac-5 @db
    Scenario: A transition that is rolled back writes no console line
      Given item "95" is Queued
      When the item is claimed, but the work around the transition fails and is rolled back
      Then the item is still Queued
      And the control plane's console has no line starting "item 95:"
