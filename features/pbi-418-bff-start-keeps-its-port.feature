@pbi-418
Feature: A BFF scenario's start step keeps the port it picked, so another worker's server can't answer in the BFF's place
  The BFF scenarios of PBI 288, PBI 289 and PBI 278 start the BFF with one shared step. That step picks a free
  port, starts the BFF on it, and waits until something answers there. The suite runs in parallel workers (PBI
  390), so in the gap between the pick and the BFF binding the port, another worker's server can take the same
  port. Then the BFF can't bind, and exits. The start step still sees an answer on the port, from the other
  server, and counts the BFF as up. Every later step of the scenario then talks to the wrong server, and the
  scenario fails on something that has nothing to do with the BFF.
  With this item, when the picked port is taken before the BFF binds it, the start step starts the BFF on
  another free port, and the rest of the scenario uses that port. The start step counts the BFF as up only when
  the BFF it started is the program answering on the port. A BFF that exits for any other reason fails the start
  step with the BFF's output, as it does today.
  In these scenarios "another program" is a server the test starts for itself. It takes a port the scenario
  picked for its BFF at the moment the test chooses, and it records every call it gets, so the test can see
  whether the scenario ever talked to it in the BFF's place.
  Scenarios tagged @db need Postgres, which each test starts for itself, and a test sign-in provider, which the
  test also starts, so CI and cells run them. The scenario that runs PBI 288's and PBI 289's scenarios 10 times
  in 4 workers is tagged @local, because 10 runs of both suites would add many minutes to every build. The owner
  runs it once and the PR records the run.

  Background:
    Given a test sign-in provider is running with the user "alice"

  Rule: When another program takes the picked port before the BFF binds it, the start step starts the BFF on another free port, and the rest of the scenario uses that port

    @ac-1 @db
    Scenario: The picked port is taken just before the BFF binds it, so the BFF starts on another free port
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      Then the start step passes
      And the BFF the scenario started is running
      And the BFF the scenario started answers on a port other than the one the other program took

    @ac-1 @db
    Scenario: The first two ports picked are both taken, so the BFF starts on a third
      Given another program will take each of the first 2 ports the scenario picks for its BFF, after each pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      Then the start step passes
      And the BFF the scenario started answers on a port neither of the other programs took

    @ac-1 @db
    Scenario: After the BFF moves to another port, a later step's call reaches the BFF and not the other program
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      And a browser with no session cookie opens "/auth/session" on the BFF
      Then the BFF the scenario started answered that call
      And the other program received no call

    @ac-1 @db
    Scenario: After the BFF moves to another port, sign-in sends the browser back to the BFF on that port
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      And "alice" tries to sign in through the BFF
      Then alice's sign-in succeeds
      And the provider sent the browser back to "/auth/callback" on the port the BFF started on
      And the other program received no call

    @ac-1 @db
    Scenario: After the BFF moves to another port, stopping and starting it again brings it back on that port
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      And the BFF is stopped and started again
      And a browser with no session cookie opens "/auth/session" on the BFF
      Then the BFF the scenario started again answers on the port the BFF first moved to
      And the BFF the scenario started again answered that call
      And the other program received no call

  Rule: The start step counts the BFF as up only when the BFF it started is the program answering on the port

    @ac-2 @db
    Scenario: Another program answering on the picked port isn't taken for the BFF
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF binds it
      When the scenario starts its BFF against that provider as its issuer
      Then the start step passes
      And when the start step counted the BFF as up, the program answering on the BFF's port was the BFF the scenario started

    @ac-2 @db
    Scenario: The BFF never comes up while another program answers on the picked port, so the start step fails
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF starts
      And the BFF the scenario starts will neither listen on any port nor exit
      When the scenario starts its BFF against that provider as its issuer
      Then the start step fails
      And the failure says the BFF the scenario started never answered on its port
      And the start step never counted the BFF as up

  Rule: A BFF that exits for any reason other than a taken port fails the start step with the BFF's output, as today

    @ac-3 @db @regression
    Scenario: A BFF with no session key exits, and the start step fails with the BFF's output
      Given the BFF the scenario starts will have no session key
      When the scenario starts its BFF against that provider as its issuer
      Then the start step fails
      And the failure carries the BFF's output, which names the missing session key
      And the start step started the BFF only once

    @ac-3 @db @regression
    Scenario: A BFF with a malformed API address exits, and the start step fails with the BFF's output
      Given the BFF the scenario starts will have the API address "not an address"
      When the scenario starts its BFF against that provider as its issuer
      Then the start step fails
      And the failure carries the BFF's output, which says the API address isn't an address
      And the start step started the BFF only once

    @ac-3 @db
    Scenario: A BFF that exits for another reason while another program holds its port fails, and isn't moved to another port
      Given another program will take the port the scenario picks for its BFF, after the pick and before the BFF starts
      And the BFF the scenario starts will have no session key
      When the scenario starts its BFF against that provider as its issuer
      Then the start step fails
      And the failure carries the BFF's output, which names the missing session key
      And the start step started the BFF only once
      And the start step never counted the BFF as up

  Rule: PBI 288's and PBI 289's scenarios pass every time in 4 workers

    @ac-4 @db @local @serial
    Scenario: PBI 288's and PBI 289's scenarios pass on each of 10 runs in a row in 4 workers
      Given the worker count setting is 4
      When the owner runs `npm run bdd -- --tags "@pbi-288 or @pbi-289"` 10 times in a row
      Then each of the 10 runs exits with code 0
      And no run reports a failed, ambiguous, undefined or pending scenario
      And each run ran in 4 workers
