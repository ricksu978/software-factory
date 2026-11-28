@pbi-280
Feature: Live Floor: the event stream with reconnect, a stale scheduler heartbeat, and the count of outbox rows set aside
  Step 8c of the control plane redesign (2026-11-07 design, §05, §07 and §12 step 8) makes the SPA's Floor live, as
  today's Floor on 7400 is. Step 8b moved Floor into the SPA, but Floor there still reads the factory only once.
  Now Floor listens to the factory's events on /bff/v1/events, which the BFF forwards to the API's /v1/events. When
  an event arrives, Floor reads the floor again and shows what changed, and the page doesn't reload. A burst of
  events refreshes Floor once. The API ends each stream after five minutes, and a stream can also drop, so Floor
  opens a new stream when one ends. Once a new stream is open, Floor reads the floor again, so it doesn't miss a
  change made while no stream was open. Today's Floor holds back while an operator fills in its form, and the SPA's
  Floor does the same: while someone is typing an override's reason, Floor doesn't refresh, so the reason isn't
  lost. Floor catches up once they're done.
  The BFF gives every call it forwards 30 seconds to finish. An event stream lasts five minutes, so the BFF passes
  the stream through for as long as the API keeps it open.
  The worker records a heartbeat on every scheduler tick, and the API already returns it with the floor (PBI 158,
  PBI 284). When the heartbeat is more than a minute old, Floor shows a banner that begins "Scheduler not ticking"
  and says when the worker last ticked, so a stopped worker doesn't look like a quiet factory. A worker that is
  ticking writes no event, so Floor also reads the floor again from time to time, even when no event arrives.
  After a row's tenth failed attempt, the worker sets it aside in the outbox (PBI 221). The floor from the API now
  counts the outbox rows set aside, and Floor shows that count next to the heartbeat.
  Scenarios that open Floor run as step 8b's do. No real BFF and no real sign-in are involved. A stub says who the
  viewer is and their roles. The SPA's API client and its event stream call a stub that answers from fixture data,
  records what the SPA asks for, and sends events when a scenario says the factory sends them. The SPA's clock and
  timers are fake, so "time passes" moves them on without waiting. Scenarios tagged @db need Postgres, which each
  test starts for itself, so cells and CI both run them. They run the API against a fake issuer, as PBI 286's do.

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: live updates from /bff/v1/events
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Floor follows the factory's events and refreshes without reloading the page

    @ac-1
    Scenario: Opening Floor opens the factory's event stream
      Given I am a viewer
      When I open Floor in the SPA
      Then the SPA opens the event stream at "/bff/v1/events"

    @ac-1
    Scenario: An event refreshes Floor with what changed, and the page doesn't reload
      Given I am a viewer with Floor open in the SPA, showing "#43 Export CSV" under "Production Line"
      And the factory, asked for the floor again, reports "#43 Export CSV" In progress at stage "red"
      When the factory sends an event on the stream
      And a second passes
      Then the SPA reads the floor from the factory again
      And the "Production Line" table has a row for "#43 Export CSV" showing "InProgress" and "red"
      And Floor shows "#43 Export CSV" in one row under "Production Line"
      And the browser didn't reload the page

    @ac-1
    Scenario: A burst of events refreshes Floor once
      Given I am a viewer with Floor open in the SPA
      When the factory sends 5 events on the stream within half a second
      And a second passes after the last of them
      Then the SPA has read the floor from the factory once more, not 5 times

    @ac-1
    Scenario: Floor stops following the events when I leave it
      Given I am a viewer with Floor open in the SPA
      When I go from Floor to Activity
      Then the SPA closes Floor's event stream
      And an event the factory sends afterwards doesn't make the SPA read the floor

  Rule: Floor opens a new stream when one ends, and catches up on what it missed

    @ac-1
    Scenario: When the factory ends a stream after five minutes, Floor opens a new one and keeps updating
      Given I am a viewer with Floor open in the SPA
      And the factory, asked for the floor again, reports "#43 Export CSV" under "Production Line"
      When the factory ends the event stream, as it does after five minutes
      Then the SPA opens the event stream at "/bff/v1/events" again within 10 seconds
      And once the new stream is open, the SPA reads the floor from the factory again
      And Floor shows "#43 Export CSV" under "Production Line"

    @ac-1
    Scenario: An event on the new stream refreshes Floor
      Given I am a viewer with Floor open in the SPA
      And the factory, asked for the floor again, reports a "pause" override with the reason "lunch"
      When the factory ends the event stream, as it does after five minutes
      And 10 seconds pass
      And the factory sends an event on whichever stream the SPA has open
      And a second passes
      Then Floor shows the banner "Paused: lunch"

    @ac-1
    Scenario: A stream that drops is opened again
      Given I am a viewer with Floor open in the SPA
      When the event stream drops without the factory ending it, as when the BFF restarts
      Then the SPA opens the event stream at "/bff/v1/events" again within 10 seconds

    @ac-1
    Scenario: While the BFF can't open a stream, Floor keeps trying without hammering it
      Given I am a viewer with Floor open in the SPA
      And the BFF answers 502 to the next 3 attempts to open the event stream
      When the event stream drops
      And a minute passes
      Then the SPA has tried to open the event stream at least 4 times
      And it waited at least a second between one attempt and the next
      And once a stream opens, the SPA reads the floor from the factory again

    @ac-1
    Scenario: A session that ended goes to sign-in instead of reopening the stream for ever
      Given I am a viewer with Floor open in the SPA
      And the BFF now answers 401 to the SPA's calls, the event stream included
      When the event stream drops
      Then the SPA sends the browser to "/auth/login"

  Rule: Floor doesn't refresh while someone is typing an override's reason

    @ac-1
    Scenario: An event while an operator types a reason doesn't refresh Floor or lose the reason
      Given I am an operator with Floor open in the SPA
      And I have typed "deploy at" in the "Reason" field under "Controls", and the field still has focus
      When the factory sends an event on the stream
      And a minute passes
      Then the SPA still has the event stream at "/bff/v1/events" open
      And the SPA hasn't read the floor from the factory again
      And the "Reason" field still holds "deploy at"
      And the browser didn't reload the page

    @ac-1
    Scenario: A reason typed and left in its field still holds Floor back
      Given I am an operator with Floor open in the SPA
      And I have typed "deploy at" in the "Reason" field under "Controls", then moved focus off the field
      When the factory sends an event on the stream
      And a minute passes
      Then the SPA still has the event stream at "/bff/v1/events" open
      And the SPA hasn't read the floor from the factory again
      And the "Reason" field still holds "deploy at"

    @ac-1
    Scenario: An empty Reason field with focus still holds Floor back
      Given I am an operator with Floor open in the SPA
      And the "Reason" field under "Controls" has focus and holds nothing
      When the factory sends an event on the stream
      And a minute passes
      Then the SPA still has the event stream at "/bff/v1/events" open
      And the SPA hasn't read the floor from the factory again

    @ac-1
    Scenario: Once the operator clears the reason and leaves the field, Floor catches up on the events it held back
      Given I am an operator with Floor open in the SPA
      And I have typed "deploy at" in the "Reason" field under "Controls", and the field still has focus
      And the factory, asked for the floor again, reports a "pause" override with the reason "lunch"
      And the factory sent an event on the stream while I was typing
      When I clear the "Reason" field and move focus off it
      And 2 seconds pass
      Then the SPA reads the floor from the factory again
      And Floor shows the banner "Paused: lunch"

  Rule: The BFF passes the event stream through for as long as the API keeps it open

    @ac-1
    Scenario: An event the API sends minutes into a stream reaches the browser through the BFF
      Given the BFF forwards to a stub API whose event stream stays open until the stub ends it
      And a browser with a session has opened "/bff/v1/events" on the BFF
      When the stub API sends an event 45 seconds after the stream opened, past the BFF's 30 seconds for a call
      Then the browser receives that event on the stream as soon as the API sends it
      And the browser's stream is still open
      And when the stub API ends the stream, the browser's stream ends too

  # ---------------------------------------------------------------------------------------------------------------
  # AC-2: the scheduler heartbeat and the outbox rows set aside
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Floor says "scheduler not ticking" when the worker's heartbeat is more than a minute old

    @ac-2
    Scenario Outline: A heartbeat more than a minute old shows the banner
      Given the worker last ticked <old> before the SPA's clock
      When I open Floor in the SPA
      Then Floor shows a banner beginning "Scheduler not ticking"

      Examples:
        | old        |
        | 61 seconds |
        | 3 hours    |

    @ac-2
    Scenario Outline: A heartbeat a minute old or less shows the worker's line with no banner
      Given the worker last ticked <old> before the SPA's clock
      And the factory's floor counts 0 outbox rows set aside
      When I open Floor in the SPA
      Then Floor shows "Outbox rows set aside: 0" next to the worker's heartbeat
      And Floor shows no banner beginning "Scheduler not ticking"

      Examples:
        | old        |
        | 20 seconds |
        | 60 seconds |

    @ac-2
    Scenario Outline: The banner says when the worker last ticked
      Given the worker last ticked <old> before the SPA's clock
      When I open Floor in the SPA
      Then Floor shows the banner "<banner>"

      Examples:
        | old        | banner                                                  |
        | 90 seconds | Scheduler not ticking. The worker last ticked 2 min ago. |
        | 3 hours    | Scheduler not ticking. The worker last ticked 3 h ago.   |
        | 3 days     | Scheduler not ticking. The worker last ticked 3 days ago. |

    @ac-2
    Scenario: A worker that has never ticked shows the banner
      Given the factory holds no heartbeat for the worker
      When I open Floor in the SPA
      Then Floor shows the banner "Scheduler not ticking. The worker hasn't ticked yet."

    @ac-2
    Scenario: Floor kept open shows the banner once the worker stops, even with no event
      Given I am a viewer with Floor open in the SPA, and the worker last ticked 5 seconds ago
      And from now on the worker doesn't tick, and the factory sends no event
      When 2 minutes pass
      Then Floor shows a banner beginning "Scheduler not ticking"

    @ac-2
    Scenario: Floor kept open while the worker keeps ticking never shows the banner, even with no event
      Given I am a viewer with Floor open in the SPA, and the worker last ticked 5 seconds ago
      And from now on the worker ticks every 5 seconds, and the factory sends no event
      When 10 minutes pass
      Then the SPA has read the floor from the factory again during those 10 minutes, though no event arrived
      And Floor has at no point shown a banner beginning "Scheduler not ticking"

    @ac-2
    Scenario: The banner goes once the worker ticks again
      Given the worker last ticked 3 hours before the SPA's clock
      And I am a viewer with Floor open in the SPA
      And from now on the worker ticks every 5 seconds, and the factory sends no event
      When 2 minutes pass
      Then Floor showed a banner beginning "Scheduler not ticking" when I opened it
      And Floor now shows no banner beginning "Scheduler not ticking"

  Rule: Floor shows how many outbox rows the worker set aside

    @ac-2 @db
    Scenario: The API's floor counts only the outbox rows set aside
      Given a fresh factory database
      And the outbox holds 2 rows the worker set aside after their tenth failed attempt
      And it holds 1 row that has failed 3 times and waits to be tried again
      And it holds 1 row that hasn't been tried yet
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor counts 2 outbox rows set aside

    @ac-2 @db
    Scenario: The API's floor counts no outbox rows set aside when there are none
      Given a fresh factory database
      And the outbox holds 1 row that has failed 3 times and waits to be tried again
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor counts 0 outbox rows set aside

    @ac-2
    Scenario Outline: Floor shows the count of outbox rows set aside, next to the heartbeat
      Given the worker last ticked 10 seconds before the SPA's clock
      And the factory's floor counts <count> outbox rows set aside
      When I open Floor in the SPA
      Then Floor shows "Outbox rows set aside: <count>" next to the worker's heartbeat

      Examples:
        | count |
        | 0     |
        | 1     |
        | 12    |

    @ac-2
    Scenario: The count shows beside the "Scheduler not ticking" banner too
      Given the worker last ticked 3 hours before the SPA's clock
      And the factory's floor counts 2 outbox rows set aside
      When I open Floor in the SPA
      Then Floor shows the banner "Scheduler not ticking. The worker last ticked 3 h ago."
      And Floor shows "Outbox rows set aside: 2"

    @ac-2
    Scenario: The count updates when Floor reads the floor again
      Given I am a viewer with Floor open in the SPA, showing "Outbox rows set aside: 0"
      And the factory, asked for the floor again, counts 1 outbox row set aside
      When the factory sends an event on the stream
      And a second passes
      Then Floor shows "Outbox rows set aside: 1"
