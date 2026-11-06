@pbi-19
Feature: Dashboard sign-in, Floor and sign-off
  The dashboard lets only allowlisted people in. Locally there's no sign-in provider, so each start
  prints a one-time link that sets a cookie. Floor shows what waits on the owner, what the factory
  takes next and what isn't ready. A product owner signs off scenarios from the dashboard or with a
  /approve comment, and both do the same thing. Scenarios tagged @db need Postgres, so cells skip
  them and CI runs them.

  @ac-1 @db
  Scenario Outline: Only allowlisted people get past sign-in
    Given the factory's allowlist holds only "octo"
    When "<person>" signs in and opens Floor
    Then the response is <status>
    And the page says "<text>"

    Examples:
      | person   | status | text                                                            |
      | stranger | 403    | You don't have access to this factory. Ask an owner to add you. |
      | octo     | 200    | Waiting on you                                                  |

  @ac-2
  Scenario: Locally, a request without this start's sign-in cookie gets no identity
    Given the dashboard runs locally for "octo"
    When a request without the sign-in cookie opens Floor, carrying every Azure sign-in header
    Then the request gets no identity

  @ac-2
  Scenario: Locally, a sign-in link with the wrong token sets no cookie
    Given the dashboard runs locally for "octo"
    When someone opens the sign-in link with a wrong token
    Then no sign-in cookie is set

  @ac-2
  Scenario: Locally, this start's sign-in link signs the owner in
    Given the dashboard runs locally for "octo"
    When someone opens this start's sign-in link
    And opens Floor with the cookie it set
    Then the request is signed in as "octo"

  @ac-2 @db
  Scenario Outline: A dashboard POST from another origin gets 403 and changes nothing
    Given "octo", a product owner, is signed in, and an item waits for sign-off
    When "octo" posts an approval <origin>
    Then the response is 403
    And the item still waits for sign-off

    Examples:
      | origin                                 |
      | with the origin "https://evil.example" |
      | with no origin                         |

  @ac-2 @db
  Scenario: A dashboard POST from the dashboard's own origin goes through
    Given "octo", a product owner, is signed in, and an item waits for sign-off
    When "octo" posts an approval from the dashboard's own origin
    Then the item is ready to resume at "red"

  @ac-3 @db
  Scenario: Floor shows what waits on the owner, oldest first
    Given a SignOff item asked 3 hours ago, a NeedsInput item asked 1 hour ago, an InReview item and a Queued item
    When "octo" opens Floor
    Then "Waiting on you" lists the SignOff item, then the NeedsInput item, then the InReview item
    And "Waiting on you" doesn't list the Queued item

  @ac-3 @db
  Scenario: Floor shows the next five items the factory would take
    Given seven Queued items ranked 1 to 7
    When "octo" opens Floor
    Then "Next up" lists the items ranked 1 to 5, in that order

  @ac-3 @db
  Scenario: Floor shows each not-ready item with the lines it failed
    Given a NotReady item that failed the dor.md line "Has a Size of 5 or less"
    When "octo" opens Floor
    Then "Not ready" lists the item with "Has a Size of 5 or less"

  @ac-4 @db
  Scenario Outline: A product owner's /approve comment signs off exactly as the dashboard button does
    Given an item waits for sign-off on scenarios at "abc123"
    When "octo", a product owner, approves through <channel>
    Then the item is ready to resume at "red"
    And its scenarios are locked at "abc123"
    And its sign-off question is answered "approve"

    Examples:
      | channel              |
      | the dashboard button |
      | a "/approve" comment |

  @ac-4 @db
  Scenario Outline: A /approve comment from anyone else changes nothing
    Given an item waits for sign-off on scenarios at "abc123"
    When <person> comments "/approve" on the item
    Then the item still waits for sign-off
    And the item gets one reply saying who can sign off

    Examples:
      | person                                                |
      | "viewer1", who is allowlisted but not a product owner |
      | "stranger", who maps to no allowlisted user           |
