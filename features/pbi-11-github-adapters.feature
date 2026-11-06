@pbi-11
Feature: GitHub adapters and webhook intake
  The factory takes GitHub's webhook deliveries only when GitHub signed them, and acts on each
  delivery once. A cell's GitHub token can push code, open a PR and comment, but can't post a check,
  so a steered cell can't mark its own PR green. The GitHub backlog adapter behaves like every other
  adapter, because it passes the same contract suite as the fake.

  @ac-1 @db
  Scenario: A delivery signed with the webhook secret is accepted
    Given the webhook secret is "s3cret"
    When GitHub delivers an issue comment with delivery id "d-1", signed with "s3cret"
    Then the intake answers 204
    And 1 event is stored for delivery "d-1"

  @ac-1 @db
  Scenario Outline: A delivery that fails the signature check is refused and nothing is stored
    Given the webhook secret is "s3cret"
    When GitHub delivers an issue comment with delivery id "d-2" and <signature>
    Then the intake answers 401
    And nothing is stored for delivery "d-2"

    Examples:
      | signature                                           |
      | a signature from "s3cret" over a body changed after |
      | no signature header                                 |
      | a sha1 signature from "s3cret"                      |

  @ac-2 @db
  Scenario: The same delivery processed twice produces one event
    Given the webhook secret is "s3cret"
    When GitHub delivers an issue comment with delivery id "d-3", signed with "s3cret"
    And GitHub delivers an issue comment with delivery id "d-3", signed with "s3cret"
    Then the intake answers 204 the first time and 200 the second time
    And 1 event is stored for delivery "d-3"

  @ac-3
  Scenario: A cell token can write code, pull requests and issues, and nothing else
    Given a GitHub App whose token requests are recorded
    When the factory asks for a cell token for the repo "ricksu978/software-factory"
    Then the token request names only the repo "ricksu978/software-factory"
    And the token request asks for exactly these permissions:
      | permission    | access |
      | contents      | write  |
      | pull_requests | write  |
      | issues        | write  |

  @ac-4 @local
  Scenario: The GitHub backlog adapter passes every case in the shared contract suite
    Given a sandbox Project on the owner's personal account
    When I run the shared contract suite against the GitHub backlog adapter
    Then every contract case passes
    And the suite ran these cases:
      | case                                                       |
      | listEligible returns only open items with the opt-in label |
      | comment twice with one dedupe key leaves one comment       |
      | claim shows the in-progress marker and release clears it   |
      | setStatus round-trips through getItem                      |
      | parseWebhook on an unknown payload returns ignored         |
      | close shows closed through getItem                         |
