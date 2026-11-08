@pbi-117 @db
Feature: Additive schema for sessions, the outbox, the heartbeat and run snapshots
  Step 1 of the control plane redesign (2026-11-07 design, §08 and §12) adds the schema that later
  steps build on, and nothing reads it yet. A user can now be known by any sign-in issuer rather than
  only by one of today's three providers. New tables hold the BFF's sessions, the worker's outbox and
  heartbeat, and each run's locked scenario files, and a run keeps its acceptance criteria. A new
  BFF role reaches sessions and nothing else, and in Azure each service's own principal gets its
  role. Everything that works today keeps working: every existing user still loads and the owner
  still signs in to today's dashboard. Scenarios tagged @db need Postgres, which each test run
  starts for itself.

  Rule: A user is known by a provider or an issuer, and an issuer never holds the same subject twice

    @ac-1
    Scenario: A user with an issuer and no provider is accepted
      When someone adds the user "alice" from the issuer "https://id.example.com/realms/factory", with no provider
      Then the user is added
      And the user "alice" loads with the issuer "https://id.example.com/realms/factory" and no provider

    @ac-1
    Scenario: A user with neither a provider nor an issuer is refused, because a user needs one of them
      When someone adds the user "nobody" with neither a provider nor an issuer
      Then the user is refused because a user needs a provider or an issuer
      And no user "nobody" exists

    @ac-1
    Scenario: A second user with the same issuer and subject is refused
      When someone adds the user "alice" from the issuer "https://id.example.com/realms/factory" twice
      Then the first is added
      And the second is refused as a duplicate of the first
      And exactly one user "alice" from that issuer exists

    @ac-1
    Scenario: The same subject from two different issuers is two different users
      When someone adds the user "alice" from the issuer "https://id.example.com/realms/factory"
      And someone adds the user "alice" from the issuer "https://login.example.org"
      Then both users are added
      And each loads with its own issuer

  Rule: Users from before the migration keep working as they do today

    @ac-2 @regression
    Scenario: Every user from before the migration still loads as it was
      Given a database at today's schema holding these users:
        | provider  | subject | tenant    | email           | GitHub login | role     | product owner |
        | dev       | octo    |           |                 | octo         | owner    | yes           |
        | google    | g-1001  |           | ada@example.com |              | viewer   | no            |
        | microsoft | m-2002  | t-contoso | bo@contoso.com  | bo-gh        | operator | no            |
      When the factory migrates that database
      Then every one of those users still loads with the provider, subject, tenant, email, GitHub login, role and product owner flag it had

    @ac-2 @regression
    Scenario: The owner from before the migration still signs in to today's dashboard
      Given a database at today's schema whose owner is "octo"
      And the factory migrates that database
      And the dashboard runs locally for "octo" on that database
      When someone opens this start's sign-in link and opens Floor
      Then the request is signed in as "octo"
      And Floor opens for "octo" rather than the no-access page

  Rule: The new tables and the run's criteria column exist with the columns §08 lists

    @ac-3
    Scenario Outline: A new table exists with the columns §08 lists
      When the factory migrates an empty database
      Then the table "<table>" exists with exactly the columns "<columns>"

      Examples:
        | table            | columns                                                                                                              |
        | session          | cookie_hash, issuer, subject, refresh_token_encrypted, access_token, access_token_expires_at, created_at, last_seen_at, expires_at |
        | outbox           | seq, consumer, event_id, item_id, attempts, next_attempt_at, failed_at                                               |
        | worker_heartbeat | ticked_at                                                                                                            |
        | run_file         | run_id, sha, path, text                                                                                              |

    @ac-3
    Scenario: A run keeps its acceptance criteria
      Given the factory has migrated an empty database
      And a run exists
      When the run's acceptance criteria are stored
      Then the run loads with those acceptance criteria

    @ac-3
    Scenario: Outbox rows are numbered in the order they're added
      Given the factory has migrated an empty database
      When two outbox rows are added one after the other
      Then the second has a higher sequence number than the first

    @ac-3
    Scenario: The worker heartbeat holds one row at most
      Given the factory has migrated an empty database
      And the worker heartbeat holds a tick
      When a second heartbeat row is added
      Then the second heartbeat row is refused
      And the worker heartbeat still holds exactly one row

  Rule: The BFF's role reaches sessions and nothing else

    @ac-4
    Scenario: The BFF's role can add, read, change and remove a session
      Given the factory has migrated an empty database
      When the BFF's role adds a session, reads it, changes its last seen time and removes it
      Then each of those succeeds
      And the session is gone

    @ac-4
    Scenario Outline: The BFF's role is refused on users, items and overrides
      Given the factory has migrated an empty database
      When the BFF's role tries to <action> the "<table>" table
      Then it is refused for lack of permission

      Examples:
        | action | table    |
        | read   | user     |
        | change | user     |
        | read   | item     |
        | change | item     |
        | read   | override |
        | add to | override |

    @ac-4
    Scenario: The BFF's role is refused on every table except session
      Given the factory has migrated an empty database
      When the BFF's role tries to read, add to, change and remove from every table except "session"
      Then every one of those attempts is refused for lack of permission

  Rule: The app's role reads and writes the other new tables, outbox included

    @ac-5
    Scenario: The app's role can add an outbox row, which takes the next sequence number
      Given the factory has migrated an empty database
      When the app's role adds an outbox row
      Then the outbox row is added with a sequence number

    @ac-5
    Scenario Outline: The app's role can add, read, change and remove rows in a new table
      Given the factory has migrated an empty database
      When the app's role adds a row to "<table>", reads it, changes it and removes it
      Then each of those succeeds

      Examples:
        | table            |
        | outbox           |
        | worker_heartbeat |
        | run_file         |

    @ac-5
    Scenario: The app's role can store a run's acceptance criteria
      Given the factory has migrated an empty database
      And a run exists
      When the app's role stores the run's acceptance criteria
      Then the run loads with those acceptance criteria

  Rule: Migrate gives each service's principal its own role, and keeps today's single mapping when none is set

    @ac-6
    Scenario: Each service's principal setting maps onto its role
      Given the principals "id-factory-bff", "id-factory-api", "id-factory-worker" and "id-factory-cellapi" exist in the database
      When the factory migrates with these settings:
        | setting                    | value              |
        | FACTORY_BFF_PRINCIPAL      | id-factory-bff     |
        | FACTORY_API_PRINCIPAL      | id-factory-api     |
        | FACTORY_WORKER_PRINCIPAL   | id-factory-worker  |
        | FACTORY_CELL_API_PRINCIPAL | id-factory-cellapi |
      Then "id-factory-bff" is a member of "factory_bff"
      And "id-factory-api" is a member of "factory_app"
      And "id-factory-worker" is a member of "factory_app"
      And "id-factory-cellapi" is a member of "factory_app"

    @ac-6
    Scenario: The BFF's principal gets the BFF's role and not the app's
      Given the principal "id-factory-bff" exists in the database
      When the factory migrates with FACTORY_BFF_PRINCIPAL set to "id-factory-bff"
      Then "id-factory-bff" is a member of "factory_bff"
      And "id-factory-bff" is not a member of "factory_app"

    @ac-6
    Scenario: A service whose principal setting is missing gets no principal mapped
      Given the principals "id-factory-bff" and "id-factory-api" exist in the database
      When the factory migrates with FACTORY_API_PRINCIPAL set to "id-factory-api" and no other principal setting
      Then "id-factory-api" is a member of "factory_app"
      And "id-factory-bff" is a member of no factory role

    @ac-6 @regression
    Scenario: With no service's principal set, today's single principal still maps onto the app's role
      Given the principal "id-factory-control" exists in the database
      When the factory migrates with FACTORY_APP_PRINCIPAL set to "id-factory-control" and no service's principal setting
      Then "id-factory-control" is a member of "factory_app"
