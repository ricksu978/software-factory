@pbi-312
Feature: npm run factory asks only for the parameters a local run uses
  Before it starts the factory, `npm run factory` asks the owner for each AppHost parameter not yet saved for
  this checkout. Then it starts nothing until every one is set. Today it finds those parameters by reading
  every parameter the AppHost declares, wherever it declares it. So it also asks for `oidc-issuer` and
  `oidc-client-secret`, which the AppHost declares only for a published run. Under `aspire run` the BFF signs
  in at the local Keycloak realm and uses neither. An owner who leaves them empty can't start the factory.
  With this item the start asks only for the parameters the AppHost declares under `aspire run`. Under
  `aspire run` today those are claude-oauth-token, github-app-key-path, github-project-token, cell-secret,
  github-webhook-secret, dev-login, github-app-id, claude-token-created-at and bff-session-key.
  A parameter declared under `aspire run` that's still missing stops the start, as it does today. A parameter
  declared only for a published run never changes what the start asks for.
  These scenarios run the start's parameter check against a fake checkout. Its AppHost is either the real one or
  one the scenario writes. They use a fresh, empty secrets store for that checkout, and the owner's answers are
  scripted. Nothing really starts: the scenarios only record whether the start would go on to `aspire run`.
  So cells and CI both run them.

  Rule: The start asks only for the parameters the AppHost declares under aspire run

    @ac-1
    Scenario: On a fresh checkout, the start asks for each local parameter and never for the OIDC settings
      Given a checkout of the factory's AppHost with no parameter saved
      And the owner will give a value for every parameter the start asks for
      When the owner runs "npm run factory"
      Then the start asks for exactly these parameters:
        | claude-oauth-token      |
        | github-app-key-path     |
        | github-project-token    |
        | cell-secret             |
        | github-webhook-secret   |
        | dev-login               |
        | github-app-id           |
        | claude-token-created-at |
        | bff-session-key         |
      And the start doesn't ask for "oidc-issuer"
      And the start doesn't ask for "oidc-client-secret"
      And the start goes on to "aspire run"

    @ac-1
    Scenario: With every local parameter saved and neither OIDC setting set, the start asks nothing and goes on
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares under "aspire run" is saved
      And "oidc-issuer" is not saved
      And "oidc-client-secret" is not saved
      When the owner runs "npm run factory"
      Then the start asks for no parameter
      And the start says every parameter is set
      And the start goes on to "aspire run"
      And "oidc-issuer" is still not saved
      And "oidc-client-secret" is still not saved

    @ac-1
    Scenario: The start counts only the local parameters when it says they're all set
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares under "aspire run" is saved
      And neither OIDC setting is saved
      When the owner runs "npm run factory"
      Then the start says all 9 parameters are set

    @ac-1
    Scenario: With one local parameter missing, the start asks for that one alone
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares under "aspire run" is saved except "bff-session-key"
      And neither OIDC setting is saved
      And the owner will give a value for every parameter the start asks for
      When the owner runs "npm run factory"
      Then the start asks for exactly these parameters:
        | bff-session-key |
      And the start goes on to "aspire run"

  Rule: A local parameter that's still missing stops the start, as today

    @ac-2 @regression
    Scenario: A local secret the owner leaves empty stops the start
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares, for either kind of run, is saved except "claude-oauth-token"
      And the owner will leave "claude-oauth-token" empty when asked
      When the owner runs "npm run factory"
      Then the start asks for "claude-oauth-token"
      And the start says "claude-oauth-token" is still missing
      And the start stops before "aspire run"

    @ac-2 @regression
    Scenario: A local plain parameter the owner leaves empty stops the start
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares, for either kind of run, is saved except "dev-login"
      And the owner will leave "dev-login" empty when asked
      When the owner runs "npm run factory"
      Then the start says "dev-login" is still missing
      And the start stops before "aspire run"

    @ac-2 @regression
    Scenario: A parameter the AppHost declares only under aspire run is asked for, and stops the start while missing
      Given a checkout whose AppHost also declares a secret "local-only-token" only under "aspire run"
      And every other parameter that AppHost declares is saved
      And the owner will leave "local-only-token" empty when asked
      When the owner runs "npm run factory"
      Then the start asks for "local-only-token"
      And the start says "local-only-token" is still missing
      And the start stops before "aspire run"

    @ac-2
    Scenario: A missing local parameter stops the start, and only the local parameters are named as missing
      Given a checkout of the factory's AppHost
      And every parameter the AppHost declares under "aspire run" is saved except "github-app-id"
      And neither OIDC setting is saved
      And the owner will leave "github-app-id" empty when asked
      When the owner runs "npm run factory"
      Then the start says "github-app-id" is still missing
      And the start doesn't name "oidc-issuer" or "oidc-client-secret" as missing
      And the start stops before "aspire run"

  Rule: A parameter declared only outside aspire run never changes what the start asks for

    @ac-3
    Scenario Outline: A new <kind> declared only for a published run isn't asked for
      Given a checkout whose AppHost also declares a <kind> "<name>" only outside "aspire run"
      And no parameter is saved
      And the owner will give a value for every parameter the start asks for
      When the owner runs "npm run factory"
      Then the start asks for exactly the parameters the factory's own AppHost declares under "aspire run"
      And the start doesn't ask for "<name>"
      And the start goes on to "aspire run"

      Examples:
        | kind            | name             |
        | secret          | publish-api-key  |
        | plain parameter | publish-region   |

    @ac-3
    Scenario: A new parameter declared only for a published run, never saved, doesn't stop the start
      Given a checkout whose AppHost also declares a secret "publish-api-key" only outside "aspire run"
      And every parameter that AppHost declares under "aspire run" is saved
      And "publish-api-key" is not saved
      When the owner runs "npm run factory"
      Then the start asks for no parameter
      And the start goes on to "aspire run"

    @ac-3
    Scenario: A parameter declared for both kinds of run is still asked for
      Given a checkout whose AppHost declares a secret "shared-token" for every run, and a secret "publish-api-key" only outside "aspire run"
      And no parameter is saved
      And the owner will give a value for every parameter the start asks for
      When the owner runs "npm run factory"
      Then the start asks for "shared-token"
      And the start doesn't ask for "publish-api-key"
