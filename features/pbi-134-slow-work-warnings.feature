@pbi-134 @db
Feature: Slow ticks, polls and cell API requests say so in the log
  A database transaction that never ends can freeze the factory: the scheduler stops starting cells,
  the board stops moving and cells wait on the cell API, while the log stays silent. Long-running work
  now speaks up. A scheduler tick or a board poll that has run for 5 minutes logs how long it has run
  and the step it is in, and logs again every 5 minutes until it ends. A cell API request still open
  after 60 seconds logs its route and its run id. Scenarios tagged @db need Postgres, which each test
  run starts for itself.

  Rule: A scheduler tick that runs for 5 minutes logs how long it has run and the step it is in

    @ac-1
    Scenario: A tick stuck for 5 minutes logs its running time and its step
      Given the scheduler tick gets stuck while expiring leases
      When 5 minutes pass
      Then the log says the scheduler tick has run for 5 minutes
      And that log line names the step "expiring leases"

    @ac-1
    Scenario: A tick that ends before 5 minutes logs no warning, and one that runs past 5 minutes does
      Given the scheduler tick gets stuck while expiring leases
      And 4 minutes pass
      When the stuck step finishes and the tick ends
      And a second scheduler tick gets stuck while chasing questions
      And 5 minutes pass
      Then the log has exactly 1 slow-tick warning
      And that warning names the step "chasing questions"

    @ac-1
    Scenario: A tick still stuck logs again every 5 minutes
      Given the scheduler tick gets stuck while polling merged CI
      When 15 minutes pass
      Then the log has 3 slow-tick warnings
      And they say the tick has run for 5, 10 and 15 minutes
      And each names the step "polling merged CI"

    @ac-1
    Scenario: A later warning names the step the tick has moved on to
      Given the scheduler tick gets stuck while expiring leases
      And 6 minutes pass
      When the tick moves on and gets stuck while starting the next item
      And 4 more minutes pass
      Then the first slow-tick warning names the step "expiring leases"
      And the second slow-tick warning, at 10 minutes, names the step "starting the next item"

    @ac-1
    Scenario: The warnings stop once the tick ends
      Given the scheduler tick gets stuck while expiring leases
      And 7 minutes pass
      When the stuck step finishes and the tick ends
      And 10 more minutes pass
      Then the log has exactly 1 slow-tick warning

    @ac-1
    Scenario: The warnings stop when the tick ends in a failure
      Given the scheduler tick gets stuck while expiring leases
      And 7 minutes pass
      When the stuck step fails and the tick ends with an error
      And 10 more minutes pass
      Then the log has exactly 1 slow-tick warning
      And the tick's failure is logged

  Rule: A board poll that runs for 5 minutes logs the same way

    @ac-2
    Scenario: A poll stuck for 5 minutes logs its running time, its board and its step
      Given the poll of board "main" gets stuck while listing new and changed items
      When 5 minutes pass
      Then the log says the poll of board "main" has run for 5 minutes
      And that log line names the step "listing new and changed items"

    @ac-2
    Scenario: A poll that ends before 5 minutes logs no warning, and one that runs past 5 minutes does
      Given the poll of board "main" gets stuck while listing new and changed items
      And 4 minutes pass
      When the stuck step finishes and the poll ends
      And a second poll of board "main" gets stuck while reading the PRs of items in review
      And 5 minutes pass
      Then the log has exactly 1 slow-poll warning
      And that warning names the step "reading the PRs of items in review"

    @ac-2
    Scenario: A poll still stuck logs again every 5 minutes, naming the step it is in each time
      Given the poll of board "main" gets stuck while listing new and changed items
      And 6 minutes pass
      When the poll moves on and gets stuck while reading the PRs of items in review
      And 9 more minutes pass
      Then the log has 3 slow-poll warnings
      And they say the poll has run for 5, 10 and 15 minutes
      And the first names the step "listing new and changed items"
      And the second and third name the step "reading the PRs of items in review"

    @ac-2
    Scenario: The warnings stop once the poll ends
      Given the poll of board "main" gets stuck while listing new and changed items
      And 7 minutes pass
      When the stuck step finishes and the poll ends
      And 10 more minutes pass
      Then the log has exactly 1 slow-poll warning

    @ac-2
    Scenario: A slow poll of one board is told apart from the other boards
      Given two boards, "main" and "side"
      And the poll of board "side" gets stuck while listing new and changed items
      And the poll of board "main" ends quickly
      When 5 minutes pass
      Then the log has exactly 1 slow-poll warning
      And that warning names board "side"

  Rule: A cell API request still open after 60 seconds logs its route and run id

    @ac-3
    Scenario: A request open for 60 seconds logs its route and run id
      Given item "134" has a run in progress
      And the database stalls the cell's request to report a stage
      When 60 seconds pass
      Then the log says a cell API request has been open for 60 seconds
      And that log line names the route "POST /stage"
      And that log line names item "134"'s run id

    @ac-3
    Scenario: A request answered within 60 seconds logs no warning, and one still open after 60 seconds does
      Given item "134" has a run in progress
      And the cell's request to fetch its context is answered after 30 seconds
      When the database stalls the cell's request to report a stage
      And 60 seconds pass
      Then the log has exactly 1 slow-request warning
      And that warning names the route "POST /stage"

    @ac-3
    Scenario: Each stuck request logs its own route and run id
      Given items "134" and "135" each have a run in progress
      And the database stalls item "134"'s request to report a stage
      And the database stalls item "135"'s request to fetch its context
      When 60 seconds pass
      Then the log has a slow-request warning naming the route "POST /stage" and item "134"'s run id
      And the log has a slow-request warning naming the route "GET /context" and item "135"'s run id
