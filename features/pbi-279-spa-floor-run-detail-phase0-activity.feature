@pbi-279
Feature: Floor, Run detail, Phase 0 and Activity in the SPA, with their forms
  Step 8b of the control plane redesign (2026-11-07 design, §05 and §12 step 8) moves today's dashboard pages into
  the React SPA that step 8a started. Floor, Run detail, Phase 0 and Activity show everything today's pages in
  src/http/views.ts show. They read it from the BFF, which forwards to /v1/floor, /v1/items/{id}, /v1/phase0 and
  /v1/activity. Their forms work there too: the operator's override controls on Floor and Run detail, the
  owner's sign-off, and the answer to a question. An override goes to /bff/v1/overrides, and sign-off and answers
  go to /bff/v1/items/{id}/decisions.
  An override needs a reason, so its form won't send one without it, as today's form doesn't. Every field and
  button on these forms has a label.
  Today's dashboard keeps serving these pages on 7400 until step 9 cuts over. The Configuration page isn't part of
  this step.

  Background:
    Given the SPA has been built
    And the BFF is running on 7403 with a session for a signed-in user

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: Floor
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Floor lists each kind of work as today's Floor does

    @ac-1
    Scenario: Floor shows what waits on you, what's next, final-stage items, and what isn't ready
      Given the factory's floor holds:
        | section        | issue | title           | detail                                                         |
        | Waiting on you | #41  | Add search        | SignOff, waiting for 3 hours                                  |
        | Waiting on you | #42  | Fix login         | InReview, waiting for 2 days, PR #77                          |
        | Next up        | #43  | Export CSV        |                                                               |
        | Final stage    | #44  | Tidy the footer   | InReview                                                      |
        | Not ready      | #45  | Do the thing      | failed "Has acceptance criteria" and "Names the user it's for" |
      When I open Floor in the SPA
      Then under "Waiting on you" Floor shows "#41 Add search" with "SignOff, waiting 3 h"
      And under "Waiting on you" Floor shows "#42 Fix login" with a link "PR #77" to that PR and "InReview, waiting 2 days"
      And under "Next up" Floor shows "#43 Export CSV"
      And under "Final stage" Floor shows "#44 Tidy the footer" with "InReview"
      And under "Not ready" Floor shows "#45 Do the thing" with "Has acceptance criteria" and "Names the user it's for"

    @ac-1
    Scenario: Each item on Floor links to its issue on GitHub and to its Run detail in the SPA
      Given the factory's floor has "#43 Export CSV" in the repo "acme/shop" under "Next up"
      When I open Floor in the SPA
      Then "#43" links to issue 43 of "acme/shop" on GitHub
      And "Export CSV" opens that item's Run detail in the SPA

    @ac-1
    Scenario: An item whose repo the factory can't tell shows its number without a link
      Given the factory's floor has "#43 Export CSV" under "Next up" with no repo known
      When I open Floor in the SPA
      Then Floor shows "#43" as plain text, not a link

    @ac-1
    Scenario: Floor shows blocked items, split parents and items that failed on main
      Given the factory's floor holds a Queued item "#50 Add filters" blocked by "#12" and "#13"
      And it holds a Split parent "#51 Big rework" split into "#60 Part one", which is Queued, and "#61 Part two", which the factory doesn't hold
      And it holds "#52 Broke main", which failed its Definition of Done on main and hasn't been re-checked yet
      When I open Floor in the SPA
      Then under "Blocked" Floor shows "#50 Add filters" with "Waits on #12 and #13, which are still open. It starts once they close."
      And under "Split" Floor shows "#51 Big rework" split into, in order, "#60 Part one" as "Queued" and "#61 Part two" as "Not in the factory"
      And under "Failed on main" Floor shows "#52 Broke main" with "Failed, not yet re-checked"

    @ac-1
    Scenario: Floor shows each item's priority, and where its priority or final-stage group comes from
      Given the factory's floor has "#43 Export CSV" under "Next up" at priority 2, taken from "#44", and final-stage because of "#44"
      When I open Floor in the SPA
      Then Floor shows "priority 2, from #44, final-stage because of #44" beside "#43 Export CSV"

    @ac-1
    Scenario: Floor's In flight table shows each running item's state, stage, time in stage, cost and last message
      Given the factory's floor has "#46 Add search" In progress at stage "green" for 12 minutes, costing $1.234, with badges "shadow: high" and last agent message "Running the tests"
      When I open Floor in the SPA
      Then the "In flight" table has the columns "Item", "State", "Stage", "In stage", "Cost" and "Last agent message"
      And its row for "#46 Add search" shows "InProgress", "green", "12 min", "$1.23" and "Running the tests"
      And the row shows the badge "shadow: high"
      And hovering the cost shows "$1.234"

    @ac-1
    Scenario: An item fixing CI shows the failed checks and the commit in place of its stage
      Given the factory's floor has "#46 Add search" at Green fixing a CI failure on commit "abc1234def" where the check "ci" failed
      When I open Floor in the SPA
      Then its Stage shows "fixing CI" with "ci failed on abc1234"
      And "ci" links to the check's run

    @ac-1
    Scenario Outline: An empty section on Floor says so
      Given the factory's floor has nothing under "<section>"
      When I open Floor in the SPA
      Then under "<section>" Floor shows "<empty>"

      Examples:
        | section        | empty                                                                     |
        | Waiting on you | Nothing waits on you.                                                     |
        | Next up        | Nothing is ready to start.                                                |
        | Final stage    | No item is in the review loop, and none is depended on by one that is.    |
        | Not ready      | Every item that entered is ready.                                         |
        | Blocked        | No ready item waits on another.                                           |
        | Split          | No item is split into children that are still open.                       |
        | Failed on main | No item failed its Definition of Done on main.                            |
        | In flight      | No item is in flight.                                                     |

    @ac-1
    Scenario: Floor shows how many items wait against the limit, and links to Activity and the Phase 0 report
      Given the factory's floor has 3 items waiting on a person against a limit of 5
      When I open Floor in the SPA
      Then Floor shows "3 of 5 waiting."
      And Floor links to Activity and to the Phase 0 report in the SPA

  Rule: Floor shows the factory's state and what needs attention, as today's banners do

    @ac-1
    Scenario Outline: Floor shows a pause, a kill or a drain with its reason
      Given the factory is under a "<override>" override with the reason "<reason>"
      And <running> cells are still running
      When I open Floor in the SPA
      Then Floor shows the banner "<banner>"

      Examples:
        | override | reason         | running | banner                                                                                         |
        | pause    | lunch          | 0       | Paused: lunch                                                                                  |
        | kill     | runaway spend  | 0       | Killed: runaway spend                                                                          |
        | drain    | deploy         | 2       | Draining: 2 cells still running. Reason: deploy.                                               |
        | drain    | deploy         | 0       | Drain done. No cell is running, so it's safe to restart the factory or stop Docker. Reason: deploy. |

    @ac-1
    Scenario Outline: Floor shows a restart being prepared
      Given the factory is preparing a restart with the reason "new image"
      And <running> cells are still running
      When I open Floor in the SPA
      Then Floor shows the banner "<banner>"

      Examples:
        | running | banner                                                                                              |
        | 1       | Preparing to restart: 1 cell still running. The factory won't stop it. Reason: new image.           |
        | 0       | Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker. Reason: new image. |

    @ac-1
    Scenario: Floor shows the cell image's commit, and when a restart is needed to pick up main
      Given the cell image was built from commit "1111111aaaa" and main's commit "2222222bbbb" needs a restart
      When I open Floor in the SPA
      Then Floor shows "The cell image was built from commit 1111111."
      And Floor shows the banner "A restart is needed to pick up main's commit 2222222. It changes code the control plane or the worker runs, so the cell image isn't rebuilt until the factory restarts."

    @ac-1
    Scenario: Floor shows when main is red, with the commit that broke it and its bug item
      Given main is red at commit "deadbee1234", the merge of PR #90 for item "#40", and its bug item is "#91 Fix main"
      When I open Floor in the SPA
      Then Floor shows "main is red." in a banner
      And the banner says "Commit deadbee broke main, the merge of PR #90 for item #40. Its bug item #91 Fix main is claimed first."

    @ac-1
    Scenario: Floor shows when the base fails in cells, with each item that waits on it and the failing tests
      Given "#47 Add search" waits on a question because its tests "auth.test" and "db.test" fail on base commit "cafe1234abc"
      When I open Floor in the SPA
      Then Floor shows the banner beginning "The base fails in cells."
      And the banner names "#47 Add search" "at base commit cafe123" with the tests "auth.test" and "db.test"

    @ac-1
    Scenario: Floor warns when the Claude token is near the end of its life
      Given the Claude token expires in 12 days
      When I open Floor in the SPA
      Then Floor shows the banner "The Claude token expires in 12 days. Make a new one with claude setup-token and update the secret."

  Rule: Floor updates live, without losing a reason being typed

    @ac-1
    Scenario: Floor shows a change as soon as the factory reports it
      Given Floor is open in the SPA with "#43 Export CSV" under "Next up"
      When the factory reports an event that moves "#43 Export CSV" into In flight
      Then within a few seconds Floor shows "#43 Export CSV" in the "In flight" table

    @ac-1
    Scenario: A reason half-typed on Floor survives a live update
      Given I am an operator with Floor open in the SPA
      And I have typed "draining for" into the Reason field
      When the factory reports an event
      Then the Reason field still holds "draining for"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: Run detail
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Run detail shows the item, where it stands and what its run is pinned to

    @ac-1
    Scenario: Run detail shows the item's issue, title, state, PR and next stage
      Given item "#42 Fix login" in "acme/shop" is InReview on an open run with PR #77 that resumes at "address"
      When I open its Run detail in the SPA
      Then the heading is "#42 Fix login", with "#42" linking to the issue on GitHub
      And Run detail shows "InReview", a link "PR #77" to the PR, and ", resumes at address"

    @ac-1
    Scenario: Run detail shows what the run is pinned to and its shadow risk tier
      Given item "#42 Fix login" has a run on SOP version "v12", config "c0ffee1", scenarios locked at "f00d123", and shadow tier "high" because "touches auth"
      When I open its Run detail in the SPA
      Then Run detail shows "SOP version" "v12", "Config" "c0ffee1" and "Scenarios locked at" "f00d123"
      And Run detail shows "Shadow risk tier" "high" with the reason "touches auth"

    @ac-1
    Scenario: An item with no run yet says what isn't pinned
      Given item "#43 Export CSV" has no run yet
      When I open its Run detail in the SPA
      Then Run detail shows "SOP version" "not pinned yet" and "Config" "not pinned yet"
      And Run detail shows "Scenarios locked at" "not signed off" and "Shadow risk tier" "not classified"
      And Run detail shows "No policy results yet.", "No stage has run yet." and "No readiness check has run yet."

    @ac-1
    Scenario: Run detail shows the item's priority, its Start now mark and a Move that the board's order ended
      Given item "#43 Export CSV" has priority 2, from "#44", which depends on it, and its own priority on the board is 5
      And it is marked Start now with the reason "customer waiting", by "octo"
      And its Move up was ended by a change to the board's order
      When I open its Run detail in the SPA
      Then Run detail shows "Priority 2, from #44, which depends on it. Its own priority on the board is 5."
      And Run detail shows "Marked Start now: customer waiting, by octo."
      And Run detail shows that its "Move up" was "ended by a change to the board's order"

    @ac-1
    Scenario: Run detail shows a Failed item's re-check, a Split parent's children and a CI failure being fixed
      Given item "#52 Broke main" failed its Definition of Done on main and hasn't been re-checked yet
      And item "#51 Big rework" was split into "#60 Part one" and "#61 Part two"
      And item "#46 Add search" is fixing CI on commit "abc1234def", where the check "ci" failed the test "logs in"
      When I open each item's Run detail in the SPA
      Then the Run detail of "#52 Broke main" says "It hasn't been re-checked yet."
      And the Run detail of "#51 Big rework" lists under "Split into", in order, "#60 Part one" and "#61 Part two"
      And the Run detail of "#46 Add search" says "Green is fixing the CI failure on commit abc1234" and lists "ci" with the failing test "logs in"

  Rule: Run detail shows the run's stages, time, policies, readiness checks and scenario verdicts

    @ac-1
    Scenario: Run detail's Stages table shows each attempt
      Given item "#46 Add search" has a finished "red" attempt 1 on model "opus" that took 4 minutes, used 12,000 tokens in and 800 out, cost $0.5678 and left a transcript
      And the PR reviewer needed a second ask in round 2 of that attempt because "the diff was cut off"
      When I open its Run detail in the SPA
      Then the "Stages" table has the columns "Stage", "Attempt", "Status", "Model", "Started", "Time spent", "Tokens", "Cost", "Transcript" and "Notes"
      And its row shows "red", "1", "opus", "4 min", "12k in, 800 out" and "$0.57"
      And hovering its tokens shows "12000 in, 800 out" and hovering its cost shows "$0.5678"
      And its Transcript is a link to the stored transcript
      And its Notes say "Needed a second ask of the PR reviewer in round 2: the diff was cut off"

    @ac-1
    Scenario Outline: An attempt with no end says whether it's running or stopped
      Given item "#46 Add search" is <state> and its newest attempt at "green" started 5 minutes ago with no end
      When I open its Run detail in the SPA
      Then that attempt's Status is "<status>" and its Time spent is "<spent>"

      Examples:
        | state                         | status  | spent           |
        | InProgress on an open run     | running | 5 min so far    |
        | NeedsInput                    | stopped | didn't finish   |

    @ac-1
    Scenario: Run detail shows times in the viewer's own time zone
      Given the browser's time zone is "Europe/Paris"
      And item "#46 Add search" has an attempt that started at 2026-11-20 09:00 UTC
      When I open its Run detail in the SPA
      Then that attempt's Started shows 10:00 on 2026-11-20
      And Run detail says "Times show in Europe/Paris."

    @ac-1
    Scenario: Run detail shows where the item's time went
      Given item "#46 Add search" took 3 hours in all, 1 hour Queued, 30 minutes waiting at sign-off, and 1 hour in "green" over 2 attempts
      When I open its Run detail in the SPA
      Then under "Time" Run detail shows "Total", "Queued", "Sign-off" and "Waiting on a person" with their times
      And its "Time in each stage" table shows "green" with its time and "2" attempts

    @ac-1
    Scenario: Run detail shows the policy results and the readiness checks with their verdicts
      Given item "#46 Add search" failed the "dod" criterion "CI passes" from "main" because "lint failed"
      And its readiness judge failed it on "Has acceptance criteria" because "none listed", and a later judge call passed it
      When I open its Run detail in the SPA
      Then the "Policy results" table shows "dod.md main", "CI passes", "failed" and "lint failed"
      And the "Readiness checks" table shows a Judge call that "Failed" with "Has acceptance criteria: none listed"
      And the "Readiness checks" table shows a Judge call that "Passed"
      And each readiness check shows its model, its tokens and its cost to four places, such as "$0.0012"

    @ac-1
    Scenario: Run detail shows the scenarios at red and green, and the signed-off feature files
      Given item "#46 Add search" has the scenario "Search finds a title", which failed at Red and passed at Green
      And its signed-off feature file "features/pbi-46-search.feature" holds "Feature: Search"
      When I open its Run detail in the SPA
      Then the "Scenarios at red and green" table shows "Search finds a title" with "failed" and "passed"
      And under "Signed-off scenarios" Run detail shows "features/pbi-46-search.feature" with its text "Feature: Search"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: sign-off and answers
  # ---------------------------------------------------------------------------------------------------------------

  Rule: At sign-off the owner reads the scope, criteria and scenarios, then approves or asks for changes

    @ac-1
    Scenario: The sign-off page shows the scope, each criterion's scenarios and the files before the buttons
      Given item "#41 Add search" waits for sign-off
      And its issue's body is "Let people search the catalogue."
      And its criterion "Search finds a title" has the scenario "Search by title", and "Every test still passes" has the @regression scenario "Existing suite"
      And its criterion "Search is fast" has no scenario
      And its feature file "features/pbi-41-search.feature" is up for sign-off
      When I open its Run detail in the SPA
      Then under "Scope" Run detail shows "Let people search the catalogue."
      And under "Criteria and their scenarios" it lists "Search by title" under "Search finds a title"
      And it marks "Existing suite" "expected to pass at Red"
      And it marks "Search is fast" "no scenario"
      And under "Scenarios up for sign-off" it shows "features/pbi-41-search.feature" with its text
      And the "Sign off" form, with "Note for the factory", "Approve the scenarios" and "Ask for changes", comes after all of these

    @ac-1
    Scenario Outline: The owner's sign-off decision goes to the factory with their note
      Given I am the product owner and item "#41 Add search" waits for sign-off
      And I open its Run detail in the SPA
      When I type "<note>" into "Note for the factory" and press "<button>"
      Then the SPA sends the factory the decision "<decision>" on "#41 Add search" with the note "<note>"
      And Run detail shows the item as it stands after the decision

      Examples:
        | button                | decision | note                    |
        | Approve the scenarios | approve  | Looks right             |
        | Ask for changes       | changes  | Cover the empty search  |

    @ac-1
    Scenario: The owner can approve without a note
      Given I am the product owner and item "#41 Add search" waits for sign-off
      And I open its Run detail in the SPA
      When I press "Approve the scenarios" with "Note for the factory" left empty
      Then the SPA sends the factory the decision "approve" on "#41 Add search" with an empty note

    @ac-1
    Scenario: A decision the factory ignores says the item isn't waiting for it
      Given I am the product owner with the sign-off form for "#41 Add search" open in the SPA
      And the item has since stopped waiting for sign-off
      When I press "Approve the scenarios"
      Then Run detail shows "That item isn't waiting for this decision."

    @ac-1
    Scenario: A decision the factory forbids shows its refusal
      Given I am a user who isn't the product owner, with the sign-off form for "#41 Add search" open in the SPA
      When I press "Approve the scenarios"
      Then the factory refuses the decision
      And Run detail shows that the decision was refused
      And the SPA doesn't show the no-access page

  Rule: A question waiting on a person shows its text and takes an answer

    @ac-1
    Scenario: Run detail shows the question and sends the answer
      Given item "#48 Pick a colour" waits on the question "Should the button be blue or green?"
      When I open its Run detail in the SPA
      Then under "Answer" Run detail shows "Should the button be blue or green?"
      When I type "Blue" into "Your answer" and press "Send the answer"
      Then the SPA sends the factory the decision "answer" on "#48 Pick a colour" with the text "Blue"

    @ac-1
    Scenario: An empty answer can't be sent
      Given item "#48 Pick a colour" waits on the question "Should the button be blue or green?"
      And I open its Run detail in the SPA
      When I press "Send the answer" with "Your answer" left empty
      Then "Your answer" is marked as needing a value
      And the SPA sends no decision

    @ac-1
    Scenario: An item with no question shows neither form
      Given item "#46 Add search" is InProgress with no open question
      When I open its Run detail in the SPA
      Then Run detail shows the item's heading "#46 Add search"
      And Run detail shows no "Sign off" form and no "Answer" form

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: override forms
  # ---------------------------------------------------------------------------------------------------------------

  Rule: An operator's override controls on Floor send the factory-wide overrides with their reason

    @ac-1
    Scenario Outline: An operator sends a factory-wide override from Floor
      Given I am an operator with Floor open in the SPA
      When I type "<reason>" into "Reason" under "Controls" and press "<button>"
      Then the SPA sends the factory a factory-wide "<kind>" override with the reason "<reason>"
      And Floor shows the factory as it stands after the override

      Examples:
        | button          | kind    | reason            |
        | Pause           | pause   | lunch             |
        | Drain           | drain   | deploy at noon    |
        | Resume          | resume  | back from lunch   |
        | Kill switch     | kill    | runaway spend     |
        | Prepare restart | restart | new cell image    |

    @ac-1
    Scenario: A viewer sees Floor with no controls
      Given I am a viewer, not an operator
      When I open Floor in the SPA
      Then Floor shows "Waiting on you"
      And Floor shows no "Controls" section, no Reason field and no override buttons

  Rule: An operator's override controls on Run detail fit the item, and send its overrides with their reason

    @ac-1
    Scenario Outline: Run detail offers the overrides that fit the item
      Given I am an operator
      And item "#46 Add search" is <situation>
      When I open its Run detail in the SPA
      Then under "Controls" Run detail offers exactly the buttons <buttons>

      Examples:
        | situation                                  | buttons                                           |
        | InProgress, not held, with a running cell  | "Hold" and "Stop the run"                         |
        | held and Failed                            | "Release the hold" and "Re-queue"                 |
        | Failed                                     | "Hold" and "Re-queue"                             |
        | Queued                                     | "Hold", "Start now", "Move up" and "Move down"    |
        | Eligible                                   | "Hold" and "Start now"                            |

    @ac-1
    Scenario Outline: An operator sends an item override from Run detail
      Given I am an operator
      And item "#46 Add search" is <situation>
      And I open its Run detail in the SPA
      When I type "<reason>" into "Reason" under "Controls" and press "<button>"
      Then the SPA sends the factory a "<kind>" override on "#46 Add search" with the reason "<reason>"
      And Run detail shows the item as it stands after the override

      Examples:
        | situation                                 | button           | kind      | reason               |
        | InProgress, not held, with a running cell | Hold             | hold      | waiting on legal     |
        | held and Failed                           | Release the hold | unhold    | legal said yes       |
        | InProgress, not held, with a running cell | Stop the run     | stop_run  | wrong approach       |
        | Queued                                    | Start now        | start_now | customer waiting     |
        | Queued                                    | Move up          | move_up   | blocks the release   |
        | Queued                                    | Move down        | move_down | can wait a week      |

    @ac-1
    Scenario: Re-queueing a Failed item sends the reason the operator gave
      Given I am an operator
      And item "#52 Broke main" is Failed
      And I open its Run detail in the SPA
      When I type "main is fixed now" into "Reason" under "Controls" and press "Re-queue"
      Then the SPA sends the factory a "requeue" override on "#52 Broke main" with the reason "main is fixed now"
      And Run detail shows the item as it stands after the re-queue

    @ac-1
    Scenario: A re-queue the factory refuses shows why
      Given I am an operator with the Run detail of Failed item "#52 Broke main" open in the SPA
      And the item has since been re-queued by someone else
      When I type "main is fixed now" into "Reason" under "Controls" and press "Re-queue"
      Then Run detail shows "Only a Failed or Abandoned item can be re-queued."

    @ac-1
    Scenario: A viewer sees Run detail with no controls
      Given I am a viewer, not an operator
      And item "#52 Broke main" is Failed
      When I open its Run detail in the SPA
      Then Run detail shows the item's heading "#52 Broke main"
      And Run detail shows no "Controls" section, no Reason field and no override buttons

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: Phase 0
  # ---------------------------------------------------------------------------------------------------------------

  Rule: The Phase 0 report shows the merged PRs, their cost and the readiness spend

    @ac-1
    Scenario: The Phase 0 report sums up the merged PRs and lists each one
      Given the factory has merged "#41 Add search" as "https://github.com/acme/shop/pull/70" on 2026-11-10 for $3.00 at shadow tier "low"
      And it has merged "#42 Fix login" as "https://github.com/acme/shop/pull/71" on 2026-11-12 for $5.00 at shadow tier "high" because "touches auth"
      And the readiness checks on every item cost $0.0123 in all
      When I open the Phase 0 report in the SPA
      Then it shows "2 merged PRs, $8.00 in all, $4.00 each on average."
      And it shows "Stage spend" "$8.00" and "Readiness spend" "$0.0123"
      And its table has the columns "Item", "PR", "Merged", "Cost" and "Shadow tier"
      And its row for "#41 Add search" shows a link to "https://github.com/acme/shop/pull/70", "2026-11-10", "$3.00" and "low"
      And its row for "#42 Fix login" shows "high" with the reason "touches auth"

    @ac-1
    Scenario: One merged PR reads in the singular
      Given the factory has merged only "#41 Add search", for $3.00
      When I open the Phase 0 report in the SPA
      Then it shows "1 merged PR, $3.00 in all, $3.00 each on average."

    @ac-1
    Scenario: With nothing merged, the Phase 0 report says so
      Given the factory has merged no PR
      And the readiness checks cost $0.0040 in all
      When I open the Phase 0 report in the SPA
      Then it shows "0 merged PRs, $0.00 in all, $0.00 each on average."
      And it shows "Readiness spend" "$0.0040"
      And it shows "No factory PR has merged yet."

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: Activity
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Activity shows the factory's newest events, newest first, in UTC

    @ac-1
    Scenario: Activity shows each event's time, item, title, kind and move
      Given the factory's newest events are, newest first:
        | at (UTC)         | issue | title      | kind       | from    | to         | event    |
        | 2026-11-20 10:05 | #41   | Add search | transition | Queued  | InProgress | claimed  |
        | 2026-11-20 10:00 | #42   | Fix login  | override   | Failed  | Queued     |          |
        | 2026-11-20 09:55 | #43   | Export CSV | sop_moved  | v11     | v12        |          |
        | 2026-11-20 09:50 | #44   | Tidy       | decision   | x       | y          | z        |
      When I open Activity in the SPA
      Then Activity shows "The 100 newest events, newest first."
      And its table has the columns "Time (UTC)", "Item", "Title", "Kind" and "Move"
      And its rows, in order, show "2026-11-20 10:05", "2026-11-20 10:00", "2026-11-20 09:55" and "2026-11-20 09:50"
      And the transition's Move shows "Queued → InProgress (claimed)"
      And the override's Move shows "Failed → Queued"
      And the SOP move's Move shows "v11 → v12"
      And the decision's Move is empty

    @ac-1
    Scenario: Activity shows who changed a setting, from what to what, and why
      Given the factory's newest event is "octo" changing "WIP limit" from not set to "4" because "more cells free"
      When I open Activity in the SPA
      Then its Move shows "octo changed WIP limit from not set to 4 because more cells free"

    @ac-1
    Scenario: Activity's times stay in UTC whatever the browser's time zone
      Given the browser's time zone is "Asia/Tokyo"
      And the factory's newest event happened at 2026-11-20 10:05 UTC
      When I open Activity in the SPA
      Then its time shows "2026-11-20 10:05"

    @ac-1
    Scenario: With no event yet, Activity says so
      Given the factory has logged no event
      When I open Activity in the SPA
      Then Activity shows "No event yet."

  # ---------------------------------------------------------------------------------------------------------------
  # AC-2: an override with an empty reason can't be sent
  # ---------------------------------------------------------------------------------------------------------------

  Rule: An override with an empty reason can't be sent from its form

    @ac-2
    Scenario Outline: Floor won't send a factory-wide override without a reason
      Given I am an operator with Floor open in the SPA
      When I leave "Reason" under "Controls" <left> and press "<button>"
      Then "Reason" is marked as needing a value
      And the SPA sends no override

      Examples:
        | left              | button          |
        | empty             | Pause           |
        | empty             | Drain           |
        | empty             | Resume          |
        | empty             | Kill switch     |
        | empty             | Prepare restart |
        | holding spaces only | Pause         |

    @ac-2
    Scenario Outline: Run detail won't send an item override without a reason
      Given I am an operator
      And item "#46 Add search" is <situation>
      And I open its Run detail in the SPA
      When I leave "Reason" under "Controls" <left> and press "<button>"
      Then "Reason" is marked as needing a value
      And the SPA sends no override

      Examples:
        | situation                                 | left                | button           |
        | InProgress, not held, with a running cell | empty               | Hold             |
        | held and Failed                           | empty               | Release the hold |
        | InProgress, not held, with a running cell | empty               | Stop the run     |
        | Failed                                    | empty               | Re-queue         |
        | Queued                                    | empty               | Start now        |
        | Queued                                    | empty               | Move up          |
        | Queued                                    | empty               | Move down        |
        | Failed                                    | holding spaces only | Re-queue         |

    @ac-2
    Scenario: Once a reason is typed, the override that was held back is sent
      Given I am an operator with Floor open in the SPA
      And I pressed "Pause" with "Reason" left empty, and no override was sent
      When I type "lunch" into "Reason" and press "Pause"
      Then the SPA sends the factory a factory-wide "pause" override with the reason "lunch"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-3: every form control has a label
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Every form control has a label

    @ac-3
    Scenario: Every control on Floor's override form has a label
      Given I am an operator
      When I open Floor in the SPA
      Then Floor has a text field labelled "Reason" under "Controls"
      And Floor has buttons labelled "Pause", "Drain", "Resume", "Kill switch" and "Prepare restart"
      And every field and button on Floor has a label a screen reader announces

    @ac-3
    Scenario Outline: Every control on Run detail's forms has a label
      Given I am <who>
      And item "#46 Add search" <situation>
      When I open its Run detail in the SPA
      Then Run detail has a <field> labelled "<label>"
      And every field and button on Run detail has a label a screen reader announces

      Examples:
        | who                                    | situation                                     | field      | label                |
        | an operator                            | is Queued                                     | text field | Reason               |
        | an operator                            | is held and Failed                            | text field | Reason               |
        | an operator                            | is Failed                                     | text field | Reason               |
        | the product owner                      | waits for sign-off                            | text area  | Note for the factory |
        | a user                                 | waits on the question "Blue or green?"        | text area  | Your answer          |

    @ac-3
    Scenario: Each label names its own control
      Given I am an operator and the product owner
      And item "#41 Add search" waits for sign-off
      When I open its Run detail in the SPA
      Then choosing the label "Note for the factory" puts the cursor in the sign-off note
      And choosing the label "Reason" puts the cursor in the override's reason
