@pbi-430 @db
Feature: Floor shows two lists, Waiting on you and Production Line, in place of its eight sections
  Today Floor splits the factory's work into eight sections: Waiting on you, Next up, Final stage, Not ready,
  Blocked, Split, Failed on main and In flight. An item can show in more than one of them. An item in review, for
  one, is under both Waiting on you and In flight, and the owner has to read every section to see what needs them.
  With this item, Floor shows two lists under its banners and Controls, which stay as today.
  "Waiting on you" holds every item that needs the owner: a question or sign-off to answer, a PR in review, an
  item the readiness gate turned down, and an item that failed on main. Each row says why it waits. The list runs
  oldest first, by when each item began waiting. A question or sign-off begins waiting when the factory asked it,
  and with two open the older one counts. An item in review begins waiting when it moved to InReview, one that's
  Not ready when the gate turned it down, and one that failed on main when it went to Failed.
  "Production Line" holds the factory's own work. Every InProgress item comes first, with the columns In flight
  shows today. Then come the queued items that wait on no open dependency, in the order the factory will claim
  them, taken from the claim's own query as "Next up" is today. An answered question or sign-off counts here too,
  since the factory takes it up again. Last come the queued items that wait on another PBI. The list holds up to
  10 rows, and a line under it says how many more are queued. Every row keeps its badges. A split child names its
  parent, and a split parent shows in neither list. No item shows twice.
  Today's Floor on 7400, the SPA's Floor and the API's answer to GET /v1/floor all carry the two lists. "The
  operator opens Floor" means today's Floor, unless a scenario says the SPA's.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub, the cells and the clock are fakes. The time is "2026-11-27 12:00" UTC and the viewer's time zone is
  "UTC". The factory's review capacity is 10, so the waiting brake stays off, unless a scenario says otherwise. An
  item has no dependencies, no labels and priority 3 unless a scenario gives it some.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: two lists in place of the eight sections
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Floor shows the two lists, with its banners and Controls as today, and none of the old section headings

    @ac-1
    Scenario: Floor shows "Waiting on you" and "Production Line", and none of the other old headings
      Given item 41 is in SignOff, waiting on the owner's sign-off
      And item 43 is Queued
      When the operator opens Floor
      Then Floor shows a list headed "Waiting on you"
      And Floor shows a list headed "Production Line"
      And Floor shows none of the headings "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main" or "In flight"

    @ac-1
    Scenario: The old headings stay away when the factory holds an item of every old kind
      Given item 41 is in SignOff, waiting on the owner's sign-off
      And item 42 is InProgress in stage "green"
      And item 43 is Queued
      And item 44 has an open PR and is Queued to address requested changes
      And item 45 is NotReady, having failed "Has acceptance criteria"
      And item 46 is Queued and depends on item 12, which is still open
      And item 47 is Split into items 60 and 61, and item 60 is Queued
      And item 48 is Failed after the event "dod_failed"
      When the operator opens Floor
      Then Floor shows a list headed "Waiting on you"
      And Floor shows a list headed "Production Line"
      And Floor shows none of the headings "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main" or "In flight"

    @ac-1
    Scenario: Floor still shows its banners and Controls above the two lists
      Given the factory is paused with the reason "deploying"
      And the Claude token expires in 20 days
      And item 43 is Queued
      When the operator opens Floor
      Then Floor shows the banner "The Claude token expires in 20 days. Make a new one with claude setup-token and update the secret."
      And Floor shows that the factory is paused with the reason "deploying"
      And Floor shows the Controls form with its "Pause", "Drain", "Resume", "Kill switch" and "Prepare restart" buttons
      And Floor shows "Production Line" listing item 43

    @ac-1
    Scenario: With nothing in the factory, Floor still shows both lists, each saying it's empty
      Given the factory holds no items
      When the operator opens Floor
      Then Floor shows a list headed "Waiting on you" that says nothing waits on you
      And Floor shows a list headed "Production Line" that says nothing is in production

  # ---------------------------------------------------------------------------------------------------------------
  # AC-2: what "Waiting on you" holds, and why each row waits
  # ---------------------------------------------------------------------------------------------------------------

  Rule: "Waiting on you" lists every item waiting on a question, a sign-off or a review, every Not ready item and every item that failed on main, and says why each waits

    @ac-2
    Scenario: An item waiting on the owner's sign-off shows in "Waiting on you" and says it waits on sign-off
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      When the operator opens Floor
      Then "Waiting on you" lists item 41 "Add search"
      And item 41's row in "Waiting on you" says it waits on the owner's sign-off

    @ac-2
    Scenario: An item waiting on a question shows the question it waits on
      Given item 42 "Export CSV" is in NeedsInput, waiting on the question "Should the export include archived rows?"
      When the operator opens Floor
      Then "Waiting on you" lists item 42 "Export CSV"
      And item 42's row in "Waiting on you" shows the question "Should the export include archived rows?"

    @ac-2
    Scenario: An item in review shows in "Waiting on you" with a link to its PR
      Given item 43 "Fix login" is InReview with PR 77 open
      When the operator opens Floor
      Then "Waiting on you" lists item 43 "Fix login"
      And item 43's row in "Waiting on you" says it waits on the review of "PR #77", which links to that PR

    @ac-2
    Scenario: A Not ready item shows every readiness line it failed
      Given item 45 "Do the thing" is NotReady, having failed "Has acceptance criteria" and "Names the user it's for"
      When the operator opens Floor
      Then "Waiting on you" lists item 45 "Do the thing"
      And item 45's row in "Waiting on you" shows the failed readiness lines "Has acceptance criteria" and "Names the user it's for"

    @ac-2
    Scenario Outline: An item that failed on main shows "Failed on main" and when it was last re-checked
      Given item 52 "Broke main" is Failed after the event "dod_failed" and <rechecked>
      When the operator opens Floor
      Then "Waiting on you" lists item 52 "Broke main"
      And item 52's row in "Waiting on you" shows "Failed on main" with "<shown>"

      Examples:
        | rechecked                                     | shown                         |
        | hasn't been re-checked yet                    | not yet re-checked            |
        | was last re-checked at "2026-11-20 10:00" UTC | last re-checked at 2026-11-20 10:00 |

    @ac-2
    Scenario: Every item of each waiting kind shows in "Waiting on you", and nothing else does
      Given item 41 is in SignOff, waiting on the owner's sign-off
      And item 42 is in NeedsInput, waiting on a question
      And item 43 is InReview with PR 77 open
      And item 45 is NotReady, having failed "Has acceptance criteria"
      And item 52 is Failed after the event "dod_failed"
      And item 60 is InProgress in stage "green"
      And item 61 is Queued
      When the operator opens Floor
      Then "Waiting on you" lists items 41, 42, 43, 45 and 52, and no others

    @ac-2
    Scenario: An item that went to Failed some other way than failing on main isn't in "Waiting on you"
      Given item 52 is Failed after the event "dod_failed"
      And item 53 is Failed after the event "stage_failed"
      When the operator opens Floor
      Then "Waiting on you" lists item 52
      And "Waiting on you" doesn't list item 53

    @ac-2
    Scenario: An item whose question has been answered no longer waits on you
      Given item 42 is in NeedsInput, waiting on a question
      And item 44 is in NeedsInput with its question answered
      When the operator opens Floor
      Then "Waiting on you" lists item 42
      And "Waiting on you" doesn't list item 44
      And "Production Line" lists item 44

    @ac-2
    Scenario: Done, Accepted and Abandoned items show in neither list
      Given item 70 is Done
      And item 71 is Accepted, waiting on main
      And item 72 is Abandoned
      And item 43 is Queued
      When the operator opens Floor
      Then "Production Line" lists item 43
      And neither "Waiting on you" nor "Production Line" lists items 70, 71 or 72

  # ---------------------------------------------------------------------------------------------------------------
  # AC-3: oldest first
  # ---------------------------------------------------------------------------------------------------------------

  Rule: "Waiting on you" runs oldest first, by when each item began waiting

    @ac-3
    Scenario: Items of every waiting kind are ordered by when each began waiting
      Given item 41 has been in SignOff since the factory asked for sign-off at "2026-11-27 09:00" UTC
      And item 42 has been in NeedsInput since the factory asked its question at "2026-11-26 15:00" UTC
      And item 43 moved to InReview at "2026-11-27 11:00" UTC
      And item 45 was turned down by the readiness gate and went NotReady at "2026-11-25 08:00" UTC
      And item 52 went to Failed after the event "dod_failed" at "2026-11-26 09:00" UTC
      When the operator opens Floor
      Then "Waiting on you" lists items 45, 52, 42, 41 and 43, in that order

    @ac-3
    Scenario: An item with two open questions counts from the older one
      Given item 42 is in NeedsInput with two open questions, asked at "2026-11-25 10:00" UTC and "2026-11-27 10:00" UTC
      And item 41 has been in SignOff since the factory asked for sign-off at "2026-11-26 10:00" UTC
      When the operator opens Floor
      Then "Waiting on you" lists items 42 and 41, in that order

    @ac-3
    Scenario: An item that began waiting later comes later, whatever its title or number
      Given item 90 "Alpha" has been in NeedsInput since the factory asked its question at "2026-11-27 10:00" UTC
      And item 10 "Zulu" has been in NeedsInput since the factory asked its question at "2026-11-27 08:00" UTC
      When the operator opens Floor
      Then "Waiting on you" lists items 10 and 90, in that order

  # ---------------------------------------------------------------------------------------------------------------
  # AC-4: in-flight items first, with In flight's columns
  # ---------------------------------------------------------------------------------------------------------------

  Rule: "Production Line" lists every InProgress item first, with the columns In flight shows today

    @ac-4
    Scenario: An InProgress item shows its state, stage, time in stage, cost and last agent message
      Given item 60 "Add filters" is InProgress in stage "green", which started at "2026-11-27 11:35" UTC
      And item 60's open run has cost $1.2345 so far
      And item 60's last agent message is "Writing the step definitions"
      When the operator opens Floor
      Then "Production Line" lists item 60 "Add filters"
      And item 60's row in "Production Line" shows the state "InProgress", the stage "green", "25 min" in stage, the cost "$1.23" and the message "Writing the step definitions"

    @ac-4
    Scenario: Every InProgress item comes before every queued item
      Given items 61 and 62 are Queued, in that board order
      And items 60 and 63 are InProgress
      When the operator opens Floor
      Then "Production Line" lists items 60 and 63 before items 61 and 62
      And "Production Line" lists items 61 and 62, in that order, after them

    @ac-4
    Scenario: Every InProgress item shows, however many there are
      Given items 60, 61, 62, 63 and 64 are InProgress
      When the operator opens Floor
      Then "Production Line" lists items 60, 61, 62, 63 and 64

    @ac-4
    Scenario: An InProgress item fixing a CI failure still shows it is fixing CI, as In flight does today
      Given item 60 is InProgress in stage "green", sent back to fix CI failing the check "ci" on commit "abc1234"
      When the operator opens Floor
      Then item 60's row in "Production Line" shows it is fixing CI on commit "abc1234", with the failed check "ci"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-5: claimable queued items in claim order, then the ones waiting on another PBI, up to 10 rows
  # ---------------------------------------------------------------------------------------------------------------

  Rule: After the in-flight items, "Production Line" lists the claimable items in claim order, then the items waiting on another PBI, up to 10 rows in all

    @ac-5
    Scenario: Claimable items come before items waiting on another PBI
      Given item 46 is Queued and depends on item 12, which is still open
      And items 61 and 62 are Queued, in that board order
      And item 60 is InProgress
      When the operator opens Floor
      Then "Production Line" lists items 60, 61, 62 and 46, in that order

    @ac-5
    Scenario: An item waiting on other PBIs names every open dependency
      Given item 46 is Queued and depends on items 12 and 13, which are both still open
      When the operator opens Floor
      Then "Production Line" lists item 46
      And item 46's row in "Production Line" shows "Waits on #12 and #13"

    @ac-5
    Scenario: A dependency that has closed isn't named
      Given item 46 is Queued and depends on items 12 and 13
      And item 12 has closed and item 13 is still open
      When the poller reads the board
      And the operator opens Floor
      Then item 46's row in "Production Line" shows "Waits on #13"
      And item 46's row in "Production Line" doesn't name "#12"

    @ac-5
    Scenario: Once every dependency closes, the item moves up among the claimable items
      Given item 46 is Queued and depends on item 12, which is still open
      And item 61 is Queued
      And the board orders the items 46, 61
      When item 12 closes
      And the poller reads the board
      And the operator opens Floor
      Then "Production Line" lists items 46 and 61, in that order
      And item 46's row in "Production Line" doesn't show "Waits on"

    @ac-5
    Scenario: The list holds at most 10 rows, in-flight items included
      Given items 60, 61 and 62 are InProgress
      And items 71, 72, 73, 74, 75, 76, 77, 78 and 79 are Queued, in that board order
      When the operator opens Floor
      Then "Production Line" shows 10 rows
      And "Production Line" lists items 60, 61, 62, 71, 72, 73, 74, 75, 76 and 77
      And "Production Line" doesn't list items 78 or 79

    @ac-5
    Scenario: Claimable items fill the rows before any item waiting on another PBI
      Given items 71, 72, 73, 74, 75, 76, 77, 78, 79 and 80 are Queued, in that board order
      And item 46 is Queued and depends on item 12, which is still open
      When the operator opens Floor
      Then "Production Line" lists items 71, 72, 73, 74, 75, 76, 77, 78, 79 and 80, in that order
      And "Production Line" doesn't list item 46

    @ac-5
    Scenario: A held item isn't listed as next to claim
      Given items 61 and 62 are Queued, in that board order
      And the operator has held item 61 with the reason "waiting on legal"
      When the operator opens Floor
      Then "Production Line" lists item 62 as the first item to claim

  # ---------------------------------------------------------------------------------------------------------------
  # AC-6: the claim's own order
  # ---------------------------------------------------------------------------------------------------------------

  Rule: "Production Line" orders its claimable items as the claim takes them, from the claim's own query

    @ac-6
    Scenario: Production Line's first claimable item is the one the scheduler claims next
      Given item "F" has an open PR, is Queued to address requested changes, and has priority 5
      And item "X" is Queued and has priority 1
      And item "Y" is Queued and has priority 2
      And the board orders the items "Y", "X", "F"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "F", "X", "Y", in that order
      When the scheduler ticks once
      Then item "F" is "InProgress"

    @ac-6
    Scenario: At priority 1, a bug item is listed before an item without the label
      Given items "A" and "B" are Queued, in that board order, with priority 1
      And item "B" carries the "bug" label
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "B", "A", in that order
      When the scheduler ticks once
      Then item "B" is "InProgress"

    @ac-6
    Scenario: In the final-stage group, a bug item is listed before another item at its priority
      Given item "A" has an open PR, is Queued to address requested changes, and has priority 3
      And item "B" has an open PR, is Queued to address requested changes, has priority 3, and carries the "bug" label
      And the board orders the items "A", "B"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "B", "A", in that order

    @ac-6
    Scenario: A Start now item is listed first, as the claim takes it first
      Given items "A" and "B" are Queued, in that board order, with priority 1
      And the operator has pressed "Start now" on item "B" with the reason "the demo needs it"
      When the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "B", "A", in that order

    @ac-6
    Scenario: Move up changes Production Line's order as it changes the claim's
      Given items "A", "B" and "C" are Queued, in that board order, with priority 3
      And the poller has read the board
      When the operator presses "Move up" on item "C" with the reason "smaller, so it goes first"
      And the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "A", "C", "B", in that order

    @ac-6
    Scenario: An answered item is listed where the claim takes it, ahead of new work at its priority
      Given item "N" is in NeedsInput with its question answered and has priority 3
      And item "A" is Queued and has priority 3
      And the board orders the items "A", "N"
      When the poller reads the board
      And the operator opens Floor before the scheduler ticks
      Then "Production Line" lists "N", "A", in that order

  # ---------------------------------------------------------------------------------------------------------------
  # AC-7: how many more
  # ---------------------------------------------------------------------------------------------------------------

  Rule: When more items are queued than fit, a line under the list says how many more there are

    @ac-7
    Scenario: A line says how many queued items didn't fit
      Given items 60, 61 and 62 are InProgress
      And items 71, 72, 73, 74, 75, 76, 77, 78 and 79 are Queued
      When the operator opens Floor
      Then under "Production Line" Floor shows a line saying 2 more items are queued

    @ac-7
    Scenario: Items waiting on another PBI that didn't fit count among the more
      Given items 71, 72, 73, 74, 75, 76, 77, 78 and 79 are Queued
      And items 46, 47 and 48 are Queued and each depends on item 12, which is still open
      When the operator opens Floor
      Then under "Production Line" Floor shows a line saying 2 more items are queued

    @ac-7
    Scenario: With exactly 10 rows, no line says there are more
      Given items 60 and 61 are InProgress
      And items 71, 72, 73, 74, 75, 76, 77 and 78 are Queued
      When the operator opens Floor
      Then "Production Line" shows 10 rows
      And under "Production Line" Floor shows no line saying more items are queued

    @ac-7
    Scenario: With fewer than 10 rows, no line says there are more
      Given item 60 is InProgress
      And items 71 and 72 are Queued
      When the operator opens Floor
      Then "Production Line" shows 3 rows
      And under "Production Line" Floor shows no line saying more items are queued

  # ---------------------------------------------------------------------------------------------------------------
  # AC-8: waiting on another PBI isn't waiting on you
  # ---------------------------------------------------------------------------------------------------------------

  Rule: An item that waits only on another PBI is in Production Line, never in "Waiting on you"

    @ac-8
    Scenario: An item waiting only on another PBI is in Production Line and not in "Waiting on you"
      Given item 46 is Queued and depends on item 12, which is still open
      When the operator opens Floor
      Then "Waiting on you" doesn't list item 46
      And "Production Line" lists item 46, showing "Waits on #12"

    @ac-8
    Scenario: An item waiting on another PBI stays out of "Waiting on you" even when that PBI waits on you
      Given item 46 is Queued and depends on item 41, which is still open
      And item 41 is in SignOff, waiting on the owner's sign-off
      When the operator opens Floor
      Then "Waiting on you" lists item 41
      And "Waiting on you" doesn't list item 46
      And "Production Line" lists item 46, showing "Waits on #41"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-9: badges
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Every row keeps the badges it has today

    @ac-9
    Scenario: A queued row in Production Line shows its priority, its bug mark and where its priority comes from
      Given item "H" is Queued and has priority 1
      And item "H" depends on item "D" on the board
      And item "D" is Queued, has priority 4, and carries the "bug" label
      When the poller reads the board
      And the operator opens Floor
      Then item "D"'s row in "Production Line" shows priority 1, taken from "H"
      And item "D"'s row in "Production Line" marks it as a bug item

    @ac-9
    Scenario: A final-stage item shows its final-stage badge in whichever list it is
      Given item "A" has an open PR and is InReview, with priority 2
      And item "B" has an open PR, is Queued to address requested changes, and has priority 2
      When the poller reads the board
      And the operator opens Floor
      Then item "A"'s row in "Waiting on you" shows the "final-stage" badge
      And item "B"'s row in "Production Line" shows the "final-stage" badge

    @ac-9
    Scenario: An item in the final-stage group through a dependent says which item it comes from
      Given item "A" has an open PR and is InReview, with priority 2
      And item "A" depends on item "D" on the board
      And item "D" is Queued and has priority 5
      When the poller reads the board
      And the operator opens Floor
      Then item "D"'s row in "Production Line" shows the "final-stage" badge, taken from "A"
      And item "D"'s row in "Production Line" shows priority 2, taken from "A"

    @ac-9
    Scenario: An InProgress row shows its held and override badges
      Given item 60 is InProgress
      And the operator has held item 60 with the reason "checking the diff"
      And item 61 is InProgress with a Start now override in force
      When the operator opens Floor
      Then item 60's row in "Production Line" shows the "held" badge
      And item 61's row in "Production Line" shows the "override" badge

    @ac-9
    Scenario: A row in "Waiting on you" shows its priority and bug mark
      Given item 42 is in NeedsInput, waiting on a question, with priority 1, and carries the "bug" label
      When the poller reads the board
      And the operator opens Floor
      Then item 42's row in "Waiting on you" shows priority 1
      And item 42's row in "Waiting on you" marks it as a bug item

    @ac-9
    Scenario: A row without a label isn't marked as a bug item
      Given items 61 and 62 are Queued
      And item 62 carries the "bug" label
      When the poller reads the board
      And the operator opens Floor
      Then item 62's row in "Production Line" marks it as a bug item
      And item 61's row in "Production Line" doesn't mark it as a bug item

  # ---------------------------------------------------------------------------------------------------------------
  # AC-10: split children and parents
  # ---------------------------------------------------------------------------------------------------------------

  Rule: A split child names its parent, and a split parent appears in neither list

    @ac-10
    Scenario: A queued split child shows "part of #N", linking to its parent
      Given item 51 "Big rework" is Split into items 60 and 61
      And item 60 is Queued
      When the operator opens Floor
      Then item 60's row in "Production Line" shows "part of #51", which opens item 51's Run detail
      And neither "Waiting on you" nor "Production Line" lists item 51

    @ac-10
    Scenario: A split child that waits on you shows "part of #N" in "Waiting on you"
      Given item 51 is Split into items 60 and 61
      And item 61 is in SignOff, waiting on the owner's sign-off
      When the operator opens Floor
      Then item 61's row in "Waiting on you" shows "part of #51", which opens item 51's Run detail

    @ac-10
    Scenario: An InProgress split child shows "part of #N"
      Given item 51 is Split into items 60 and 61
      And item 60 is InProgress
      When the operator opens Floor
      Then item 60's row in "Production Line" shows "part of #51", which opens item 51's Run detail

    @ac-10
    Scenario: A split parent whose children are all still to come appears in neither list
      Given item 51 "Big rework" is Split into items 60 and 61, neither of which the factory holds yet
      And item 43 is Queued
      When the operator opens Floor
      Then "Production Line" lists item 43
      And neither "Waiting on you" nor "Production Line" lists item 51

    @ac-10
    Scenario: An item that isn't a split child shows no "part of"
      Given item 51 is Split into items 60 and 61
      And items 60 and 43 are Queued
      When the operator opens Floor
      Then item 60's row in "Production Line" shows "part of #51"
      And item 43's row in "Production Line" shows no "part of"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-11: once only
  # ---------------------------------------------------------------------------------------------------------------

  Rule: No item appears in both lists, or twice in one

    @ac-11
    Scenario Outline: An item <kind> appears once, in "Waiting on you", and not in Production Line
      Given item 41 <kind>
      And item 61 is Queued
      When the operator opens Floor
      Then "Waiting on you" lists item 41 once
      And "Production Line" doesn't list item 41
      And "Production Line" lists item 61 once

      Examples:
        | kind                                             |
        | is in SignOff, waiting on the owner's sign-off   |
        | is in NeedsInput, waiting on a question          |
        | is InReview with PR 77 open                      |

    @ac-11
    Scenario: A final-stage item that is InReview appears once, in "Waiting on you"
      Given item "A" has an open PR and is InReview, with priority 1
      And item "Q" is Queued
      When the poller reads the board
      And the operator opens Floor
      Then "Waiting on you" lists item "A" once
      And "Production Line" doesn't list item "A"
      And "Production Line" lists item "Q" once

    @ac-11
    Scenario: A final-stage item queued to address changes appears once, in Production Line
      Given item "B" has an open PR, is Queued to address requested changes, and has priority 1
      When the poller reads the board
      And the operator opens Floor
      Then "Production Line" lists item "B" once
      And "Waiting on you" doesn't list item "B"

    @ac-11
    Scenario: An item waiting on a base that fails in the cell appears once in "Waiting on you"
      Given item 42 is in NeedsInput, waiting on a question that says the base fails in the cell
      When the operator opens Floor
      Then "Waiting on you" lists item 42 once
      And "Production Line" doesn't list item 42

    @ac-11
    Scenario: With every kind of item at once, no item appears in both lists or twice in one
      Given item 41 is in SignOff, waiting on the owner's sign-off
      And item 42 is in NeedsInput with two open questions
      And item 43 has an open PR and is InReview, with priority 1
      And item 44 is in NeedsInput with its question answered
      And item 45 is NotReady, having failed "Has acceptance criteria"
      And item 46 is Queued and depends on item 41, which is still open
      And item 51 is Split into items 60 and 61
      And item 60 is InProgress
      And item 61 is Queued
      And item 52 is Failed after the event "dod_failed"
      When the poller reads the board
      And the operator opens Floor
      Then "Waiting on you" lists items 41, 42, 43, 45 and 52, each once
      And "Production Line" lists items 60, 44, 61 and 46, each once
      And no item appears in both lists

  # ---------------------------------------------------------------------------------------------------------------
  # AC-12: today's Floor, the SPA's Floor and the API
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Today's Floor, the SPA's Floor and the API's Floor answer carry the same two lists

    @ac-12
    Scenario Outline: <floor> shows the two lists, with the same rows in the same order
      Given item 41 has been in SignOff since the factory asked for sign-off at "2026-11-27 09:00" UTC
      And item 45 was turned down by the readiness gate and went NotReady at "2026-11-25 08:00" UTC, having failed "Has acceptance criteria"
      And item 52 went to Failed after the event "dod_failed" at "2026-11-26 09:00" UTC
      And item 60 is InProgress in stage "green"
      And items 61 and 62 are Queued, in that board order
      And item 46 is Queued and depends on item 12, which is still open
      When the operator opens <floor>
      Then "Waiting on you" lists items 45, 52 and 41, in that order
      And item 45's row in "Waiting on you" shows the failed readiness line "Has acceptance criteria"
      And item 52's row in "Waiting on you" shows "Failed on main" with "not yet re-checked"
      And "Production Line" lists items 60, 61, 62 and 46, in that order
      And item 46's row in "Production Line" shows "Waits on #12"
      And <floor> shows none of the headings "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main" or "In flight"

      Examples:
        | floor             |
        | today's Floor     |
        | the SPA's Floor   |

    @ac-12
    Scenario Outline: <floor> shows the line saying how many more items are queued
      Given items 71, 72, 73, 74, 75, 76, 77, 78, 79, 80 and 81 are Queued
      When the operator opens <floor>
      Then "Production Line" shows 10 rows
      And under "Production Line" <floor> shows a line saying 1 more item is queued

      Examples:
        | floor           |
        | today's Floor   |
        | the SPA's Floor |

    @ac-12
    Scenario Outline: <floor> shows a split child's "part of #N" and the badges
      Given item 51 is Split into items 60 and 61
      And item 60 is Queued, has priority 1, and carries the "bug" label
      When the poller reads the board
      And the operator opens <floor>
      Then item 60's row in "Production Line" shows "part of #51", which opens item 51's Run detail
      And item 60's row in "Production Line" shows priority 1 and marks it as a bug item

      Examples:
        | floor           |
        | today's Floor   |
        | the SPA's Floor |

    @ac-12
    Scenario: The API's Floor answer carries both lists, in their order, with what each row shows
      Given item 41 has been in SignOff since the factory asked for sign-off at "2026-11-27 09:00" UTC
      And item 42 has been in NeedsInput since the factory asked "Which format?" at "2026-11-26 09:00" UTC
      And item 60 is InProgress in stage "green"
      And items 61 and 62 are Queued, in that board order
      And item 46 is Queued and depends on item 12, which is still open
      When a client reads the API's Floor answer
      Then the answer's "Waiting on you" list holds items 42 and 41, in that order
      And the answer gives item 42 as waiting on the question "Which format?" since "2026-11-26 09:00" UTC
      And the answer's "Production Line" list holds items 60, 61, 62 and 46, in that order
      And the answer gives item 46 as waiting on "#12"
      And the answer says how many more queued items didn't fit, which is 0

    @ac-12
    Scenario: What the SPA's Floor shows is what the API's Floor answer carries
      Given item 41 is in SignOff, waiting on the owner's sign-off
      And items 61 and 62 are Queued, in that board order
      When a client reads the API's Floor answer
      And the operator opens the SPA's Floor
      Then the SPA's "Waiting on you" lists the same items, in the same order, as the answer's "Waiting on you" list
      And the SPA's "Production Line" lists the same items, in the same order, as the answer's "Production Line" list
