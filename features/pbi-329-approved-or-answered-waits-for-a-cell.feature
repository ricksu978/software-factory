@pbi-329 @db
Feature: Floor and the item page show an approved or answered item as waiting for a cell, not as waiting on a person
  Once the owner approves an item's scenarios, or answers its question, the item stays in SignOff or NeedsInput
  until a cell claims it and resumes the run. Today Floor's "Production Line" shows such an item as "SignOff" or
  "NeedsInput", and its item page (Run detail) reads "SignOff, resumes at red", which reads as if it still waits on
  a person. With this item, both say the item has been approved or answered and waits for a cell, with the stage
  it resumes at, such as "Approved, waiting for a cell, resumes at red".
  An item that still waits on a person reads as it does today. The label is a reading of the item and nothing more:
  its state stays SignOff or NeedsInput in the event log, on the board, in GET /v1/floor and wherever the factory
  picks items by state.
  "The operator opens Floor" means today's Floor on 7400. "Item page" means the item's Run detail page.

  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. The board,
  GitHub, the cells and the clock are fakes. No cell is free to claim work unless a scenario says otherwise, so an
  approved or answered item stays where it is while the scenario reads it.

  Background:
    Given the control plane is running with a fake board
    And an operator "octo" is signed in
    And a product owner "Pat" is signed in

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: an approved SignOff item waits for a cell
  # ---------------------------------------------------------------------------------------------------------------
  Rule: A SignOff item whose scenarios have been approved shows as approved and waiting for a cell, with the stage it resumes at

    @ac-1
    Scenario: Floor shows an approved item as approved and waiting for a cell, resuming at red
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      And "Pat" approves the scenarios of item 41
      When the operator opens Floor
      Then item 41's row in "Production Line" reads "Approved, waiting for a cell, resumes at red"
      And item 41's row in "Production Line" doesn't read "SignOff"

    @ac-1
    Scenario: The item page shows an approved item as approved and waiting for a cell, resuming at red
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      And "Pat" approves the scenarios of item 41
      When the operator opens item 41's item page
      Then item 41's item page gives its state as "Approved, waiting for a cell, resumes at red"
      And item 41's item page doesn't give its state as "SignOff"

    @ac-1
    Scenario: An approved item still shows as waiting for a cell when every cell is busy
      Given every cell is busy with another item
      And item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      And "Pat" approves the scenarios of item 41
      When the operator opens Floor
      Then item 41's row in "Production Line" reads "Approved, waiting for a cell, resumes at red"
      And "Waiting on you" doesn't list item 41

  # ---------------------------------------------------------------------------------------------------------------
  # AC-2: an answered NeedsInput item waits for a cell
  # ---------------------------------------------------------------------------------------------------------------
  Rule: A NeedsInput item whose question has been answered, with no newer open question, shows as answered and waiting for a cell, with the stage it resumes at

    @ac-2
    Scenario: Floor shows an answered item as answered and waiting for a cell, resuming where the question was asked
      Given item 42 "Export CSV" is in NeedsInput, waiting on the question "Should the export include archived rows?" asked at stage "green"
      And "octo" answers item 42's question with "Yes, include them"
      When the operator opens Floor
      Then item 42's row in "Production Line" reads "Answered, waiting for a cell, resumes at green"
      And item 42's row in "Production Line" doesn't read "NeedsInput"

    @ac-2
    Scenario: The item page shows an answered item as answered and waiting for a cell, resuming where the question was asked
      Given item 42 "Export CSV" is in NeedsInput, waiting on the question "Should the export include archived rows?" asked at stage "green"
      And "octo" answers item 42's question with "Yes, include them"
      When the operator opens item 42's item page
      Then item 42's item page gives its state as "Answered, waiting for a cell, resumes at green"
      And item 42's item page doesn't give its state as "NeedsInput"

    @ac-2
    Scenario Outline: An answered item names the stage it resumes at, whichever stage asked
      Given item 42 "Export CSV" is in NeedsInput, waiting on a question asked at stage "<stage>"
      And "octo" answers item 42's question with "Go ahead"
      When the operator opens Floor
      Then item 42's row in "Production Line" reads "Answered, waiting for a cell, resumes at <stage>"

      Examples:
        | stage   |
        | specify |
        | red     |
        | green   |
        | open-pr |

    @ac-2
    Scenario: An item whose first question is answered and whose newer question is answered too waits for a cell
      Given item 42 "Export CSV" is in NeedsInput with a question asked at stage "green" and answered
      And the factory asked item 42 a newer question at stage "green"
      And "octo" answers item 42's newer question with "Keep the header row"
      When the operator opens Floor
      Then item 42's row in "Production Line" reads "Answered, waiting for a cell, resumes at green"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-3: an item still waiting on a person reads as it does today
  # ---------------------------------------------------------------------------------------------------------------
  Rule: A SignOff or NeedsInput item still waiting on a person reads as it does today

    @ac-3 @regression
    Scenario: An item waiting on sign-off still shows in "Waiting on you" as waiting on the owner's sign-off
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      When the operator opens Floor
      Then "Waiting on you" lists item 41
      And item 41's row in "Waiting on you" shows "SignOff" and says it waits on the owner's sign-off
      And "Production Line" doesn't list item 41

    @ac-3 @regression
    Scenario: The item page of an item waiting on sign-off still gives its state as SignOff and offers the sign-off form
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      When "Pat" opens item 41's item page
      Then item 41's item page gives its state as "SignOff"
      And item 41's item page doesn't read "waiting for a cell"
      And item 41's item page offers "Approve the scenarios" and "Ask for changes"

    @ac-3 @regression
    Scenario: An item waiting on a question still shows in "Waiting on you" with its question
      Given item 42 "Export CSV" is in NeedsInput, waiting on the question "Should the export include archived rows?" asked at stage "green"
      When the operator opens Floor
      Then item 42's row in "Waiting on you" shows "NeedsInput" and the question "Should the export include archived rows?"
      And "Production Line" doesn't list item 42

    @ac-3 @regression
    Scenario: The item page of an item waiting on a question still gives its state as NeedsInput and offers the answer form
      Given item 42 "Export CSV" is in NeedsInput, waiting on the question "Should the export include archived rows?" asked at stage "green"
      When the operator opens item 42's item page
      Then item 42's item page gives its state as "NeedsInput"
      And item 42's item page doesn't read "waiting for a cell"
      And item 42's item page offers "Send the answer"

    @ac-3 @regression
    Scenario: An item with an answered question and a newer open question still waits on a person
      Given item 42 "Export CSV" is in NeedsInput with a question asked at stage "green" and answered
      And the factory asked item 42 a newer question "Should dates use UTC?" at stage "green"
      When the operator opens Floor
      Then item 42's row in "Waiting on you" shows "NeedsInput" and the question "Should dates use UTC?"
      And "Production Line" doesn't list item 42
      And item 42's item page doesn't read "waiting for a cell"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-4: the underlying state doesn't change
  # ---------------------------------------------------------------------------------------------------------------
  Rule: The underlying state stays SignOff or NeedsInput, so the event log, the board mirror and every filter by state still see it

    @ac-4 @regression
    Scenario: Approving the scenarios writes no state change to the item's event log
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      When "Pat" approves the scenarios of item 41
      Then item 41's state is "SignOff"
      And item 41's event log holds the approval's decision event
      And item 41's event log holds no transition out of SignOff

    @ac-4 @regression
    Scenario: Answering a question writes no state change to the item's event log
      Given item 42 "Export CSV" is in NeedsInput, waiting on a question asked at stage "green"
      When "octo" answers item 42's question with "Yes, include them"
      Then item 42's state is "NeedsInput"
      And item 42's event log holds the answer's decision event
      And item 42's event log holds no transition out of NeedsInput

    @ac-4 @regression
    Scenario: The board keeps an approved item at SignOff's status
      Given item 41 "Add search" is in SignOff, waiting on the owner's sign-off of its scenarios
      And the fake board shows item 41 at the status the field map names for SignOff
      When "Pat" approves the scenarios of item 41
      And the worker handles every outbox row
      Then the fake board still shows item 41 at the status the field map names for SignOff
      And the decision queued no board mirror row for item 41

    @ac-4 @regression
    Scenario: The board keeps an answered item at NeedsInput's status
      Given item 42 "Export CSV" is in NeedsInput, waiting on a question asked at stage "green"
      And the fake board shows item 42 at the status the field map names for NeedsInput
      When "octo" answers item 42's question with "Yes, include them"
      And the worker handles every outbox row
      Then the fake board still shows item 42 at the status the field map names for NeedsInput
      And the decision queued no board mirror row for item 42

    @ac-4 @regression
    Scenario: GET /v1/floor still gives an approved or answered item's state as SignOff or NeedsInput
      Given item 41 is in SignOff with its sign-off approved
      And item 42 is in NeedsInput with its question answered at stage "green"
      When the operator asks the API for GET /v1/floor
      Then the answer's "Production Line" row for item 41 has the state "SignOff"
      And the answer's "Production Line" row for item 42 has the state "NeedsInput"

    @ac-4 @regression
    Scenario: The item page still offers an approved item the moves of a queued item
      Given item 41 is in SignOff with its sign-off approved
      When the operator opens item 41's item page
      Then item 41's item page offers "Start now", "Move up" and "Move down"

    @ac-4 @regression
    Scenario: The claim still takes up an approved item and resumes it at the stage it named
      Given item 41 is in SignOff with its sign-off approved
      When a cell is free and claims work
      Then the claim takes item 41
      And item 41's run resumes at "red"
