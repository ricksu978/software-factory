@pbi-6
Feature: Local platform on Aspire
  `aspire run` starts the factory's dependencies on the owner's machine, and a local cell container can reach them.
  Scenarios tagged @local need Docker, the Aspire CLI and the owner's secrets, so CI and cells skip them.

  @ac-1 @local
  Scenario: aspire run brings up the local platform
    When I start "aspire run" and wait until the control resource answers
    Then the "pg" and "storage" containers are running, each with a data volume
    And the "migrate" resource has exited with code 0

  @ac-2 @local
  Scenario: The database survives a restart
    Given "aspire run" has run once and the migrate probe recorded its run count
    When I stop "aspire run" and start it again
    Then the migrate probe's run count is one higher than before

  @ac-3 @local
  Scenario: The control resource gets its connections and secrets
    Given "aspire run" is up
    When I ask the control resource for the names of its environment variables
    Then the names include "FACTORY_DB_URI", "FACTORY_BLOB", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_APP_KEY", "GITHUB_PROJECT_TOKEN" and "CELL_SECRET"
    And the spike record names the variables Aspire injected for the database and the blobs

  @ac-4 @local
  Scenario: A cell container reaches the control plane and the storage emulator
    Given "aspire run" is up and the image "factory-cell:local" is built
    When a "factory-cell:local" container posts to "/internal/cells/ping" on the control plane
    Then the response status is 204
    When the container PUTs a blob to an upload URL from "/probe/sas"
    Then the response status is 201

  @ac-5 @local
  Scenario: A cell container runs the Agent SDK on the subscription token
    Given the image "factory-cell:local" is built
    When a "factory-cell:local" container runs "spike/sdk-oauth.ts" with the Claude token
    Then the result's subtype is "success", or the spike record shows the "claude -p" fallback working

  @ac-6
  Scenario: The spike record answers the two platform questions
    When I read "docs/superpowers/spikes/2026-11-local-platform.md"
    Then it states whether bubblewrap starts in a local cell container
    And it states whether GitHub lets the App's bot be assigned to an issue
