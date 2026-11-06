@pbi-33
Feature: Keep the owner's Claude token out of cells
  A cell holds only a stand-in token for its own run. The control plane's model gateway checks it,
  swaps in the owner's token, and passes everything else through untouched, so nothing a steered
  agent writes can carry the owner's token.

  @ac-1
  Scenario: The gateway sends the owner's token upstream in place of the cell's credential
    Given a model gateway in front of a fake upstream, holding the owner token "owner-secret"
    When a cell sends a model request with a valid run credential and the header "anthropic-beta: oauth-2025-04-20"
    Then the upstream receives the authorization "Bearer owner-secret"
    And the upstream receives the header "anthropic-beta: oauth-2025-04-20"
    And the cell receives the upstream's reply

  @ac-1
  Scenario: The gateway refuses a credential the factory didn't issue
    Given a model gateway in front of a fake upstream, holding the owner token "owner-secret"
    When a cell sends a model request with a run credential the factory didn't issue
    Then the gateway answers 401
    And the upstream receives no request

  @ac-2 @local
  Scenario: A cell runs the Agent SDK on the owner's subscription through the gateway
    Given the image "factory-cell:local" is built
    When a cell container holding only a stand-in token runs "spike/sdk-oauth.ts" through the gateway
    Then the cell's result has the subtype "success"

  @ac-3 @local
  Scenario: The owner's token is absent from a running cell's environment
    Given the image "factory-cell:local" is built
    When a cell container holding only a stand-in token lists its environment
    Then no variable in it holds the owner's Claude token
