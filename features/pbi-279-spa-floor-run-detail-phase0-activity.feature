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
  Each page draws from one read of the factory. Live updates come in a later step. Today's dashboard keeps serving
  these pages on 7400 until step 9 cuts over. The Configuration page isn't part of this step.
  As in step 8a, these scenarios run with no BFF and no sign-in: "opening" a page renders it with react-dom/server
  from the fixture data the factory is said to hold, and the SPA's API client calls a stubbed fetch that answers
  with that data and records what the SPA sends. Numbers and times read as today's pages format them in
  src/http/format.ts.

  Background:
    Given the SPA's pages are rendered with react-dom/server
    And the SPA's API client calls a stubbed fetch that answers from fixture data, with no BFF and no one signed in

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: Floor
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Floor lists each kind of work as today's Floor does

    @ac-1
    Scenario: Floor shows what waits on you, what's next, final-stage items, and what isn't ready
      Given the factory's floor holds:
        | section        | issue | title           | detail                                                         |
        | Waiting on you | #41   | Add search      | SignOff, waiting for 3 hours                                   |
        | Waiting on you | #42   | Fix login       | InReview, waiting for 2 days, PR #77                           |
        | Next up        | #43   | Export CSV      |                                                                |
        | Final stage    | #44   | Tidy the footer | InReview                                                       |
        | Not ready      | #45   | Do the thing    | failed "Has acceptance criteria" and "Names the user it's for" |
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
    Scenario: Floor shows blocked items and split parents with each child's state
      Given the factory's floor holds a Queued item "#50 Add filters" blocked by "#12" and "#13"
      And it holds a Split parent "#51 Big rework" split into "#60 Part one", which is Queued, "#61 Part two", which is Done, and "#62 Part three", which the factory doesn't hold
      When I open Floor in the SPA
      Then under "Blocked" Floor shows "#50 Add filters" with "Waits on #12 and #13, which are still open. It starts once they close."
      And under "Split" Floor shows "#51 Big rework" split into, in order, "#60 Part one" as "Queued", "#61 Part two" as "Done" and "#62 Part three" as "Not in the factory"

    @ac-1
    Scenario Outline: Floor shows each item that failed on main, and when it was last re-checked
      Given the viewer's time zone is "UTC"
      And the factory's floor has "#52 Broke main", which failed its Definition of Done on main and <rechecked>
      When I open Floor in the SPA
      Then under "Failed on main" Floor shows "#52 Broke main" with "<shown>"

      Examples:
        | rechecked                                 | shown                                     |
        | hasn't been re-checked yet                | Failed, not yet re-checked                |
        | was last re-checked at 2026-11-20 10:00 UTC | Failed, last re-checked at 2026-11-20 10:00 |

    @ac-1
    Scenario: Floor shows each item's priority, and where its priority or final-stage group comes from
      Given the factory's floor has "#43 Export CSV" under "Next up" at priority 2, taken from "#44", and final-stage because of "#44"
      When I open Floor in the SPA
      Then Floor shows "priority 2, from #44, final-stage because of #44" beside "#43 Export CSV"

    @ac-1
    Scenario: Floor marks a bug item with a badge
      Given the factory's floor has "#53 Fix crash", which carries the bug label, under "Next up" at priority 1
      When I open Floor in the SPA
      Then Floor shows the badge "bug" and "priority 1" beside "#53 Fix crash"

    @ac-1
    Scenario: Floor's In flight table shows each running item's state, stage, time in stage, cost and last message
      Given the factory's floor has "#46 Add search" In progress at stage "green" for 12 minutes, costing $1.234, with badges "shadow: high" and last agent message "Running the tests"
      When I open Floor in the SPA
      Then the "In flight" table has the columns "Item", "State", "Stage", "In stage", "Cost" and "Last agent message"
      And its row for "#46 Add search" shows "InProgress", "green", "12 min", "$1.23" and "Running the tests"
      And the row shows the badge "shadow: high"
      And the row's cost has the title "$1.234"

    @ac-1
    Scenario Outline: An item fixing CI shows the failed checks and the commit in place of its stage
      Given the factory's floor has "#46 Add search" at Green fixing a CI failure on commit "abc1234def" where <checks>
      When I open Floor in the SPA
      Then its Stage shows "<stage>"

      Examples:
        | checks                                    | stage                                                         |
        | the check "ci" failed                     | fixing CI ci failed on abc1234                                |
        | the checks "ci" and "e2e" failed          | fixing CI ci, e2e failed on abc1234                           |
        | CI named no check the factory could read  | fixing CI no check the factory could read failed on abc1234   |

    @ac-1
    Scenario: A failed check on Floor links to its run
      Given the factory's floor has "#46 Add search" at Green fixing a CI failure on commit "abc1234def" where the check "ci" failed at "https://github.com/acme/shop/actions/runs/9"
      When I open Floor in the SPA
      Then "ci" links to "https://github.com/acme/shop/actions/runs/9"

    @ac-1
    Scenario Outline: An empty section on Floor says so
      Given the factory's floor has nothing under "<section>"
      When I open Floor in the SPA
      Then under "<section>" Floor shows "<empty>"

      Examples:
        | section        | empty                                                                  |
        | Waiting on you | Nothing waits on you.                                                  |
        | Next up        | Nothing is ready to start.                                             |
        | Final stage    | No item is in the review loop, and none is depended on by one that is. |
        | Not ready      | Every item that entered is ready.                                      |
        | Blocked        | No ready item waits on another.                                        |
        | Split          | No item is split into children that are still open.                    |
        | Failed on main | No item failed its Definition of Done on main.                         |
        | In flight      | No item is in flight.                                                  |

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
      And the factory counts <running> cells still running
      When I open Floor in the SPA
      Then Floor shows the banner "<banner>"

      Examples:
        | override | reason        | running | banner                                                                                              |
        | pause    | lunch         | 0       | Paused: lunch                                                                                       |
        | kill     | runaway spend | 0       | Killed: runaway spend                                                                               |
        | drain    | deploy        | 2       | Draining: 2 cells still running. Reason: deploy.                                                    |
        | drain    | deploy        | 1       | Draining: 1 cell still running. Reason: deploy.                                                     |
        | drain    | deploy        | 0       | Drain done. No cell is running, so it's safe to restart the factory or stop Docker. Reason: deploy. |

    @ac-1
    Scenario: A drain the factory gives no count for shows its reason alone
      Given the factory is under a "drain" override with the reason "deploy"
      And the factory gives no count of the cells still running
      When I open Floor in the SPA
      Then Floor shows the banner "Draining: deploy"

    @ac-1
    Scenario Outline: Floor shows a restart being prepared
      Given the factory is preparing a restart with the reason "new image"
      And the factory counts <running> cells still running
      When I open Floor in the SPA
      Then Floor shows the banner "<banner>"

      Examples:
        | running | banner                                                                                                       |
        | 2       | Preparing to restart: 2 cells still running. The factory won't stop them. Reason: new image.                 |
        | 1       | Preparing to restart: 1 cell still running. The factory won't stop it. Reason: new image.                    |
        | 0       | Ready to restart. No cell is running, so it's safe to restart the factory or stop Docker. Reason: new image. |

    @ac-1
    Scenario: Floor shows the cell image's commit, and when a restart is needed to pick up main
      Given the cell image was built from commit "1111111aaaa" and main's commit "2222222bbbb" needs a restart
      When I open Floor in the SPA
      Then Floor shows "The cell image was built from commit 1111111."
      And Floor shows the banner "A restart is needed to pick up main's commit 2222222. It changes code the control plane or the worker runs, so the cell image isn't rebuilt until the factory restarts."

    @ac-1
    Scenario: A cell image with no commit label says its commit isn't known
      Given the cell image carries no commit label and no restart is needed
      When I open Floor in the SPA
      Then Floor shows "The cell image was built from commit not known: it carries no commit label, as an image built from a checkout with uncommitted edits doesn't."
      And Floor shows no banner beginning "A restart is needed"

    @ac-1
    Scenario Outline: Floor shows when main is red, with the commit that broke it and what became of its bug item
      Given main is red at commit "deadbee1234", <cause>
      When I open Floor in the SPA
      Then Floor shows a banner beginning "<lead>"
      And the banner says "<line>"

      Examples:
        | cause                                                                          | lead                                                                                                               | line                                                                                                                                      |
        | the merge of PR #90 for item "#40", and its bug item is "#91 Fix main"          | main is red. The factory fixes it before it builds anything else, and an item merged onto it meanwhile waits for it to pass again. | Commit deadbee broke main, the merge of PR #90 for item #40. Its bug item #91 Fix main is claimed first.                                 |
        | the merge of PR #90 for item "#40", and the factory hasn't filed its bug item yet | main is red. The factory fixes it before it builds anything else, and an item merged onto it meanwhile waits for it to pass again. | Commit deadbee broke main, the merge of PR #90 for item #40. The factory is filing its bug item.                                         |
        | the merge of PR #90 for item "#40", and its bug item "#91 Fix main" is Failed   | main is red. The factory fixes it before it builds anything else, and an item merged onto it meanwhile waits for it to pass again. | Commit deadbee broke main, the merge of PR #90 for item #40. Its bug item #91 Fix main failed to make main pass, so main stays red until it's re-queued or someone fixes it. |
        | which the factory didn't merge, so no item is charged with it                  | main is red. An item merged onto it meanwhile waits for it to pass again.                                          | main was already red at commit deadbee, which the factory didn't merge, so it filed no bug item. Someone needs to fix main.              |

    @ac-1
    Scenario: Floor shows when the base fails in cells, with each item that waits on it and the failing tests
      Given "#47 Add search" waits on a question because its tests "auth.test" and "db.test" fail on base commit "cafe1234abc"
      When I open Floor in the SPA
      Then Floor shows the banner beginning "The base fails in cells. These items wait on it, since their Definition of Done or their CI fails the same tests on the base commit. Fix the base, then answer each item's question."
      And the banner names "#47 Add search" "at base commit cafe123" with the tests "auth.test" and "db.test"

    @ac-1
    Scenario: Floor warns when the Claude token is near the end of its life
      Given the Claude token expires in 12 days
      When I open Floor in the SPA
      Then Floor shows the banner "The Claude token expires in 12 days. Make a new one with claude setup-token and update the secret."

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
      Given the viewer's time zone is "UTC"
      And item "#43 Export CSV" has priority 2, from "#44", which depends on it, and its own priority on the board is 5
      And it is marked Start now with the reason "customer waiting", by "octo"
      And its Move up was ended by a change to the board's order at 2026-11-20 10:00 UTC
      When I open its Run detail in the SPA
      Then Run detail shows "Priority 2, from #44, which depends on it. Its own priority on the board is 5."
      And Run detail shows "Marked Start now: customer waiting, by octo. The next free slot claims it first once it's Queued, not held and not blocked."
      And Run detail shows "Move up ended by a change to the board's order, at 2026-11-20 10:00: the board now puts the item and the item it passed the other way round from when it was moved, so it follows the board again."

    @ac-1
    Scenario Outline: Run detail says why an item is final-stage, and what its bug label does
      Given item "#43 Export CSV" has priority <priority> and <group>, and <bug>
      When I open its Run detail in the SPA
      Then Run detail shows "<lines>"

      Examples:
        | priority | group                                         | bug                       | lines                                                                                                                                                                                         |
        | 2        | is final-stage because "#44" depends on it    | doesn't carry the bug label | Priority 2. Final-stage because #44 depends on it, so it's claimed ahead of other work while that dependency stands.                                                                        |
        | 2        | is final-stage because its PR is open         | doesn't carry the bug label | Priority 2. Final-stage: its PR is open and it's in the review loop, so it's claimed ahead of other work.                                                                                   |
        | 2        | is final-stage because its PR is open         | carries the bug label     | Priority 2. Final-stage: its PR is open and it's in the review loop, so it's claimed ahead of other work. Carries the bug label, so it's claimed before the items at priority 2 in the final-stage group that don't. |
        | 1        | isn't final-stage                             | carries the bug label     | Priority 1. Carries the bug label, so it's claimed before the priority-1 items outside the final-stage group that don't.                                                                    |
        | 3        | isn't final-stage                             | carries the bug label     | Priority 3. Carries the bug label, which puts it first only in the final-stage group or at priority 1.                                                                                      |

    @ac-1
    Scenario: An item that isn't final-stage and has no bug label never shows either word
      Given item "#43 Export CSV" has priority 3, isn't final-stage, and doesn't carry the bug label
      When I open its Run detail in the SPA
      Then Run detail shows "Priority 3."
      And Run detail doesn't show "Final-stage" or "bug label"

    @ac-1
    Scenario Outline: Run detail shows when a Failed item was last re-checked
      Given the viewer's time zone is "UTC"
      And item "#52 Broke main" failed its Definition of Done on main and <rechecked>
      When I open its Run detail in the SPA
      Then Run detail shows "<line>"

      Examples:
        | rechecked                                   | line                                                                                                                                                         |
        | hasn't been re-checked yet                  | It hasn't been re-checked yet. The factory re-checks it every few hours and moves it back to Accepted once its merge no longer counts as breaking main.     |
        | was last re-checked at 2026-11-20 10:00 UTC | Last re-checked at 2026-11-20 10:00. The factory re-checks it every few hours and moves it back to Accepted once its merge no longer counts as breaking main. |

    @ac-1
    Scenario: Run detail shows a Split parent's children with their states
      Given item "#51 Big rework" was split into "#60 Part one", which is Queued, "#61 Part two", which is Done, and "#62 Part three", which the factory doesn't hold
      When I open its Run detail in the SPA
      Then under "Split into" Run detail lists, in order, "#60 Part one" as "Queued", "#61 Part two" as "Done" and "#62 Part three" as "Not in the factory"

    @ac-1
    Scenario: Run detail shows a CI failure being fixed, with each check's address and failing tests
      Given item "#46 Add search" is fixing CI on commit "abc1234def", where the check "ci" at "https://github.com/acme/shop/actions/runs/9" failed the test "logs in"
      When I open its Run detail in the SPA
      Then Run detail says "Fixing CI: Green is fixing the CI failure on commit abc1234. The checks that failed:"
      And it lists "ci", linking to "https://github.com/acme/shop/actions/runs/9", with the failing test "logs in"

    @ac-1
    Scenario: A failed check that named no failing test says so
      Given item "#46 Add search" is fixing CI on commit "abc1234def", where the check "ci" failed and named no failing test
      When I open its Run detail in the SPA
      Then Run detail lists "ci" with "named no failing test"

    @ac-1
    Scenario: A CI failure with no check the factory could read says so
      Given item "#46 Add search" is fixing CI on commit "abc1234def", where CI named no check the factory could read
      When I open its Run detail in the SPA
      Then Run detail says "Fixing CI: Green is fixing the CI failure on commit abc1234. The checks that failed:"
      And Run detail says "CI named no failed check the factory could read."

  Rule: Run detail shows the run's stages, time, policies, readiness checks and scenario verdicts

    @ac-1
    Scenario: Run detail's Stages table shows each attempt
      Given transcripts can be served
      And item "#46 Add search" has a finished "red" attempt 1 on model "opus" that took 4 minutes, used 12,000 tokens in and 800 out, cost $0.5678 and left a transcript
      And the PR reviewer needed a second ask in round 2 of that attempt because "the diff was cut off"
      When I open its Run detail in the SPA
      Then the "Stages" table has the columns "Stage", "Attempt", "Status", "Model", "Started", "Time spent", "Tokens", "Cost", "Transcript" and "Notes"
      And its row shows "red", "1", "opus", "4m 0s", "12.0k in, 800 out" and "$0.57"
      And its tokens have the title "12000 in, 800 out" and its cost has the title "$0.5678"
      And its Transcript is a link "transcript" to the stored transcript
      And its Notes say "Needed a second ask of the PR reviewer in round 2: the diff was cut off"

    @ac-1
    Scenario: An attempt's notes start with what its cell or the factory said about it
      Given item "#46 Add search" has a "green" attempt whose message is "The cell's lease ran out"
      And the PR reviewer needed a second ask in round 1 of that attempt because "no verdict"
      When I open its Run detail in the SPA
      Then that attempt's Notes say, in order, "The cell's lease ran out" and "Needed a second ask of the PR reviewer in round 1: no verdict"

    @ac-1
    Scenario: When transcripts can't be served, each shows as plain text
      Given transcripts can't be served
      And item "#46 Add search" has an attempt whose transcript is stored as "transcripts/46-red-1.jsonl"
      When I open its Run detail in the SPA
      Then that attempt's Transcript shows "transcripts/46-red-1.jsonl" as plain text, not a link

    @ac-1
    Scenario Outline: An attempt with no end says whether it's running or stopped
      Given item "#46 Add search" is <state> and its newest attempt at "green" started 5 minutes ago with no end
      When I open its Run detail in the SPA
      Then that attempt's Status is "<status>" and its Time spent is "<spent>"

      Examples:
        | state                     | status  | spent         |
        | InProgress on an open run | running | 5m 0s so far  |
        | NeedsInput                | stopped | didn't finish |

    @ac-1
    Scenario: Run detail shows times in the viewer's own time zone
      Given the viewer's time zone is "Europe/Paris"
      And item "#46 Add search" has an attempt that started at 2026-11-20 09:00 UTC
      When I open its Run detail in the SPA
      Then that attempt's Started shows "2026-11-20 10:00"
      And Run detail says "Times show in Europe/Paris."

    @ac-1
    Scenario: Run detail shows where the item's time went
      Given item "#46 Add search" took 3 hours in all, 1 hour Queued, 30 minutes waiting at sign-off, 20 minutes on a question, 10 minutes in review, and 1 hour in "green" over 2 attempts
      When I open its Run detail in the SPA
      Then under "Time" Run detail shows "Total" "3h 0m" and "Queued" "1h 0m"
      And under "Waiting on a person" it shows "Sign-off" "0h 30m", "Needs input" "0h 20m", "In review" "0h 10m" and "Waiting on a person" "1h 0m"
      And its "Time in each stage" table shows "green" with "1h 0m" and "2" attempts

    @ac-1
    Scenario: A total the factory can't work out yet says so
      Given item "#46 Add search" has no creation time, so its total time isn't known
      When I open its Run detail in the SPA
      Then under "Time" Run detail shows "Total" "not known yet"

    @ac-1
    Scenario: Run detail shows the policy results
      Given item "#46 Add search" failed the "dod" criterion "CI passes" from "main" because "lint failed"
      When I open its Run detail in the SPA
      Then the "Policy results" table has the columns "File", "Criterion", "Result" and "Reason"
      And it shows "dod.md main", "CI passes", "failed" and "lint failed"

    @ac-1
    Scenario: Run detail shows each readiness check with its model, tokens and cost
      Given item "#46 Add search" had a readiness judge call on "haiku" that used 1,500 tokens in and 200 out and cost $0.0012
      When I open its Run detail in the SPA
      Then the "Readiness checks" table has the columns "Ran", "Call", "Model", "Tokens", "Cost" and "Verdict"
      And its row shows "Judge", "haiku", "1.5k in, 200 out" and "$0.0012"

    @ac-1
    Scenario Outline: Each readiness check shows what its call decided, or why it has no verdict
      Given item "#46 Add search" had a readiness <call>
      When I open its Run detail in the SPA
      Then the "Readiness checks" table shows a "<kind>" call whose Verdict is "<verdict>"

      Examples:
        | call                                                                                               | kind           | verdict                                                     |
        | judge call that passed it                                                                          | Judge          | Passed                                                      |
        | judge call with no verdict recorded                                                                | Judge          | No verdict was recorded                                     |
        | judge call whose output was unreadable                                                             | Judge          | No verdict: the judge's output was unreadable               |
        | judge call that failed with no verdict                                                             | Judge          | The call failed with no verdict                             |
        | judge call on the proposed child "Part one" that passed it                                         | Judge          | On the proposed child “Part one”: Passed                    |
        | split proposal                                                                                     | Split proposal |                                                             |

    @ac-1
    Scenario: A failed readiness check lists each failed line with its reason, and each flag
      Given item "#46 Add search" had a readiness judge call that failed it on "Has acceptance criteria" because "none listed", flagging "vague title"
      When I open its Run detail in the SPA
      Then the "Readiness checks" table shows a "Judge" call whose Verdict is "Failed"
      And under it the Verdict lists, in order, "Has acceptance criteria: none listed" and "Flag: vague title"

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
      And the factory, asked for the item after the decision, reports it with no open question
      And I open its Run detail in the SPA
      When I submit the "Sign off" form with "<button>" and the note "<note>"
      Then the SPA sends the factory the decision "<decision>" on "#41 Add search" with the note "<note>"
      And the SPA reads the item from the factory again after the decision is accepted
      And Run detail no longer shows the "Sign off" form

      Examples:
        | button                | decision | note                   |
        | Approve the scenarios | approve  | Looks right            |
        | Ask for changes       | changes  | Cover the empty search |

    @ac-1
    Scenario: The owner can approve without a note
      Given I am the product owner and item "#41 Add search" waits for sign-off
      And I open its Run detail in the SPA
      When I submit the "Sign off" form with "Approve the scenarios" and "Note for the factory" left empty
      Then the SPA sends the factory the decision "approve" on "#41 Add search" with an empty note

    @ac-1
    Scenario: A decision the factory ignores says the item isn't waiting for it
      Given I am the product owner with the sign-off form for "#41 Add search" open in the SPA
      And the factory answers the decision that the item isn't waiting for it
      When I submit the "Sign off" form with "Approve the scenarios"
      Then Run detail shows "That item isn't waiting for this decision."

    @ac-1
    Scenario: A decision the factory forbids shows its refusal
      Given I am a user who isn't the product owner, with the sign-off form for "#41 Add search" open in the SPA
      And the factory answers the decision with 403, as it does for someone who can't make it
      When I submit the "Sign off" form with "Approve the scenarios"
      Then Run detail shows "You can't make that decision."
      And the SPA doesn't show the no-access page

  Rule: A question waiting on a person shows its text and takes an answer

    @ac-1
    Scenario: Run detail shows the question and sends the answer
      Given item "#48 Pick a colour" waits on the question "Should the button be blue or green?"
      And the factory, asked for the item after the answer, reports it with no open question
      When I open its Run detail in the SPA
      Then under "Answer" Run detail shows "Should the button be blue or green?"
      When I submit the "Answer" form with "Send the answer" and the answer "Blue"
      Then the SPA sends the factory the decision "answer" on "#48 Pick a colour" with the text "Blue"
      And the SPA reads the item from the factory again after the answer is accepted
      And Run detail no longer shows the "Answer" form

    @ac-1
    Scenario: An empty answer can't be sent
      Given item "#48 Pick a colour" waits on the question "Should the button be blue or green?"
      And I open its Run detail in the SPA
      When I submit the "Answer" form with "Send the answer" and "Your answer" left empty
      Then "Your answer" is required, and the submit handler refuses an empty answer
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
      Given I am an operator with Floor open in the SPA, and the factory is under no override
      And the factory, asked for the floor after the override, reports a "<kind>" override with the reason "<reason>" and <running> cells still running
      When I submit the "Controls" form with "<button>" and the reason "<reason>"
      Then the SPA sends the factory a factory-wide "<kind>" override with the reason "<reason>"
      And the SPA reads the floor from the factory again after the override is accepted
      And Floor shows the banner "<banner>"

      Examples:
        | button          | kind    | reason         | running | banner                                                                                         |
        | Pause           | pause   | lunch          | 0       | Paused: lunch                                                                                  |
        | Drain           | drain   | deploy at noon | 2       | Draining: 2 cells still running. Reason: deploy at noon.                                       |
        | Kill switch     | kill    | runaway spend  | 0       | Killed: runaway spend                                                                          |
        | Prepare restart | restart | new cell image | 1       | Preparing to restart: 1 cell still running. The factory won't stop it. Reason: new cell image. |

    @ac-1
    Scenario: An operator resumes the factory from Floor
      Given I am an operator with Floor open in the SPA, and the factory is under a "pause" override with the reason "lunch"
      And the factory, asked for the floor after the override, reports no override
      When I submit the "Controls" form with "Resume" and the reason "back from lunch"
      Then the SPA sends the factory a factory-wide "resume" override with the reason "back from lunch"
      And the SPA reads the floor from the factory again after the override is accepted
      And Floor shows no banner "Paused: lunch"

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
        | situation                                 | buttons                                        |
        | InProgress, not held, with a running cell | "Hold" and "Stop the run"                      |
        | held and Failed                           | "Release the hold" and "Re-queue"              |
        | Failed                                    | "Hold" and "Re-queue"                          |
        | Queued                                    | "Hold", "Start now", "Move up" and "Move down" |
        | Eligible                                  | "Hold" and "Start now"                         |

    @ac-1
    Scenario Outline: An operator sends an item override from Run detail
      Given I am an operator
      And item "#46 Add search" is <situation>
      And the factory, asked for the item after the override, reports it <after>
      And I open its Run detail in the SPA
      When I submit the "Controls" form with "<button>" and the reason "<reason>"
      Then the SPA sends the factory a "<kind>" override on "#46 Add search" with the reason "<reason>"
      And the SPA reads the item from the factory again after the override is accepted
      And Run detail shows <shown>

      Examples:
        | situation                                 | button           | kind      | reason             | after                                                       | shown                                                                                    |
        | InProgress, not held, with a running cell | Hold             | hold      | waiting on legal   | held, InProgress with a running cell                        | the buttons "Release the hold" and "Stop the run" under "Controls"                       |
        | held and Failed                           | Release the hold | unhold    | legal said yes     | not held, and Failed                                        | the buttons "Hold" and "Re-queue" under "Controls"                                       |
        | InProgress, not held, with a running cell | Stop the run     | stop_run  | wrong approach     | held and Failed                                             | the state "Failed" and the buttons "Release the hold" and "Re-queue" under "Controls"    |
        | Queued                                    | Start now        | start_now | customer waiting   | Queued and marked Start now with that reason, by "octo"     | "Marked Start now: customer waiting, by octo."                                           |
        | Queued                                    | Move up          | move_up   | blocks the release | Queued at priority 1                                        | "Priority 1."                                                                            |
        | Queued                                    | Move down        | move_down | can wait a week    | Queued at priority 4                                        | "Priority 4."                                                                            |

    @ac-1
    Scenario: Re-queueing a Failed item sends the reason the operator gave
      Given I am an operator
      And item "#52 Broke main" is Failed
      And the factory, asked for the item after the override, reports it Queued
      And I open its Run detail in the SPA
      When I submit the "Controls" form with "Re-queue" and the reason "main is fixed now"
      Then the SPA sends the factory a "requeue" override on "#52 Broke main" with the reason "main is fixed now"
      And the SPA reads the item from the factory again after the override is accepted
      And Run detail shows the state "Queued" and no "Re-queue" button

    @ac-1
    Scenario: A re-queue the factory refuses shows why
      Given I am an operator with the Run detail of Failed item "#52 Broke main" open in the SPA
      And the factory answers the re-queue that only a Failed or Abandoned item can be re-queued, since someone else re-queued it first
      When I submit the "Controls" form with "Re-queue" and the reason "main is fixed now"
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
    Scenario: A merged PR whose run was never classified says so
      Given the factory has merged "#41 Add search" for $3.00 with no shadow tier
      When I open the Phase 0 report in the SPA
      Then its row for "#41 Add search" shows the Shadow tier "not classified"

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
        | at (UTC)         | issue | title      | kind       | from   | to         | event   |
        | 2026-11-20 10:05 | #41   | Add search | transition | Queued | InProgress | claimed |
        | 2026-11-20 10:00 | #42   | Fix login  | override   | Failed | Queued     |         |
        | 2026-11-20 09:55 | #43   | Export CSV | sop_moved  | v11    | v12        |         |
        | 2026-11-20 09:50 | #44   | Tidy       | decision   | x      | y          | z       |
      When I open Activity in the SPA
      Then Activity shows "The 100 newest events, newest first."
      And its table has the columns "Time (UTC)", "Item", "Title", "Kind" and "Move"
      And its rows, in order, show "2026-11-20 10:05", "2026-11-20 10:00", "2026-11-20 09:55" and "2026-11-20 09:50"
      And the transition's Move shows "Queued → InProgress (claimed)"
      And the override's Move shows "Failed → Queued"
      And the SOP move's Move shows "v11 → v12"
      And the decision's Move is empty

    @ac-1
    Scenario: Activity's Item links to the issue on GitHub when its repo is known
      Given the factory's newest events are one on "#41 Add search" in "acme/shop" and one on "#42 Fix login" with no repo known
      When I open Activity in the SPA
      Then the first event's Item "#41" links to issue 41 of "acme/shop" on GitHub
      And the second event's Item shows "#42" as plain text, not a link

    @ac-1
    Scenario: An event with no item leaves its Item empty
      Given the factory's newest event is a "setting" change with no item
      When I open Activity in the SPA
      Then that event's Item is empty

    @ac-1
    Scenario: Activity shows who changed a setting, from what to what, and why
      Given the factory's newest event is "octo" changing "WIP limit" from not set to "4" because "more cells free"
      When I open Activity in the SPA
      Then its Move shows "octo changed WIP limit from not set to 4 because more cells free"

    @ac-1
    Scenario: Activity's times stay in UTC whatever the viewer's time zone
      Given the viewer's time zone is "Asia/Tokyo"
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
      When I submit the "Controls" form with "<button>" and "Reason" <left>
      Then "Reason" is required, and the submit handler refuses an empty reason
      And the SPA sends no override

      Examples:
        | left                | button          |
        | left empty          | Pause           |
        | left empty          | Drain           |
        | left empty          | Resume          |
        | left empty          | Kill switch     |
        | left empty          | Prepare restart |
        | holding spaces only | Pause           |

    @ac-2
    Scenario Outline: Run detail won't send an item override without a reason
      Given I am an operator
      And item "#46 Add search" is <situation>
      And I open its Run detail in the SPA
      When I submit the "Controls" form with "<button>" and "Reason" <left>
      Then "Reason" is required, and the submit handler refuses an empty reason
      And the SPA sends no override

      Examples:
        | situation                                 | left                | button           |
        | InProgress, not held, with a running cell | left empty          | Hold             |
        | held and Failed                           | left empty          | Release the hold |
        | InProgress, not held, with a running cell | left empty          | Stop the run     |
        | Failed                                    | left empty          | Re-queue         |
        | Queued                                    | left empty          | Start now        |
        | Queued                                    | left empty          | Move up          |
        | Queued                                    | left empty          | Move down        |
        | Failed                                    | holding spaces only | Re-queue         |

    @ac-2
    Scenario: Once a reason is typed, the override that was held back is sent
      Given I am an operator with Floor open in the SPA
      And I submitted the "Controls" form with "Pause" and "Reason" left empty, and no override was sent
      When I submit the "Controls" form with "Pause" and the reason "lunch"
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
      And Floor has buttons with the text "Pause", "Drain", "Resume", "Kill switch" and "Prepare restart"
      And every input and textarea on Floor has a label whose for matches its id, and every button has text

    @ac-3
    Scenario Outline: Every control on Run detail's forms has a label
      Given I am <who>
      And item "#46 Add search" <situation>
      When I open its Run detail in the SPA
      Then Run detail has a <field> labelled "<label>"
      And every input and textarea on Run detail has a label whose for matches its id, and every button has text

      Examples:
        | who               | situation                              | field      | label                |
        | an operator       | is Queued                              | text field | Reason               |
        | an operator       | is held and Failed                     | text field | Reason               |
        | an operator       | is Failed                              | text field | Reason               |
        | the product owner | waits for sign-off                     | text area  | Note for the factory |
        | a user            | waits on the question "Blue or green?" | text area  | Your answer          |

    @ac-3
    Scenario: Each label names its own control
      Given I am an operator and the product owner
      And item "#41 Add search" waits for sign-off
      When I open its Run detail in the SPA
      Then the label "Note for the factory" is for the sign-off note's id
      And the label "Reason" is for the override reason's id
      And the two ids differ
