@pbi-325
Feature: A failed save after a token refresh doesn't lose the rotated refresh token or sign the person out
  Before it forwards a /bff/v1 call, the BFF refreshes an access token that expires within 60 seconds and saves
  the new tokens to the session store (pbi-289). A provider that rotates refresh tokens hands back a new refresh
  token with each refresh and refuses the old one from then on. When the session store fails that save, the BFF
  must neither blame the sign-in provider nor drop the new refresh token: dropping it leaves the session holding
  a refresh token the provider no longer accepts, which signs the person out at their next call.
  The BFF may retry the save, or keep the new tokens so a later call saves them. Either way, the session keeps
  working once the session store answers again.
  Scenarios tagged @db need Postgres, which each test starts for itself, and a test sign-in provider and a
  stand-in API, which the test also starts, so CI and cells run them.

  Background:
    Given a test sign-in provider is running with the user "alice"
    And the provider rotates refresh tokens, refusing a refresh token once it has been replaced
    And a stand-in API is running
    And the BFF is running against that provider as its issuer and that stand-in as its API
    And the provider will issue the refresh token "rt-alice-1" for the next sign-in
    And "alice" has signed in through the BFF
    And alice's access token expires in 30 seconds
    And the provider will issue the access token "at-alice-2", lasting 5 minutes, and the refresh token "rt-alice-2" on the next refresh

  Rule: A failed save of refreshed tokens is reported as the session store's failure, and logged

    @ac-1 @db
    Scenario: The call's error names the session store, not the sign-in provider
      Given the session store will fail every save of alice's tokens
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers with a server error
      And the error says the session store couldn't save the session
      And the error doesn't mention the sign-in provider
      And the BFF doesn't clear alice's session cookie

    @ac-1 @db
    Scenario: The BFF logs the failed save as the session store's failure
      Given the session store will fail every save of alice's tokens
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF's log records that the session store couldn't save alice's refreshed tokens
      And that log entry doesn't say the sign-in provider didn't answer

  Rule: The rotated refresh token survives a failed save, and the session works again once the store answers

    @ac-2 @db
    Scenario: After the store recovers, the rotated refresh token is the one stored
      Given the session store will fail the next save of alice's tokens
      When alice's browser calls GET "/bff/v1/floor"
      And the session store answers again
      And alice's browser calls GET "/bff/v1/floor" again
      Then the stored refresh token decrypts to "rt-alice-2" under the BFF's session key
      And the stored refresh token doesn't contain "rt-alice-2"

    @ac-2 @db
    Scenario: The BFF never spends the replaced refresh token again
      Given the session store will fail the next save of alice's tokens
      When alice's browser calls GET "/bff/v1/floor"
      And the session store answers again
      And alice's browser calls GET "/bff/v1/floor" again
      Then the provider received one refresh with "rt-alice-1"
      And the provider refused no refresh

    @ac-2 @db
    Scenario: A store that stays down for several calls still loses nothing once it answers
      Given the session store will fail the next 3 saves of alice's tokens
      When alice's browser calls GET "/bff/v1/floor" 3 times
      And the session store answers again
      And alice's browser calls GET "/bff/v1/floor" again
      Then the BFF's last answer is the stand-in API's answer
      And the API's last call carried "at-alice-2" as a bearer token
      And the stored refresh token decrypts to "rt-alice-2" under the BFF's session key

    @ac-2 @db
    Scenario: The next refresh after recovery uses the rotated refresh token
      Given the session store will fail the next save of alice's tokens
      And alice's browser has called GET "/bff/v1/floor"
      And the session store answers again
      And alice's browser has called GET "/bff/v1/floor" again
      And alice's access token expires in 30 seconds
      And the provider will issue the access token "at-alice-3" and the refresh token "rt-alice-3" on the next refresh
      When alice's browser calls GET "/bff/v1/floor" again
      Then the provider received a refresh with "rt-alice-2"
      And the API's last call carried "at-alice-3" as a bearer token
      And the stored refresh token decrypts to "rt-alice-3" under the BFF's session key

  Rule: The rotation-and-failed-save case is covered end to end

    @ac-3 @db
    Scenario: The next call after the store recovers still forwards, without a new sign-in
      Given the session store will fail the next save of alice's tokens
      When alice's browser calls GET "/bff/v1/floor"
      And the session store answers again
      And alice's browser calls GET "/bff/v1/floor" again
      Then the BFF's last answer is the stand-in API's answer
      And the API's last call carried "at-alice-2" as a bearer token
      And alice hasn't signed in again at the provider
