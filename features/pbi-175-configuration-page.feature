@pbi-175
Feature: A Configuration page lists every runtime and env-backed setting, and an operator can change the runtime ones
  The owner needs one place to see how the factory is set up right now, without reading the AppHost or the
  database. The dashboard has a Configuration page, linked from Floor, that lists every setting with its
  current value. Runtime settings are the values in the factory's WIP policy: the WIP mode, the WIP minimum,
  maximum and current value, the review capacity, the usage reserve, the usage pause and the daily budget.
  An operator can change the WIP minimum, maximum and current value, the review capacity, the usage reserve
  and the daily budget from the page, and the change takes effect without a restart. The WIP mode and the
  usage pause are set by the factory itself, so the page shows them but doesn't change them.
  Env-backed settings are the values the control plane reads from its environment at start. They show
  read-only, and each is marked as needing a restart, because a change takes effect only when the factory
  restarts. The page never shows a secret's value: not the GitHub App key, the GitHub project token, the
  Claude OAuth token, the database URI, the blob connection, the cell secret or the webhook secret.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory runs locally for "octo"
    And "octo" is signed in to the dashboard

  Rule: Floor links to the Configuration page

    @ac-1 @db
    Scenario: Floor links to the Configuration page
      When "octo" opens Floor
      Then Floor has a link named "Configuration"
      When "octo" follows the "Configuration" link
      Then the page's heading is "Configuration"

    @ac-1 @db
    Scenario: A viewer who isn't allowlisted can't open the Configuration page
      Given the factory's allowlist holds only "octo"
      When "stranger" signs in and opens the Configuration page
      Then the response is 403
      And the page says "You don't have access to this factory. Ask an owner to add you."
      And the page shows no setting

  Rule: The page lists every runtime setting with its current value

    @ac-1 @db
    Scenario Outline: The page shows the runtime setting <setting> with its current value
      Given the factory's WIP policy has <setting> set to <stored>
      When "octo" opens the Configuration page
      Then the runtime settings list "<setting>" with the value "<shown>"

      Examples:
        | setting          | stored                 | shown                  |
        | WIP mode         | "fixed"                | fixed                  |
        | WIP minimum      | 1                      | 1                      |
        | WIP maximum      | 2                      | 2                      |
        | current WIP      | 2                      | 2                      |
        | review capacity  | 4                      | 4                      |
        | usage reserve    | 0.7                    | 0.7                    |
        | daily budget     | 25                     | 25                     |
        | usage pause      | "2026-11-14T09:00:00Z" | 2026-11-14T09:00:00Z   |

    @ac-1 @db
    Scenario: The page shows a runtime setting's value as it is now, not as it was at start
      Given the factory's WIP policy has review capacity set to 3
      And "octo" has opened the Configuration page once
      When the factory's WIP policy changes review capacity to 5
      And "octo" opens the Configuration page again
      Then the runtime settings list "review capacity" with the value "5"
      And the runtime settings don't show "review capacity" with the value "3"

    @ac-1 @db
    Scenario Outline: A runtime setting with no value shows as not set
      Given the factory's WIP policy has no <setting>
      When "octo" opens the Configuration page
      Then the runtime settings list "<setting>" as "not set"

      Examples:
        | setting      |
        | daily budget |
        | usage pause  |

    @ac-1 @db
    Scenario: Runtime settings aren't marked as needing a restart
      When "octo" opens the Configuration page
      Then the runtime settings list "review capacity"
      And "review capacity" isn't marked as needing a restart

  Rule: An operator can change a runtime setting from the page, and it takes effect without a restart

    @ac-1 @db
    Scenario Outline: An operator changes <setting> from the page
      Given "octo" is an operator
      And the factory's WIP policy has WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1
      And the factory's WIP policy has <setting> set to <before>
      When "octo" changes <setting> to "<after>" on the Configuration page
      Then the page says "<setting> changed"
      And the runtime settings list "<setting>" with the value "<after>"
      And the factory's WIP policy has <setting> set to <after>

      Examples:
        | setting         | before | after |
        | WIP minimum     | 1      | 2     |
        | WIP maximum     | 3      | 4     |
        | current WIP     | 1      | 2     |
        | review capacity | 3      | 5     |
        | usage reserve   | 0.7    | 0.8   |
        | daily budget    | 25     | 40    |

    @ac-1 @db
    Scenario: A changed WIP takes effect without restarting the factory
      Given "octo" is an operator
      And the factory's WIP policy has WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1
      And one item is in progress and another is queued
      When "octo" changes current WIP to "2" on the Configuration page
      And the scheduler takes its next turn, with no restart
      Then the queued item is in progress
      And "current WIP" isn't marked as needing a restart

    @ac-1 @db
    Scenario: An operator clears the daily budget
      Given "octo" is an operator
      And the factory's WIP policy has daily budget set to 25
      When "octo" clears daily budget on the Configuration page
      Then the runtime settings list "daily budget" as "not set"
      And the factory's WIP policy has no daily budget

    @ac-1 @db
    Scenario: A change shows in the activity log with who made it
      Given "octo" is an operator
      And the factory's WIP policy has review capacity set to 3
      When "octo" changes review capacity to "5" on the Configuration page
      Then the activity log shows that "octo" changed review capacity from "3" to "5"

    @ac-1 @db
    Scenario Outline: A change that breaks a rule is turned down and the setting keeps its value
      Given "octo" is an operator
      And the factory's WIP policy has WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1
      And the factory's WIP policy has review capacity set to 3, usage reserve set to 0.7 and daily budget set to 25
      When "octo" changes <setting> to "<value>" on the Configuration page
      Then the change is turned down with the message "<message>"
      And the factory's WIP policy still has <setting> set to <kept>
      And the activity log shows no change to <setting>

      Examples:
        | setting         | value | kept | message                                                    |
        | WIP minimum     | 0     | 1    | WIP minimum must be a whole number of at least 1.          |
        | WIP minimum     | 4     | 1    | WIP minimum can't be more than WIP maximum.                |
        | WIP maximum     | 2.5   | 3    | WIP maximum must be a whole number of at least 1.          |
        | current WIP     | 5     | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | review capacity | 0     | 3    | Review capacity must be a whole number of at least 1.      |
        | review capacity | many  | 3    | Review capacity must be a whole number of at least 1.      |
        | usage reserve   | 1.5   | 0.7  | Usage reserve must be more than 0 and at most 1.           |
        | usage reserve   | 0     | 0.7  | Usage reserve must be more than 0 and at most 1.           |
        | daily budget    | -10   | 25   | Daily budget must be more than 0, or left empty for none.  |

    @ac-1 @db
    Scenario: A viewer sees the runtime settings but can't change them
      Given "vera" is a viewer
      And the factory's WIP policy has review capacity set to 3
      When "vera" opens the Configuration page
      Then the runtime settings list "review capacity" with the value "3"
      And the page has no field, form or button to change a setting

    @ac-1 @db
    Scenario: A viewer who sends a change anyway is refused and nothing changes
      Given "vera" is a viewer
      And the factory's WIP policy has review capacity set to 3
      When "vera" sends a change of review capacity to "9" to the Configuration page
      Then the response is 403
      And the page says "Only an operator can change the factory's settings."
      And the factory's WIP policy still has review capacity set to 3

    @ac-1 @db
    Scenario Outline: The page offers no way to change <setting>, which the factory sets itself
      Given "octo" is an operator
      When "octo" opens the Configuration page
      Then the runtime settings list "<setting>"
      And the page has no field to change "<setting>"

      Examples:
        | setting     |
        | WIP mode    |
        | usage pause |

  Rule: The page lists every env-backed setting with the value the factory started with

    @ac-1 @db
    Scenario Outline: The page shows the env-backed setting <setting> with its current value
      Given the factory started with <setting> set to "<value>"
      When "octo" opens the Configuration page
      Then the env-backed settings list "<setting>" with the value "<value>"

      Examples:
        | setting                  | value                             |
        | FACTORY_ENV              | local                             |
        | FACTORY_DEV_LOGIN        | octo                              |
        | GITHUB_APP_ID            | 123456                            |
        | CELL_CONTROL_URL         | http://host.docker.internal:7400  |
        | CELL_BLOB_HOST           | host.docker.internal              |
        | FACTORY_POLICY_DIR       | ./policy                          |
        | CLAUDE_TOKEN_CREATED_AT  | 2026-10-01                        |
        | FACTORY_KILL             | 1                                 |

    @ac-1 @db
    Scenario: An env-backed setting the factory started without shows as not set
      Given the factory started without FACTORY_KILL
      When "octo" opens the Configuration page
      Then the env-backed settings list "FACTORY_KILL" as "not set"

    @ac-1 @db
    Scenario: A setting's value shows as text, never as markup
      Given the factory started with FACTORY_POLICY_DIR set to "./policy\"><b>x</b>"
      When "octo" opens the Configuration page
      Then the env-backed settings list "FACTORY_POLICY_DIR" with the value "./policy\"><b>x</b>"
      And the page has no bold element from the value

  Rule: Env-backed settings are read-only and each is marked as needing a restart

    @ac-2 @db
    Scenario Outline: The env-backed setting <setting> is marked as needing a restart
      Given the factory started with <setting> set to "<value>"
      When "octo" opens the Configuration page
      Then the env-backed settings list "<setting>" with the value "<value>"
      And "<setting>" is marked as needing a restart

      Examples:
        | setting            | value                             |
        | FACTORY_ENV        | local                             |
        | GITHUB_APP_ID      | 123456                            |
        | CELL_CONTROL_URL   | http://host.docker.internal:7400  |
        | FACTORY_POLICY_DIR | ./policy                          |

    @ac-2 @db
    Scenario: An env-backed setting the factory started without is still marked as needing a restart
      Given the factory started without FACTORY_KILL
      When "octo" opens the Configuration page
      Then the env-backed settings list "FACTORY_KILL" as "not set"
      And "FACTORY_KILL" is marked as needing a restart

    @ac-2 @db
    Scenario: The page offers no way to change an env-backed setting, even to an operator
      Given "octo" is an operator
      And the factory started with GITHUB_APP_ID set to "123456"
      When "octo" opens the Configuration page
      Then the env-backed settings list "GITHUB_APP_ID" with the value "123456"
      And the page has no field, form or button to change an env-backed setting

    @ac-2 @db
    Scenario: An operator can't change an env-backed setting by sending a change to the page
      Given "octo" is an operator
      And the factory started with GITHUB_APP_ID set to "123456"
      And "octo" has opened the Configuration page once
      When "octo" sends a change of GITHUB_APP_ID to "999999" to the Configuration page
      And "octo" opens the Configuration page again
      Then the env-backed settings list "GITHUB_APP_ID" with the value "123456"
      And the page doesn't show "999999"

  Rule: The page never shows a secret

    @ac-2 @db
    Scenario Outline: The page never shows the value of <secret>
      Given the factory started with <secret> set to "<value>"
      And the factory started with GITHUB_APP_ID set to "123456"
      When "octo" opens the Configuration page
      Then the env-backed settings list "GITHUB_APP_ID" with the value "123456"
      And the page doesn't show "<value>" anywhere, in its text or its markup

      Examples:
        | secret                  | value                                                         |
        | GITHUB_APP_KEY          | -----BEGIN RSA PRIVATE KEY-----app-key-canary                 |
        | GITHUB_PROJECT_TOKEN    | ghp_project_token_canary                                      |
        | CLAUDE_CODE_OAUTH_TOKEN | sk-ant-oat01-oauth-canary                                     |
        | FACTORY_DB_URI          | postgresql://factory:db-password-canary@localhost:5432/factory |
        | FACTORY_BLOB            | AccountKey=blob-key-canary                                    |
        | CELL_SECRET             | cell-secret-canary                                            |
        | GITHUB_WEBHOOK_SECRET   | webhook-secret-canary                                         |

    @ac-2 @db
    Scenario: No part of the database URI shows, not even its password alone
      Given the factory started with FACTORY_DB_URI set to "postgresql://factory:db-password-canary@db.internal:5432/factory"
      And the factory started with GITHUB_APP_ID set to "123456"
      When "octo" opens the Configuration page
      Then the env-backed settings list "GITHUB_APP_ID" with the value "123456"
      And the page doesn't show "db-password-canary" anywhere, in its text or its markup
      And the page doesn't show "db.internal" anywhere, in its text or its markup

