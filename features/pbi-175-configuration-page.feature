@pbi-175
Feature: A read-only Configuration page lists every runtime and env-backed setting
  The owner needs one place to see how the factory is set up right now, without reading the AppHost or the
  database. The dashboard has a Configuration page, linked from Floor, that lists every setting with its
  current value. Runtime settings are the values in the factory's WIP policy: the WIP mode, the WIP minimum,
  maximum and current value, the review capacity, the usage reserve, the usage pause and the daily budget.
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
    Scenario: The page offers no way to change an env-backed setting
      Given the factory started with GITHUB_APP_ID set to "123456"
      When "octo" opens the Configuration page
      Then the env-backed settings list "GITHUB_APP_ID" with the value "123456"
      And the page has no field, form or button to change an env-backed setting

    @ac-2 @db
    Scenario: An owner can't change an env-backed setting by sending a change to the page
      Given the factory started with GITHUB_APP_ID set to "123456"
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

