@pbi-154
Feature: A model request whose upstream hangs says so in the log
  A cell's model requests go through the model gateway to the upstream model service. When the upstream
  hangs before it answers, the cell waits and the log stays silent, so nobody can tell a stuck model call
  from a slow agent. The gateway now speaks up: a model request whose upstream hasn't sent its response
  headers 60 seconds after the gateway forwarded it logs one "slow:" line naming the request's path and
  its run id, the same run id the cell API's own "slow:" lines name. A request that is answered, fails
  or is dropped by its cell before then stays quiet.

  Rule: A model request with no upstream answer 60 seconds after it was forwarded logs one slow line naming its path and run id

    @ac-1
    Scenario: A hung model request logs its path and run id after 60 seconds
      Given item "154" has a run in progress
      And the upstream never answers
      When item "154"'s cell sends a model request to "/v1/messages"
      And 60 seconds pass after the gateway forwards it
      Then the log has exactly 1 "slow:" line from the model gateway
      And that line names the path "/v1/messages"
      And that line names item "154"'s run id

    @ac-1
    Scenario: The slow line names the same run id as the cell API's own slow line
      Given item "154" has a run in progress
      And the upstream never answers
      And the database stalls item "154"'s request to report a stage
      When item "154"'s cell sends a model request to "/v1/messages"
      And 60 seconds pass
      Then the log has a "slow:" line from the cell API naming a run id
      And the log has a "slow:" line from the model gateway naming a run id
      And both lines name item "154"'s run id

    @ac-1
    Scenario: A hung model request logs only once, however long it hangs
      Given item "154" has a run in progress
      And the upstream never answers
      When item "154"'s cell sends a model request to "/v1/messages"
      And 5 minutes pass after the gateway forwards it
      Then the log has exactly 1 "slow:" line from the model gateway

    @ac-1
    Scenario: A request whose headers finally arrive after 60 seconds still logged its slow line
      Given item "154" has a run in progress
      And the upstream sends its response headers 90 seconds after it gets a request
      When item "154"'s cell sends a model request to "/v1/messages"
      And 120 seconds pass after the gateway forwards it
      Then the log has exactly 1 "slow:" line from the model gateway
      And that line names item "154"'s run id

    @ac-1
    Scenario: Each hung model request logs its own path and run id
      Given items "154" and "155" each have a run in progress
      And the upstream never answers
      When item "154"'s cell sends a model request to "/v1/messages"
      And item "155"'s cell sends a model request to "/v1/messages/count_tokens"
      And 60 seconds pass after the gateway forwards them
      Then the log has a "slow:" line from the model gateway naming the path "/v1/messages" and item "154"'s run id
      And the log has a "slow:" line from the model gateway naming the path "/v1/messages/count_tokens" and item "155"'s run id

  Rule: A model request whose upstream sends its headers within 60 seconds logs no slow line, however long it streams

    @ac-2
    Scenario: A long stream that started within 60 seconds logs nothing, while a hung request alongside it does
      Given items "154" and "155" each have a run in progress
      And the upstream answers item "154"'s model requests with headers after 10 seconds and keeps streaming for 3 minutes
      And the upstream never answers item "155"'s model requests
      When item "154"'s cell sends a model request to "/v1/messages"
      And item "155"'s cell sends a model request to "/v1/messages"
      And 3 minutes pass after the gateway forwards them
      Then the log has exactly 1 "slow:" line from the model gateway
      And that line names item "155"'s run id

    @ac-2
    Scenario: Headers that arrive just before 60 seconds count as an answer
      Given items "154" and "155" each have a run in progress
      And the upstream answers item "154"'s model requests with headers after 59 seconds and keeps streaming for 2 minutes
      And the upstream never answers item "155"'s model requests
      When item "154"'s cell sends a model request to "/v1/messages"
      And item "155"'s cell sends a model request to "/v1/messages"
      And 2 minutes pass after the gateway forwards them
      Then the log has exactly 1 "slow:" line from the model gateway
      And that line names item "155"'s run id

  Rule: A model request that ends in an upstream error or a cell disconnect before 60 seconds logs no slow line later

    @ac-3
    Scenario: An upstream call that errors before 60 seconds logs nothing, while a hung request alongside it does
      Given items "154" and "155" each have a run in progress
      And the upstream drops item "154"'s model requests after 20 seconds without answering
      And the upstream never answers item "155"'s model requests
      When item "154"'s cell sends a model request to "/v1/messages"
      And item "155"'s cell sends a model request to "/v1/messages"
      And 2 minutes pass after the gateway forwards them
      Then item "154"'s cell got a failed response
      And the log has exactly 1 "slow:" line from the model gateway
      And that line names item "155"'s run id

    @ac-3
    Scenario: A cell that disconnects before 60 seconds leaves no slow line, while a hung request alongside it does
      Given items "154" and "155" each have a run in progress
      And the upstream never answers
      When item "154"'s cell sends a model request to "/v1/messages"
      And item "155"'s cell sends a model request to "/v1/messages"
      And item "154"'s cell disconnects 20 seconds later
      And 2 minutes pass after the gateway forwards them
      Then the log has exactly 1 "slow:" line from the model gateway
      And that line names item "155"'s run id
